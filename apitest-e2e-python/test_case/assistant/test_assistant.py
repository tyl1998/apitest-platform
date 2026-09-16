"""assistant 模块（P9-2/P9-4b）：五条会话路由 × 真实 agent-vendor stg 平台（经平台代理）。

前置（一次）：source env.local.sh && python3 setup/seed_assistant.py——直插 agent-vendor
provider 行（通用协议）+ 为种子管理员配置用户 agent（P9-4b 凭据用户级）。未种子时
整模块 skip，不伪装成通过。

2026-09-14（P9-4 修订）：assistant_enabled 项目闸门随迁移 058 作废——助手默认
开启，原「闸门 404」用例删除；模块前置只剩 provider 种子。同日 P9-4b：上游通用化
（protocol 配置驱动，adapter 代码删除），503/2005 的语义从「无默认 provider」变为
「未配置用户 agent」。

2026-09-16（对话用户级化，迁移 062）：会话路由搬出项目段——/api/v1/assistant/
conversations*，登录即用、按 user_id 归属。模块与项目彻底解耦：e2e-assistant 项目
fixture 删除（曾经的写库说明随之作废——本模块不再写项目库，只写会话映射行）。

平台现状（2026-09-11 联调）：agent-vendor 平台侧 LLM Key 额度不足，真实回复出不来，
上游以 FINAL_RESULT success:false 落地、引擎按错误终态映射。因此消息用例断言
**协议不变量**（归一事件形状、终态唯一且在最后、字段非空），done / error 都接受；
额度修复后同一组用例自然覆盖正常流式（token 逐段 / 工具行 / HEART_BEAT 吸收）。
"""
import json
import logging
import time
import uuid

import allure
import pytest

from data.constant import CODE_BAD_REQUEST, CODE_NOT_FOUND, CODE_SUCCESS

log = logging.getLogger("apitest.assistant")

_SEED_HINT = "assistant 未种子：source env.local.sh && python3 setup/seed_assistant.py"


@pytest.fixture(scope="module")
def assistant_ready(api):
    """前置自检：会话路由组通了才继续，否则整模块 skip（provider 种子缺一半）。"""
    probe = api.get("/api/v1/assistant/conversations")
    if probe.status_code == 503:
        pytest.skip(f"未配置用户 agent（provider 种子缺一半）——{_SEED_HINT}")
    assert probe.status_code == 200, probe.text


@pytest.fixture(scope="module")
def conversation(api, assistant_ready):
    """整个模块共用一个会话（对上游轻一点；历史断言各自发带唯一标记的消息）。"""
    resp = api.post("/api/v1/assistant/conversations")
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]


def _stream_events(api, url: str, payload: dict):
    """POST + SSE 读到底，返回 (HTTP 状态, 归一事件列表)。

    不用 iter_lines：它按底层 chunk 切行，长事件的 JSON 会被拦腰截断
    （requests 的 iter_lines 对 SSE 不做跨 chunk 的事件重组）。这里按
    iter_content 原始字节自己攒缓冲、按空行切事件、再取 data: 行——与服务端
    SseDataParser 同一套纪律（SSE 事件以空行分隔）。
    """
    resp = api.session.post(url, json=payload, stream=True, timeout=(10, 90))
    buffer = ""
    events = []
    for chunk in resp.iter_content(chunk_size=None, decode_unicode=True):
        buffer += chunk
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.rstrip("\r")
            if not line or line.startswith(":") or line.startswith("event:"):
                continue  # 空行/保活注释/事件名（事件名与 data.type 冗余，取 data 为准）
            if line.startswith("data:"):
                events.append(json.loads(line[len("data:"):].strip()))
    if buffer.startswith("data:"):  # 缺结尾空行的最后一个事件（防御性）
        events.append(json.loads(buffer[len("data:"):].strip()))
    return resp.status_code, events


def _message_url(api, conversation_id) -> str:
    return f"{api.host}/api/v1/assistant/conversations/{conversation_id}/message"


@allure.title("创建会话：201 + 映射行字段（upstreamConversationId 非空）")
def test_create_conversation(conversation):
    """建会话按默认 provider 转发上游 conversation/add，落一行映射（正文不落库）。

    upstreamConversationId 回归锚点（2026-09-14 双重解包缺陷，见 issue_fix）：
    agent-vendor 的会话 id 是 JSON 数字（"data": 89），引擎曾把信封预剥一层 data 再按
    根相对路径取值，数字上取 .data 恒空——「建会话必失败」。id 能原样落进映射行
    即证明引擎按「路径说了算」取值且数字型 id 不被丢。"""
    with allure.step("校验映射行字段"):
        uuid.UUID(conversation["id"])
        assert conversation["providerId"], "providerId 缺失"
        assert conversation["upstreamConversationId"], "上游会话 id 缺失"
        # 数字型 id 不会被 String() 弄丢（89 应以 "89" 形态落库）。
        assert str(conversation["upstreamConversationId"]).strip().isdigit(), (
            f"上游会话 id 应为数字形态，实际: {conversation['upstreamConversationId']!r}"
        )
        assert conversation["topic"] == ""


@allure.title("会话列表（读映射表，不调上游）包含刚建的会话")
def test_list_conversations(api, assistant_ready, conversation):
    with allure.step("请求我的会话列表"):
        body = api.get("/api/v1/assistant/conversations").json()
        log.info("conversations total=%s", body["meta"]["total"])

    with allure.step("校验包络与成员"):
        assert body["code"] == CODE_SUCCESS
        ids = [row["id"] for row in body["data"]]
        assert conversation["id"] in ids
        assert body["meta"]["total"] == len(body["data"])


@allure.title("发消息：SSE 归一事件以唯一终态（done|error）收尾")
def test_message_stream_terminal_invariant(api, assistant_ready, conversation):
    """协议不变量：事件形状 ∈ {token,tool,done,error}；终态恰好一个且在最后；
    done 带 fullText / error 带可读 message（平台侧额度不足也走这条）。"""
    with allure.step("POST message 并读完整条 SSE 流"):
        status, events = _stream_events(api, _message_url(api, conversation["id"]), {"message": "e2e 流式探测"})
        log.info("message stream: http=%s events=%s", status, [event["type"] for event in events])

    with allure.step("校验事件形状与终态不变量"):
        assert status == 200
        assert events, "SSE 流一个事件都没有"
        for event in events:
            assert event["type"] in ("token", "tool", "done", "error"), f"未知事件类型: {event}"
        terminals = [event for event in events if event["type"] in ("done", "error")]
        assert len(terminals) == 1, "终态事件必须恰好一个"
        assert events[-1]["type"] in ("done", "error"), "终态必须是最后一个事件"
        terminal = terminals[0]
        if terminal["type"] == "done":
            assert terminal["fullText"], "done 缺 fullText"
        else:
            assert terminal["message"], "error 缺可读 message"


@allure.title("历史代理：刚发的消息出现在归一历史里（user 角色）")
def test_history_reflects_sent_message(api, assistant_ready, conversation):
    with allure.step("先发一条带唯一标记的消息"):
        marker = f"e2e-history-{uuid.uuid4().hex[:8]}"
        status, events = _stream_events(api, _message_url(api, conversation["id"]), {"message": marker})
        assert status == 200
        assert events[-1]["type"] in ("done", "error")

    with allure.step("历史里能查到这条 user 消息，且存在 assistant 消息"):
        resp = api.get(
            f"/api/v1/assistant/conversations/{conversation['id']}/messages",
            params={"limit": 20},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["code"] == CODE_SUCCESS
        messages = body["data"]
        assert body["meta"]["total"] == len(messages)
        mine = [message for message in messages if message["text"] == marker]
        assert mine, "刚发的 user 消息没进历史"
        assert mine[0]["role"] == "user"
        assert any(message["role"] == "assistant" for message in messages), "上游没有落 assistant 消息"
        for message in messages:
            assert message["role"] in ("user", "assistant")
            assert "text" in message


@allure.title("停止生成：agent-vendor 能力面开启时 stop 返回 stopped=true")
def test_stop_generation(api, assistant_ready, conversation):
    resp = api.post(f"/api/v1/assistant/conversations/{conversation['id']}/stop")
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"] == {"stopped": True}


@allure.title("空消息 / 缺消息被 1001 拒绝")
def test_message_requires_content(api, assistant_ready, conversation):
    path = f"/api/v1/assistant/conversations/{conversation['id']}/message"
    for payload in ({"message": ""}, {"message": "   "}, {}):
        resp = api.post(path, json=payload)
        assert resp.status_code == 400, payload
        assert resp.json()["code"] == CODE_BAD_REQUEST, payload


@allure.title("不存在的会话：message / stop / messages 一律 404 / 2001")
def test_unknown_conversation_not_found(api, assistant_ready):
    base = f"/api/v1/assistant/conversations/{uuid.uuid4()}"
    for step in ("message", "stop", "messages"):
        if step == "messages":
            resp = api.get(f"{base}/{step}")
        else:
            resp = api.post(f"{base}/{step}", json={"message": "hi"} if step == "message" else None)
        assert resp.status_code == 404, step
        assert resp.json()["code"] == CODE_NOT_FOUND, step


@allure.title("首条消息自动生成会话标题：topic 从空串变为消息摘要")
def test_first_message_sets_topic(api, assistant_ready):
    """P9-4 修订之四：topic 是首条消息的折叠摘要（下拉里读出「聊的是什么」）。
    服务端在流的 finally 里 fire-and-forget 落 topic，这里轮询一小段时间等它落地。"""
    with allure.step("建一个全新会话（topic 恒为空串）"):
        resp = api.post("/api/v1/assistant/conversations")
        assert resp.status_code == 201, resp.text
        conversation = resp.json()["data"]
        assert conversation["topic"] == ""

    with allure.step("发一条带唯一标记的消息"):
        marker = f"e2e-topic-{uuid.uuid4().hex[:8]}"
        status, events = _stream_events(
            api, _message_url(api, conversation["id"]), {"message": f"{marker} 后续内容"}
        )
        assert status == 200
        assert events[-1]["type"] in ("done", "error")

    with allure.step("轮询会话列表直到 topic 落地（fire-and-forget 有毫秒级延迟）"):
        topic = ""
        for _ in range(20):
            rows = api.get("/api/v1/assistant/conversations").json()["data"]
            row = next((item for item in rows if item["id"] == conversation["id"]), None)
            topic = row["topic"] if row else ""
            if topic:
                break
            time.sleep(0.2)
        assert topic.startswith(marker), f"topic 未生成或不含消息前缀: {topic!r}"
