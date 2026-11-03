"""一次性上报（P4-10，计划 7.0 边界 6/12）。

**上报只发生一次，在 ``pytest_sessionfinish``。** 桩体全程零网络，这里是整个 SDK 唯一
发请求的地方。

两条纪律：
- **不动退出码**：5 秒超时 + 一次重试，失败只 warning。用户的 CI 不该因为平台挂了而红。
- **用标准库 ``urllib``**，不用 ``requests`` / ``httpx``。用它们的话上报请求会被自己的桩
  采到（桩打在传输层，分不清是谁发的），而且会把两个 HTTP 库变成真依赖——那与「不进
  dependencies」直接冲突。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import warnings

from .config import Config

PROTOCOL_VERSION = "1.0"
SDK_NAME = "apitrack-sdk"


def build_payload(
    *,
    config: Config,
    scope: list[str],
    is_full_inventory: bool,
    inventory: list[dict],
    records: list[dict],
    version: str,
    started_at: str | None = None,
    finished_at: str | None = None,
) -> dict:
    """协议 v1.0 的请求体（`REPOSITORY_ARCHITECTURE.md` 3.4 + 计划 7.2 的三处增补）。

    三处增补：``run.scope``（本次范围，边界 11/19）、``records[].phase``（只有 call 阶段
    建立用例关系，边界 10）、``inventory[].result``（用例级结果——records 里的 passed 是
    每个请求的，推不出一条被 skip 的用例）。
    """
    return {
        "protocol_version": PROTOCOL_VERSION,
        "run": {
            "repo": {"git_url": config.git_url},
            "commit_sha": config.commit,
            "branch": config.branch,
            "ci_run_id": config.ci_run_id,
            "ci_run_url": config.ci_run_url,
            "scope": scope,
            "is_full_inventory": is_full_inventory,
            "sdk": {"name": SDK_NAME, "version": version},
            "started_at": started_at,
            "finished_at": finished_at,
        },
        "inventory": inventory,
        "records": records,
    }


def send(config: Config, payload: dict) -> tuple[bool, str]:
    """发一次上报。返回 ``(成功, 说明)``，从不抛异常。

    重试**一次**就停：上报是 CI 收尾时的最后一步，重试到底只会把「平台挂了」变成「CI 卡
    了三十秒才结束」。幂等键在（``repository + commit + ci_run_id``），所以第二次尝试
    如果其实第一次已经写进去了，也只是一次合并。
    """
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        config.ingest_endpoint,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.token}",
        },
    )
    last_error = ""
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=config.timeout) as response:  # noqa: S310 - URL 来自用户自己的配置
                raw = response.read().decode("utf-8", "replace")
            parsed = json.loads(raw) if raw else {}
            data = parsed.get("data") or {}
            summary = (
                f"matched={data.get('matched', '?')} unmatched={data.get('unmatched', '?')} "
                f"unplaced={data.get('unplaced', '?')} reconciled={data.get('reconciled', '?')}"
            )
            return True, summary
        except urllib.error.HTTPError as error:
            # 4xx 不重试：Token 无效、git_url 冲突、协议不认——重试一次得到的是同一个答案。
            detail = error.read().decode("utf-8", "replace")[:500] if error.fp else ""
            last_error = f"HTTP {error.code}: {detail or error.reason}"
            if error.code < 500:
                break
        except BaseException as error:  # noqa: BLE001 - 上报失败绝不外溢
            last_error = f"{type(error).__name__}: {error}"
        if attempt == 0:
            continue
    return False, last_error


def report(config: Config, payload: dict) -> None:
    """发一次上报并把结果写成 warning / 打印。

    成功时只打一行摘要而不是 warning：一次正常的上报不该在 CI 日志里长得像个问题。
    """
    ok, detail = send(config, payload)
    if ok:
        print(f"[apitrack] reported to {config.ingest_endpoint} ({detail})")
        return
    warnings.warn(
        f"apitrack could not report this run to {config.ingest_endpoint} ({detail}); "
        "the test result is unaffected",
        RuntimeWarning,
        stacklevel=2,
    )
