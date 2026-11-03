"""内存缓冲、inventory 收集与降级（P4-10，计划 7.0 边界 6/10/11）。

这个模块承担一条硬要求：**上报不能影响用例执行**。落地形状是「桩体只往内存 list 追加
一条 dict，全程零网络」，一次上报只发生在 ``pytest_sessionfinish``。

另一条贯穿全文的分工：**存在性看 inventory，归属看 records**。inventory 是「这一轮
collect 到了哪些用例」，records 是「它们打过谁」——平台侧的删除对账只看前者。

pytest-xdist 下每个进程各有一个 Collector，worker 把自己那份（``export_slice``）交回
controller，controller 用 ``absorb`` 合并成一份再上报（见 ``distributed.py``）。合并规则
刻意不新写一套：``absorb`` 走的是 ``register_case`` / ``set_result`` / ``add_record`` 这三个
已有入口，于是「一个子项失败就是整条用例失败」这类判断在单进程与多进程下由同一段代码
决定——两套实现迟早会在某个组合上给出不同答案。
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
        #: records 的 seq 起点。只有 xdist 的**降级**路径会把它设成非 0：那时每个 worker
        #: 各发一份上报，而 seq 是平台侧 ``UNIQUE (ingest_run_id, seq)`` 的幂等键，各进程
        #: 都从 0 编号会让后到的整批被当成重投丢弃（见 ``distributed.py``）。
        self.seq_base = 0

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
                    #
                    # ``seq_base`` 只在 xdist 的降级路径下非 0（见 ``distributed.py``）：
                    # 那时同一次 CI 会有多份上报合并进同一行 run，而 seq 在那一行里必须
                    # 唯一。正常路径（含 controller 合并后的那一份）仍是 0 起的密集序列。
                    "seq": self.seq_base + index,
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

    # ── xdist 交接（见 distributed.py）─────────────────────────────

    def export_slice(self, *, filters: list[str] | None = None) -> dict:
        """worker 侧：这个进程采到的全部东西，一份可经 execnet 序列化的纯数据。

        只用 dict / list / str / int / bool / None——execnet 的序列化不认 dataclass，
        送一个 ``CaseEntry`` 过去会在 ``workeroutput`` 那一跳直接抛 ``DumpError``，而那时
        用例都跑完了，症状是「一次成功的运行末尾多一个看不懂的错误」。

        **records 不带 seq**：编号是 controller 合并完之后才能定的事（各 worker 的批内
        下标必然互相碰撞），这里送原始顺序，由 ``absorb`` 追加进 controller 的 list、
        ``payload_sections`` 统一编号。

        ``filters`` 一并带回：deselect 发生在 worker 自己的 collect 里，controller 身上
        不会触发 ``pytest_deselected``，不带过去的话「这一轮有没有过滤」在 controller 那边
        就答错了——而那个答案直接决定平台侧要不要删用例。
        """
        with self._lock:
            return {
                "cases": [
                    {
                        "case_key": entry.case_key,
                        "name": entry.name,
                        "description": entry.description,
                        "file_path": entry.file_path,
                        "tags": list(entry.tags),
                        "result": entry.result,
                    }
                    for entry in self._cases.values()
                ],
                "records": [
                    {
                        "case_key": record.case_key,
                        "param_id": record.param_id,
                        "phase": record.phase,
                        "method": record.method,
                        "path_raw": record.path_raw,
                        "status_code": record.status_code,
                        "latency_ms": record.latency_ms,
                        "passed": record.passed,
                        "error": record.error,
                        "request_summary": dict(record.request_summary),
                    }
                    for record in self._records
                ],
                "filters": [str(name) for name in (filters or [])],
                "warnings": list(self.warnings),
                "dropped_records": self.dropped_records,
            }

    def absorb(self, slice_: dict) -> None:
        """controller 侧：把一个 worker 交回来的那份并进自己。

        走 ``register_case`` / ``set_result`` / ``add_record`` 三个已有入口，不直接改内部
        结构：合并语义（同 case_key 只留一条、标签取并集、失败优先级最高、超上限只丢
        records）因此在单进程与多进程下由同一段代码决定。自己写一套 merge 的话，「``[vip]``
        在 gw0 失败、``[normal]`` 在 gw1 通过」这类跨进程组合迟早会给出与单进程不同的答案。

        **``unknown`` 不参与结果合并**：一条参数化用例的场景被分到不同 worker 时，没跑到
        它的那个进程仍会把它登记进 inventory（xdist 的每个 worker 都 collect 全量再各跑
        一部分），结果是 ``unknown``。让它进 ``set_result`` 会撞上「skipped 不覆盖已有的
        passed/failed，但 unknown 之后可以被覆盖」那条规则的边界——按 worker 的到达顺序
        决定胜负。跳过它则无论顺序如何，答案都由真的跑过它的那个进程给出。
        """
        for entry in slice_.get("cases") or []:
            case_key = str(entry.get("case_key") or "")
            if not case_key:
                continue
            self.register_case(CaseEntry(
                case_key=case_key,
                name=str(entry.get("name") or ""),
                description=str(entry.get("description") or ""),
                file_path=str(entry.get("file_path") or ""),
                tags=[str(tag) for tag in (entry.get("tags") or [])],
            ))
            result = entry.get("result")
            if result in {"passed", "failed", "skipped"}:
                self.set_result(case_key, result)  # type: ignore[arg-type]
        for entry in slice_.get("records") or []:
            self.add_record(RecordEntry(
                case_key=str(entry.get("case_key") or ""),
                phase=entry.get("phase") or "call",  # type: ignore[arg-type]
                method=str(entry.get("method") or ""),
                path_raw=str(entry.get("path_raw") or ""),
                param_id=entry.get("param_id"),
                status_code=entry.get("status_code"),
                latency_ms=entry.get("latency_ms"),
                passed=entry.get("passed"),
                error=entry.get("error"),
                request_summary=dict(entry.get("request_summary") or {}),
            ))
        for message in slice_.get("warnings") or []:
            self.note(str(message))
        dropped = slice_.get("dropped_records")
        if isinstance(dropped, int) and dropped > 0:
            # worker 自己那一侧撞了本地上限。加到 controller 的计数上，
            # `payload_sections` 会把总数写成一条 warning——不然「上报的条数比实际发的少」
            # 就成了一件无痕的事。
            self.dropped_records += dropped
