"""头部脱敏（P4-10，计划 7.0 边界 14）。

**脱敏在 SDK 侧就做，不指望平台侧**：数据一旦离开用户机器，平台侧再脱敏已经晚了。

保留键名而丢掉值是刻意的——「这个请求带了 Authorization 吗」在排查 401 时是有用信息，
而它的值不是。
"""

from __future__ import annotations

from typing import Iterable, Mapping

#: 整个值一律丢掉的头。
BLOCKED = {"authorization", "cookie", "set-cookie", "proxy-authorization"}

#: 名字里含这些片段的一律丢掉值。覆盖 `X-Api-Token`、`X-Secret-Key`、`app_password` 等
#: 各家自定义的写法——枚举具体头名是列不完的。
BLOCKED_FRAGMENTS = ("token", "secret", "key", "password", "credential", "signature")

MASK = "<redacted>"


def mask_header_name(name: str) -> bool:
    lowered = name.lower()
    if lowered in BLOCKED:
        return True
    return any(fragment in lowered for fragment in BLOCKED_FRAGMENTS)


def mask_headers(headers: Mapping[str, str] | Iterable[tuple[str, str]] | None) -> dict[str, str]:
    """脱敏后的头字典。键名原样保留，敏感值换成 ``<redacted>``。"""
    if not headers:
        return {}
    items = headers.items() if isinstance(headers, Mapping) else headers
    masked: dict[str, str] = {}
    for name, value in items:
        key = str(name)
        masked[key] = MASK if mask_header_name(key) else str(value)
    return masked


def truncate_body(body: object, limit: int) -> str | None:
    """body 摘要，仅在 ``APITRACK_BODY_CAPTURE`` 打开时调用。

    统一转成字符串再截断：bytes 用 replace 解码（一个二进制上传体不该让上报炸掉），
    对象走 ``str()``——这里要的是「大概是什么」而不是可反序列化的原文。
    """
    if body is None:
        return None
    if isinstance(body, bytes):
        text = body.decode("utf-8", "replace")
    else:
        text = body if isinstance(body, str) else str(body)
    return text[:limit] + ("…" if len(text) > limit else "")
