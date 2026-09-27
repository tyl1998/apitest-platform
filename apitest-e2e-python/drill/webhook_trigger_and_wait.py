#!/usr/bin/env python3
"""
Webhook 触发 + 状态查询 e2e 脚本（全 HMAC-SHA256 签名，不需要 API key / JWT）。

功能：
1. 通过 webhook 触发套件执行 / 仓库任务（支持变量注入和 _trigger_url）
2. 通过 webhook 状态查询端点轮询等待执行完成
3. 输出通过/失败/跳过统计

用法：
  # 触发套件
  python3 webhook_trigger_and_wait.py \
    --webhook-url http://localhost:3000/webhooks/xxxx \
    --secret xxxx \
    --target-type suite \
    --body '{"x":"debug","_trigger_url":"https://ci.example.com/job/1"}'

  # 触发仓库任务
  python3 webhook_trigger_and_wait.py \
    --webhook-url http://localhost:3000/webhooks/xxxx \
    --secret xxxx \
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


def sign(secret: str, body_str: str) -> dict:
    ts = str(int(time.time()))
    nonce = secrets.token_hex(16)
    sig = hmac.new(
        secret.encode(),
        f"{ts}.{nonce}.{body_str}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-Apitest-Timestamp": ts,
        "X-Apitest-Nonce": nonce,
        "X-Apitest-Signature": sig,
    }


def trigger(webhook_url: str, secret: str, body: dict) -> dict:
    body_str = json.dumps(body)
    headers = { **sign(secret, body_str), "Content-Type": "application/json" }
    resp = requests.post(webhook_url, headers=headers, data=body_str.encode(), timeout=30)
    print(f"[trigger] POST {webhook_url}")
    print(f"[trigger] body: {body_str}")
    print(f"[trigger] -> {resp.status_code}")
    result = resp.json()
    print(f"[trigger] response: {json.dumps(result, ensure_ascii=False)}")
    return result


def poll_status(webhook_url: str, secret: str, run_id: str, interval: int = 5, timeout: int = 300) -> dict:
    """GET /webhooks/{publicId}/runs/{runId} —— 签名原文 = timestamp.nonce.（空 body）。"""
    status_url = f"{webhook_url}/runs/{run_id}"
    start = time.time()
    deadline = start + timeout
    while time.time() < deadline:
        headers = sign(secret, "")
        resp = requests.get(status_url, headers=headers, timeout=30)
        data = resp.json().get("data", {})
        status = data.get("status", "unknown")
        elapsed = int(time.time() - start)
        print(f"[poll] {elapsed}s status={status}  pass={data.get('successCount', 0)}  fail={data.get('failedCount', 0)}")
        if status in ("success", "failed", "aborted", "canceled", "error"):
            return data
        time.sleep(interval)
    print("[poll] timeout!")
    return {}


def show_result(target_type: str, data: dict):
    print("\n===== 执行结果 =====")
    print(f"  状态:   {data.get('status', '?')}")
    if target_type == "ci_task":
        print(f"  运行号: #{data.get('runNumber', '?')}")
    print(f"  总数:   {data.get('total', 0)}")
    print(f"  通过:   {data.get('successCount', 0)}")
    print(f"  失败:   {data.get('failedCount', 0)}")
    print(f"  跳过:   {data.get('skippedCount', 0)}")
    error = data.get("error")
    if error:
        print(f"  错误:   {error}")


def main():
    parser = argparse.ArgumentParser(description="Webhook 触发 + 状态查询（全 HMAC-SHA256）")
    parser.add_argument("--webhook-url", required=True, help="Webhook 触发地址 (POST /webhooks/{publicId})")
    parser.add_argument("--secret", required=True, help="Webhook HMAC 密钥")
    parser.add_argument("--target-type", required=True, choices=["suite", "ci_task", "flow"], help="目标类型")
    parser.add_argument("--body", default="{}", help="请求体 JSON（含 _trigger_url 和环境变量）")
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
    final = poll_status(args.webhook_url, args.secret, run_id, args.interval, args.timeout)

    # 4. 展示结果
    show_result(args.target_type, final)

    status = final.get("status", "")
    if status != "success":
        sys.exit(1)


if __name__ == "__main__":
    main()
