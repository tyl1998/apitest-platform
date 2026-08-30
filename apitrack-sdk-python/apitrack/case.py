"""可选的显式覆盖装饰器（P4-10，计划 7.0 边界 7）。

默认路径不需要它：``case_key`` 取自 pytest nodeid、名字取自 docstring 首行。这个装饰器
存在的理由只有一个——**让身份与显示名可以分开演进**。

``@case(key=…)`` 的价值在于文件移动或函数改名之后用例仍是同一条（``file_path`` 不参与
``removed`` 判定，边界 8，但 nodeid 里的文件路径参与 ``case_key``）。
"""

from __future__ import annotations

from typing import Callable, Sequence, TypeVar

F = TypeVar("F", bound=Callable[..., object])

#: 挂在函数上的属性名。用一个前缀过的名字而不是 pytest marker：marker 会进 ``tags``
#: （边界 7 的映射表），而这些是元数据不是标签。
ATTRIBUTE = "__apitrack_case__"


def case(name: str | None = None, *, key: str | None = None, tags: Sequence[str] | None = None) -> Callable[[F], F]:
    """标注一条用例的显示名 / 稳定 key / 附加标签。

    三个参数都可选，且都只是**覆盖**：没给的仍走默认推导。``tags`` 与 pytest marker 取
    并集而不是替换——marker 是 pytest 自己的事实，装饰器不该把它盖掉。
    """

    def decorate(function: F) -> F:
        setattr(function, ATTRIBUTE, {"name": name, "key": key, "tags": list(tags or [])})
        return function

    return decorate


def read(function: object) -> dict:
    value = getattr(function, ATTRIBUTE, None)
    return value if isinstance(value, dict) else {}
