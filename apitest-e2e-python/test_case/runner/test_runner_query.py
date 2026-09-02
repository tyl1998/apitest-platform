"""runner 模块：Runner 相关**只读**查询接口（/api/v1/system/runner-*）。

只打 GET、不建任何新记录——Runner 协议（/runner/*）全是 POST 写接口，查询侧在
系统管理端点：runner 池聚合、Runner 清单、Runner 注册 Token 列表。
"""
import requests

from data.constant import CODE_INVALID_CREDENTIALS, CODE_SUCCESS


def test_runner_pool_requires_token(api_host):
    """无 token 访问 runner 池返回 401。"""
    resp = requests.get(f"{api_host}/api/v1/system/runner-pool", timeout=15)
    assert resp.status_code == 401
    assert resp.json()["code"] == CODE_INVALID_CREDENTIALS


def test_runner_pool_returns_pool_stats(api):
    """runner 池返回聚合统计：标签列表 + 数字，不泄露机器信息。"""
    resp = api.get("/api/v1/system/runner-pool")
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == CODE_SUCCESS
    data = body["data"]
    assert data["offlineAfterSeconds"] > 0
    assert isinstance(data["labels"], list)
    for entry in data["labels"]:
        assert isinstance(entry["label"], str)
        assert isinstance(entry["online"], int)
        assert isinstance(entry["total"], int)
        assert isinstance(entry["capacity"], int)
        assert isinstance(entry["inflight"], int)
        assert isinstance(entry["queued"], int)
    for field in ("online", "total", "capacity", "inflight", "queued"):
        assert isinstance(data[field], int)


def test_runners_requires_token(api_host):
    """无 token 访问 Runner 清单返回 401。"""
    resp = requests.get(f"{api_host}/api/v1/system/runners", timeout=15)
    assert resp.status_code == 401
    assert resp.json()["code"] == CODE_INVALID_CREDENTIALS


def test_runners_returns_pool(api):
    """Runner 清单（管理员）返回 runners 列表与容量数字。"""
    resp = api.get("/api/v1/system/runners")
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == CODE_SUCCESS
    data = body["data"]
    assert isinstance(data["runners"], list)
    assert data["offlineAfterSeconds"] > 0
    for field in ("capacity", "online", "total"):
        assert isinstance(data[field], int)
    for runner in data["runners"]:
        assert runner["id"]
        assert runner["name"]
        assert isinstance(runner["labels"], list)
        assert isinstance(runner["capacity"], int)


def test_runner_tokens_requires_token(api_host):
    """无 token 访问 Runner token 列表返回 401。"""
    resp = requests.get(f"{api_host}/api/v1/system/runner-tokens", timeout=15)
    assert resp.status_code == 401
    assert resp.json()["code"] == CODE_INVALID_CREDENTIALS


def test_runner_tokens_returns_list(api):
    """Runner token 列表（管理员）返回 data 与 meta.total 一致。"""
    resp = api.get("/api/v1/system/runner-tokens")
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == CODE_SUCCESS
    assert isinstance(body["data"], list)
    assert body["meta"]["total"] == len(body["data"])
    for token in body["data"]:
        assert token["id"]
        assert token["name"]
        assert "tokenPrefix" in token
        assert isinstance(token["labels"], list)
