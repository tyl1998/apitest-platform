"""非 pytest 场景的备用入口（P4-10，计划 7.0 边界 4）。

**pytest 场景下永远不需要它**：插件靠 entry point 自动加载，CI 命令一个字都不改。原交互
文档里的「CI 里跑 `apitest-run` 并上报」已被降级为这个备用入口——留着是因为降级阶梯里确实
有非 pytest 的一档（unittest、自研 runner），而不是因为主路径需要它。

它做的事很窄：读一份 JSON payload 文件并上报，或打印当前探测到的配置。真正的采集在
pytest 插件里，因为「哪条用例正在跑」这个事实只有测试框架知道。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import load
from .reporter import PROTOCOL_VERSION, report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m apitrack", description="apitrack SDK utilities")
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser("doctor", help="Show the detected configuration and exit.")
    doctor.set_defaults(handler=_doctor)

    submit = sub.add_parser("submit", help="Send a prepared payload file to the platform.")
    submit.add_argument("payload", type=Path, help="A JSON file in the protocol v1.0 shape.")
    submit.set_defaults(handler=_submit)

    args = parser.parse_args(argv)
    return int(args.handler(args))


def _doctor(_args: argparse.Namespace) -> int:
    """接入排查的第一步：看平台侧要的四样东西这台机器上探到了没有。

    **Token 只打印它在不在**，不打印值——这条命令的输出会被贴进工单和聊天窗口。
    """
    config = load()
    print(f"protocol_version : {PROTOCOL_VERSION}")
    print(f"enabled          : {config.enabled}")
    print(f"url              : {config.url or '(unset)'}")
    print(f"token            : {'set' if config.token else '(unset)'}")
    print(f"git_url          : {config.git_url or '(not detected)'}")
    print(f"commit           : {config.commit or '(not detected)'}")
    print(f"branch           : {config.branch or '(not detected)'}")
    print(f"ci_run_id        : {config.ci_run_id or '(local run)'}")
    print(f"capture_body     : {config.capture_body}")
    return 0 if config.enabled else 1


def _submit(args: argparse.Namespace) -> int:
    config = load()
    if not config.enabled:
        print("apitrack is disabled: set APITRACK_URL and APITRACK_TOKEN", file=sys.stderr)
        return 1
    try:
        payload = json.loads(args.payload.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"could not read payload: {error}", file=sys.stderr)
        return 1
    report(config, payload)
    return 0


if __name__ == "__main__":  # pragma: no cover - 由 `python -m apitrack` 触发
    raise SystemExit(main())
