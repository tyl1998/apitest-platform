"""auth 模块：登录与 /auth/me。"""
import requests

from data.config import BASE_CONFIG
from data.constant import CODE_INVALID_CREDENTIALS, CODE_SUCCESS
from req.http_req import login


def test_login_success_returns_token_and_user():
    """正确账密登录，返回 JWT 与用户信息。"""
    resp = login(BASE_CONFIG.email, BASE_CONFIG.password)
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == CODE_SUCCESS
    data = body["data"]
    assert data["token"]
    assert data["user"]["email"] == BASE_CONFIG.email
    assert data["user"]["id"]


def test_login_wrong_password_is_rejected():
    """错误密码返回 401 + code 1002，data 为 null。"""
    resp = login(BASE_CONFIG.email, "wrong-password")
    assert resp.status_code == 401
    body = resp.json()
    assert body["code"] == CODE_INVALID_CREDENTIALS
    assert body["data"] is None


def test_login_unknown_email_is_rejected():
    """不存在的邮箱同样 401，不泄露账号是否存在。"""
    resp = login("nobody@local.test", BASE_CONFIG.password)
    assert resp.status_code == 401
    assert resp.json()["code"] == CODE_INVALID_CREDENTIALS


def test_auth_me_requires_token(api_host):
    """无 token 访问 /auth/me 返回 401。"""
    resp = requests.get(f"{api_host}/api/v1/auth/me", timeout=15)
    assert resp.status_code == 401
    assert resp.json()["code"] == CODE_INVALID_CREDENTIALS


def test_auth_me_returns_current_user(api):
    """带 token 的 /auth/me 返回当前登录用户。"""
    resp = api.get("/api/v1/auth/me")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["email"] == BASE_CONFIG.email
    assert data["id"]
