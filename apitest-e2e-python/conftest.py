import logging
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.dirname(__file__))
from data.config import BASE_CONFIG  # noqa: E402
from req.http_req import login  # noqa: E402

log = logging.getLogger("apitest.e2e")


def pytest_addoption(parser):
    """--host 指定被测服务根地址；留空默认 localhost:3000。"""
    parser.addoption(
        "--host",
        action="store",
        default="",
        help="被测 apitest-server 根地址（如 http://127.0.0.1:3000）；留空默认 http://localhost:3000",
    )


def pytest_configure(config):
    """--host 非空时覆盖 base_url，login 及所有请求都打到指定地址。"""
    host = config.getoption("--host")
    if host:
        BASE_CONFIG.base_url = host.rstrip("/")


def pytest_runtest_logstart(nodeid):
    log.info("==> %s", nodeid)


def pytest_runtest_logfinish(nodeid, location):
    log.info("<== %s", nodeid)


@pytest.fixture(scope="session")
def api_host() -> str:
    """被测 apitest-server 的根地址。"""
    return BASE_CONFIG.base_url


@pytest.fixture(scope="session")
def auth_token(api_host) -> str:
    """登录一次拿 JWT，整 session 复用。"""
    resp = login(BASE_CONFIG.email, BASE_CONFIG.password)
    assert resp.status_code == 200, f"login failed: {resp.status_code} {resp.text}"
    body = resp.json()
    assert body["code"] == 0
    token = body["data"]["token"]
    assert token
    return token


@pytest.fixture(scope="session")
def api(api_host, auth_token):
    """带 Authorization 的 requests.Session；每个请求自动打一行日志。"""

    class _Api:
        def __init__(self, host, token):
            self.host = host
            self.session = requests.Session()
            self.session.headers["Authorization"] = f"Bearer {token}"
            self.token = token
            self.log = logging.getLogger("apitest.http")

        def _send(self, method, path, **kwargs):
            resp = self.session.request(method, self.host + path, timeout=15, **kwargs)
            try:
                body = resp.json()
            except ValueError:
                body = None
            if isinstance(body, dict):
                self.log.info("%s %s -> %s code=%s", method, path, resp.status_code, body.get("code"))
            else:
                self.log.info("%s %s -> %s", method, path, resp.status_code)
            if resp.status_code >= 400:
                self.log.debug("response body: %s", resp.text)
            return resp

        def get(self, path, **kwargs):
            return self._send("GET", path, **kwargs)

        def post(self, path, json=None, **kwargs):
            return self._send("POST", path, json=json, **kwargs)

        def put(self, path, json=None, **kwargs):
            return self._send("PUT", path, json=json, **kwargs)

        def patch(self, path, json=None, **kwargs):
            return self._send("PATCH", path, json=json, **kwargs)

        def delete(self, path, **kwargs):
            return self._send("DELETE", path, **kwargs)

    return _Api(api_host, auth_token)
