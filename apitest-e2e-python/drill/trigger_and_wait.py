#!/usr/bin/env python3
"""
Webhook 触发 + 轮询等待 e2e 脚本。

功能：
1. 向 webhook 地址发送 HMAC-SHA256 签名的触发请求（支持 `_trigger_url` 和环境变量注入）
2. 轮询 REST API 等待执行完成
3. 输出通过/失败/跳过统计

用法：
  python3 trigger_and_wait.py \
    --webhook-url http://localhost:3000/webhooks/xxxx \
    --secret xxxx \
    --api-base http://localhost:3000/api/v1 \
    --project-id <projectId> \
    --target-type suite \
    --body '{"x":"debug","_trigger_url":"https://ci.example.com/job/1"}'

  # 仓库任务
  python3 trigger_and_wait.py \
    --webhook-url http://localhost:3000/webhooks/xxxx \
    --secret xxxx \
    --api-base http://localhost:3000/api/v1 \
    --project-id <projectId> \
    --target-type ci_task \
    --body '{"x":"debug","_trigger_url":"https://ci.example.com/job/2"}'
"""
import argparse
import hashlib
import hmac
import json
import secrets
import sys
import time

import requests


def sign(secret: str, body: bytes) -> dict:
    ts = str(int(time.time()))
    nonce = secrets.token_hex(16)
    sig = hmac.new(
        secret.encode(),
        f"{ts}.{nonce}.".encode() + body,
        hashlib.sha256,
    ).hexdigest()
    return {
        "Content-Type": "application/json",
        "X-Apitest-Timestamp": ts,
        "X-Apitest-Nonce": nonce,
        "X-Apitest-Signature": sig,
    }


def trigger(webhook_url: str, secret: str, body: dict) -> dict:
    body_bytes = json.dumps(body).encode()
    headers = sign(secret, body_bytes)
    resp = requests.post(webhook_url, headers=headers, data=body_bytes, timeout=30)
    print(f"[trigger] POST {webhook_url} -> {resp.status_code}")
    result = resp.json()
    print(f"[trigger] response: {json.dumps(result, ensure_ascii=False)}")
    return result


def poll_status(api_base: str, token: str, project_id: str, target_type: str, run_id: str, interval: int = 5, timeout: int = 300) -> dict:
    """轮询 REST API 等待执行完成。返回最终的 data。"""
    if target_type == "ci_task":
        path = f"/projects/{project_id}/pipeline-runs/{run_id}"
    elif target_type == "suite":
        path = f"/projects/{project_id}/suite-reports/{run_id}"
    else:
        path = f"/projects/{project_id}/execution-index/{run_id}"

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = requests.get(f"{api_base}{path}", headers=headers, timeout=30)
        data = resp.json().get("data", {})
        status = data.get("status", "unknown")
        print(f"[poll] status={status}  elapsed={int(time.time() - (deadline - timeout))}s")
        if status in ("success", "failed", "aborted", "canceled", "error"):
            return data
        time.sleep(interval)
    print("[poll] timeout!")
    return {}


def show_result(data: dict):
    print("\n===== 执行结果 =====")
    print(f"  状态:   {data.get('status', '?')}")
    print(f"  总数:   {data.get('total', 0)}")
    print(f"  通过:   {data.get('successCount', data.get('passedCount', 0))}")
    print(f"  失败:   {data.get('failedCount', 0)}")
    print(f"  跳过:   {data.get('skippedCount', 0)}")
    pass_rate = data.get("passRate")
    if pass_rate is not None:
        print(f"  通过率: {pass_rate}%")
    error = data.get("error")
    if error:
        print(f"  错误:   {error}")


def main():
    parser = argparse.ArgumentParser(description="Webhook 触发 + 轮询等待")
    parser.add_argument("--webhook-url", required=True, help="Webhook 触发地址 (POST /webhooks/{publicId})")
    parser.add_argument("--secret", required=True, help="Webhook HMAC 密钥")
    parser.add_argument("--api-base", required=True, help="REST API 根地址 (如 http://localhost:3000/api/v1)")
    parser.add_argument("--project-id", required=True, help="项目 ID")
    parser.add_argument("--target-type", required=True, choices=["suite", "ci_task", "flow"], help="目标类型")
    parser.add_argument("--body", required=True, help="请求体 JSON（含 _trigger_url 和环境变量）")
    parser.add_argument("--token", default="", help="API 密钥（Bearer token），用于轮询状态")
    parser.add_argument("--interval", type=int, default=5, help="轮询间隔秒数（默认 5）")
    parser.add_argument("--timeout", type=int, default=300, help="轮询超时秒数（默认 300）")

    args = parser.parse_args()
    body = json.loads(args.body)

    # 1. 触发
    result = trigger(args.webhook_url, args.secret, body)
    if result.get("code") != 0:
        print(f"[error] 触发失败: {result.get('message')}")
        sys.exit(1)

    # 2. 提取 run id
    data = result.get("data", {})
    if args.target_type == "ci_task":
        run_id = data.get("pipelineRunId")
    elif args.target_type == "suite":
        run_id = data.get("suiteExecutionId")
    else:
        run_id = data.get("flowExecutionId")

    if not run_id:
        print(f"[error] 未找到 run id: {data}")
        sys.exit(1)

    print(f"[trigger] run_id={run_id}")

    # 3. 轮询
    final = poll_status(args.api_base, args.token, args.project_id, args.target_type, run_id, args.interval, args.timeout)

    # 4. 展示结果
    show_result(final)

    status = final.get("status", "")
    if status != "success":
        sys.exit(1)


if __name__ == "__main__":
    main()
