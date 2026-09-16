"""P9-2/P9-4b 联调种子（测试数据）：agent-vendor provider 行（通用协议）+ 种子管理员的
用户 agent。

2026-09-14（P9-4b 修订）：上游通用化——provider 行带 protocol（4 接口 + SSE 映射 +
认证模板）与 user_params（用户要填什么）；凭据从系统行挪到用户级，种子管理员经
PUT /api/v1/assistant/my-agents/:providerId 自配（API 侧加密，不再需要借
lib/crypto.ts 在本地做密文）。

做什么（幂等，可重复跑）：
  1. upsert `assistant_providers` 一行 agent-vendor（protocol + user_params，is_default=true，
     其余默认 provider 一并取消默认，保住「默认唯一」）。
  2. find-or-create e2e 项目（走 API，与 pytest 同一个登录通道）。
  3. 为种子管理员配置用户 agent（agentId 明文参数 + apiKey 密文参数，走 API）。

前置：apitest-server 在跑（迁移 058/059 已应用）；docker compose 的 postgres 起着。

用法：
  source env.local.sh && python3 setup/seed_assistant.py
可覆盖（环境变量）：agent-vendor_BASE_URL / agent-vendor_AGENT_ID / PROJECT_NAME / PROVIDER_NAME /
APITEST_BASE_URL / APITEST_EMAIL / APITEST_PASSWORD / SERVER_DIR
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import requests

E2E_DIR = Path(__file__).resolve().parent.parent
SERVER_DIR = Path(os.environ.get("SERVER_DIR", str(E2E_DIR.parent / "apitest-server")))
BASE_URL = os.environ.get("APITEST_BASE_URL", "http://localhost:3000").rstrip("/")
EMAIL = os.environ.get("APITEST_EMAIL", "admin@local.test")
PASSWORD = os.environ.get("APITEST_PASSWORD", "admin123")

# agent-vendor stg 平台（2026-09-11 联调口径；agentId 是 ak- Key 绑定的智能体——每把 Key
# 绑一个 agent，建会话必须传同一个 id，见第三方接口文档 §鉴权/§2.2）。
# 主机名不入库（内网地址不是仓库资产）：默认串是掩码，**必须**用 agent-vendor_BASE_URL
# 覆盖成真实地址（env.local.sh 里 export 一次即可）；漏了会以一个解析不了的主机
# 直接连接失败，不会静默打到别处。
agent-vendor_BASE_URL = os.environ.get("agent-vendor_BASE_URL", "http://stgstplatform.***.net:8089")
agent-vendor_AGENT_ID = os.environ.get("agent-vendor_AGENT_ID", "26")
agent-vendor_API_KEY = os.environ.get("agent-vendor_API_KEY") or sys.exit(
    "需要 agent-vendor_API_KEY（source env.local.sh 或直接 export；Key 由 agent-vendor 平台管理后台签发）"
)

PROJECT_NAME = os.environ.get("PROJECT_NAME", "e2e-assistant")
PROVIDER_NAME = os.environ.get("PROVIDER_NAME", "agent-vendor-stg")

# agent-vendor 的标准通用协议（与迁移 059 的存量翻译同一份）：管理员在系统管理里手填的就是
# 这份形状——种子只是把它直插进库。
agent-vendor_PROTOCOL = {
    "baseUrl": agent-vendor_BASE_URL,
    "auth": {"header": "Authorization", "value": "Bearer {{user.apiKey}}"},
    "successCode": {"field": "code", "value": "0000"},
    "createConversation": {
        "method": "POST",
        "path": "/api/v1/chat/conversation/add",
        "body": {"agentId": "{{user.agentId}}"},
        "conversationId": "data",
    },
    "chat": {
        "method": "POST",
        "path": "/api/v1/chat/{{conversationId}}",
        "body": {"conversationId": "{{conversationId}}", "message": "{{message}}"},
    },
    "stop": {"method": "POST", "path": "/api/v1/chat/{{conversationId}}/stop"},
    "delete": {"method": "POST", "path": "/api/v1/chat/conversation/{{conversationId}}/delete"},
    "history": {
        "method": "GET",
        "path": "/api/v1/chat/{{conversationId}}/messages",
        "query": {"index": "{{index}}", "limit": "{{limit}}"},
        "messages": "data",
        "fields": {"id": "id", "role": "role", "text": "text", "time": "time"},
    },
    "attachments": True,
    "sse": {
        "eventField": "eventType",
        "token": {"on": "MESSAGE", "text": "data.text"},
        "tool": {"on": "PROCESSING", "name": "data.name", "status": "data.status", "nameFallback": "data.type"},
        "done": {"on": "FINAL_RESULT", "text": "data.outputText", "success": "data.success"},
        "error": {"on": "ERROR", "message": "data.error"},
        "ignore": ["HEART_BEAT"],
    },
}

agent-vendor_USER_PARAMS = [
    {"key": "agentId", "label": "agentId", "secret": False, "required": True},
    {"key": "apiKey", "label": "API Key", "secret": True, "required": True},
    {"key": "mcpToken", "label": "MCP Token", "secret": True, "required": False},
]


def psql(sql: str, **variables: str) -> str:
    """docker compose 里的 psql。SQL 走 stdin 而不是 -c：`:'name'` 这类 psql 变量
    插值只在 stdin/脚本输入时发生，-c 的串会原样发给服务器。值经 -v 传入，
    不做 shell/SQL 拼接。"""
    cmd = [
        "docker", "compose", "-f", str(SERVER_DIR / "compose.yaml"), "exec", "-T",
        "postgres", "psql", "-U", "apitest", "-d", "apitest", "-v", "ON_ERROR_STOP=1",
    ]
    for name, value in variables.items():
        cmd += ["-v", f"{name}={value}"]
    return subprocess.run(cmd, input=sql, capture_output=True, text=True, check=True).stdout


def login_session() -> requests.Session:
    """与 pytest 同一个登录通道（种子管理员的会话）。"""
    session = requests.Session()
    login = session.post(f"{BASE_URL}/api/v1/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    login.raise_for_status()
    token = login.json()["data"]["token"]
    assert token, "login succeeded but no token returned"
    session.headers["Authorization"] = f"Bearer {token}"
    return session


def find_or_create_project(session: requests.Session) -> str:
    """find-or-create e2e 项目（走 API——项目行的 owner/角色语义由服务端事务保证）。"""
    found = session.get(f"{BASE_URL}/api/v1/projects", params={"keyword": PROJECT_NAME}, timeout=15).json()["data"]
    for project in found:
        if project["name"] == PROJECT_NAME:
            return project["id"]
    created = session.post(
        f"{BASE_URL}/api/v1/projects",
        json={"name": PROJECT_NAME, "description": "P9-2 站内助手 e2e（setup/seed_assistant.py 维护）"},
        timeout=15,
    )
    created.raise_for_status()
    return created.json()["data"]["id"]


def main() -> None:
    print(f"[seed] server: {SERVER_DIR}")
    print(f"[seed] agent-vendor:  {agent-vendor_BASE_URL} (agentId={agent-vendor_AGENT_ID})")

    psql(
        """
        INSERT INTO assistant_providers (id, name, protocol, user_params, enabled, is_default)
        VALUES (gen_random_uuid(), :'name', :'protocol'::jsonb, :'params'::jsonb, true, true)
        ON CONFLICT (name) DO UPDATE SET
          protocol = EXCLUDED.protocol, user_params = EXCLUDED.user_params,
          enabled = true, is_default = true, updated_at = now();
        """,
        name=PROVIDER_NAME,
        protocol=json.dumps(agent-vendor_PROTOCOL),
        params=json.dumps(agent-vendor_USER_PARAMS),
    )
    # 默认唯一：别的 provider 一并摘掉默认帽（直插时代保不住唯一约束，脚本里保）。
    psql("UPDATE assistant_providers SET is_default = false, updated_at = now() WHERE is_default AND name <> :'name';", name=PROVIDER_NAME)
    provider_id = psql("SELECT id FROM assistant_providers WHERE name = :'name';", name=PROVIDER_NAME).strip().splitlines()[-1].strip()
    print(f"[seed] provider '{PROVIDER_NAME}' 已 upsert（通用协议 + 用户参数模式，id={provider_id}）")

    session = login_session()
    project_id = find_or_create_project(session)
    print(f"[seed] 项目 '{PROJECT_NAME}' ({project_id}) 就绪（助手默认开启，无项目开关）")

    # 用户级凭据：agentId 明文参数 + apiKey 密文参数（API 侧 AES-GCM 加密落库）。
    agent = session.put(
        f"{BASE_URL}/api/v1/assistant/my-agents/{provider_id}",
        json={"params": {"agentId": agent-vendor_AGENT_ID}, "secrets": {"apiKey": agent-vendor_API_KEY}},
        timeout=15,
    )
    agent.raise_for_status()
    print(f"[seed] 种子管理员 ({EMAIL}) 的用户 agent 已配置（provider={PROVIDER_NAME}）")
    print("[seed] 完成——pytest 可跑 test_case/assistant/")


if __name__ == "__main__":
    main()
