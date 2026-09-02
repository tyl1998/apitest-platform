"""集成测试：跑一个真实的 pytest 子进程，验几条不能靠单测保证的性质。

1. **零改动接入**：只装包、只配两个环境变量，插件自动生效（不用 conftest、不用 `-p`）。
2. **流不被吃**：`stream=True` 逐块读到的内容与没装这个包时逐字节相同（边界 6）。
3. **不影响退出码**：上报地址指向一个黑洞端口后测试仍全绿、只多一条 warning。
4. **pytest-xdist 下一次运行只上报一份**，且 records 一条不丢（见 `distributed.py`）。

用子进程而不是 `pytester`：`pytester` 需要 pytest 自己的插件，而这里要验的恰好是「一个
干净的 python 进程里，装上包之后 pytest 会自己加载它」。xdist 那几条更是只能这么验——
缺陷本体就是「进程数 > 1」，单进程的 mock 里根本不存在。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

FIXTURE_TEST = '''
def test_passes():
    """一条通过的用例。

    第二行开始是描述。
    """
    assert 1 == 1


def test_fails():
    """一条失败的用例。"""
    assert 1 == 2


import pytest


@pytest.mark.parametrize("tier", ["vip", "normal"])
def test_parametrized(tier):
    """参数化用例。"""
    assert tier


@pytest.mark.parametrize("tier", ["vip", "normal"])
def test_tier_bare(tier):
    # 无 docstring 的参数化用例：兜底名走 case_key 的函数名段（2026-08-30 修正）。
    assert tier


@pytest.mark.skip(reason="deliberate")
def test_skipped():
    """被跳过的用例。"""
'''


def _run_pytest(tmp_path: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    (tmp_path / "tests").mkdir(exist_ok=True)
    (tmp_path / "tests" / "test_sample.py").write_text(FIXTURE_TEST, "utf-8")
    environment = dict(os.environ)
    # 让子进程能 import 到源码树里的 apitrack（未安装时）。
    environment["PYTHONPATH"] = str(ROOT) + os.pathsep + environment.get("PYTHONPATH", "")
    environment.update(env or {})
    return subprocess.run(
        # `-p no:apitrack` 先屏蔽掉**已安装**那份的 entry point，再用 `-p apitrack.plugin`
        # 显式加载源码树这一份。两件事都做是必需的：开发机上常常装着一个从 TestPyPI 验下来
        # 的旧包，两份同时加载会让 pytest 直接报
        # `Plugin already registered under a different name`——整个集成测试文件全红，而被测
        # 代码一点问题都没有。CI 的干净环境里 `no:apitrack` 是个无害的空操作。
        [sys.executable, "-m", "pytest", "-p", "no:apitrack", "-p", "apitrack.plugin", *args],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        env=environment,
        check=False,
    )


DRY_RUN_MARKER = "[apitrack] dry run, nothing was sent:"


def _dry_run_payload(result: subprocess.CompletedProcess[str]) -> dict:
    """从 dry-run 的 stdout 里取出那份 payload。

    **不能直接 `json.loads` 标记之后的全部内容**：dry-run 打完 payload 之后，pytest 自己还会
    继续输出测试摘要（`=== 1 failed, 3 passed ===` 之类），而 `json.loads` 要求整个字符串恰好
    是一个 JSON 值，于是报 `Extra data`。

    `raw_decode` 正好对应这里的事实——解析第一个完整的 JSON 值就停下，后面是什么都不管。
    这比「按 `====` 之类的分隔符截断」稳：那种切法依赖 pytest 的输出措辞，换个版本就失效。
    """
    assert DRY_RUN_MARKER in result.stdout, result.stdout + result.stderr
    tail = result.stdout.split(DRY_RUN_MARKER, 1)[1].lstrip()
    payload, _ = json.JSONDecoder().raw_decode(tail)
    return payload


def test_dry_run_payload_shape(tmp_path: Path):
    """dry-run 输出的 payload 形状就是协议 v1.0。

    顺带验三件事：docstring 首行当名字、其后当描述；参数化用例在 inventory 里是**一条**；
    参数化的名字是函数级的——带 docstring 的取 docstring 首行，裸函数取函数名段，
    都不带第一个参数的 ``[param]`` 后缀（2026-08-30 修正前，兜底名会被污染成
    ``test_tier_bare[vip]``）。
    """
    result = _run_pytest(tmp_path, "--apitrack-dry-run", "tests/")
    payload = _dry_run_payload(result)

    assert payload["protocol_version"] == "1.0"
    assert payload["run"]["scope"] == ["tests"]
    # 没有过滤 → 范围内的全量。
    assert payload["run"]["is_full_inventory"] is True

    by_key = {entry["case_key"]: entry for entry in payload["inventory"]}
    assert len(by_key) == 5, sorted(by_key)

    passing = by_key["tests/test_sample.py::test_passes"]
    assert passing["name"] == "一条通过的用例。"
    assert "第二行开始是描述。" in passing["description"]
    assert passing["result"] == "passed"
    assert by_key["tests/test_sample.py::test_fails"]["result"] == "failed"
    assert by_key["tests/test_sample.py::test_skipped"]["result"] == "skipped"
    # 参数化：一条用例，不是两条；名字取 docstring 首行（函数级）。
    assert by_key["tests/test_sample.py::test_parametrized"]["name"] == "参数化用例。"
    assert by_key["tests/test_sample.py::test_parametrized"]["result"] == "passed"
    # 无 docstring 的参数化：兜底名是函数名段，不带 [vip] 后缀。
    assert by_key["tests/test_sample.py::test_tier_bare"]["name"] == "test_tier_bare"
    assert by_key["tests/test_sample.py::test_tier_bare"]["result"] == "passed"


def test_marker_filter_is_not_full_inventory(tmp_path: Path):
    """`-m` 是范围内的挑选 → 非全量，平台侧不会删任何用例（边界 11）。"""
    result = _run_pytest(tmp_path, "--apitrack-dry-run", "-m", "not slow", "tests/")
    assert _dry_run_payload(result)["run"]["is_full_inventory"] is False


def test_keyword_filter_is_not_full_inventory(tmp_path: Path):
    result = _run_pytest(tmp_path, "--apitrack-dry-run", "-k", "passes", "tests/")
    assert _dry_run_payload(result)["run"]["is_full_inventory"] is False


# ── 勾选执行（P4.5-9，计划 8.3）──────────────────────────────────────────────


def test_case_keys_option_runs_only_the_selected_cases(tmp_path: Path):
    """`--apitrack-case-keys` 只跑选中的，且 **inventory 里只有跑了的那些**。

    inventory 必须跟着收窄，否则平台侧算不出 `not_run` 差集（边界 16）：被摘掉的用例若也
    登记进 inventory，它们会带着本次 ingest_run 的 id 落库，差集恒为空——勾了没跑的用例
    会一直显示上一轮的 `passed`。
    """
    result = _run_pytest(
        tmp_path,
        "--apitrack-dry-run",
        "--apitrack-case-keys",
        "tests/test_sample.py::test_passes,tests/test_sample.py::test_parametrized",
        "tests/",
    )
    payload = _dry_run_payload(result)
    keys = sorted(entry["case_key"] for entry in payload["inventory"])
    assert keys == ["tests/test_sample.py::test_parametrized", "tests/test_sample.py::test_passes"]
    # 有筛选 → 非全量 → 平台侧不对账删除。
    assert payload["run"]["is_full_inventory"] is False
    # 走 pytest 自己的 deselect 通知，所以终端摘要里数得出来。
    assert "deselected" in result.stdout


def test_case_keys_env_is_consumed(tmp_path: Path):
    """Runner 注入的形态：`APITRACK_CASE_KEYS`，逗号分隔（P4.5-5 冻结的线上形状）。"""
    result = _run_pytest(
        tmp_path,
        "--apitrack-dry-run",
        "tests/",
        env={"APITRACK_CASE_KEYS": "tests/test_sample.py::test_fails"},
    )
    payload = _dry_run_payload(result)
    assert [entry["case_key"] for entry in payload["inventory"]] == ["tests/test_sample.py::test_fails"]


def test_selecting_a_parametrized_case_keeps_every_scenario(tmp_path: Path):
    """勾一条参数化用例 = 跑它的全部场景（case_key 不含 `[...]`）。"""
    result = _run_pytest(
        tmp_path,
        "--apitrack-dry-run",
        "--apitrack-case-keys",
        "tests/test_sample.py::test_parametrized",
        "tests/",
    )
    payload = _dry_run_payload(result)
    assert [entry["case_key"] for entry in payload["inventory"]] == ["tests/test_sample.py::test_parametrized"]
    # 两个场景都跑了，所以结果是 passed 而不是「没跑」。
    assert payload["inventory"][0]["result"] == "passed"
    assert "2 passed" in result.stdout


def test_unmatched_case_keys_run_nothing_and_warn(tmp_path: Path):
    """一条都没匹配上时不回落成全量跑，只警告。

    回落会让平台收到「全都报到了」的上报、差集为空，于是一次 key 失配（勾的是别的仓库 /
    别的 ref）被显示成一次成功——那是这条性质存在的全部理由。
    """
    result = _run_pytest(
        tmp_path,
        "--apitrack-dry-run",
        "--apitrack-case-keys",
        "tests/test_other.py::test_nothing",
        "tests/",
    )
    payload = _dry_run_payload(result)
    assert payload["inventory"] == []
    assert "apitrack selected 0 of" in result.stdout + result.stderr


@pytest.mark.skipif(
    __import__("importlib.util", fromlist=["util"]).find_spec("requests") is None,
    reason="requests is not installed in this environment",
)
def test_parametrized_records_carry_param_id(tmp_path: Path):
    """参数化的场景维度要落到 records 上（2026-08-30）。

    树上的用例名是函数级的（兜底名不带 ``[param]`` 后缀），**场景这一层只存在于
    ``records[].param_id``**——nodeid 拆分 → contextvar → 传输层桩这条链路不验的话，
    平台侧「哪个场景发的请求」就查不出来。用真实 HTTP 服务而不是 mock：桩挂在传输层，
    mock 响应对象根本到不了那一层。
    """
    (tmp_path / "tests").mkdir(exist_ok=True)
    (tmp_path / "tests" / "test_scenarios.py").write_text(
        '''
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
import requests


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()


@pytest.mark.parametrize("tier", ["vip", "normal"])
def test_hits_api_per_scenario(tier):
    # 无 docstring：连带验证兜底名不带第一个参数的 [vip] 后缀。
    requests.get(f"http://127.0.0.1:{server.server_port}/orders", timeout=5)
''',
        "utf-8",
    )
    result = _run_pytest(tmp_path, "--apitrack-dry-run", "tests/test_scenarios.py")
    payload = _dry_run_payload(result)

    by_key = {entry["case_key"]: entry for entry in payload["inventory"]}
    case_key = "tests/test_scenarios.py::test_hits_api_per_scenario"
    assert by_key[case_key]["name"] == "test_hits_api_per_scenario"
    assert by_key[case_key]["result"] == "passed"

    # 两个场景各发了一条请求，param_id 各归各的；归属都在同一条用例上。
    assert sorted(record["param_id"] for record in payload["records"]) == ["normal", "vip"]
    for record in payload["records"]:
        assert record["case_key"] == case_key
        assert record["method"] == "GET"
        assert record["phase"] == "call"


def test_unreachable_platform_does_not_change_exit_code(tmp_path: Path):
    """把上报地址指到一个黑洞端口：测试结果与退出码不变，只多一条 warning（边界 6）。"""
    baseline = _run_pytest(tmp_path, "tests/test_sample.py::test_passes")
    reported = _run_pytest(
        tmp_path,
        "tests/test_sample.py::test_passes",
        env={
            "APITRACK_URL": "http://127.0.0.1:9",
            "APITRACK_TOKEN": "apitrack_test",
            "APITRACK_TIMEOUT": "1",
            # 显式给 git 信息：CI 上的临时目录不是 git 工作树，否则会走「跳过上报」分支
            # 而测不到这条性质。
            "APITRACK_GIT_URL": "git@example.com:demo/repo.git",
            "APITRACK_COMMIT": "0123456789abcdef",
            "APITRACK_BRANCH": "main",
        },
    )
    assert reported.returncode == baseline.returncode == 0
    assert "could not report this run" in reported.stdout + reported.stderr


# ── pytest-xdist（见 distributed.py）───────────────────────────────────────────

#: xdist 是可选的。装了才跑这一组——但这一组是这次修复的核心，CI 的 `test` job 里 xdist
#: 必须装上，否则「一次运行只上报一份」这条性质就退回成一句没人执行的话。
requires_xdist = pytest.mark.skipif(
    __import__("importlib.util", fromlist=["util"]).find_spec("xdist") is None,
    reason="pytest-xdist is not installed in this environment",
)


@requires_xdist
def test_xdist_reports_exactly_once(tmp_path: Path):
    """N+1 个进程，**一份** payload。

    这是缺陷本体：`pytest11` entry point 在 controller 与每个 worker 里各加载一次插件，
    各自上报的话平台按 `(repository, commit, ci_run_id)` 合并进同一行 run，records 的 seq
    又各自从 0 起 —— 后到的整批被 `UNIQUE (ingest_run_id, seq)` + `ON CONFLICT DO NOTHING`
    静默丢弃。
    """
    result = _run_pytest(tmp_path, "--apitrack-dry-run", "-n", "2", "tests/")
    assert result.stdout.count(DRY_RUN_MARKER) == 1, result.stdout + result.stderr


@requires_xdist
def test_xdist_merges_every_worker_result(tmp_path: Path):
    """合并后的那一份与单进程跑出来的**逐字段相同**（时间戳除外）。

    分开验「份数」与「内容」是刻意的：只数份数的话，一个把 worker 数据丢掉、只报
    controller 那份空 inventory 的实现也能通过——而那正是缺陷的另一半症状
    （`case_total = 0` + 「空 inventory 跳过对账」）。
    """
    single = _dry_run_payload(_run_pytest(tmp_path, "--apitrack-dry-run", "tests/"))
    distributed = _dry_run_payload(_run_pytest(tmp_path, "--apitrack-dry-run", "-n", "2", "tests/"))

    assert distributed["run"]["is_full_inventory"] is True
    assert distributed["run"]["scope"] == single["run"]["scope"]

    def by_key(payload: dict) -> dict:
        return {
            entry["case_key"]: (entry["name"], entry["description"], entry["result"], sorted(entry["tags"]))
            for entry in payload["inventory"]
        }

    # 用例数、显示名、描述、标签、结果全部一致——包括那条参数化用例仍是**一条**、
    # 那条失败的用例仍是 failed（结果合并走 `set_result`，失败优先级最高）。
    assert by_key(distributed) == by_key(single)


@requires_xdist
def test_xdist_records_keep_a_dense_unique_seq(tmp_path: Path):
    """所有 worker 的 records 合成一批，seq 从 0 密集且唯一。

    seq 是平台侧的幂等键。合并后仍撞号的话，症状不是报错而是**静默少数据**：36 个用例的
    e2e 只落 9 条 records。
    """
    (tmp_path / "tests").mkdir(exist_ok=True)
    # 一条 case、六个场景、每个场景打两次：足够让 `-n 3` 把它们分到不同进程。
    (tmp_path / "tests" / "test_calls.py").write_text(
        '''
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
import requests


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


@pytest.fixture(scope="session")
def base_url():
    # 每个 worker 各起一个自己的服务：xdist 的 worker 是独立进程，session fixture 不共享。
    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


@pytest.mark.parametrize("n", list(range(6)))
def test_hits(base_url, n):
    """每个场景打两个接口。"""
    requests.get(f"{base_url}/orders/{n}", timeout=5)
    requests.get(f"{base_url}/users/{n}", timeout=5)
''',
        "utf-8",
    )
    result = _run_pytest(tmp_path, "--apitrack-dry-run", "-n", "3", "tests/test_calls.py")
    payload = _dry_run_payload(result)

    seqs = [record["seq"] for record in payload["records"]]
    assert len(seqs) == 12, payload["records"]
    assert seqs == list(range(12))
    # 六个场景一条都没丢，且都挂在同一条用例上（case_key 不含 `[...]`，边界 7）。
    assert sorted({record["param_id"] for record in payload["records"]}) == ["0", "1", "2", "3", "4", "5"]
    assert {record["case_key"] for record in payload["records"]} == {"tests/test_calls.py::test_hits"}


@requires_xdist
def test_xdist_worker_side_deselect_reaches_the_controller(tmp_path: Path):
    """勾选执行在 worker 里 deselect，controller 必须仍判成**非全量**。

    xdist 下每个 worker 自己 collect、自己 deselect，controller 身上永远不会触发
    `pytest_deselected`。不把 worker 的 filters 带回来的话，一次「只跑 2 条」的勾选执行会被
    报成范围内的全量，平台侧照它把树上其余的用例全部标成消失。
    """
    result = _run_pytest(
        tmp_path,
        "--apitrack-dry-run",
        "-n", "2",
        "--apitrack-case-keys",
        "tests/test_sample.py::test_passes,tests/test_sample.py::test_parametrized",
        "tests/",
    )
    payload = _dry_run_payload(result)
    assert payload["run"]["is_full_inventory"] is False
    assert sorted(entry["case_key"] for entry in payload["inventory"]) == [
        "tests/test_sample.py::test_parametrized",
        "tests/test_sample.py::test_passes",
    ]


@requires_xdist
def test_xdist_collect_error_is_not_a_full_inventory(tmp_path: Path):
    """worker 里的 collect 失败要让 controller 那一份降级为非全量。

    一份因为 import 失败而残缺的 inventory 拿去对账，会把整个包下的用例判成消失（边界 11）。
    xdist 把 worker 的失败 collectreport 转发给 controller，所以这条走的是既有路径——
    但它必须真的被验过一次。
    """
    (tmp_path / "tests").mkdir(exist_ok=True)
    (tmp_path / "tests" / "test_broken.py").write_text(
        "import a_module_that_does_not_exist_xyz\n\n\ndef test_never_runs():\n    pass\n",
        "utf-8",
    )
    result = _run_pytest(tmp_path, "--apitrack-dry-run", "-n", "2", "tests/")
    assert _dry_run_payload(result)["run"]["is_full_inventory"] is False


@requires_xdist
def test_xdist_disabled_distribution_behaves_like_a_single_process(tmp_path: Path):
    """`-n0` 下 xdist 装着但不分发：行为必须与没装它完全一致。

    判据挂在 `dsession` 这个插件在不在，而不是 `-n` 的取值——`-n0` / `--dist no` /
    `--collect-only` 时 xdist 不注册它。按取值判会让 `-n0` 的用户报成一份空 inventory。
    """
    payload = _dry_run_payload(_run_pytest(tmp_path, "--apitrack-dry-run", "-n", "0", "tests/"))
    assert payload["run"]["is_full_inventory"] is True
    assert len(payload["inventory"]) == 5


@requires_xdist
def test_xdist_crashed_worker_drops_the_full_inventory_claim(tmp_path: Path):
    """一个 worker 硬崩（`os._exit`）：controller 收不到它那份，于是不声明全量。

    收不到 = 少一批用例。照那份残缺清单对账会把它们判成消失，而它们只是没报上来。
    """
    (tmp_path / "tests").mkdir(exist_ok=True)
    (tmp_path / "tests" / "test_crash.py").write_text(
        '''
import os

import pytest


@pytest.mark.parametrize("n", list(range(8)))
def test_ok(n):
    """普通用例。"""
    assert True


def test_hard_crash():
    """把自己的进程直接杀掉。"""
    os._exit(9)
''',
        "utf-8",
    )
    result = _run_pytest(
        tmp_path,
        "--apitrack-dry-run",
        "-n", "2",
        # 不让 xdist 重启崩掉的 worker：重启后它会重新交接，那就测不到「丢了一份」。
        "--max-worker-restart", "0",
        "tests/test_crash.py",
    )
    assert _dry_run_payload(result)["run"]["is_full_inventory"] is False


@pytest.mark.skipif(
    __import__("importlib.util", fromlist=["util"]).find_spec("requests") is None,
    reason="requests is not installed in this environment",
)
def test_stream_is_not_consumed(tmp_path: Path):
    """桩绝不读 body：`stream=True` 的响应逐块读出来的内容必须与没装桩时一致。

    起一个本地 HTTP 服务而不是 mock：被吃掉的是**真实的底层流**，用 mock 响应对象验证不到
    这件事。
    """
    (tmp_path / "tests").mkdir(exist_ok=True)
    (tmp_path / "tests" / "test_stream.py").write_text(
        '''
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests

PAYLOAD = b"x" * 5000


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", str(len(PAYLOAD)))
        self.end_headers()
        self.wfile.write(PAYLOAD)

    def log_message(self, *args):
        pass


def test_stream_reads_every_byte():
    """流式响应逐块读完，内容与服务端发出的完全一致。"""
    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/blob"
        response = requests.get(url, stream=True, timeout=5)
        chunks = b"".join(response.iter_content(chunk_size=512))
    finally:
        server.shutdown()
    assert chunks == PAYLOAD
''',
        "utf-8",
    )
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(ROOT) + os.pathsep + environment.get("PYTHONPATH", "")
    environment["APITRACK_URL"] = "http://127.0.0.1:9"
    environment["APITRACK_TOKEN"] = "apitrack_test"
    environment["APITRACK_TIMEOUT"] = "1"
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-p", "no:apitrack", "-p", "apitrack.plugin", "tests/test_stream.py"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        env=environment,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
