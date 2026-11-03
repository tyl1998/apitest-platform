"""pytest 插件（P4-10，计划 7.0 边界 4/7/10/11）。

**零改动接入是硬指标**：装包 + 配两个环境变量 + 原样跑 ``pytest``。为此这个模块靠
``pytest11`` entry point 自动加载——不要 ``conftest.py``、不要 ``-p`` 参数。

它负责三件事：
1. 从 nodeid 推出用例身份（``case_key``）与显示名，两者分开（边界 7）；
2. 用 contextvar 标出「现在跑的是哪条用例、在哪个阶段」，给传输层的桩用（边界 10）；
3. 判断本次跑的**范围**与**这个范围内有没有过滤**（边界 11），并在 sessionfinish 时上报。

**一次 CI 只发一个 ``/ingest``**，pytest-xdist 下也一样：``pytest11`` 会在 controller 与每个
worker 里各加载一次本插件，各自上报的话平台按 ``(repository, commit, ci_run_id)`` 合并进同一
行 run，而 records 的 seq 各自从 0 起，后到的整批被当成重投丢弃。所以 worker 把自己那份交回
controller、由 controller 合并成一份再发（见 ``distributed.py``）。

**取 ``case.py`` 里的符号一律直接导入**（``from .case import read``），不要写
``from . import case``：``apitrack/__init__.py`` 的 ``from .case import case`` 把包属性
``case`` 重新绑定成了那个装饰器函数，于是 ``from . import case`` 拿到的是函数而不是模块。
这条已经炸过一次（``AttributeError: 'function' object has no attribute 'read'``，见
``issue_fix``）。
"""

from __future__ import annotations

import json
import os
import warnings
from datetime import datetime, timezone

# 只为了 `@pytest.hookimpl(optionalhook=True)`（xdist 的 `pytest_testnodedown`）。这个模块
# 本来就只可能在 pytest 进程里被 import——它是 pytest 插件——所以这不引入新的运行期依赖，
# `pytest` 也仍然不在 `dependencies` 里。
import pytest

from .case import read as read_case_override
from .collector import CaseEntry, Collector, current_case, current_param, current_phase
from .config import BODY_LIMIT, load
from .distributed import hand_off, is_controller, seq_offset, take_slice, worker_id
from .patch import install_all, uninstall_all
from .reporter import build_payload, report
from .selection import CASE_KEYS_ENV, resolve_case_keys, split as split_by_keys, warn_no_match

try:  # 包已安装时取真实版本；从源码树直接跑时退到 0.0.0
    from importlib.metadata import version as _version

    VERSION = _version("apitrack-sdk")
except Exception:  # noqa: BLE001
    VERSION = "0.0.0"

#: pytest 自己的内置 marker，不该进用例标签（边界 7 的映射表）。
BUILTIN_MARKERS = {
    "parametrize", "skip", "skipif", "xfail", "usefixtures", "filterwarnings",
    "tryfirst", "trylast", "hookwrapper", "asyncio", "anyio",
}

#: 出现任一个就说明「这个范围内有过滤」（边界 11）。它们是范围内的挑选，不是范围本身。
#:
#: 用 **dest 名**而不是命令行拼写：`getoption` 查的是 dest，而 pytest 的 dest 与拼写常常
#: 对不上——`-x` 的 dest 是 `maxfail`（store_const 1），`--lf` 的是 `lf`，`--ff` 的是
#: `failedfirst`。写错的表现是静默：`getoption` 带 default 时不报错，于是一次 `-x` 或
#: `--lf` 的局部跑会被当成全量报上去，而那正是「跑个 smoke 删掉 90% 的树」那类事故的成因。
#: 拿不准的一律两种都列（`lf` / `last_failed`）——多列一个不存在的 dest 是无害的，漏一个
#: 不是。
FILTER_OPTIONS = (
    "keyword",      # -k
    "markexpr",     # -m
    "maxfail",      # -x / --maxfail（默认 0，给了才为真）
    "lf",           # --lf / --last-failed
    "last_failed",  # 同上，防 pytest 改 dest
    "failedfirst",  # --ff / --failed-first
    "stepwise",     # --sw
    "deselect",     # --deselect
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def split_nodeid(nodeid: str) -> tuple[str, str | None, str]:
    """``nodeid`` → ``(case_key, param_id, file_path)``。

    ``case_key`` 是 nodeid 去掉 ``[...]``（边界 7）：参数化的多个子项属于**同一条**用例，
    树上是一条用例、多个子结果。把 ``[vip]`` 留在 key 里会让参数表一改就长出一批新用例、
    旧的全被判消失。
    """
    param_id = None
    key = nodeid
    if key.endswith("]") and "[" in key:
        head, _, tail = key.partition("[")
        key = head
        param_id = tail[:-1]
    file_path = key.split("::", 1)[0]
    return key, param_id, file_path


def case_key_of(item) -> str:  # noqa: ANN001 - pytest Item
    """一个 item 的有效 ``case_key``（``@case(key=…)`` 覆盖优先）。

    单独抽出来是因为它有**三个**消费者：inventory 登记（``describe``）、执行阶段的
    contextvar（``_enter``）、勾选执行的 deselect（``pytest_collection_modifyitems``）。
    三处各写一遍 override 逻辑的话，一个带 ``@case(key=…)`` 的用例会出现「树上是覆盖后的
    key、筛选却按 nodeid 比」这种只在部分用例上复现的失配。
    """
    key, _, _ = split_nodeid(item.nodeid)
    function = getattr(item, "function", None)
    override = read_case_override(function) if function is not None else {}
    return override.get("key") or key


def describe(item) -> CaseEntry:  # noqa: ANN001 - pytest Item
    """一条用例的 inventory 条目。

    映射规则（边界 7）：显示名取 ``@case("…")`` > docstring 首行 > 函数名**原样**；描述取
    docstring 首行之后全部。首行当名字、余下当描述是 PEP 257 已有的约定，也是 pytest ``-v``
    的习惯——不让用户学新东西。函数名兜底时保持原样，不做中文猜测。

    兜底名取 **case_key 的函数名段**而不是 ``item.name``（2026-08-30 修正）：
    ``item.name`` 在参数化时带着参数后缀（``test_create_order[vip_user]``），而多个子项共用
    一个 ``case_key``、只登记一次——存下来的名字会被 collect 顺序里**第一个**参数的
    后缀污染，读起来像「这条用例就是 vip 场景」，其余场景的名字则消失。函数名段对所有
    子项一致，也正是「一条用例、多个子结果」该有的名字。
    """
    key, _, file_path = split_nodeid(item.nodeid)
    function = getattr(item, "function", None)
    override = read_case_override(function) if function is not None else {}

    doc = (getattr(function, "__doc__", None) or "").strip()
    lines = [line.strip() for line in doc.splitlines()] if doc else []
    doc_name = lines[0] if lines else ""
    description = "\n".join(lines[1:]).strip() if len(lines) > 1 else ""

    tags = [
        marker.name
        for marker in item.iter_markers()
        if marker.name not in BUILTIN_MARKERS
    ]
    for tag in override.get("tags") or []:
        if tag not in tags:
            tags.append(tag)

    return CaseEntry(
        case_key=case_key_of(item),
        name=override.get("name") or doc_name or key.split("::")[-1],
        description=description,
        file_path=file_path,
        tags=tags,
    )


def detect_scope(config) -> list[str]:  # noqa: ANN001 - pytest Config
    """本次跑的范围，相对仓库根（边界 11/19）。

    取自 pytest 自己的参数，零配置：``config.args`` → 退到 ini 的 ``testpaths`` → 都没有
    则仓库根（空数组）。

    范围是必需的，不是特设的：一个仓库常按目录划分系统，该项目的 CI 每次都是
    ``pytest tests/order/``。没有范围概念的话，这类仓库要么永远不对账（用例删了平台永远
    不知道），要么把 ``tests/user/`` 下的用例全判成消失。
    """
    raw = [arg for arg in (config.args or []) if not arg.startswith("-")]
    if not raw:
        raw = list(config.getini("testpaths") or [])
    root = str(config.rootpath)
    scope: list[str] = []
    for entry in raw:
        # 参数里可能带 `::` 选择器（`tests/a.py::test_x`）；范围只到文件为止。
        path = entry.split("::", 1)[0]
        absolute = os.path.abspath(path)
        try:
            relative = os.path.relpath(absolute, root)
        except ValueError:  # 跨盘符（Windows）
            continue
        if relative in {".", ""} or relative.startswith(".."):
            # 参数就是仓库根（或在根之外）：整仓，用空数组表达。
            return []
        normalized = relative.replace(os.sep, "/")
        if normalized not in scope:
            scope.append(normalized)
    return scope


def detect_filters(config) -> list[str]:
    """本次用到的过滤项。非空 = 非全量（边界 11）。"""
    active: list[str] = []
    for name in FILTER_OPTIONS:
        try:
            value = config.getoption(name, default=None)
        except (ValueError, AttributeError):
            continue
        if value:
            active.append(name)
    return active


class ApitrackPlugin:
    def __init__(self, config) -> None:  # noqa: ANN001
        self.pytest_config = config
        self.config = load()
        self.collector = Collector(self.config.max_records)
        self.dry_run = bool(config.getoption("apitrack_dry_run", default=False))
        self.started_at = _now()
        self.installed: list[str] = []
        #: collect 出错就一律非全量（边界 11）：一份因为 import 失败而残缺的 inventory
        #: 拿去对账，会把整个包下的用例判成消失。
        self.collect_error = False
        self.scope = detect_scope(config)
        self.filters = detect_filters(config)
        #: xdist 里这个进程的身份（见 ``distributed.py``）。``None`` = 单进程或 controller。
        self.worker = worker_id(config)
        #: controller 侧：收到 / 丢掉的 worker 交接份数。
        self.slices_taken = 0
        self.slices_lost = 0

    def _note_filter(self, name: str) -> None:
        """记一项过滤，同名只记一次。

        `filters` 只被当成「空 / 非空」用，重复项无害，但它会原样出现在诊断输出里——同一个
        原因列四遍读起来像四个不同的问题。
        """
        if name not in self.filters:
            self.filters.append(name)

    # ── 生命周期 ───────────────────────────────────────────────────

    def install(self) -> None:
        """安装桩。停用状态下**一个桩都不打**（计划 7.4）。"""
        if not self.config.enabled and not self.dry_run:
            return
        self.installed = install_all(
            self.collector,
            capture_body=self.config.capture_body,
            body_limit=BODY_LIMIT,
        )

    # ── collect ────────────────────────────────────────────────────

    def pytest_collection_modifyitems(self, items) -> None:  # noqa: ANN001
        """勾选执行的 deselect（P4.5-9）+ inventory 登记（边界 11）。

        **顺序是先摘后登记**，而不是登记全部再摘：inventory 的语义在这里就是「平台侧
        『本次实际报到的集合』」，而平台算 `not_run` 差集正是拿 `case_filter.case_keys`
        减去它（边界 16）。若把被摘掉的用例也登记进去，它们会带着本次 `ingest_run` 的 id
        落库，差集恒为空——勾了没跑的用例会一直显示上一轮的 `passed`，也就是这一批要修的
        那个问题。

        这样做不会误删任何用例：被摘掉 = 有过滤 = 非全量（`pytest_deselected` 把
        `"deselected"` 记进 `self.filters`），平台侧的删除对账两道闸门都不会开
        （`is_full_inventory=false` → `reconciled=false`）。

        **存在性看 inventory，绝不看 records**：被 skip 的用例、这一轮没打到任何接口的
        用例，records 里是空的；按「没报到就算消失」去删，一次全量跑就会把所有 skip 的
        用例判成消失。
        """
        selected = resolve_case_keys(self.pytest_config)
        if selected is not None:
            kept, dropped = split_by_keys(items, case_key_of, selected)
            if dropped:
                items[:] = kept
                # 走 pytest 自己的钩子而不是静默改 items：终端摘要里的 "N deselected"
                # 与我们自己的 `pytest_deselected`（记非全量）都挂在这一个通知上。
                self.pytest_config.hook.pytest_deselected(items=dropped)
                if not kept:
                    # 一条都没匹配上 = 接入失配（key 来自别的仓库 / 别的 ref / 改过目录）。
                    # 这时**仍然一条都不跑**：回落成全量跑会让平台收到一份「全都报到了」
                    # 的上报，差集为空，于是一次失配被显示成一次成功。
                    # 条件挂在 `dropped` 里面：collect 本来就是零条（空目录 / 全部 import
                    # 失败）时不该怪筛选，那种情况 pytest 自己已经报了。
                    warn_no_match(selected, len(dropped))
        for item in items:
            self.collector.register_case(describe(item))

    def pytest_collectreport(self, report) -> None:  # noqa: ANN001
        if report.failed:
            self.collect_error = True

    def pytest_deselected(self, items) -> None:  # noqa: ANN001
        """``-k`` / ``-m`` 之外还有 ``pytest_collection_modifyitems`` 里 deselect 的插件。

        这一钩子是那些情况的兜底：只要有用例被摘掉，这一轮就不是范围内的全量。
        """
        if items:
            self._note_filter("deselected")

    # ── xdist 交接（见 distributed.py）─────────────────────────────

    @pytest.hookimpl(optionalhook=True)
    def pytest_testnodedown(self, node, error) -> None:  # noqa: ANN001 - xdist WorkerController
        """controller 侧：一个 worker 结束了，把它交回来的那份并进来。

        ``optionalhook=True`` 是必需的，不是保险：这是 xdist 自己加的 hookspec
        （``xdist/newhooks.py``），没装 xdist 的环境里它不存在，而 pytest 在 collect 结束时
        会调 ``pluginmanager.check_pending()`` 把「实现了一个没人声明的钩子」判成
        ``PluginValidationError``——那会让**每一个没装 xdist 的用户**装上这个包后 pytest
        直接起不来。

        取不到那份（worker 崩了、或它走了降级路径自己上报）只记数：那意味着 controller 手上
        的 inventory 不完整，``sessionfinish`` 会据此放弃「全量」的声明。
        """
        slice_ = take_slice(node)
        if slice_ is None:
            self.slices_lost += 1
            return
        self.collector.absorb(slice_)
        # worker 侧的过滤也要并过来：xdist 让每个 worker 自己 collect、自己 deselect，
        # controller 身上永远不会触发 `pytest_deselected`。只认 controller 自己的 CLI 选项的话，
        # 一个只在 worker 里生效的第三方 deselect 插件会让这一轮被报成范围内的全量，平台侧
        # 照它把被摘掉的用例全判成消失。
        for name in slice_.get("filters") or []:
            self._note_filter(str(name))
        self.slices_taken += 1
        # collect 报错不用在这里传：xdist 自己把 worker 的失败 collectreport 转发给
        # controller 的 `pytest_collectreport`（`_failed_worker_collectreport`），
        # `self.collect_error` 已经被那条路径置上了。

    # ── 执行阶段 ───────────────────────────────────────────────────

    def pytest_runtest_setup(self, item) -> None:  # noqa: ANN001
        self._enter(item, "setup")

    def pytest_runtest_call(self, item) -> None:  # noqa: ANN001
        self._enter(item, "call")

    def pytest_runtest_teardown(self, item) -> None:  # noqa: ANN001
        self._enter(item, "teardown")

    def _enter(self, item, phase: str) -> None:  # noqa: ANN001
        _, param_id, _ = split_nodeid(item.nodeid)
        current_case.set(case_key_of(item))
        current_param.set(param_id)
        current_phase.set(phase)  # type: ignore[arg-type]

    def pytest_runtest_logreport(self, report) -> None:  # noqa: ANN001
        """用例结果来自 pytest 自己的 report（协议的 ``inventory[].result``）。

        它**不能**由 records 里的 ``passed`` 推出来：一条断言「404 是预期行为」的用例会有
        一条 4xx 记录却是通过的；一条被 skip 的用例根本没有记录。
        """
        key, _, _ = split_nodeid(report.nodeid)
        if report.when == "call":
            self.collector.set_result(key, "passed" if report.passed else "failed" if report.failed else "skipped")
        elif report.failed:
            # setup / teardown 失败也是这条用例失败——错在 fixture 里，但结果是它没跑成。
            self.collector.set_result(key, "failed")
        elif report.skipped and report.when == "setup":
            self.collector.set_result(key, "skipped")

    # ── 收尾 ───────────────────────────────────────────────────────

    def pytest_sessionfinish(self, session, exitstatus) -> None:  # noqa: ANN001
        """唯一的上报点（边界 6）。

        ``-x`` 中断、CI 超时、OOM 会让这个钩子不执行，那一次运行就**整份不上报**——这是
        有意的（边界 12）：宁可界面上「昨晚那次没有记录」，也不要半份数据被当成全量去
        对账。落盘补投是二期。

        xdist 下这个钩子在 N+1 个进程里各跑一次，但**只有一个进程会发请求**：worker 把
        自己那份交回 controller 就返回（``hand_off``），controller 在自己的 sessionfinish 里
        已经通过 ``pytest_testnodedown`` 收齐了所有 worker 的数据（controller 的
        ``pytest_runtestloop`` 要等全部节点 down 才退出，所以次序是有保证的）。
        """
        uninstall_all()

        # 停用状态下这里没有任何事可做。提前返回而不是走到最后那个 `if not enabled: return`
        # ——xdist 下再往下走就会为每个 worker 白跑一次 execnet 序列化，把一份没人会读的
        # inventory 送回 controller。本地不配 Token 跑 `-n auto` 正是最常见的情形。
        if not self.config.enabled and not self.dry_run:
            return

        # worker：交给 controller，自己不发。交接不成才退回「自己发一份」，并给 seq 加进程
        # 偏移——那时同一次 CI 会有多份上报落进同一行 run，各自从 0 编号会让后到的整批被
        # 平台按 `UNIQUE (ingest_run_id, seq)` 当成重投丢弃（这次要修的缺陷本体）。
        if self.worker is not None:
            if hand_off(self.pytest_config, self.collector.export_slice(filters=self.filters)):
                return
            self.collector.seq_base = seq_offset(self.worker)
            # 一个 worker 手上只有 inventory 的**全量**（xdist 让每个 worker 都 collect 全部
            # 再各跑一部分）但只有自己那一份 records。它单独报上去时不能声明全量：平台
            # 按 scope 对账时会看到一份「用例都在、但结果多半是 unknown」的清单——那份清单
            # 用来删用例是安全的（用例都在里面），可 `case_total`、通过失败数会被最后到达的
            # 那一份覆盖成只有它自己跑的那些，读起来像「36 条用例只跑了 9 条」。
            self._note_filter("xdist-worker")

        inventory, records = self.collector.payload_sections()

        # controller 一份都没收到（worker 全崩、或它们都走了降级路径自己上报）：这个进程
        # 手上什么都没有——controller 不 collect、不跑用例。**这时一个字都不发**。
        #
        # 发一份空 payload 的代价是实打实的：平台按 `(repository, commit, ci_run_id)` 合并进
        # 同一行 run，而 `case_total` / 通过失败数 / 未归位数是「每次重算」的列，于是这份空的
        # 会把 worker 刚报上去的 33 条计数覆盖成 0（这正是这次要修的第二个症状）。空 payload
        # 换不来任何信息，却能抹掉真数据。
        if is_controller(self.pytest_config) and not self.slices_taken:
            print(
                "[apitrack] nothing to report from the xdist controller "
                f"({self.slices_lost} worker slice(s) missing); the workers reported for themselves"
            )
            return

        # 全量 = 这个范围内没有过滤（边界 11）。宁可少报一次全量（本该删的用例多留一天），
        # 不可多报一次（跑个 smoke 删掉 90% 的树）。
        # `-x` 落在 `maxfail` 上，已由 FILTER_OPTIONS 覆盖：它中断在第三个用例时 inventory
        # 是完整的（collect 已跑完），但用户显然没跑完这个范围。
        is_full = not self.filters and not self.collect_error

        # controller 手上的 inventory 完全来自 worker 的交接，所以「有没有丢」直接决定它能
        # 不能声明全量：丢了一份就意味着少一批用例，照它对账会把那批用例判成消失。
        if self.slices_lost:
            is_full = False
            self.collector.note(
                f"{self.slices_lost} xdist worker(s) did not hand their results back; "
                "this run is reported as a partial inventory"
            )

        payload = build_payload(
            config=self.config,
            scope=self.scope,
            is_full_inventory=is_full,
            inventory=inventory,
            records=records,
            version=VERSION,
            started_at=self.started_at,
            finished_at=_now(),
        )

        if self.dry_run:
            print("[apitrack] dry run, nothing was sent:")
            print(json.dumps(payload, indent=2, ensure_ascii=False))
            return
        if not self.config.enabled:
            return
        if not self.config.git_url or not self.config.commit:
            # 平台侧会回 422，但在这里说清缺什么更有用：CI 上最常见的原因是浅克隆没带
            # remote，或者根本不是一个 git 工作树。
            warnings.warn(
                "apitrack skipped reporting: could not determine the git remote or commit "
                "(set APITRACK_GIT_URL / APITRACK_COMMIT explicitly)",
                RuntimeWarning,
                stacklevel=2,
            )
            return
        report(self.config, payload)


# ── pytest 钩子入口 ───────────────────────────────────────────────


def pytest_addoption(parser) -> None:  # noqa: ANN001
    group = parser.getgroup("apitrack")
    group.addoption(
        "--apitrack-dry-run",
        dest="apitrack_dry_run",
        action="store_true",
        default=False,
        # 「先看一眼再开」是让人敢装一个拦截全部 HTTP 流量的包的前提（计划 7.4）。
        help="Print what apitrack would report instead of sending it.",
    )
    group.addoption(
        "--apitrack-case-keys",
        dest="apitrack_case_keys",
        default=None,
        metavar="KEYS",
        # 勾选执行（计划 8.3）。默认 None（不是空串）才能区分「没给」与「给了个空的」：
        # 后者读作没有选择，不是「一条都不跑」。
        help=(
            "Run only these case keys (comma-separated). Overrides the "
            f"{CASE_KEYS_ENV} environment variable, which the platform's runner sets when "
            "a run is triggered from a selection in the case tree."
        ),
    )


def pytest_configure(config) -> None:  # noqa: ANN001
    plugin = ApitrackPlugin(config)
    plugin.install()
    config.pluginmanager.register(plugin, "apitrack-runtime")


def pytest_unconfigure(config) -> None:  # noqa: ANN001
    """兜底卸载：``sessionfinish`` 没跑到（collect 阶段崩溃）时桩仍留在原处。"""
    uninstall_all()
