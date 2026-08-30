"""桩的安装入口。两个 HTTP 库靠 ``importlib.util.find_spec`` 探测，探不到就不打那个桩
（计划 7.4：``requests`` / ``httpx`` / ``pytest`` 全部不进 ``dependencies``，声明依赖会在
用户环境里触发一次不必要的版本解析，甚至升级掉他们钉住的版本）。
"""

from __future__ import annotations

from ..collector import Collector
from . import httpx_patch, requests_patch


def install_all(collector: Collector, *, capture_body: bool, body_limit: int) -> list[str]:
    installed: list[str] = []
    if requests_patch.install(collector, capture_body=capture_body, body_limit=body_limit):
        installed.append("requests")
    if httpx_patch.install(collector, capture_body=capture_body, body_limit=body_limit):
        installed.append("httpx")
    return installed


def uninstall_all() -> None:
    requests_patch.uninstall()
    httpx_patch.uninstall()
