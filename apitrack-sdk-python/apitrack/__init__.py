"""``apitrack`` 包入口。

导入名是 ``apitrack``，分发名是 ``apitrack-sdk``（计划 7.4）。这里导出 ``@case``、
``select()`` 与版本——插件本身由 ``pytest11`` entry point 加载，用户不需要 import 任何东西。

**下面这行 re-export 会遮蔽同名子模块**：``from .case import case`` 先导入
``apitrack.case``（此时包属性 ``case`` 是那个模块），紧接着把 ``case`` 这个名字重新绑定成
函数。于是包内任何 ``from . import case`` 拿到的都是**函数而不是模块**，调 ``case.read(…)``
会得到 ``AttributeError: 'function' object has no attribute 'read'``。

它已经炸过一次（见 ``issue_fix``：仓库模式 SDK 首轮 TestPyPI 校验）。包内取 ``case.py`` 里
的东西一律 ``from .case import read``——直接导符号，不经过包属性。这里不改名让位（把子模块
叫 ``case_meta`` 之类）是因为 ``@case`` 是用户唯一会写的公开 API，``from apitrack import
case`` 必须成立，而模块名与它同名恰好是最自然的组织。

``select()`` 住在 ``selection.py`` 而不是 ``select.py``，正是为了不再制造第二个这样的陷阱。
"""

from __future__ import annotations

from .case import case
from .selection import select

try:
    from importlib.metadata import version as _version

    __version__ = _version("apitrack-sdk")
except Exception:  # noqa: BLE001 - 从源码树直接跑时包未安装
    __version__ = "0.0.0"

__all__ = ["case", "select", "__version__"]
