"""auth 模块：参数化的无效登录场景（验证 apitrack 参数化上报）。"""
import logging

import allure
import pytest

from data.config import BASE_CONFIG
from data.constant import CODE_INVALID_CREDENTIALS
from req.http_req import login

log = logging.getLogger("apitest.auth")


@pytest.mark.parametrize(
    ("email", "password"),
    [
        pytest.param(BASE_CONFIG.email, "wrong-password", id="wrong-password"),
        pytest.param("nobody@local.test", BASE_CONFIG.password, id="unknown-email"),
        pytest.param("", BASE_CONFIG.password, id="empty-email"),
        pytest.param(BASE_CONFIG.email, "", id="empty-password"),
    ],
)
def test_login_invalid_credentials_are_rejected(email, password):
    """各类无效账密统一 401 + code 1002，不泄露具体原因。"""
    with allure.step("发起登录请求"):
        resp = login(email, password)
        log.info("login request (email=%r) -> HTTP %s", email, resp.status_code)

    with allure.step("校验 401 与 code 1002"):
        assert resp.status_code == 401
        assert resp.json()["code"] == CODE_INVALID_CREDENTIALS
        log.info("invalid login rejected -> HTTP %s (email=%r)", resp.status_code, email)
