"""``apitrack`` 包入口。

导入名是 ``apitrack``，分发名是 ``apitrack-sdk``（计划 7.4）。这里只导出 ``@case`` 与版本
——插件本身由 ``pytest11`` entry point 加载，用户不需要 import 任何东西。
"""

from __future__ import annotations

from .case import case

try:
    from importlib.metadata import version as _version

    __version__ = _version("apitrack-sdk")
except Exception:  # noqa: BLE001 - 从源码树直接跑时包未安装
    __version__ = "0.0.0"

__all__ = ["case", "__version__"]
