"""auth 模块：登录与 /auth/me。"""
import logging

import allure
import requests

from data.config import BASE_CONFIG
from data.constant import CODE_INVALID_CREDENTIALS, CODE_SUCCESS
from req.http_req import login

log = logging.getLogger("apitest.auth")


def test_login_success_returns_token_and_user():
    """正确账密登录，返回 JWT 与用户信息。"""
    with allure.step("发起登录请求"):
        resp = login(BASE_CONFIG.email, BASE_CONFIG.password)
        log.info("login request -> HTTP %s", resp.status_code)

    with allure.step("校验响应包络 code=0"):
        body = resp.json()
        assert body["code"] == CODE_SUCCESS
        log.info("envelope code=%s", body["code"])

    with allure.step("校验返回 token 与用户信息"):
        data = body["data"]
        assert data["token"]
        assert data["user"]["email"] == BASE_CONFIG.email
        assert data["user"]["id"]
        log.info("login ok user=%s id=%s", data["user"]["email"], data["user"]["id"])


def test_login_wrong_password_is_rejected():
    """错误密码返回 401 + code 1002，data 为 null。"""
    with allure.step("用错误密码发起登录"):
        resp = login(BASE_CONFIG.email, "wrong-password")
        log.info("login request -> HTTP %s", resp.status_code)

    with allure.step("校验 401 与 code 1002，data 为 null"):
        body = resp.json()
        assert resp.status_code == 401
        assert body["code"] == CODE_INVALID_CREDENTIALS
        assert body["data"] is None
        log.info("wrong password rejected -> HTTP %s code=%s", resp.status_code, body["code"])


def test_login_unknown_email_is_rejected():
    """不存在的邮箱同样 401，不泄露账号是否存在。"""
    with allure.step("用不存在的邮箱发起登录"):
        resp = login("nobody@local.test", BASE_CONFIG.password)
        log.info("login request -> HTTP %s", resp.status_code)

    with allure.step("校验 401 与 code 1002"):
        assert resp.status_code == 401
        assert resp.json()["code"] == CODE_INVALID_CREDENTIALS
        log.info("unknown email rejected -> HTTP %s", resp.status_code)


def test_auth_me_requires_token(api_host):
    """无 token 访问 /auth/me 返回 401。"""
    with allure.step("不带 token 访问 /auth/me"):
        resp = requests.get(f"{api_host}/api/v1/auth/me", timeout=15)
        log.info("auth/me request -> HTTP %s", resp.status_code)

    with allure.step("校验 401 与 code 1002"):
        assert resp.status_code == 401
        assert resp.json()["code"] == CODE_INVALID_CREDENTIALS
        log.info("auth/me without token -> HTTP %s (expected 401)", resp.status_code)


def test_auth_me_returns_current_user(api):
    """带 token 的 /auth/me 返回当前登录用户。"""
    with allure.step("带 token 访问 /auth/me"):
        resp = api.get("/api/v1/auth/me")
        log.info("auth/me request -> HTTP %s", resp.status_code)

    with allure.step("校验返回当前用户"):
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["email"] == BASE_CONFIG.email
        assert data["id"]
        log.info("auth/me user=%s id=%s", data["email"], data["id"])
