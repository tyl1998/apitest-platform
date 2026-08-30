"""SDK 单元测试。

只测**不依赖网络与真实 pytest 会话**的那几块：nodeid 拆分、脱敏、范围推导、collector 的
结果合并规则。桩本身的行为（不吃流、不外溢）在集成测试里靠一个真实 pytest 子进程验，见
`test_plugin_session.py`。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from apitrack.collector import CaseEntry, Collector  # noqa: E402
from apitrack.masker import mask_headers, truncate_body  # noqa: E402
from apitrack.patch.common import content_length, path_of  # noqa: E402
from apitrack.plugin import split_nodeid  # noqa: E402


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
