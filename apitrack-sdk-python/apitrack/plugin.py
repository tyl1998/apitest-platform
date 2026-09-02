"""pytest 插件（P4-10，计划 7.0 边界 4/7/10/11）。

**零改动接入是硬指标**：装包 + 配两个环境变量 + 原样跑 ``pytest``。为此这个模块靠
``pytest11`` entry point 自动加载——不要 ``conftest.py``、不要 ``-p`` 参数。

它负责三件事：
1. 从 nodeid 推出用例身份（``case_key``）与显示名，两者分开（边界 7）；
2. 用 contextvar 标出「现在跑的是哪条用例、在哪个阶段」，给传输层的桩用（边界 10）；
3. 判断本次跑的**范围**与**这个范围内有没有过滤**（边界 11），并在 sessionfinish 时上报。

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

from .case import read as read_case_override
from .collector import CaseEntry, Collector, current_case, current_param, current_phase
from .config import BODY_LIMIT, load
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
            self.filters.append("deselected")

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
        """
        uninstall_all()
        inventory, records = self.collector.payload_sections()

        # 全量 = 这个范围内没有过滤（边界 11）。宁可少报一次全量（本该删的用例多留一天），
        # 不可多报一次（跑个 smoke 删掉 90% 的树）。
        # `-x` 落在 `maxfail` 上，已由 FILTER_OPTIONS 覆盖：它中断在第三个用例时 inventory
        # 是完整的（collect 已跑完），但用户显然没跑完这个范围。
        is_full = not self.filters and not self.collect_error

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
