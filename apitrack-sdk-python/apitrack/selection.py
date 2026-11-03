"""按 ``case_key`` 挑选要跑的用例（P4.5-9，计划 8.3）。

平台侧「勾选执行」把选中的 key 以两种形态送到脚本里：环境变量 ``APITRACK_CASE_KEYS``
（Runner 注入，逗号分隔——这是 P4.5-5 已冻结的线上形状）与命令行 ``--apitrack-case-keys``
（人手敲 / 自建 CI 用）。本模块只负责**解析与优先级**，真正的 deselect 在 ``plugin.py``。

**为什么必须由脚本消费**：平台不持有测试代码，它能做的只有传参。脚本忽略这个参数就是
全量跑，平台以 ``not_run`` 差集兜底（边界 16），不会把没跑的用例误报成通过。

模块名刻意叫 ``selection`` 而不是 ``select``：``__init__.py`` 会把 ``select`` 这个名字绑成
下面那个函数，与子模块同名的话包内 ``from . import select`` 会拿到函数——``case.py`` 已经
为这件事炸过一次（见该文件的文件头）。
"""

from __future__ import annotations

import os
import warnings
from typing import Iterable

from .config import PREFIX

#: Runner 注入的形态（P4.5-5 偏差①冻结）：逗号分隔的 case_key 列表。
CASE_KEYS_ENV = f"{PREFIX}CASE_KEYS"

#: ``select()`` 写下的显式选择。``None`` = 没调过（与「调了但传了空集合」不同，后者是
#: 「一条都不跑」这个明确意图）。
_explicit: frozenset[str] | None = None


def parse_case_keys(raw: str | Iterable[str] | None) -> frozenset[str] | None:
    """把逗号 / 换行分隔的原文（或一个可迭代对象）归一成 key 集合。

    换行一并接受是因为人手粘贴时常常一行一条；空串与纯分隔符读作 ``None``（= 没有选择）
    而不是空集合——一个误设成 ``APITRACK_CASE_KEYS=`` 的变量不该让整轮测试一条都不跑。
    """
    if raw is None:
        return None
    if isinstance(raw, str):
        parts = [piece.strip() for piece in raw.replace("\n", ",").split(",")]
    else:
        parts = [str(piece).strip() for piece in raw]
    keys = {piece for piece in parts if piece}
    return frozenset(keys) if keys else None


def select(case_keys: Iterable[str] | str | None) -> None:
    """显式指定这一轮只跑哪些 ``case_key``（在 ``conftest.py`` 里调）。

    用于平台传参之外的场景：脚本自己算出要跑哪些、或者要在 env / CLI 之上再收一刀。
    传 ``None`` 或空集合等于**撤销**显式选择，回落到 CLI / 环境变量。

    优先级 ``select() > --apitrack-case-keys > APITRACK_CASE_KEYS``：越靠近「这一次运行的
    具体意图」的来源越优先——env 是部署环境留下的，CLI 是这条命令带的，而 ``select()`` 是
    代码在运行时做的决定。

    必须在 collect **之前**调用（``conftest.py`` 顶层、或 ``pytest_configure``）：deselect
    发生在 ``pytest_collection_modifyitems``，那之后再改不会有任何效果。
    """
    global _explicit
    _explicit = parse_case_keys(case_keys)


def resolve_case_keys(config) -> frozenset[str] | None:  # noqa: ANN001 - pytest Config
    """本次运行的 key 选择；``None`` = 没有选择（跑 pytest 自己收集到的全部）。"""
    if _explicit is not None:
        return _explicit
    from_cli = parse_case_keys(config.getoption("apitrack_case_keys", default=None))
    if from_cli is not None:
        return from_cli
    return parse_case_keys(os.environ.get(CASE_KEYS_ENV))


def split(items: list, key_of, selected: frozenset[str]) -> tuple[list, list]:
    """``items`` → ``(保留, 摘掉)``，按 ``key_of(item)`` 是否在 ``selected`` 里。

    ``key_of`` 由调用方给（它要与 inventory 用的那个 key 完全一致，包括 ``@case(key=…)``
    的覆盖）。参数化的多个子项天然一起保留或一起摘掉——``case_key`` 已经去掉了
    ``[...]`` 后缀（边界 7），这正是「勾一条用例 = 它的全部场景」该有的语义。
    """
    kept: list = []
    dropped: list = []
    for item in items:
        (kept if key_of(item) in selected else dropped).append(item)
    return kept, dropped


def warn_no_match(selected: frozenset[str], collected: int) -> None:
    """一条 key 都没匹配上时说清缺什么。

    这是最容易发生的接入事故：仓库里的 nodeid 与平台树上的 ``case_key`` 对不上（改过目录、
    从别的分支勾的、或者压根勾的是另一个仓库的用例）。静默跑成「零条用例」会让平台侧收到
    一份空 inventory，用户只看到「这次一条都没跑」而不知道为什么。
    """
    warnings.warn(
        f"apitrack selected 0 of {collected} collected tests: none of the "
        f"{len(selected)} case keys in {CASE_KEYS_ENV} / --apitrack-case-keys matched a "
        "collected test id. Check that the keys come from this repository and this ref.",
        RuntimeWarning,
        stacklevel=2,
    )
