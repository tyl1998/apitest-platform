# 第三方接入：会话确认（confirm）协议

> 面向调用本平台**会话 API**（`POST /api/conversations/:id/chat`）的第三方客户端。
> 说明危险工具 / 服务端反向确认在 SSE 流里如何出现、以及第三方必须怎么应答，
> 否则这类工具**不会被执行**。

---

## 1. 为什么会有 confirm

会话是 **SSE 流式**接口。模型在一轮对话里可能调用 MCP 工具。其中一类工具在**执行前需要用户点头**，这时后端不会直接调用工具，而是先在流里发一个 `confirm` 事件并**挂起本轮**，等你回一个应答，再决定执行还是跳过。

确认有**两个来源**（`confirm.source`），机制完全一致、应答方式相同，只是触发方不同：

| `source` | 触发方 | 含义 |
|---|---|---|
| `PLATFORM` | 本平台的危险工具判定 | 工具的 MCP `annotations` 没有声明 `readOnlyHint:true`（或声明了 `destructiveHint:true`）⇒ 保守判为"危险" ⇒ 执行前问一句。**注意**：很多 MCP server 根本不写 annotations，于是它们的工具（含只读查询）也会走这条确认。 |
| `SERVER` | 上游 MCP server 反向发起（`elicitation/create`） | 工具在执行途中主动要求用户确认/补充输入（例如"删除前二次确认"）。 |

> ⚠️ 目前**没有**任何"免确认名单 / auto-approve"。想让危险工具执行，客户端**必须**实现本协议。只读工具（正确声明 `readOnlyHint:true`）不会触发 confirm，可直接执行。

---

## 2. 完整时序

```
客户端                                          服务端
  │  POST /api/conversations/:id/chat  (SSE)     │
  │ ───────────────────────────────────────────►│
  │                                              │  ...delta / thinking...
  │  ◄─── event: tool_call {status:RUNNING?}     │  (危险工具不发 RUNNING，直接挂起)
  │  ◄─── event: confirm {confirmId, ...}        │  本轮挂起，等待应答（默认 120s）
  │                                              │
  │  POST /api/conversations/:id/confirm         │  （另一条独立请求，不在 SSE 流里）
  │       {confirmId, accepted:true|false}       │
  │ ───────────────────────────────────────────►│
  │  ◄─── 200 {applied:true}                     │
  │                                              │  收到应答 → 继续本轮
  │  ◄─── event: tool_call {status:SUCCESS/ERROR}│
  │  ◄─── ...delta...                            │
  │  ◄─── event: done {finishReason:COMPLETE}    │
```

要点：
- `confirm` 事件走**SSE 流**；应答走**另一条普通 HTTP 请求** `POST /:id/confirm`。同一个会话的这两条请求靠 `conversationId` + `confirmId` 关联。
- **应答不会在 SSE 流里产生额外事件**——你回 `/confirm` 之后，本轮直接以 `delta` / `tool_call` / `done` 继续。

---

## 3. 端点

所有接口都需要与其它 `/api` 接口一致的**登录态 / 鉴权**（同一套会话凭据）。

### 3.1 发消息（SSE）

```
POST /api/conversations/:id/chat
Content-Type: application/json
Accept: text/event-stream

{ "content": "…", "modelId": "可选：从该智能体模型池里选一个" }
```

- 成功：`200` + `Content-Type: text/event-stream`，随后是事件流。
- **前置失败走 JSON 信封**（不是事件流）：`401` 未登录 / `400` 参数 / `404` 会话不存在或不是你的 / `409` 会话只读 / `424` 缺凭据。按 `Content-Type` 区分：不是 `text/event-stream` 就按普通错误信封处理。
- **并发冲突是流内事件**：同一会话已有流在跑时，返回 `200` + 一条 `event: error {code:"CONFLICT"}` 收尾（不是信封）。

### 3.2 应答确认

```
POST /api/conversations/:id/confirm
Content-Type: application/json

{ "confirmId": "<来自 confirm 事件>", "accepted": true }
```

响应：

```json
{ "id": "<会话id>", "confirmId": "…", "accepted": true, "applied": true }
```

- `applied:true` = 有一轮正在等这个 `confirmId`，应答已生效。
- `applied:false` = **没人在等这个 id**（已超时 / 已被处理 / 这一轮早结束了 / `confirmId` 是上一张卡的迟到点击）。这是**正常终局**，返回 `200`，不是错误。**不要**重试。

### 3.3 查询活跃状态（断线重连用）

```
GET /api/conversations/:id/active
```

```json
{
  "streaming": true,
  "currentTool": null,
  "startedAt": "2026-…Z",
  "pendingConfirmId": "…或 null",
  "queuedPosition": null
}
```

- 断线重连后：先查这个。`pendingConfirmId !== null` 表示"有一个确认在等你"，用它作为 `confirmId` 去回 `/confirm` 即可（`confirm` 事件本身可能在断线时错过了）。

### 3.4 停止本轮

```
POST /api/conversations/:id/stop   →   { "id":"…", "signaled": true|false }
```

- 仅写停止信号；真正停止由流里的 `done{finishReason:"STOPPED"}` 宣布。
- 注意：`/confirm` 的 `accepted:false`（取消）**只是跳过这个工具、本轮继续**；要**终止整轮**请用 `/stop`。两者是不同动作。

---

## 4. SSE 帧格式与事件全集

标准 SSE，每帧两行 + 空行分隔：

```
event: <事件名>
data: <一行 JSON>

```

`data` 恒为**单行 JSON**（换行已转义）。事件全集：

| 事件 | 说明 |
|---|---|
| `delta` | 正文增量：`{ "text": "…" }`，逐帧拼接 |
| `thinking` | 思考增量：`{ "text": "…" }` |
| `tool_call` | 工具卡（同 `callId` 多次推送 = 状态流转，按 `callId` upsert） |
| **`confirm`** | **确认请求（本文重点）** |
| `citations` | 引用列表 `{ "items":[…] }` |
| `artifact` | 产物文件（TaskAgent） |
| `queued` | 排队位次 `{ "position": n }` |
| `ping` | 心跳 `{ "ts":"…" }` —— **静默忽略**（挂起等待期间也靠它保活） |
| `done` | 结束 `{ "messageId":…\|null, "finishReason":"COMPLETE"\|"STOPPED"\|"ERROR", "usage":… }` |
| `error` | 流内错误 `{ "code":"<错误码>", "message":"…" }` |

一条流以 `done` **或** `error` 结尾（二选一、各一次）。

---

## 5. confirm 事件 payload

```json
event: confirm
data: {
  "confirmId": "758b508b-8224-4c2e-bc28-1ba674675036",
  "source": "PLATFORM",
  "toolName": "mcp_apitest_delete_environment",
  "inputSummary": "{\"projectId\":\"…\",\"environmentId\":\"…\"}",
  "expiresAt": "2026-09-28T09:18:19.014Z"
}
```

| 字段 | 说明 |
|---|---|
| `confirmId` | 本次确认的唯一 id。回 `/confirm` 时**原样带回**。 |
| `source` | `PLATFORM`（平台危险判定）或 `SERVER`（上游 MCP 反向发起）。只影响你给用户的说明文案。 |
| `toolName` | 待确认的工具名。`PLATFORM` 时是下发给模型的名字（`mcp_{slug}_{tool}`）。 |
| `inputSummary` | 参数摘要（凭据值已抹除，可直接展示）。 |
| `expiresAt` | **服务端**这次等待的绝对截止时刻（ISO 8601）。倒计时**只读它**，不要前端自己另起 120s。 |

---

## 6. 超时与"不应答"的后果

- 挂起上限 = `MCP_CONFIRM_TIMEOUT_SEC`（默认 **120 秒**，见 `expiresAt`）。
- 到点仍无应答 ⇒ 按**取消**处理：该工具**不执行**，回填一条"未执行"结果给模型，**本轮继续**（模型不带该工具结果作答）。
- 因此：**不实现本协议的客户端，危险工具永远执行不了**，且每个还会白等 120s。

`accepted` 的两种取值：
- `true`：执行该工具。
- `false`：跳过该工具、**本轮继续**（不是终止；终止用 `/stop`）。

超时后再点击（`applied:false`）不会生效。

---

## 7. 最小客户端示例（伪代码 / fetch）

```js
const base = '/api/conversations'
const id = '<conversationId>'

// 1) 开流
const res = await fetch(`${base}/${id}/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  credentials: 'include',
  body: JSON.stringify({ content: '删除测试环境 xxx' }),
})
if (!res.headers.get('content-type')?.includes('text/event-stream')) {
  throw new Error('前置失败：' + JSON.stringify(await res.json())) // 401/400/404/409/424
}

// 2) 解析 SSE，遇到 confirm 就应答
const reader = res.body.getReader()
const decoder = new TextDecoder()
let buf = ''
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  buf += decoder.decode(value, { stream: true })
  let sep
  while ((sep = buf.indexOf('\n\n')) !== -1) {
    const frame = buf.slice(0, sep); buf = buf.slice(sep + 2)
    const name = frame.match(/^event: (.*)$/m)?.[1]
    const data = frame.match(/^data: (.*)$/m)?.[1]
    if (!name || !data) continue
    const payload = JSON.parse(data)

    if (name === 'confirm') {
      // === 你的确认逻辑：弹窗 / 策略判断，得到 accepted ===
      const accepted = await askUser(payload)  // true | false
      await fetch(`${base}/${id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ confirmId: payload.confirmId, accepted }),
      })
      // 不用等它返回额外事件——本轮会在 SSE 流里继续
    } else if (name === 'delta') {
      appendText(payload.text)
    } else if (name === 'done' || name === 'error') {
      // 收尾
    }
    // 其它事件按需处理；ping 忽略
  }
}
```

---

## 8. 常见坑

1. **`confirmId` 必须原样回传**，服务端按它匹配"回答的是不是当前这个问题"；对不上就 `applied:false` 静默忽略。
2. **倒计时读 `expiresAt`**，不要自己数 120 秒——两边有时差会出现"你以为还没到、服务端已按取消处理"。
3. **只读工具不会有 confirm**——如果你希望某些工具免确认，让对应 MCP server 给它声明 `annotations.readOnlyHint:true`（且非 destructive）。平台侧目前没有 auto-approve 名单。
4. **`SERVER` 来源要求上游连接支持服务端→客户端请求**（有会话 / SSE 升级）。若上游 MCP server 以无会话的"每请求单响应"模式服务，它发不出 `elicitation/create`，该工具会以错误结果返回（见下节）。
5. **区分取消与停止**：`/confirm{accepted:false}` = 跳过工具、继续；`/stop` = 终止本轮。

---

## 9. 关于 `SERVER` 来源（上游 elicitation）的一个已知边界

`source:"SERVER"` 依赖上游 MCP server 在 `tools/call` 执行途中发起 `elicitation/create`（服务端→客户端请求）。这要求该连接**能承载反向请求**——通常意味着上游 server 走**有会话**（下发 `Mcp-Session-Id`）或把该次 `tools/call` 以 SSE 方式返回。

如果上游 server 以**无会话、每请求单响应**的"legacy"模式服务，它无法把 `elicitation/create` 发回来，工具会直接返回类似下面的错误结果（`tool_call{status:ERROR}`），本平台**不会**为它弹 `confirm` 卡：

```
Cannot request input 'confirm' (elicitation/create): the client on this
2025-era connection did not declare the required capability
(… per-request legacy serving cannot receive server-to-client requests)
```

这属于**上游 server 的服务模式限制**，需在上游侧改为有会话 / SSE 升级来支持二次确认。本平台客户端侧已声明 elicitation 能力并具备应答方，无需额外配置。
