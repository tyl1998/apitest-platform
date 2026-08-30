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
from apitrack.masker import mask_headers, truncate_body  # noqa: E402
from apitrack.patch.common import content_length, path_of  # noqa: E402
from apitrack.plugin import describe, split_nodeid  # noqa: E402


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
