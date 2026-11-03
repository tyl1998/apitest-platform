"""共享的桩纪律（P4-10，计划 7.0 边界 5/6）。

**打桩打在传输层，不打门面函数**：打 ``requests.get`` 那一层必然漏掉所有用 ``Session``
或自建 client 的仓库（也就是绝大多数）；打 socket 层则拿不到 URL 与 header 语义，还会
连带采到 SDK 自己的上报请求。

桩体里的纪律（全部有代价，不是洁癖）：

- **绝不读 body**（``.content`` / ``.text`` / ``.json()``）。``stream=True`` 与 httpx 的
  未读流被桩读一次就被吃掉了，那是真正会改变用户测试行为的事。响应大小只从
  ``Content-Length`` 取，取不到记 ``None``。
- **延迟用桩自己的 ``perf_counter`` 差**，不用 ``response.elapsed``——adapter 层还没有它。
- **桩自身的失败不外溢**：整体裹 ``BaseException``，异常只计数；连续失败 3 次自我卸载。
"""

from __future__ import annotations

import warnings
from urllib.parse import urlsplit

from ..collector import Collector, RecordEntry, current_case, current_param, current_phase
from ..masker import mask_headers, truncate_body

#: 连续失败到这个次数就自我卸载（边界 6）。
FAILURE_LIMIT = 3


def path_of(url: str) -> str:
    """从完整 URL 取路径。

    平台侧要的是 ``path_raw``（归一留在平台侧，边界 15），所以 query 一并丢掉：它含
    token、订单号这类东西，而路径模板的匹配用不上它。
    """
    parts = urlsplit(url)
    return parts.path or "/"


def content_length(headers: object) -> int | None:
    """响应大小，只从头里取。

    读 body 才知道大小的那条路是被明确禁掉的（见模块注释）。取不到就是 ``None``——一个
    诚实的空值胜过一个把流吃掉换来的数字。
    """
    try:
        raw = headers.get("content-length") if hasattr(headers, "get") else None  # type: ignore[union-attr]
    except BaseException:  # noqa: BLE001 - 桩里的任何异常都不能外溢
        return None
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def build_record(
    *,
    method: str,
    url: str,
    status_code: int | None,
    elapsed_ms: int,
    request_headers: object,
    response_headers: object,
    error: str | None,
    capture_body: bool,
    request_body: object = None,
    body_limit: int = 2048,
) -> RecordEntry:
    """把一次请求变成一条待上报记录。

    ``passed`` 的判据是 HTTP 层面的：2xx/3xx 算通过，4xx/5xx 算失败，没有响应
    （连接错误）算失败。它**不是用例的结果**——用例结果由 pytest 的 report 给
    （``inventory[].result``），两者混用会让一个「断言 404 是预期行为」的用例被记成失败。
    """
    summary: dict = {"requestHeaders": mask_headers(request_headers)}
    response_size = content_length(response_headers)
    if response_size is not None:
        summary["responseBytes"] = response_size
    if capture_body:
        body = truncate_body(request_body, body_limit)
        if body is not None:
            summary["requestBody"] = body

    passed = None if status_code is None and error is None else (status_code is not None and status_code < 400)
    return RecordEntry(
        case_key=current_case.get() or "",
        phase=current_phase.get(),
        param_id=current_param.get(),
        method=method.upper(),
        path_raw=path_of(url),
        status_code=status_code,
        latency_ms=elapsed_ms,
        passed=passed,
        error=error,
        request_summary=summary,
    )


class PatchGuard:
    """桩体的失败计数与自我卸载。

    ``uninstall`` 由各个桩传进来：卸载动作必须是「把原函数放回去」，而原函数只有安装它的
    那个模块知道。
    """

    def __init__(self, collector: Collector, label: str, uninstall) -> None:
        self._collector = collector
        self._label = label
        self._uninstall = uninstall
        self.active = True

    def failed(self, error: BaseException) -> None:
        if not self.active:
            return
        self._collector.patch_failures += 1
        if self._collector.patch_failures < FAILURE_LIMIT:
            return
        self.active = False
        message = f"apitrack disabled its {self._label} patch after {FAILURE_LIMIT} failures: {error!r}"
        self._collector.note(message)
        warnings.warn(message, RuntimeWarning, stacklevel=2)
        try:
            self._uninstall()
        except BaseException:  # noqa: BLE001 - 卸载失败也不能外溢
            pass
