"""projects 模块：项目查询（列表/详情/标签/设置）为主，创建类用例暂缓。"""
import logging
import uuid

import pytest
import requests

from data.constant import (
    CODE_BAD_REQUEST,
    CODE_INVALID_CREDENTIALS,
    CODE_NOT_FOUND,
    CODE_SUCCESS,
)
from utils.other_utils import unique_project_name

log = logging.getLogger("apitest.projects")


def _create_project_data(api, name=None, description=""):
    """建一个项目并返回 data；失败直接让断言炸。"""
    name = name or unique_project_name()
    resp = api.post("/api/v1/projects", json={"name": name, "description": description})
    assert resp.status_code == 201, resp.text
    data = resp.json()["data"]
    log.info("created project name=%s id=%s", data["name"], data["id"])
    return data


@pytest.mark.skip(reason="创建类用例暂缓，本轮聚焦查询")
def test_create_project_success(api):
    """建项目返回 201，data 含 id/name。"""
    name = unique_project_name()
    data = _create_project_data(api, name=name)
    assert data["name"] == name
    assert uuid.UUID(data["id"])  # id 是合法 UUID


@pytest.mark.skip(reason="创建类用例暂缓，本轮聚焦查询")
def test_create_project_without_name_fails(api):
    """name 为空 / 全空白都被 1001 拒绝。"""
    resp = api.post("/api/v1/projects", json={"name": "   "})
    assert resp.status_code == 400
    assert resp.json()["code"] == CODE_BAD_REQUEST


def test_list_projects_contains_created_one(api):
    """项目列表能查到刚建的项目。"""
    created = _create_project_data(api)
    resp = api.get("/api/v1/projects")
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == CODE_SUCCESS
    ids = [p["id"] for p in body["data"]]
    assert created["id"] in ids


def test_get_project_detail(api):
    """按 id 查详情，字段与创建时一致。"""
    created = _create_project_data(api)
    resp = api.get(f"/api/v1/projects/{created['id']}")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["id"] == created["id"]
    assert data["name"] == created["name"]


def test_get_project_tags_is_empty_for_fresh_project(api):
    """新项目的 tags 接口返回空列表（用例/流程都还没打标签）。"""
    created = _create_project_data(api)
    resp = api.get(f"/api/v1/projects/{created['id']}/tags")
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"] == []
    assert body["meta"]["total"] == 0


def test_get_project_settings_defaults(api):
    """新项目 settings 默认无默认环境、不存明文。"""
    created = _create_project_data(api)
    resp = api.get(f"/api/v1/projects/{created['id']}/settings")
    assert resp.status_code == 200
    data = resp.json()["data"]
    # 无默认环境时字段直接缺省（Fastify 序列化省略 undefined）
    assert data.get("defaultEnvironmentId") is None
    assert data["storePlaintext"] is False


def test_update_project_settings_store_plaintext(api):
    """storePlaintext 可开关。

    只传 defaultEnvironmentId=null 时，服务端对 store_plaintext 走
    COALESCE($3, false)（projects.ts PUT settings 的 SQL），即未提供的
    布尔会被写回 false 而不是保留原值——按现状断言。
    """
    created = _create_project_data(api)
    project_id = created["id"]

    resp = api.put(f"/api/v1/projects/{project_id}/settings", json={"storePlaintext": True})
    assert resp.status_code == 200
    assert resp.json()["data"]["storePlaintext"] is True

    resp = api.put(f"/api/v1/projects/{project_id}/settings", json={"defaultEnvironmentId": None})
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data.get("defaultEnvironmentId") is None
    assert data.get("storePlaintext") is False  # 现状：COALESCE 落回 false


def test_update_project_settings_rejects_foreign_environment(api):
    """defaultEnvironmentId 必须属于本项目：随便塞一个 UUID 返回 400。"""
    created = _create_project_data(api)
    resp = api.put(
        f"/api/v1/projects/{created['id']}/settings",
        json={"defaultEnvironmentId": str(uuid.uuid4())},
    )
    assert resp.status_code == 400
    assert resp.json()["code"] == CODE_BAD_REQUEST


def test_rename_project(api):
    """PATCH 改名生效；空白名被拒。"""
    created = _create_project_data(api)
    new_name = unique_project_name("renamed")
    resp = api.patch(f"/api/v1/projects/{created['id']}", json={"name": new_name})
    assert resp.status_code == 200
    assert resp.json()["data"]["name"] == new_name

    resp = api.patch(f"/api/v1/projects/{created['id']}", json={"name": "   "})
    assert resp.status_code == 400


def test_delete_project(api):
    """删掉之后详情查不到（404）。"""
    created = _create_project_data(api)
    project_id = created["id"]

    resp = api.delete(f"/api/v1/projects/{project_id}")
    assert resp.status_code == 200
    assert resp.json()["data"]["deleted"] is True

    resp = api.get(f"/api/v1/projects/{project_id}")
    assert resp.status_code == 404


def test_list_projects_keyword_filters_by_name(api):
    """keyword 按项目名子串（不区分大小写）过滤。"""
    name = unique_project_name()
    created = _create_project_data(api, name=name)
    resp = api.get("/api/v1/projects", params={"keyword": name})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == CODE_SUCCESS
    assert any(p["id"] == created["id"] for p in body["data"])


def test_list_projects_keyword_matches_description(api):
    """keyword 也能匹配 description 子串。"""
    description = f"desc-{uuid.uuid4().hex[:8]}"
    created = _create_project_data(api, description=description)
    resp = api.get("/api/v1/projects", params={"keyword": description})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == CODE_SUCCESS
    assert any(p["id"] == created["id"] for p in body["data"])


def test_list_projects_keyword_no_match_returns_empty(api):
    """keyword 无命中时列表为空、total 为 0。"""
    resp = api.get("/api/v1/projects", params={"keyword": f"no-such-{uuid.uuid4().hex}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == CODE_SUCCESS
    assert body["data"] == []
    assert body["meta"]["total"] == 0


def test_list_projects_pagination_covers_created(api):
    """分页合计覆盖刚建的三个项目，两页不重叠，total 为命中数。"""
    prefix = f"page-{uuid.uuid4().hex[:8]}"
    created = [_create_project_data(api, name=unique_project_name(prefix)) for _ in range(3)]
    ids = {p["id"] for p in created}

    resp = api.get("/api/v1/projects", params={"keyword": prefix, "pageSize": 2, "page": 1})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == CODE_SUCCESS
    assert body["meta"] == {"page": 1, "pageSize": 2, "total": 3}
    page1 = {p["id"] for p in body["data"]}

    resp = api.get("/api/v1/projects", params={"keyword": prefix, "pageSize": 2, "page": 2})
    body = resp.json()
    assert body["code"] == CODE_SUCCESS
    page2 = {p["id"] for p in body["data"]}
    assert page1 & page2 == set()
    assert ids == page1 | page2


def test_list_projects_page_size_is_clamped(api):
    """pageSize 越界被服务端钳制到 [1, 100]，仍返回 200。"""
    resp = api.get("/api/v1/projects", params={"pageSize": 0})
    assert resp.status_code == 200
    meta = resp.json()["meta"]
    assert meta["pageSize"] == 1
    assert meta["page"] == 1

    resp = api.get("/api/v1/projects", params={"pageSize": 9999})
    assert resp.status_code == 200
    assert resp.json()["meta"]["pageSize"] == 100


def test_list_projects_project_ids_filter(api):
    """projectIds 精确过滤到指定项目。"""
    a = _create_project_data(api)
    b = _create_project_data(api)
    resp = api.get("/api/v1/projects", params={"projectIds": f"{a['id']},{b['id']}"})
    assert resp.status_code == 200
    body = resp.json()
    ids = {p["id"] for p in body["data"]}
    assert ids == {a["id"], b["id"]}


def test_list_projects_project_ids_drops_invalid(api):
    """projectIds 里的非法 UUID 被忽略，不报错。"""
    created = _create_project_data(api)
    resp = api.get("/api/v1/projects", params={"projectIds": f"not-a-uuid,{created['id']}"})
    assert resp.status_code == 200
    body = resp.json()
    ids = {p["id"] for p in body["data"]}
    assert ids == {created["id"]}


def test_get_project_not_found(api):
    """不存在的项目 id 返回 404 + code 2001。"""
    resp = api.get(f"/api/v1/projects/{uuid.uuid4()}")
    assert resp.status_code == 404
    assert resp.json()["code"] == CODE_NOT_FOUND


def test_get_project_tags_scope_suites_is_empty(api):
    """scope=suites 只看套件标签，新项目同样为空。"""
    created = _create_project_data(api)
    resp = api.get(f"/api/v1/projects/{created['id']}/tags", params={"scope": "suites"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"] == []
    assert body["meta"]["total"] == 0


def test_list_projects_requires_token(api_host):
    """无 token 访问项目列表返回 401。"""
    resp = requests.get(f"{api_host}/api/v1/projects", timeout=15)
    assert resp.status_code == 401
    assert resp.json()["code"] == CODE_INVALID_CREDENTIALS
