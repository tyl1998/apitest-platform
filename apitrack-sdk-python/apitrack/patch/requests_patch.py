"""``requests`` 的传输层桩：``HTTPAdapter.send``（P4-10，计划 7.0 边界 5）。

选 ``HTTPAdapter.send`` 而不是 ``requests.get`` / ``Session.request``：
- ``requests.get`` 那一层漏掉所有用 ``Session`` 或自建 client 的仓库（绝大多数）；
- ``Session.request`` 拿不到重定向链上的每一跳，而「登录接口被调了几次」这类事实就藏在
  那里；
- adapter 是所有路径的必经之处，包括 ``Session.send`` 直接调用。
"""

from __future__ import annotations

import importlib.util
import time

from ..collector import Collector
from .common import PatchGuard, build_record

_original_send = None
_guard: PatchGuard | None = None


def available() -> bool:
    """``requests`` 不在 ``dependencies`` 里（计划 7.4），靠探测决定要不要打这个桩。"""
    return importlib.util.find_spec("requests") is not None


def install(collector: Collector, *, capture_body: bool, body_limit: int) -> bool:
    global _original_send, _guard
    if not available() or _original_send is not None:
        return False

    from requests.adapters import HTTPAdapter

    _original_send = HTTPAdapter.send
    _guard = PatchGuard(collector, "requests", uninstall)

    def send(self, request, **kwargs):  # noqa: ANN001, ANN202 - 必须与被替换的签名一致
        started = time.perf_counter()
        try:
            response = _original_send(self, request, **kwargs)
        except BaseException as error:
            # 请求本身失败（连接错误、超时）也要记一条：一次「服务没起来」的运行在树上
            # 应该看得见，而不是表现为「这个接口这一轮没被调用」。
            _record(
                collector,
                request=request,
                response=None,
                elapsed_ms=int((time.perf_counter() - started) * 1000),
                error=f"{type(error).__name__}: {error}",
                capture_body=capture_body,
                body_limit=body_limit,
            )
            raise
        _record(
            collector,
            request=request,
            response=response,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
            error=None,
            capture_body=capture_body,
            body_limit=body_limit,
        )
        return response

    HTTPAdapter.send = send  # type: ignore[method-assign]
    return True


def _record(collector: Collector, *, request, response, elapsed_ms: int, error: str | None, capture_body: bool, body_limit: int) -> None:
    """采集一条记录。整体裹 ``BaseException``：桩自身的 bug 不能让用户的测试变红。"""
    if _guard is None or not _guard.active:
        return
    try:
        collector.add_record(
            build_record(
                method=request.method or "GET",
                url=request.url or "",
                status_code=getattr(response, "status_code", None),
                elapsed_ms=elapsed_ms,
                request_headers=getattr(request, "headers", None),
                # 绝不读 body：`.content` 会把 stream=True 的响应吃掉（边界 6）。
                response_headers=getattr(response, "headers", None),
                error=error,
                capture_body=capture_body,
                request_body=getattr(request, "body", None) if capture_body else None,
                body_limit=body_limit,
            )
        )
    except BaseException as failure:  # noqa: BLE001
        _guard.failed(failure)


def uninstall() -> None:
    global _original_send, _guard
    if _original_send is None:
        return
    from requests.adapters import HTTPAdapter

    HTTPAdapter.send = _original_send  # type: ignore[method-assign]
    _original_send = None
    _guard = None
