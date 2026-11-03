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
