"""SDK 单元测试。

只测**不依赖网络与真实 pytest 会话**的那几块：nodeid 拆分、用例元数据映射、脱敏、
collector 的结果合并规则。桩本身的行为（不吃流、不外溢）在集成测试里靠一个真实 pytest
子进程验，见 `test_plugin_session.py`。

`describe()` 曾经是一个盲区：它需要一个 pytest `Item` 才能进，于是在只有纯函数测试的
环境里一次都没被执行过，而它是唯一读 `@case` 元数据的地方——一个包属性遮蔽的 bug 就这样
一路走到了 TestPyPI 校验（见 issue_fix）。所以这里用一个**手搓的假 Item** 覆盖它：
`describe()` 只用到 `nodeid` / `name` / `function` / `iter_markers` 四样，不值得为它
拉起整个 pytest。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from apitrack.case import case  # noqa: E402
from apitrack.collector import CaseEntry, Collector  # noqa: E402
from apitrack.distributed import (  # noqa: E402
    HANDOFF_KEY,
    SEQ_BLOCK,
    hand_off,
    is_controller,
    seq_offset,
    take_slice,
    worker_id,
)
from apitrack.masker import mask_headers, truncate_body  # noqa: E402
from apitrack.patch.common import content_length, path_of  # noqa: E402
from apitrack.plugin import case_key_of, describe, split_nodeid  # noqa: E402
from apitrack.selection import parse_case_keys, resolve_case_keys, select, split  # noqa: E402


class FakeMarker:
    def __init__(self, name: str) -> None:
        self.name = name


class FakeItem:
    """`describe()` 需要的最小 pytest Item 形状。"""

    def __init__(self, nodeid: str, function: object, markers: tuple[str, ...] = ()) -> None:
        self.nodeid = nodeid
        self.name = nodeid.split("::")[-1]
        self.function = function
        self._markers = [FakeMarker(name) for name in markers]

    def iter_markers(self):
        return iter(self._markers)


def test_case_key_drops_parametrize_id():
    """参数化的多个子项共用一个 case_key（边界 7）。"""
    key, param, path = split_nodeid("tests/order/test_create.py::TestCreate::test_create_order[vip]")
    assert key == "tests/order/test_create.py::TestCreate::test_create_order"
    assert param == "vip"
    assert path == "tests/order/test_create.py"


def test_case_key_without_params():
    key, param, path = split_nodeid("tests/test_a.py::test_b")
    assert key == "tests/test_a.py::test_b"
    assert param is None
    assert path == "tests/test_a.py"


def test_case_key_keeps_brackets_inside_param():
    """参数 id 自己带方括号时只剥最外层。"""
    key, param, _ = split_nodeid("tests/test_a.py::test_b[a[0]]")
    assert key == "tests/test_a.py::test_b"
    assert param == "a[0]"


def test_headers_are_masked_by_name_and_fragment():
    masked = mask_headers({
        "Authorization": "Bearer secret-value",
        "X-Api-Token": "abc",
        "Content-Type": "application/json",
        "X-Request-Id": "r-1",
    })
    assert masked["Authorization"] == "<redacted>"
    assert masked["X-Api-Token"] == "<redacted>"
    # 键名保留：「这个请求带了 Authorization 吗」在排查 401 时有用。
    assert set(masked) == {"Authorization", "X-Api-Token", "Content-Type", "X-Request-Id"}
    assert masked["Content-Type"] == "application/json"


def test_body_truncation():
    assert truncate_body(None, 10) is None
    assert truncate_body("abcdefghijk", 5) == "abcde…"
    assert truncate_body(b"\xff\xfe", 10) is not None


def test_path_drops_query():
    """平台侧只要 path_raw；query 含 token 与订单号，路径模板匹配用不上它。"""
    assert path_of("https://api.example.com/orders/12?token=x") == "/orders/12"
    assert path_of("https://api.example.com") == "/"


def test_content_length_never_reads_body():
    class Headers:
        def get(self, name):
            return "42" if name == "content-length" else None

    assert content_length(Headers()) == 42
    assert content_length(None) is None

    class Broken:
        def get(self, name):
            raise RuntimeError("boom")

    # 桩里的任何异常都不能外溢。
    assert content_length(Broken()) is None


def test_failed_wins_over_passed_for_parametrized_case():
    """一个子项失败就是整条用例失败：按「最后一个说了算」会把红的显示成绿的。"""
    collector = Collector(max_records=10)
    collector.register_case(CaseEntry(case_key="k", name="n"))
    collector.set_result("k", "passed")
    collector.set_result("k", "failed")
    collector.set_result("k", "passed")
    inventory, _ = collector.payload_sections()
    assert inventory[0]["result"] == "failed"


def test_registering_same_case_merges_tags_only():
    collector = Collector(max_records=10)
    collector.register_case(CaseEntry(case_key="k", name="first", tags=["smoke"]))
    collector.register_case(CaseEntry(case_key="k", name="second", tags=["slow"]))
    inventory, _ = collector.payload_sections()
    assert inventory[0]["name"] == "first"
    assert sorted(inventory[0]["tags"]) == ["slow", "smoke"]


def test_record_cap_drops_records_but_keeps_inventory():
    """超上限只丢新记录：丢 inventory 会让平台侧拿一份残缺清单去对账。"""
    collector = Collector(max_records=1)
    collector.register_case(CaseEntry(case_key="k", name="n"))
    from apitrack.collector import RecordEntry

    collector.add_record(RecordEntry(case_key="k", phase="call", method="GET", path_raw="/a"))
    collector.add_record(RecordEntry(case_key="k", phase="call", method="GET", path_raw="/b"))
    inventory, records = collector.payload_sections()
    assert len(inventory) == 1
    assert len(records) == 1
    assert any("dropped" in warning for warning in collector.warnings)


def test_record_seq_is_dense_and_zero_based():
    """seq 是重投的幂等键之一（UNIQUE(run, seq)），必须稳定且不重复。"""
    collector = Collector(max_records=10)
    collector.register_case(CaseEntry(case_key="k", name="n"))
    from apitrack.collector import RecordEntry

    for path in ("/a", "/b", "/c"):
        collector.add_record(RecordEntry(case_key="k", phase="call", method="GET", path_raw=path))
    _, records = collector.payload_sections()
    assert [record["seq"] for record in records] == [0, 1, 2]


def test_seq_base_shifts_the_whole_batch():
    """降级路径（每个 worker 各发一份）下 seq 整批平移，批内仍然密集。

    平移量由 `seq_offset` 给，段宽远大于本地记录上限，所以两个 worker 的段不可能交叠——
    交叠就意味着后到的那批被平台按 `UNIQUE (ingest_run_id, seq)` 整批 DO NOTHING 掉。
    """
    collector = Collector(max_records=10)
    collector.register_case(CaseEntry(case_key="k", name="n"))
    from apitrack.collector import RecordEntry

    for path in ("/a", "/b"):
        collector.add_record(RecordEntry(case_key="k", phase="call", method="GET", path_raw=path))
    collector.seq_base = seq_offset("gw3")
    _, records = collector.payload_sections()
    assert [record["seq"] for record in records] == [3 * SEQ_BLOCK, 3 * SEQ_BLOCK + 1]


# ── xdist 交接（见 distributed.py）─────────────────────────────────────────────


class FakeXdistConfig:
    """`worker_id` / `hand_off` 只用到 `workerinput` / `workeroutput` 两个属性。"""

    def __init__(self, *, workerinput=None, workeroutput=None, plugins=()) -> None:  # noqa: ANN001
        if workerinput is not None:
            self.workerinput = workerinput
        if workeroutput is not None:
            self.workeroutput = workeroutput
        self.pluginmanager = FakePluginManager(plugins)


class FakePluginManager:
    def __init__(self, plugins) -> None:  # noqa: ANN001
        self._plugins = set(plugins)

    def hasplugin(self, name: str) -> bool:
        return name in self._plugins


def test_worker_id_reads_workerinput_not_the_environment(monkeypatch):
    """身份只认 `config.workerinput`，**不认** `PYTEST_XDIST_WORKER`。

    环境变量会被**测试自己起的子进程**继承（这个仓库的集成测试就是这么跑的），于是那个
    子进程会把自己当成 worker、尝试交接、失败、然后按降级路径把一次本该正常的单进程上报
    报成非全量。`workerinput` 是进程内独有的，不会被继承。
    """
    monkeypatch.setenv("PYTEST_XDIST_WORKER", "gw2")
    assert worker_id(FakeXdistConfig()) is None
    assert worker_id(FakeXdistConfig(workerinput={"workerid": "gw2"})) == "gw2"
    # 空 workerid（xdist 内部的 "?" 兜底之前）读作「不是 worker」。
    assert worker_id(FakeXdistConfig(workerinput={"workerid": ""})) is None


def test_controller_is_only_the_process_that_distributes():
    """判据是 `dsession` 在不在，而不是 `-n` 的取值。

    `-n0` / `--dist no` / `--collect-only` 下 xdist 装着但不分发，那时这个进程就是普通的
    单进程 pytest，行为必须与没装 xdist 完全一致——xdist 只在真要分发时才注册 `dsession`。
    """
    assert is_controller(FakeXdistConfig(plugins=("dsession",))) is True
    assert is_controller(FakeXdistConfig()) is False
    # worker 进程里也有 dsession 这个名字的可能性要排掉：worker 永远不是 controller。
    assert is_controller(FakeXdistConfig(workerinput={"workerid": "gw0"}, plugins=("dsession",))) is False


def test_seq_offset_gives_each_worker_a_disjoint_block():
    assert seq_offset(None) == 0
    assert seq_offset("gw0") == 0
    assert seq_offset("gw1") == SEQ_BLOCK
    assert seq_offset("gw11") == 11 * SEQ_BLOCK
    # 取不出数字时回 0：宁可与 gw0 撞号（平台侧丢一批），也不要抛异常影响用例。
    assert seq_offset("popen") == 0


def test_hand_off_and_take_slice_round_trip():
    output: dict = {}
    config = FakeXdistConfig(workerinput={"workerid": "gw0"}, workeroutput=output)
    assert hand_off(config, {"cases": [], "records": []}) is True
    # 键名带包名前缀：`workeroutput` 是全仓库共享的，pytest-cov 等插件也往里写。
    assert HANDOFF_KEY in output

    class FakeNode:
        workeroutput = output

    assert take_slice(FakeNode()) == {"cases": [], "records": []}


def test_hand_off_fails_when_there_is_no_channel():
    """老版本 xdist 没有 `workeroutput`：交接失败要让调用方退回自己上报，而不是抛异常。"""
    assert hand_off(FakeXdistConfig(workerinput={"workerid": "gw0"}), {}) is False


def test_take_slice_is_none_for_a_crashed_worker():
    """worker 崩了（errordown）时 `workeroutput` 根本没送到。"""

    class Crashed:
        pass

    assert take_slice(Crashed()) is None

    class Empty:
        workeroutput: dict = {}

    assert take_slice(Empty()) is None


def test_absorb_merges_a_worker_slice_through_the_existing_rules():
    """合并走 register_case / set_result / add_record，不另写一套。

    两个 worker 各跑同一条参数化用例的一个场景时，「一个子项失败就是整条失败」必须仍然
    成立——而那条规则只写在 `set_result` 里。
    """
    from apitrack.collector import RecordEntry

    gw0 = Collector(max_records=10)
    gw0.register_case(CaseEntry(case_key="k", name="用例", tags=["smoke"]))
    gw0.set_result("k", "passed")
    gw0.add_record(RecordEntry(case_key="k", phase="call", method="GET", path_raw="/a", param_id="vip"))

    gw1 = Collector(max_records=10)
    gw1.register_case(CaseEntry(case_key="k", name="用例", tags=["slow"]))
    gw1.set_result("k", "failed")
    gw1.add_record(RecordEntry(case_key="k", phase="call", method="GET", path_raw="/b", param_id="normal"))

    controller = Collector(max_records=10)
    controller.absorb(gw0.export_slice(filters=[]))
    controller.absorb(gw1.export_slice(filters=["deselected"]))

    inventory, records = controller.payload_sections()
    # 一条用例，不是两条；标签取并集；失败优先级最高。
    assert len(inventory) == 1
    assert inventory[0]["result"] == "failed"
    assert sorted(inventory[0]["tags"]) == ["slow", "smoke"]
    # 两个进程的 records 合成一批、统一从 0 密集编号，于是平台侧一条都不会被去重掉。
    assert [record["seq"] for record in records] == [0, 1]
    assert sorted(record["param_id"] for record in records) == ["normal", "vip"]
    # filters 由插件读，collector 只负责原样带过来。
    assert gw1.export_slice(filters=["deselected"])["filters"] == ["deselected"]


def test_absorb_ignores_unknown_results():
    """xdist 的每个 worker 都 collect 全量，没跑到的用例结果是 `unknown`。

    让它进 `set_result` 会让答案取决于 worker 的到达顺序（`unknown` 可以覆盖 `skipped`）。
    跳过它，答案就只由真的跑过它的那个进程给出。
    """
    gw0 = Collector(max_records=10)
    gw0.register_case(CaseEntry(case_key="k", name="n"))
    gw0.set_result("k", "passed")

    gw1 = Collector(max_records=10)
    gw1.register_case(CaseEntry(case_key="k", name="n"))  # 没跑到 → unknown

    controller = Collector(max_records=10)
    controller.absorb(gw1.export_slice())   # 先并「没跑到」的那份
    controller.absorb(gw0.export_slice())
    assert controller.payload_sections()[0][0]["result"] == "passed"

    controller = Collector(max_records=10)
    controller.absorb(gw0.export_slice())   # 反过来的顺序，答案必须一样
    controller.absorb(gw1.export_slice())
    assert controller.payload_sections()[0][0]["result"] == "passed"


def test_absorb_carries_over_the_worker_side_cap():
    """worker 那侧撞了本地上限时，条数必须出现在合并后的 warnings 里。

    不带过来的话「上报的条数比实际发的少」就是一件无痕的事。
    """
    from apitrack.collector import RecordEntry

    gw0 = Collector(max_records=1)
    gw0.register_case(CaseEntry(case_key="k", name="n"))
    gw0.add_record(RecordEntry(case_key="k", phase="call", method="GET", path_raw="/a"))
    gw0.add_record(RecordEntry(case_key="k", phase="call", method="GET", path_raw="/b"))

    controller = Collector(max_records=10)
    controller.absorb(gw0.export_slice())
    controller.payload_sections()
    assert any("dropped" in warning for warning in controller.warnings)


# ── describe()：用例元数据映射（边界 7）─────────────────────────────────────


def _sample_with_docstring():
    """一条普通用例。

    第二行起是描述。
    """


@case("创建订单-VIP", key="order.create.vip", tags=["regression"])
def _sample_decorated():
    """这行 docstring 应该被装饰器的 name 盖掉。"""


def _sample_bare():
    pass


def test_describe_reads_case_metadata_through_a_direct_import():
    """这条测试的真正目标是「`describe()` 能跑通」。

    它曾经抛 `AttributeError: 'function' object has no attribute 'read'`：
    `apitrack/__init__.py` 的 `from .case import case` 把包属性 `case` 从模块重新绑定成了
    装饰器函数，而 `plugin.py` 当时写的是 `from . import case as case_meta`。修法是直接导
    符号（`from .case import read`），不经过包属性。
    """
    entry = describe(FakeItem("tests/test_a.py::test_plain", _sample_with_docstring, ("smoke", "parametrize")))
    assert entry.case_key == "tests/test_a.py::test_plain"
    # 显示名 = docstring 首行，描述 = 其后全部（PEP 257 已有的约定，不让用户学新东西）。
    assert entry.name == "一条普通用例。"
    assert entry.description == "第二行起是描述。"
    assert entry.file_path == "tests/test_a.py"
    # `parametrize` 是 pytest 内置 marker，不该进用例标签。
    assert entry.tags == ["smoke"]


def test_describe_lets_the_decorator_override_key_and_name():
    entry = describe(FakeItem("tests/test_b.py::test_decorated", _sample_decorated, ("smoke",)))
    # key 被覆盖：文件移动或函数改名后仍是同一条用例（边界 8）。
    assert entry.case_key == "order.create.vip"
    assert entry.name == "创建订单-VIP"
    # tags 与 marker 取**并集**而不是替换：marker 是 pytest 自己的事实。
    assert sorted(entry.tags) == ["regression", "smoke"]


def test_describe_falls_back_to_the_function_name():
    """没有 docstring 也没有装饰器时保持函数名原样，不做中文猜测。"""
    entry = describe(FakeItem("tests/test_c.py::test_bare", _sample_bare))
    assert entry.name == "test_bare"
    assert entry.description == ""
    assert entry.tags == []


def test_describe_strips_the_param_suffix_from_the_name_fallback():
    """参数化子项的兜底名不带 ``[param]`` 后缀（2026-08-30 修正）。

    ``item.name`` 在参数化时是 ``test_create_order[vip_user]``，而多个子项共用一个
    case_key、inventory 只登记一次——拿 ``item.name`` 兜底会让 collect 顺序里**第一个**
    参数的后缀污染整条用例的名字（读起来像「这条用例就是 vip 场景」），其余场景的名字
    则消失。兜底名取 case_key 的函数名段；场景维度归 records 的 ``param_id``。
    """
    entry = describe(FakeItem("tests/test_d.py::test_create_order[vip_user]", _sample_bare, ("parametrize",)))
    assert entry.name == "test_create_order"
    # case_key 同样剥掉 [...]（边界 7）：参数化的多个子项是同一条用例。
    assert entry.case_key == "tests/test_d.py::test_create_order"


# ── 勾选执行的 key 选择（P4.5-9，计划 8.3）──────────────────────────────────


def test_case_keys_parse_from_comma_and_newline():
    """两种分隔都收：Runner 注入的是逗号分隔，人手粘贴常常是一行一条。"""
    assert parse_case_keys("a, b\nc,,  ") == frozenset({"a", "b", "c"})
    assert parse_case_keys(["a", " b "]) == frozenset({"a", "b"})


def test_empty_case_keys_read_as_no_selection():
    """空串读作「没有选择」而不是「一条都不跑」。

    一个误设成 `APITRACK_CASE_KEYS=` 的变量（CI 里 secret 没注入到就长这样）不该让整轮
    测试静默跑成零条。
    """
    assert parse_case_keys("") is None
    assert parse_case_keys("  , ,") is None
    assert parse_case_keys(None) is None


class FakeConfig:
    """`resolve_case_keys` 只用到 `getoption`。"""

    def __init__(self, value: str | None) -> None:
        self._value = value

    def getoption(self, name: str, default=None):  # noqa: ANN001, ANN201
        return self._value if name == "apitrack_case_keys" else default


def test_cli_option_beats_environment(monkeypatch):
    monkeypatch.setenv("APITRACK_CASE_KEYS", "from_env")
    assert resolve_case_keys(FakeConfig("from_cli")) == frozenset({"from_cli"})
    assert resolve_case_keys(FakeConfig(None)) == frozenset({"from_env"})


def test_select_beats_both_and_can_be_cleared(monkeypatch):
    """`select()` 是运行时的决定，优先级最高；传 None 撤销，回落到 CLI / env。"""
    monkeypatch.setenv("APITRACK_CASE_KEYS", "from_env")
    try:
        select(["explicit"])
        assert resolve_case_keys(FakeConfig("from_cli")) == frozenset({"explicit"})
        select(None)
        assert resolve_case_keys(FakeConfig("from_cli")) == frozenset({"from_cli"})
    finally:
        # 模块级状态：不还原会污染后面的测试。
        select(None)


def test_split_keeps_every_scenario_of_a_selected_case():
    """勾一条参数化用例 = 跑它的全部场景（case_key 已经剥掉了 [...]）。"""
    items = [
        FakeItem("tests/test_a.py::test_x[vip]", _sample_bare),
        FakeItem("tests/test_a.py::test_x[normal]", _sample_bare),
        FakeItem("tests/test_a.py::test_y", _sample_bare),
    ]
    kept, dropped = split(items, case_key_of, frozenset({"tests/test_a.py::test_x"}))
    assert [item.nodeid for item in kept] == ["tests/test_a.py::test_x[vip]", "tests/test_a.py::test_x[normal]"]
    assert [item.nodeid for item in dropped] == ["tests/test_a.py::test_y"]


def test_split_matches_the_decorator_overridden_key():
    """筛选比的是**有效** key：`@case(key=…)` 覆盖后以覆盖值为准。

    树上存的是覆盖后的 key，所以平台勾选传下来的也是它。这里若按 nodeid 比，带装饰器的
    用例会永远匹配不上——而那类用例恰恰是最可能被显式勾选的（key 稳定才好点）。
    """
    items = [FakeItem("tests/test_b.py::test_decorated", _sample_decorated)]
    kept, dropped = split(items, case_key_of, frozenset({"order.create.vip"}))
    assert len(kept) == 1 and not dropped
    kept, dropped = split(items, case_key_of, frozenset({"tests/test_b.py::test_decorated"}))
    assert not kept and len(dropped) == 1
