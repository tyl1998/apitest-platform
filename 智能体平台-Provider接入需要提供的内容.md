# Provider 接入：第三方需要提供的内容

> 面向**要接入本平台站内助手（assistant）的上游 agent 平台**。
> 本平台不实现 agent，只做代理：`浏览器 → 平台助手代理（只转发 SSE）→ 你的 agent 平台 → 平台 /mcp → 库`。
> 接入 = 管理员在系统管理里填一份**协议配置**（4 个接口 + SSE 事件映射 + 认证模板）。平台不改代码。
>
> 平台**不内建任何厂商的默认 provider**（2026-10-22）：每一家上游都是一份管理员手填/导入的协议配置。
> 本文回答的是：**你的平台要交付给我们什么，才能被配成一份可用的 provider。**

---

## 0. 一句话清单


| #  | 交付物                              | 必填                             | 用途               |
| ---- | ------------------------------------- | ---------------------------------- | -------------------- |
| 1  | 接口环境地址（base URL）            | 是                               | 所有路径拼在它后面 |
| 2  | 鉴权方式与请求头形态                | 是                               | 渲染认证头         |
| 3  | 建会话接口                          | 是                               | 新对话第一个调用   |
| 4  | 发消息接口（**必须是 SSE 事件流**） | 是                               | 核心链路           |
| 5  | 发消息流的**事件样本**（原样抓包）  | 是                               | 平台据此做事件映射 |
| 6  | 停止生成接口                        | 否（不配则没有停止按钮）         | 中途打断           |
| 7  | 删除会话接口                        | 否（不配则只清本地映射）         | 用户删会话         |
| 8  | 历史消息接口                        | 否（不配则只显示本次打开后消息） | 重开抽屉回放       |
| 9  | 附件支持情况                        | 否                               | 用户发图/文件      |
| 10 | 用户级凭据清单（每人要填什么）      | 是                               | 用户参数模式       |
| 11 | 一份可用测试账号                    | 是                               | 测试连接 + 联调    |

---

## 1. 接入资格线

只接**有会话管理的 agent 平台**，不是裸 LLM 接口。必须满足：

1. **有会话概念**：能创建会话、拿到会话 id，之后的消息都挂在它下面（平台不代为保存上下文）。
2. **回复是 SSE 流**：逐字增量推送，不是一次性 JSON 返回。
3. **能承载工具调用**：agent 在我们的 MCP 上调用工具时，工具执行状态能出现在流里。

不满足第 1 或第 2 条的，需要在你侧改造后重新提供，平台侧无法兜底。

---

## 2. 协议配置总形状

管理员实际填写的是下面这份 JSON（也是平台「导入 / 导出」的格式，**不含任何凭据**）：

```json
{
  "name": "provider-名字（平台内唯一）",
  "protocol": {
    "baseUrl": "https://your-agent.example.com",
    "auth": { "header": "Authorization", "value": "Bearer {{user.apiKey}}" },
    "successCode": { "field": "code", "value": "0000" },
    "createConversation": { "...": "见 3.1" },
    "chat": { "...": "见 3.2" },
    "stop": { "...": "见 3.3" },
    "delete": { "...": "见 3.3" },
    "history": { "...": "见 3.4" },
    "attachments": true,
    "sse": { "...": "见 4" }
  },
  "userParams": [ "...见 5" ]
}
```

### 2.1 通用字段


| 字段                           | 必填 | 说明                                                                                               |
| -------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `baseUrl`                      | 是   | `http(s)://` 开头，末尾斜杠会被去掉                                                                |
| `auth.header`                  | 否   | 认证头名，如 `Authorization`                                                                       |
| `auth.value`                   | 否   | 认证头值的**模板**，如 `Bearer {{user.apiKey}}`。注意这里只写「怎么拼」，真实凭据由用户自己填      |
| `successCode.field` / `.value` | 否   | 业务码判定：HTTP 200 但 `field` 的值 ≠ `value` 视为失败。**两个都填才生效**；不填只看 HTTP 状态码 |

### 2.2 端点字段

每个端点（`createConversation` / `chat` / `stop` / `delete` / `history`）共用：


| 字段     | 必填 | 说明                                                            |
| ---------- | ------ | ----------------------------------------------------------------- |
| `method` | 是   | `GET` / `POST` / …                                             |
| `path`   | 是   | 以 `/` 开头，可含占位符（如 `/api/v1/chat/{{conversationId}}`） |
| `body`   | 否   | 请求体模板（JSON），值里可含占位符                              |

> `path` 与 `body` 里的占位符要用你平台的**真实语境**表达，不要照抄示例里的值。

---

## 3. 四个接口要提供的内容

对每个接口，请提供：**方法 + 路径 + 请求体示例 + 响应示例（成功 / 失败各一份）+ 是否需要认证**。

### 3.1 建会话（`createConversation`，必填）


| 需要提供                 | 说明                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------- |
| 方法 + 路径              | 例：`POST /api/v1/chat/conversation/add`                                             |
| 请求体                   | 需要哪些字段（如 agentId / 变量）                                                    |
| **响应里会话 id 的位置** | 点路径，如 `data`（响应 `{"code":"0000","data":"57"}` 就是 `data`）、`data.id`、`id` |
| id 类型                  | 字符串还是数字（数字会按数字发送，不带引号）                                         |
| 失败响应                 | 业务码字段与失败值                                                                   |

> 会话 id 是后续所有接口的 `{{conversationId}}` 来源；取不到值时平台直接报错。

### 3.2 发消息（`chat`，必填，**SSE**）


| 需要提供     | 说明                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| 方法 + 路径  | 路径里怎么带会话 id（如 `POST /api/v1/chat/{{conversationId}}`）                                                   |
| 请求体       | 用户消息放哪个字段（如 `message`）；**会话 id 是否还要在 body 里重复一次**                                         |
| 响应头       | 是否为 `Content-Type: text/event-stream`                                                                           |
| **事件样本** | 见第 4 节，这是接入成败的关键                                                                                      |
| 前置失败形态 | 参数错 / 未授权 / 会话不存在时的状态码与 JSON 结构（平台按 `Content-Type` 区分：不是事件流就当普通 JSON 错误处理） |

> **会话 id 必须清楚**：路径和 body 是否都要传，请明确写出来。有的平台只放路径会返回 `4000 conversationId is required`。

### 3.3 停止生成 / 删除会话（`stop` / `delete`，可选）


| 需要提供    | 说明                                   |
| ------------- | ---------------------------------------- |
| 方法 + 路径 | 会话 id 怎么带（`{{conversationId}}`） |
| 请求体      | 有则给出                               |
| 成功响应    | 结构（信封是否带业务码）               |

不提供的结果：`stop` 不配 → 前端不显示「停止生成」按钮；`delete` 不配 → 用户删除会话时只清本地映射，你的平台留痕。

### 3.4 历史消息（`history`，可选）


| 需要提供             | 说明                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| 方法 + 路径          | 通常 `GET`，路径带 `{{conversationId}}`                                                                  |
| 分页参数             | 游标参数名与条数参数名（平台提供 `{{index}}` / `{{limit}}` 两个值，你告诉我们它们该落在哪个 query 键上） |
| **消息数组位置**     | 响应里的点路径，如 `data`                                                                                |
| **每条消息的字段名** | id / role / text / time 分别叫什么                                                                       |
| role 取值            | 哪个值代表「用户」（平台只把 `USER`（大小写不敏感）当用户消息，其余一律当助手消息）                      |
| 分页语义             | 游标是「上一页最后一条 id / index」还是 offset                                                           |

### 3.5 附件（可选）

如果发消息接口支持附件，请提供：

- 附件字段名（平台固定发送数组，字段名 **`attachments`**）；
- 每项需要的字段（平台发送的是 `{ fileUrl, fileName, mimeType }`）；
- **文件是你方按 URL 自行拉取，还是需要平台上传**（当前平台只传 URL，不经手文件本体）；
- 支持的类型 / 大小上限、URL 是否需要可公网访问或需要签名。

不支持附件的，`attachments` 保持关闭，用户带附件时平台不会把附件塞进请求体。

---

## 4. 事件流（SSE）要提供的内容 —— 重点

平台不理解你的事件语义，只按**配置的点路径**取值。因此请提供**一段真实抓包的原始 SSE**（至少覆盖：正常回答一段、一次工具调用、一次结束、一次报错、一次心跳），并逐项说明下表。

### 4.1 帧格式要求

```
data: {"requestId":"...","eventType":"MESSAGE","data":{"text":"你"},"completed":false}
```

- 平台按标准 SSE 解析：**事件以空行分隔**，只读 `data:` 行（`data:` 后有无一个空格都兼容）；
- 每条 `data:` 必须是**单行 JSON**（多行 data 会按 `\n` 拼接后整体解析，请尽量避免）；
- `event:` 行与 `: 注释` 行平台**不使用**（保活心跳由平台自己发），所以「这是什么事件」必须写在 `data` 的 JSON 里；
- 平台自行按 15s 发保活注释行，不依赖你方心跳。

### 4.2 事件映射表（请逐项填写并给出点路径）


| 映射项             | 必填                 | 需要你说明                                                   | 示例                                                                                    |
| -------------------- | ---------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `sse.eventField`   | 是                   | 表示事件类型的字段名；若种类在 SSE 的 `event:` 行而不在 JSON 里，事件名写 `名字@event` | `eventType`                                                                            |
| `sse.token`        | 至少配 token 或 done | 文字增量事件名 + 文字在哪个字段（可写 `a\|b` 候选路径）       | `on: MESSAGE`，`text: data.text\|data.content`                                         |
| `sse.done`         | 至少配 token 或 done | 结束事件名 + 完整回复在哪个字段                              | `on: FINAL_RESULT`，`text: data.outputText`                                            |
| `sse.done.success` | 可选但**强烈建议**   | 「成功/失败」标记字段，值为 false 时按失败处理               | `data.success`                                                                         |
| `sse.error`        | 建议                 | 报错事件名 + 给用户看的文案字段                              | `on: ERROR`，`message: data.error`（有的上游不发，错误落在 done+success:false）        |
| `sse.tool`         | 建议                 | 工具执行事件名 + 工具名 / 状态字段 + 兜底名 + **入参**字段   | `on: PROCESSING`，`name: data.name`，`status: data.status`，`input: data.result.input` |
| `sse.ignore`       | 可选                 | 无需转发的事件名                                             | `["HEART_BEAT"]`                                                                       |
| `sse.elicit`       | 可选                 | 确认表单事件：事件名（+ 可选判别字段 `type`/`typeValue`）、文案/工具路径、可选 `schema` | `on: MESSAGE`，`type: data.type`，`typeValue: ELICITATION`                              |
| `protocol.success` | 可选                 | 一问一答接口的信封失败判定（`{field, ok:[...]}` 或 `{field, not}`） | `{"field": "code", "ok": ["0"]}`                                                    |
| `attachmentsField` | 可选                 | 发消息请求体里承载附件数组的字段名                           | `attachments`                                                                          |
| `streamEnd`        | 可选                 | 终帧后上游仍不断流时：`close`（默认，平台主动断开）或 `continue` | `close`                                                                                |

### 4.3 事件语义必须明确回答的问题

1. **一条流怎么结束**：是固定发一个 `done` 类事件，还是靠连接关闭？平台只认结束事件；若流关了却没终态，平台会合成一个终态（已收到文字则以文字收尾，一个字没收到则报错）。
2. **错误怎么表达**：独立的 `ERROR` 事件，还是结束事件里带 `success: false`？（平台两种都能配，但需你明确）
3. **`FINAL_RESULT` 里的完整文本是否包含已推过的 token**：平台以结束事件的完整文本为权威全文；若你的结束事件不带文本，平台用累计 token 兜底。
4. **心跳事件名**：请给出，以便配进 `ignore`。
5. **长时间无输出时的行为**：平台有 60s 静默预算（两块数据之间超过 60s 无任何数据即以「上游静默」收尾），若你的场景可能静默更久，请说明并在该间隔内发心跳。
6. **限流**：是否返回 HTTP 429 与 `Retry-After`（平台会如实转发给用户并提示稍后重试）。
7. **同一会话并发发消息**：后到请求是排队、拒绝还是打断？
8. **流中途断开的后果**：本轮是否作废、是否计费。

### 4.4 工具确认（调用前弹窗，2026-10-21 起）

平台的 MCP **不再发送确认请求**（elicitation / MRTR 已移除，删除类工具一次调用即执行）。
唯一需要你确认的是：**你的运行时是否在调用前按 MCP `tools/list` 的 annotations 弹窗向人
确认**——尤其是 `destructiveHint: true` 的 `delete_*`。请回答：

1. 调用前是否读 `annotations` 并弹确认（是 / 否 / 仅某些工具）；
2. 弹窗是否会展示工具名与入参（人能否看出「确认的是哪个对象」）；
3. 用户拒绝时是否**不发起调用**（而不是调用后让平台回错误）。

若答「不弹窗」，删除动作在聊天里就没有任何人工确认环节——请据此决定是否限制 write
scope 的 Token。

### 4.5 示例：一份典型的事件全集

```
data:{"eventType":"MESSAGE","data":{"text":"你"},"completed":false}
data:{"eventType":"PROCESSING","data":{"type":"Knowledge","status":"EXECUTING","name":"知识库检索","result":{"input":{"id":12}}}}
data:{"eventType":"MESSAGE","data":{"type":"ELICITATION","text":"确认删除？","toolCallId":"call-1","elicitationSchema":{"type":"boolean"}}}
data:{"eventType":"FINAL_RESULT","completed":true,"data":{"success":true,"outputText":"完整回复"}}
data:{"eventType":"HEART_BEAT"}
```

---

## 5. 用户级凭据（`userParams`）要提供的内容

**平台不保存共享 Key**。每个使用助手的用户，都要在自己那边填一份你平台签发的凭据。请告诉我们：


| 需要你说明       | 说明                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| 每人要填哪些参数 | 键名、显示名、是否必填、是否密文、输入提示                            |
| 凭据从哪来       | 用户在哪申请（如你的控制台 / agent 详情页），是否需要你方管理员先创建 |
| 绑定关系         | 凭据是否绑定某个 agent（绑定的 agentId 要不要单独作为参数让用户填）   |
| 密文参数         | 哪些必须在平台加密存储、接口只回「已配置」（API Key、Token 一律密文） |
| 权限粒度         | 一个凭据能访问什么范围（是否还有项目级 / 数据域限制）                 |
| 吊销与轮换       | 怎么吊销、吊销后平台表现（预期是上游 401 → 用户重新填写）            |
| 有效期           | 是否过期，过期时返回什么                                              |

### 5.1 参数定义示例

```json
[
  { "key": "agentId", "label": "agentId", "secret": false, "required": true, "placeholder": "24" },
  { "key": "apiKey",  "label": "API Key", "secret": true,  "required": true, "placeholder": "ak-…" }
]
```

### 5.2 占位符词汇表（这部分是平台固定的，你只需要知道它们能出现在哪）


| 占位符                    | 可用位置                           | 值来源              |
| --------------------------- | ------------------------------------ | --------------------- |
| `{{user.键名}}`           | 认证头值、请求体、路径、历史 query | 用户自己填的参数    |
| `{{conversationId}}`      | 路径、请求体、历史 query           | 建会话接口返回值    |
| `{{message}}`             | 仅发消息请求体                     | 用户输入的文字      |
| `{{index}}` / `{{limit}}` | 仅历史 query                       | 平台分页游标 / 条数 |

> 键名规则：字母开头，字母/数字/下划线，最多 20 个参数。
> 值整体就是一个占位符且结果是数字时，平台按数字发送（不带引号）；其余按字符串。

### 5.3 平台会替你注入的东西（不需要你要求，但你的接口要能吃下）

- **页面上下文块**：发消息时，平台会在用户原文**后面**拼一段 ` ```apitest-page-context` 围栏（用户当前在哪个页面、哪个项目/接口等，≤ 2KB），再作为 `{{message}}` 的值发给你——开头始终是用户原文。你的 agent 可以据此理解「当前接口」这类指代；不需要就忽略。
- **附件数组**：仅在开启 `attachments` 且用户真的带了附件时，并进请求体的 `attachments` 字段。

---

## 6. 联调前需要你提供的测试资料


| 项目         | 说明                                                                           |
| -------------- | -------------------------------------------------------------------------------- |
| 测试环境地址 | 与生产分开，给出可直连的 base URL（有无网关 / 白名单请说明）                   |
| 测试 agent   | 一个已发布、模型有额度的 agent                                                 |
| 测试凭据     | 一组可用的 agentId + API Key（**请通过约定渠道线下交接，不要写进文档或工单**） |
| 调用量限制   | QPS / 并发 / 每日额度，以及超限时的响应                                        |
| 网络要求     | 是否需要加白名单（我们的出口 IP）、是否需要 mTLS                               |
| 日志与排障   | 是否提供 requestId 查询、能否按会话查询你侧的日志                              |

---

## 7. 我们这边会做哪些检查（供你预判）

管理员填入配置后，平台的「测试连接」会：**建会话 → 发一条 `ping` → 把归一事件回显**。请确保这条链路能走通。


| 现象                                                                                 | 说明                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------- |
| `protocol.baseUrl must be an http(s) URL`                                            | 地址格式不对                         |
| `protocol.createConversation/chat must define a method and a path starting with "/"` | 端点缺失                             |
| `protocol.createConversation.conversationId must be a response field path`           | 没告诉我们会话 id 在哪               |
| `protocol.sse.eventField must be the upstream event-type field`                      | 没给事件类型字段                     |
| `protocol.sse must define at least a token or done mapping`                          | 流里认不出文字或完成                 |
| `assistant upstream did not return a conversation id`                                | 会话 id 取值拿空                     |
| `... returned "application/json" instead of an event stream`                         | 发消息没有返回 SSE                   |
| 正常字符但迟迟不结束                                                                 | 缺结束事件或没有心跳（60s 静默收尾） |
| HTTP 429 + `Retry-After`                                                             | 上游限流，用户会看到「稍后重试」     |

---

## 8. 已知边界（先对齐，避免返工）

1. **平台是哑管道**：只转发，不替你保存上下文、不做模型路由、不改写你的文本。
2. **错误文案原样透出**：你返回的错误消息会直接显示给用户，请写成人话。
3. **超时**：建会话 / 停止 / 删除 / 历史这些一问一答接口 **15s**；发消息流只在两块数据之间衡量，静默 **60s** 即结束。长任务请用工具状态事件或心跳维持。
4. **会话归属按 provider**：用户切换默认 provider 后，旧会话仍按原 provider 收发；你方换默认不影响历史会话。
5. **删除 provider 会级联删除会话与用户凭据**：不可恢复。
6. **确认表单目前走平台自己的 REST**，不走上游 resume 通道；需要你方开放 resume 时另行评估。
7. **不支持**：无会话的一次性补全接口、非 SSE 的轮询式回复、平台侧自动批准危险工具。

---

## 9. 填写模板（可直接回填给我们）

```json
{
  "vendor": "厂商名 / 产品名",
  "env": { "test": "https://…", "prod": "https://…" },
  "auth": { "header": "Authorization", "value": "Bearer {{user.apiKey}}" },
  "successCode": { "field": "code", "value": "0000" },
  "createConversation": {
    "method": "POST", "path": "/…", "body": { "agentId": "{{user.agentId}}" }, "conversationId": "data"
  },
  "chat": {
    "method": "POST", "path": "/…/{{conversationId}}",
    "body": { "conversationId": "{{conversationId}}", "message": "{{message}}" }
  },
  "stop":   { "method": "POST", "path": "/…/{{conversationId}}/stop" },
  "delete": { "method": "POST", "path": "/…/{{conversationId}}/delete" },
  "history": {
    "method": "GET", "path": "/…/{{conversationId}}/messages",
    "query": { "index": "{{index}}", "limit": "{{limit}}" },
    "messages": "data",
    "fields": { "id": "id", "role": "role", "text": "text", "time": "time" }
  },
  "attachments": false,
  "sse": {
    "eventField": "eventType",
    "token": { "on": "…", "text": "data.text" },
    "tool":  { "on": "…", "name": "data.name", "status": "data.status", "nameFallback": "data.type", "input": "data.result.input" },
    "done":  { "on": "…", "text": "data.outputText", "success": "data.success" },
    "error": { "on": "…", "message": "data.error" },
    "ignore": ["…"]
  },
  "userParams": [
    { "key": "agentId", "label": "agentId", "secret": false, "required": true },
    { "key": "apiKey",  "label": "API Key", "secret": true,  "required": true }
  ],
  "limits": { "qps": "…", "concurrency": "…", "dailyQuota": "…" },
  "notes": "并发语义 / 断流后果 / 心跳间隔 / 429 行为 等"
}
```

随附：

- [ ]  建会话、发消息（SSE）、停止、删除、历史的 **curl 示例**（凭据用占位）
- [ ]  一段**原始 SSE 抓包**（正常 / 工具调用 / 结束 / 报错 / 心跳）
- [ ]  一份**失败响应**样本（含业务码字段）
- [ ]  测试环境可用凭据（线下交接）
