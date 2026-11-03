"""HTTP 请求封装：apitest-server 全部走 Bearer JWT + JSON 包络。"""
import logging
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from data.config import BASE_CONFIG  # noqa: E402

log = logging.getLogger("apitest.auth")

_CONNECT_TIMEOUT = 10
_READ_TIMEOUT = 30


def _do(method: str, url: str, **kwargs):
    kwargs.setdefault("timeout", (_CONNECT_TIMEOUT, _READ_TIMEOUT))
    return requests.request(method, url, **kwargs)


def login(email: str, password: str):
    """POST /api/v1/auth/login —— 不带 token 的入口。"""
    resp = _do(
        "POST",
        f"{BASE_CONFIG.base_url}/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    try:
        code = resp.json().get("code")
    except ValueError:
        code = None
    log.info("POST /api/v1/auth/login -> %s code=%s", resp.status_code, code)
    return resp


def get(api, path: str):
    """GET 一个需要鉴权的路径。"""
    return api.get(path)
