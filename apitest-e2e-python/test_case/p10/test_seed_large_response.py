"""p10 模块：P10 前端改造的数据种子 + 链路验证（pytest）。

目的（2026-09-19，P10-1）：给「下载完整响应」按钮造一条真实的大响应执行——只有全量正
文真的转存过（`response_body_object_key` 非空）时，前端详情页 / 工作台实时响应面板才会
出现那个按钮（`EndpointWorkspace.tsx` / `ExecutionSnapshot.tsx` 的
`DownloadFullResponseButton`）。跑完这条用例后打开浏览器看那条执行即可核验。

整条链路走真实 worker：API 只把运行排队（202），真正发请求、写正文、转存对象存储的
是独立的 worker 进程。**前置：apitest-server 与 worker 都在跑**（项目「执行队列从不内联
进 API 进程」，见 AGENTS.md）。若 worker 没起，执行会一直停在 `queued`，本用例断言会
因此失败并给出明确提示，而不是静默通过。

数据模型（来自 P10-1 实现）：
- 阈值 10_000 字节（`src/lib/run.ts` 的 `RESPONSE_LIMIT`）；正文长度 > 10000 才会被
  截断，转存判定与截断同一条线（`responseTruncated` 时才算「有全量可言」）。
- 转存再抬上限 `RESPONSE_OFFLOAD_MAX_BYTES`（默认 8MB），11KB 在范围内。
- 详情/列表只回布尔 `responseBodyStored`，不回对象 key；「下载完整响应」按钮点击时
  走 `GET /executions/:id/response-body` 换 5 分钟 presignGet 直链。
"""
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import allure
import pytest

from data.constant import CODE_SUCCESS

log = logging.getLogger("apitest.p10")

# 11KB 响应体：> RESPONSE_LIMIT(10000) 触发截断与转存，但仍远低于默认 8MB 落盘上限。
_LARGE_BODY = ("x" * 1024) + "-large-response-" * 11  # 1024 + ~17B*11 ≈ 1.2KB；确保够大
_LARGE_BODY = _LARGE_BODY * 10  # 摊到 ~12KB，稳定越过 10000
assert len(_LARGE_BODY) > 10_000

_POLL_INTERVAL_MS = 400
_POLL_TIMEOUT_MS = 30_000


class _LargeBodyHandler(BaseHTTPRequestHandler):
    """本地假上游：任何请求都回一份 >10KB 的 JSON 正文（触发 P10-1 转存）。"""

    def do_GET(self):  # noqa: N802
        payload = f'{{"ok":true,"data":"{_LARGE_BODY}"}}'.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # noqa: A003
        pass  # 本地假上游不刷屏


@pytest.fixture(scope="module")
def large_response_mock():
    """起一个本机假上游，返回 (host, port)。进程级内即可，随测试结束自动关闭。"""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _LargeBodyHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    log.info("large-response mock listening on 127.0.0.1:%s", port)
    try:
        yield "127.0.0.1", port
    finally:
        server.shutdown()
        server.server_close()


def _find_or_create_project(api) -> str:
    """find-or-create e2e 项目（与 setup/seed_assistant.py 同逻辑，范围收敛到 p10 用）。"""
    keyword = "e2e-p10"
    for project in api.get("/api/v1/projects", params={"keyword": keyword}).json()["data"]:
        if project["name"] == keyword:
            return project["id"]
    resp = api.post(
        "/api/v1/projects",
        json={"name": keyword, "description": "P10-1 大响应转存种子上游（test_case/p10 维护）"},
    )
    return resp.json()["data"]["id"]


def _wait_terminal(api, project_id: str, execution_id: str) -> dict:
    """轮询单条执行直到终态（success/failed/canceled），带回 mapExecution 后的载荷。"""
    import time

    deadline = time.time() + _POLL_TIMEOUT_MS / 1000
    while time.time() < deadline:
        data = api.get(f"/api/v1/projects/{project_id}/executions/{execution_id}").json()["data"]
        if data["status"] not in ("queued", "running"):
            return data
        time.sleep(_POLL_INTERVAL_MS / 1000)
    raise AssertionError(
        f"execution {execution_id} 在 {_POLL_TIMEOUT_MS}ms 内未到终态（仍在 "
        f"{api.get(f'/api/v1/projects/{project_id}/executions/{execution_id}').json()['data']['status']}）。"
        "多半是 worker 没在跑——项目执行队列从不内联进 API 进程，需先用 start.sh 起 worker。"
    )


@allure.title("P10-1：造一条大响应执行（responseBodyStored=true）供前端核验")
def test_seed_large_response_execution(api, large_response_mock):
    """排队跑一次 11KB 响应，断言走完转存链路，给前端留一条「可下载完整响应」的记录。"""
    host, port = large_response_mock

    with allure.step("find-or-create e2e 项目"):
        project_id = _find_or_create_project(api)
        log.info("project %s 就绪", project_id)

    with allure.step("建一个指向本机假上游的端点（GET {host}:{port}/large）"):
        url = f"http://{host}:{port}/large"
        created = api.post(
            f"/api/v1/projects/{project_id}/endpoints",
            json={"name": "p10-large-response", "method": "GET", "url": url},
        )
        assert created.status_code == 201, created.text
        endpoint_id = created.json()["data"]["id"]
        log.info("endpoint %s -> GET %s", endpoint_id, url)

    with allure.step("排队执行该端点（POST /execute，202）"):
        queued = api.post(
            f"/api/v1/projects/{project_id}/endpoints/{endpoint_id}/execute",
            json={"environmentId": None},
        )
        assert queued.status_code == 202, queued.text
        execution_id = queued.json()["data"]["id"]
        log.info("execution %s queued", execution_id)

    with allure.step("轮询到终态并校验 P10-1 四要素"):
        data = _wait_terminal(api, project_id, execution_id)
        assert data["status"] in ("success", "failed"), data
        assert data["responseTruncated"] is True, (
            f"响应未截断（size={data['responseSizeBytes']}），不会触发转存。"
            f"本机假上游是否可达？url={url}"
        )
        assert data["responseBodyStored"] is True, (
            "responseBodyStored=false：全量正文没转存。可能原因：项目级转存被关、"
            "超 RESPONSE_OFFLOAD_MAX_BYTES、或 worker 侧写对象失败（降级为无全量）。"
            f"实际 size={data['responseSizeBytes']} status={data['status']} "
            f"error={data.get('error')} truncated={data['responseTruncated']}"
        )
        assert data["responseSizeBytes"] > 10_000
        log.info(
            "P10-1 链路就绪：execution=%s status=%s size=%s truncated=%s stored=%s",
            execution_id, data["status"], data["responseSizeBytes"],
            data["responseTruncated"], data["responseBodyStored"],
        )

    with allure.step("换「下载完整响应」直链（前端按钮走的同一端点）"):
        body = api.get(
            f"/api/v1/projects/{project_id}/executions/{execution_id}/response-body"
        ).json()
        assert body["code"] == CODE_SUCCESS, body
        assert body["data"]["downloadUrl"].startswith(("http://", "https://"))
        assert body["data"]["expiresIn"] == 300
        log.info("response-body 直链已签发（expiresIn=%ss）", body["data"]["expiresIn"])