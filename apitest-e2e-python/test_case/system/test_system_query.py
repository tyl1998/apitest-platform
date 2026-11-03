"""system 模块：系统级**只读**查询接口。

只打 GET、不建任何新记录、不产生副作用。覆盖 `/api/v1/system/limits` 与
`/api/v1/system/runner-labels`。
"""
import logging

import allure
import requests

from data.constant import CODE_INVALID_CREDENTIALS, CODE_SUCCESS

log = logging.getLogger("apitest.system")


@allure.title("系统执行预算 limits 可读且有保护性上限")
def test_system_limits_returns_budget(api):
    """/system/limits 只需登录即可读，返回执行预算与保护性上限。"""
    with allure.step("请求系统 limits"):
        resp = api.get("/api/v1/system/limits")
        log.info("GET /api/v1/system/limits -> HTTP %s", resp.status_code)

    with allure.step("校验包络与正整数预算字段"):
        assert resp.status_code == 200
        body = resp.json()
        assert body["code"] == CODE_SUCCESS
        data = body["data"]
        for field in (
            "flowParallelism", "suiteLeafBudget", "suiteMaxConcurrency",
            "maxLoopIterations", "maxLoopConcurrency", "maxWaitMs", "suiteMaxMembers",
        ):
            assert isinstance(data[field], int)
            assert data[field] > 0, f"{field} 应为正整数"
        log.info("limits ok flowParallelism=%d suiteLeafBudget=%d", data["flowParallelism"], data["suiteLeafBudget"])


@allure.title("无 token 访问系统 limits 返回 401")
def test_system_limits_requires_token(api_host):
    """/system/limits 无 token 返回 401。"""
    with allure.step("不带 token 请求 limits"):
        resp = requests.get(f"{api_host}/api/v1/system/limits", timeout=15)
        log.info("limits (no token) -> HTTP %s", resp.status_code)

    with allure.step("校验 401 与 code 1002"):
        assert resp.status_code == 401
        assert resp.json()["code"] == CODE_INVALID_CREDENTIALS
        log.info("limits without token -> HTTP %s (expected 401)", resp.status_code)


@allure.title("执行分区标签目录 runner-labels 可读")
def test_runner_labels_returns_labels(api):
    """/system/runner-labels 只需登录即可读，返回标签与在线台数。"""
    with allure.step("请求 runner-labels 分区标签目录"):
        resp = api.get("/api/v1/system/runner-labels")
        log.info("GET /api/v1/system/runner-labels -> HTTP %s", resp.status_code)

    with allure.step("校验包络与标签列表形状"):
        assert resp.status_code == 200
        body = resp.json()
        assert body["code"] == CODE_SUCCESS
        data = body["data"]
        assert isinstance(data, list)
        for entry in data:
            assert isinstance(entry["label"], str)
            assert isinstance(entry["online"], int)
            assert isinstance(entry["total"], int)
        log.info("runner-labels count=%d", len(data))


@allure.title("无 token 访问 runner-labels 返回 401")
def test_runner_labels_requires_token(api_host):
    """/system/runner-labels 无 token 返回 401。"""
    with allure.step("不带 token 请求 runner-labels"):
        resp = requests.get(f"{api_host}/api/v1/system/runner-labels", timeout=15)
        log.info("runner-labels (no token) -> HTTP %s", resp.status_code)

    with allure.step("校验 401 与 code 1002"):
        assert resp.status_code == 401
        assert resp.json()["code"] == CODE_INVALID_CREDENTIALS
        log.info("runner-labels without token -> HTTP %s (expected 401)", resp.status_code)