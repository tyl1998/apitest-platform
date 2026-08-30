"""``httpx`` 的传输层桩：``HTTPTransport.handle_request`` 与它的 async 版
（P4-10，计划 7.0 边界 5）。

同步与异步两个都要打：一个用 ``AsyncClient`` 的仓库只打同步版等于完全没打，而那类仓库
恰好是最不会主动改代码来配合平台的一类。

``aiohttp`` 首版不做（边界 5）：它没有干净的 transport 层，拦截点脏。
"""

from __future__ import annotations

import importlib.util
import time

from ..collector import Collector
from .common import PatchGuard, build_record

_original_sync = None
_original_async = None
_guard: PatchGuard | None = None


def available() -> bool:
    return importlib.util.find_spec("httpx") is not None


def install(collector: Collector, *, capture_body: bool, body_limit: int) -> bool:
    global _original_sync, _original_async, _guard
    if not available() or _original_sync is not None:
        return False

    import httpx

    _original_sync = httpx.HTTPTransport.handle_request
    _original_async = httpx.AsyncHTTPTransport.handle_async_request
    _guard = PatchGuard(collector, "httpx", uninstall)

    def handle_request(self, request):  # noqa: ANN001, ANN202
        started = time.perf_counter()
        try:
            response = _original_sync(self, request)
        except BaseException as error:
            _record(collector, request, None, int((time.perf_counter() - started) * 1000), f"{type(error).__name__}: {error}", capture_body, body_limit)
            raise
        _record(collector, request, response, int((time.perf_counter() - started) * 1000), None, capture_body, body_limit)
        return response

    async def handle_async_request(self, request):  # noqa: ANN001, ANN202
        started = time.perf_counter()
        try:
            response = await _original_async(self, request)
        except BaseException as error:
            _record(collector, request, None, int((time.perf_counter() - started) * 1000), f"{type(error).__name__}: {error}", capture_body, body_limit)
            raise
        _record(collector, request, response, int((time.perf_counter() - started) * 1000), None, capture_body, body_limit)
        return response

    httpx.HTTPTransport.handle_request = handle_request  # type: ignore[method-assign]
    httpx.AsyncHTTPTransport.handle_async_request = handle_async_request  # type: ignore[method-assign]
    return True


def _record(collector: Collector, request, response, elapsed_ms: int, error: str | None, capture_body: bool, body_limit: int) -> None:
    if _guard is None or not _guard.active:
        return
    try:
        collector.add_record(
            build_record(
                method=str(getattr(request, "method", "GET")),
                url=str(getattr(request, "url", "")),
                status_code=getattr(response, "status_code", None),
                elapsed_ms=elapsed_ms,
                request_headers=getattr(request, "headers", None),
                response_headers=getattr(response, "headers", None),
                error=error,
                capture_body=capture_body,
                # httpx 的请求体在 transport 层可能还是未消费的流；只在开了 body 捕获且
                # 它已经是 bytes 时才取，绝不去 read() 它（边界 6）。
                request_body=getattr(request, "_content", None) if capture_body else None,
                body_limit=body_limit,
            )
        )
    except BaseException as failure:  # noqa: BLE001
        _guard.failed(failure)


def uninstall() -> None:
    global _original_sync, _original_async, _guard
    if _original_sync is None:
        return
    import httpx

    httpx.HTTPTransport.handle_request = _original_sync  # type: ignore[method-assign]
    if _original_async is not None:
        httpx.AsyncHTTPTransport.handle_async_request = _original_async  # type: ignore[method-assign]
    _original_sync = None
    _original_async = None
    _guard = None
