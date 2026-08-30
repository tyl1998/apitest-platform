"""内存缓冲、inventory 收集与降级（P4-10，计划 7.0 边界 6/10/11）。

这个模块承担一条硬要求：**上报不能影响用例执行**。落地形状是「桩体只往内存 list 追加
一条 dict，全程零网络」，一次上报只发生在 ``pytest_sessionfinish``。

另一条贯穿全文的分工：**存在性看 inventory，归属看 records**。inventory 是「这一轮
collect 到了哪些用例」，records 是「它们打过谁」——平台侧的删除对账只看前者。
"""

from __future__ import annotations

import contextvars
import threading
from dataclasses import dataclass, field
from typing import Literal

Phase = Literal["setup", "call", "teardown"]
CaseResult = Literal["passed", "failed", "skipped", "unknown"]

#: 当前用例与阶段。用 contextvar 而不是模块级全局：``pytest-xdist`` 之外还有用户自己起
#: 线程发请求的情况，contextvar 至少能保证同一协程/线程内取到自己的那一条。
current_case: contextvars.ContextVar[str | None] = contextvars.ContextVar("apitrack_case", default=None)
current_param: contextvars.ContextVar[str | None] = contextvars.ContextVar("apitrack_param", default=None)
current_phase: contextvars.ContextVar[Phase] = contextvars.ContextVar("apitrack_phase", default="call")


@dataclass
class CaseEntry:
    case_key: str
    name: str
    description: str = ""
    file_path: str = ""
    tags: list[str] = field(default_factory=list)
    result: CaseResult = "unknown"


@dataclass
class RecordEntry:
    case_key: str
    phase: Phase
    method: str
    path_raw: str
    param_id: str | None = None
    status_code: int | None = None
    latency_ms: int | None = None
    passed: bool | None = None
    error: str | None = None
    request_summary: dict = field(default_factory=dict)


class Collector:
    """一次 pytest session 的全部采集结果。

    线程安全靠一把最粗的锁：桩体里做的事只有「append 一条 dict」，锁的持有时间是纳秒级，
    而用更精细的结构换来的复杂度会落在一段**跑在用户测试进程里**的代码上。
    """

    def __init__(self, max_records: int) -> None:
        self._lock = threading.Lock()
        self._cases: dict[str, CaseEntry] = {}
        self._records: list[RecordEntry] = []
        self._max_records = max_records
        self.warnings: list[str] = []
        #: 桩自身的失败次数（边界 6）：连续 3 次就自我卸载，用户的测试不该因为上报库有
        #: bug 而变红。
        self.patch_failures = 0
        self.dropped_records = 0

    # ── inventory ──────────────────────────────────────────────────

    def register_case(self, entry: CaseEntry) -> None:
        with self._lock:
            existing = self._cases.get(entry.case_key)
            if existing is None:
                self._cases[entry.case_key] = entry
                return
            # 参数化的多个子项共用一个 case_key（边界 7）：树上是**一条**用例、多个子结果。
            # 所以第二次见到时只合并标签，不覆盖已有的显示名。
            for tag in entry.tags:
                if tag not in existing.tags:
                    existing.tags.append(tag)

    def set_result(self, case_key: str, result: CaseResult) -> None:
        """记一条用例的最终结果。

        失败**优先级最高**：参数化用例里只要有一个子项失败，这条用例就是失败的——按「最后
        一个子项说了算」会让 ``[vip]`` 失败、``[normal]`` 通过的用例在树上显示为绿色。
        skipped 不覆盖已有的 passed/failed（同一条用例的 setup 跳过与 call 通过不可能同时
        发生，但 xfail 之类的组合会）。
        """
        with self._lock:
            entry = self._cases.get(case_key)
            if entry is None:
                return
            if entry.result == "failed":
                return
            if result == "failed" or entry.result in {"unknown", "skipped"}:
                entry.result = result

    # ── records ────────────────────────────────────────────────────

    def add_record(self, record: RecordEntry) -> None:
        with self._lock:
            if len(self._records) >= self._max_records:
                # 超上限只丢新记录、不丢 inventory：用例树还能长出来，只是这一轮的归属
                # 少了一部分。反过来（丢 inventory）会让平台侧的对账拿到一份残缺清单。
                self.dropped_records += 1
                return
            self._records.append(record)

    # ── 输出 ───────────────────────────────────────────────────────

    @property
    def case_count(self) -> int:
        return len(self._cases)

    @property
    def record_count(self) -> int:
        return len(self._records)

    def note(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)

    def payload_sections(self) -> tuple[list[dict], list[dict]]:
        with self._lock:
            inventory = [
                {
                    "case_key": entry.case_key,
                    "name": entry.name,
                    "description": entry.description,
                    "file": entry.file_path,
                    "tags": list(entry.tags),
                    "result": entry.result,
                }
                for entry in self._cases.values()
            ]
            records = [
                {
                    "case_key": record.case_key,
                    "param_id": record.param_id,
                    "phase": record.phase,
                    # seq 由这里给（不是让平台按数组下标补）：分批重投时批次内的幂等键
                    # 必须稳定，而下标会随分批方式变。
                    "seq": index,
                    "method": record.method,
                    "path_raw": record.path_raw,
                    "status_code": record.status_code,
                    "latency_ms": record.latency_ms,
                    "passed": record.passed,
                    "error": record.error,
                    "request_summary": record.request_summary,
                }
                for index, record in enumerate(self._records)
            ]
        if self.dropped_records:
            self.note(f"{self.dropped_records} record(s) dropped after reaching the local cap")
        return inventory, records
