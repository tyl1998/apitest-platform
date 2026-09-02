"""projects 模块：项目**只读**查询。

约定：本模块运行时不产生任何新记录——需要建项目做前置的用例全部 skip
（理由见各自的 skip reason）。只保留不写库的查询。
"""
import logging
import uuid

import allure
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

# 需要「先建一个项目」才能断言其结果的用例：跑了就会新增记录，本轮一律 skip。
_NEED_FIXTURE = "需要建项目做前置（会新增记录），本轮只跑纯只读查询"


@pytest.mark.skip(reason="创建类用例暂缓")
def test_create_project_success(api):
    """建项目返回 201，data 含 id/name。"""
    name = unique_project_name()
    resp = api.post("/api/v1/projects", json={"name": name})
    assert resp.status_code == 201, resp.text
    data = resp.json()["data"]
    assert data["name"] == name
    assert uuid.UUID(data["id"])


@pytest.mark.skip(reason="创建类用例暂缓")
def test_create_project_without_name_fails(api):
    """name 为空 / 全空白都被 1001 拒绝。"""
    resp = api.post("/api/v1/projects", json={"name": "   "})
    assert resp.status_code == 400
    assert resp.json()["code"] == CODE_BAD_REQUEST


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_list_projects_contains_created_one(api):
    """项目列表能查到刚建的项目。"""
    created = api.post("/api/v1/projects", json={"name": unique_project_name()}).json()["data"]
    resp = api.get("/api/v1/projects")
    ids = [p["id"] for p in resp.json()["data"]]
    assert created["id"] in ids


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_get_project_detail(api):
    """按 id 查详情，字段与创建时一致。"""
    created = api.post("/api/v1/projects", json={"name": unique_project_name()}).json()["data"]
    resp = api.get(f"/api/v1/projects/{created['id']}")
    data = resp.json()["data"]
    assert data["id"] == created["id"]
    assert data["name"] == created["name"]


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_get_project_tags_is_empty_for_fresh_project(api):
    """新项目的 tags 接口返回空列表。"""
    created = api.post("/api/v1/projects", json={"name": unique_project_name()}).json()["data"]
    resp = api.get(f"/api/v1/projects/{created['id']}/tags")
    body = resp.json()
    assert body["data"] == []
    assert body["meta"]["total"] == 0


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_get_project_tags_scope_suites_is_empty(api):
    """scope=suites 只看套件标签，新项目同样为空。"""
    created = api.post("/api/v1/projects", json={"name": unique_project_name()}).json()["data"]
    resp = api.get(f"/api/v1/projects/{created['id']}/tags", params={"scope": "suites"})
    body = resp.json()
    assert body["data"] == []
    assert body["meta"]["total"] == 0


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_get_project_settings_defaults(api):
    """新项目 settings 默认无默认环境、不存明文。"""
    created = api.post("/api/v1/projects", json={"name": unique_project_name()}).json()["data"]
    data = api.get(f"/api/v1/projects/{created['id']}/settings").json()["data"]
    assert data.get("defaultEnvironmentId") is None
    assert data["storePlaintext"] is False


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_update_project_settings_store_plaintext(api):
    """storePlaintext 可开关（现状：COALESCE 会把缺省布尔落回 false）。"""
    created = api.post("/api/v1/projects", json={"name": unique_project_name()}).json()["data"]
    pid = created["id"]
    resp = api.put(f"/api/v1/projects/{pid}/settings", json={"storePlaintext": True})
    assert resp.json()["data"]["storePlaintext"] is True
    resp = api.put(f"/api/v1/projects/{pid}/settings", json={"defaultEnvironmentId": None})
    data = resp.json()["data"]
    assert data.get("defaultEnvironmentId") is None
    assert data.get("storePlaintext") is False


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_update_project_settings_rejects_foreign_environment(api):
    """defaultEnvironmentId 必须属于本项目：随便塞一个 UUID 返回 400。"""
    created = api.post("/api/v1/projects", json={"name": unique_project_name()}).json()["data"]
    resp = api.put(
        f"/api/v1/projects/{created['id']}/settings",
        json={"defaultEnvironmentId": str(uuid.uuid4())},
    )
    assert resp.status_code == 400
    assert resp.json()["code"] == CODE_BAD_REQUEST


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_rename_project(api):
    """PATCH 改名生效；空白名被拒。"""
    created = api.post("/api/v1/projects", json={"name": unique_project_name()}).json()["data"]
    new_name = unique_project_name("renamed")
    resp = api.patch(f"/api/v1/projects/{created['id']}", json={"name": new_name})
    assert resp.json()["data"]["name"] == new_name
    resp = api.patch(f"/api/v1/projects/{created['id']}", json={"name": "   "})
    assert resp.status_code == 400


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_delete_project(api):
    """删掉之后详情查不到（404）。"""
    created = api.post("/api/v1/projects", json={"name": unique_project_name()}).json()["data"]
    pid = created["id"]
    resp = api.delete(f"/api/v1/projects/{pid}")
    assert resp.json()["data"]["deleted"] is True
    resp = api.get(f"/api/v1/projects/{pid}")
    assert resp.status_code == 404


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_list_projects_keyword_filters_by_name(api):
    """keyword 按项目名子串过滤（需建项目做命中样本）。"""
    name = unique_project_name()
    api.post("/api/v1/projects", json={"name": name})
    body = api.get("/api/v1/projects", params={"keyword": name}).json()
    assert any(p["name"] == name for p in body["data"])


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_list_projects_keyword_matches_description(api):
    """keyword 也能匹配 description 子串（需建项目做命中样本）。"""
    description = f"desc-{uuid.uuid4().hex[:8]}"
    api.post("/api/v1/projects", json={"name": unique_project_name(), "description": description})
    body = api.get("/api/v1/projects", params={"keyword": description}).json()
    assert any(p["description"] == description for p in body["data"])


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_list_projects_pagination_covers_created(api):
    """分页合计覆盖刚建的三个项目（需建项目做命中样本）。"""
    prefix = f"page-{uuid.uuid4().hex[:8]}"
    ids = {
        api.post("/api/v1/projects", json={"name": unique_project_name(prefix)}).json()["data"]["id"]
        for _ in range(3)
    }
    page1 = {p["id"] for p in api.get("/api/v1/projects", params={"keyword": prefix, "pageSize": 2, "page": 1}).json()["data"]}
    page2 = {p["id"] for p in api.get("/api/v1/projects", params={"keyword": prefix, "pageSize": 2, "page": 2}).json()["data"]}
    assert ids == page1 | page2


@pytest.mark.skip(reason=_NEED_FIXTURE)
def test_list_projects_project_ids_filter(api):
    """projectIds 精确过滤到指定项目（需建项目做命中样本）。"""
    a = api.post("/api/v1/projects", json={"name": unique_project_name()}).json()["data"]
    b = api.post("/api/v1/projects", json={"name": unique_project_name()}).json()["data"]
    ids = {p["id"] for p in api.get("/api/v1/projects", params={"projectIds": f"{a['id']},{b['id']}"}).json()["data"]}
    assert ids == {a["id"], b["id"]}


@allure.title("项目列表返回包络且 total 与行数一致")
def test_list_projects_returns_envelope(api):
    """项目列表返回 200 + code 0，data 为项目数组，meta.total 与行数一致。"""
    with allure.step("请求项目列表"):
        resp = api.get("/api/v1/projects")
        log.info("GET /api/v1/projects -> HTTP %s", resp.status_code)

    with allure.step("校验响应包络与列表形状"):
        assert resp.status_code == 200
        body = resp.json()
        assert body["code"] == CODE_SUCCESS
        assert isinstance(body["data"], list)
        assert body["meta"]["total"] == len(body["data"])
        for project in body["data"]:
            assert project["id"]
            assert project["name"]
        log.info("projects list total=%d", body["meta"]["total"])


@allure.title("keyword 无命中时列表为空且 total=0")
def test_list_projects_keyword_no_match_returns_empty(api):
    """keyword 无命中时列表为空、total 为 0（纯读，不建样本）。"""
    with allure.step("用不可能命中的 keyword 请求列表"):
        resp = api.get("/api/v1/projects", params={"keyword": f"no-such-{uuid.uuid4().hex}"})
        log.info("GET /api/v1/projects?keyword=no-such-* -> HTTP %s", resp.status_code)

    with allure.step("校验空结果与 total=0"):
        assert resp.status_code == 200
        body = resp.json()
        assert body["code"] == CODE_SUCCESS
        assert body["data"] == []
        assert body["meta"]["total"] == 0
        log.info("keyword no-match -> empty, total=0")


@allure.title("pageSize 越界被钳制到 [1, 100]")
def test_list_projects_page_size_is_clamped(api):
    """pageSize 越界被服务端钳制到 [1, 100]，仍返回 200。"""
    with allure.step("pageSize=0 应钳制为 1"):
        resp = api.get("/api/v1/projects", params={"pageSize": 0})
        assert resp.status_code == 200
        meta = resp.json()["meta"]
        assert meta["pageSize"] == 1
        assert meta["page"] == 1
        log.info("pageSize=0 -> clamped to %s", meta["pageSize"])

    with allure.step("pageSize=9999 应钳制为 100"):
        resp = api.get("/api/v1/projects", params={"pageSize": 9999})
        assert resp.status_code == 200
        assert resp.json()["meta"]["pageSize"] == 100
        log.info("pageSize=9999 -> clamped to 100")


@allure.title("projectIds 非法 UUID 被忽略且结果为空")
def test_list_projects_project_ids_drops_invalid(api):
    """projectIds 里的非法 UUID 被忽略，不报错、不匹配任何项目。"""
    with allure.step("projectIds 只传非法 UUID 请求列表"):
        resp = api.get("/api/v1/projects", params={"projectIds": "not-a-uuid"})
        log.info("GET /api/v1/projects?projectIds=not-a-uuid -> HTTP %s", resp.status_code)

    with allure.step("校验非法 UUID 被丢弃、结果为空"):
        assert resp.status_code == 200
        body = resp.json()
        assert body["code"] == CODE_SUCCESS
        assert body["data"] == []
        assert body["meta"]["total"] == 0
        log.info("projectIds=not-a-uuid -> empty, total=0")


@allure.title("不存在的项目 id 返回 404 / 2001")
def test_get_project_not_found(api):
    """不存在的项目 id 返回 404 + code 2001。"""
    with allure.step("请求一个随机 UUID 的项目详情"):
        resp = api.get(f"/api/v1/projects/{uuid.uuid4()}")
        log.info("GET /api/v1/projects/<random-uuid> -> HTTP %s", resp.status_code)

    with allure.step("校验 404 与 code 2001"):
        assert resp.status_code == 404
        assert resp.json()["code"] == CODE_NOT_FOUND
        log.info("get project random uuid -> 404 code=2001")


@allure.title("无 token 访问项目列表返回 401")
def test_list_projects_requires_token(api_host):
    """无 token 访问项目列表返回 401。"""
    with allure.step("不带 token 请求项目列表"):
        resp = requests.get(f"{api_host}/api/v1/projects", timeout=15)
        log.info("GET /api/v1/projects (no token) -> HTTP %s", resp.status_code)

    with allure.step("校验 401 与 code 1002"):
        assert resp.status_code == 401
        assert resp.json()["code"] == CODE_INVALID_CREDENTIALS
        log.info("projects without token -> HTTP %s (expected 401)", resp.status_code)
