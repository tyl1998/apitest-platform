"""运行环境配置：默认指向本机 apitest-server。"""
import os


def _base_url() -> str:
    return os.environ.get("APITEST_BASE_URL", "http://localhost:3000").rstrip("/")


class BASE_CONFIG:
    run_env = os.environ.get("APITEST_ENV", "local")
    base_url = _base_url()
    # 种子管理员（apitest-server/src/lib/auth.ts 的 seedAdmin）。
    # 只在本机开发库存在，环境变量可覆盖。
    email = os.environ.get("APITEST_EMAIL", "admin@local.test")
    password = os.environ.get("APITEST_PASSWORD", "admin123")

    # ── P9-2 站内助手（真实 agent-vendor stg 平台，经 apitest-server 代理转发）───────
    # 前置种子（一次）：source env.local.sh && python3 setup/seed_assistant.py
    # —— agent-vendor provider 行（provider CRUD 落地后的过渡姿势）。未种子时
    # test_case/assistant 整模块 skip。
    # 平台现状（2026-09-11 联调）：agent-vendor 侧 LLM Key 额度不足，消息走 error 终态；
    # 用例断言协议不变量，done / error 两条路都接受，额度修复后自然覆盖流式。
    # 2026-09-14（P9-4 修订）：assistant_enabled 项目闸门作废（助手默认开启），
    # 闸门对照项目配置随之删除。
    assistant_project_name = os.environ.get("APITEST_ASSISTANT_PROJECT", "e2e-assistant")
