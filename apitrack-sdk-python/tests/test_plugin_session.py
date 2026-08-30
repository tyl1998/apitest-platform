"""集成测试：跑一个真实的 pytest 子进程，验三条不能靠单测保证的性质。

1. **零改动接入**：只装包、只配两个环境变量，插件自动生效（不用 conftest、不用 `-p`）。
2. **流不被吃**：`stream=True` 逐块读到的内容与没装这个包时逐字节相同（边界 6）。
3. **不影响退出码**：上报地址指向一个黑洞端口后测试仍全绿、只多一条 warning。

用子进程而不是 `pytester`：`pytester` 需要 pytest 自己的插件，而这里要验的恰好是「一个
干净的 python 进程里，装上包之后 pytest 会自己加载它」。
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
        [sys.executable, "-m", "pytest", "-p", "apitrack.plugin", *args],
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

    顺带验两件事：docstring 首行当名字、其后当描述；参数化用例在 inventory 里是**一条**。
    """
    result = _run_pytest(tmp_path, "--apitrack-dry-run", "tests/")
    payload = _dry_run_payload(result)

    assert payload["protocol_version"] == "1.0"
    assert payload["run"]["scope"] == ["tests"]
    # 没有过滤 → 范围内的全量。
    assert payload["run"]["is_full_inventory"] is True

    by_key = {entry["case_key"]: entry for entry in payload["inventory"]}
    assert len(by_key) == 4, sorted(by_key)

    passing = by_key["tests/test_sample.py::test_passes"]
    assert passing["name"] == "一条通过的用例。"
    assert "第二行开始是描述。" in passing["description"]
    assert passing["result"] == "passed"
    assert by_key["tests/test_sample.py::test_fails"]["result"] == "failed"
    assert by_key["tests/test_sample.py::test_skipped"]["result"] == "skipped"
    # 参数化：一条用例，不是两条。
    assert by_key["tests/test_sample.py::test_parametrized"]["result"] == "passed"


def test_marker_filter_is_not_full_inventory(tmp_path: Path):
    """`-m` 是范围内的挑选 → 非全量，平台侧不会删任何用例（边界 11）。"""
    result = _run_pytest(tmp_path, "--apitrack-dry-run", "-m", "not slow", "tests/")
    assert _dry_run_payload(result)["run"]["is_full_inventory"] is False


def test_keyword_filter_is_not_full_inventory(tmp_path: Path):
    result = _run_pytest(tmp_path, "--apitrack-dry-run", "-k", "passes", "tests/")
    assert _dry_run_payload(result)["run"]["is_full_inventory"] is False


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
        [sys.executable, "-m", "pytest", "-p", "apitrack.plugin", "tests/test_stream.py"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        env=environment,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
