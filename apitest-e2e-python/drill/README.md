# 上游异常演练（P9-8）

站内助手的上游是**外部 agent 平台**，它的坏法平台管不着、只能自己接住。这份清单把
三类上游异常（**断流 / 限流 / ERROR 事件**）以及相邻的几种失败形态做成可复现的操练：
一个零依赖的假上游（`stub_upstream.py`）按 `mode` 制造故障，观察平台侧怎么收尾。

**范围**：只覆盖上游异常与凭据可见性。验收结论按 `AGENTS.md` 留给用户手工跑后给出，
本目录只提供「怎么造、该看到什么」。

## 一、准备

```bash
# 1. 后端在跑（postgres/redis 外部起好）
./start.sh --restart api worker

# 2. 起演练桩（前台跑，请求日志直接打在终端）
cd apitest-e2e-python
python3 drill/stub_upstream.py --port 8099

# 3. 把 provider 指向桩（复用种子脚本，只换 baseUrl；桩不校验 Key，随便给一个）
agent-vendor_BASE_URL=http://127.0.0.1:8099 agent-vendor_AGENT_ID=1 agent-vendor_API_KEY=drill \
  python3 setup/seed_assistant.py
```

桩与 apitest-server 在同一台机器时 `127.0.0.1` 即可；分开部署就填后端能出站访问到的地址。

浏览器里打开任意页面 → 顶栏助手头像 → 抽屉即为观察窗口。**收尾**：把 baseUrl 换回真
上游（再跑一次种子脚本，去掉 `agent-vendor_BASE_URL` 覆盖即可）——别让开发环境一直指着桩。

切模式（全局，管家公的）：

```bash
curl -sX POST localhost:8099/__mode -d '{"mode":"silent"}'   # 切换
curl -s localhost:8099/__mode                                 # 查看
```

`?mode=xxx` 查询参数可**单次覆盖**全局模式（一个桩同时演多种故障时用）。

## 二、演练项

模式定义与实现见 `stub_upstream.py` 的模块文档。下表「后端」列看 `.dev-logs/api.log`
与终端里的桩日志，「界面」列是抽屉里该看到的东西。

### 1. 正常基线（先跑它，确认链路本身是通的）

| mode | 操作 | 期望（后端） | 期望（界面） |
| --- | --- | --- | --- |
| `ok` | 发任意消息 | 桩收到 `POST /api/v1/chat/<id>`；无 5xx | 工具行两行（`get_project_overview · EXECUTING/FINISHED`）→ 逐字 → 定稿 `drill stub streaming reply.`；会话标题变成消息前缀 |

### 2. ERROR 事件（上游自报错——文案原样透出，不带码）

| mode | 操作 | 期望（后端） | 期望（界面） |
| --- | --- | --- | --- |
| `error_event` | 发消息 | 流末 `ERROR` 帧；**不是** 5xx | 半截文字 + 错误气泡，文案 `drill stub: upstream reported an error` |
| `fail_result` | 发消息 | `FINAL_RESULT success:false` 被映射成 error 终态（agent-vendor 实际用的失败形态，它不发 ERROR） | 半截文字 + 错误气泡 `drill stub: the platform refused this request` |

### 3. 断流（连接不再给结果——四种形态各有各的收尾）

| mode | 操作 | 期望（后端） | 期望（界面） |
| --- | --- | --- | --- |
| `drop` | 发消息 | 桩掐断连接 → 路由 catch → error 终态帧（`code=upstream_stream_failed`） | 半截文字 + **「连接中断，回复未完成」** |
| `empty` | 发消息 | 干净收尾但零事件 → 引擎合成 error（`code=stream_incomplete`） | 错误气泡 **「上游没有给出结果」** |
| `silent` | 发消息 | 响应头到了、一个字不发 → **60s 后**静默预算到期 → error 帧（`code=upstream_silent`） | 「正在思考…」持续约 60s → 错误气泡 **「上游长时间没有回应，本次回复已中断」** |
| `stall_mid` | 发消息 | 同上，但流里已有 token | 半截文字 + 同一个气泡（半截回复留在原地，不清空） |
| `heartbeat_only` | 发消息 | **不会**超时：心跳（`HEART_BEAT`）被映射忽略但**重置**静默预算 | 「正在思考…」一直转、不报错——这是设计预期（有心跳=连接活着）；手动关抽屉断开即可 |

> 静默预算的意义：没有它，上游挂死时这条 SSE 只能靠客户端断开结束（连接与 15s 心跳
> 永久占用）。`heartbeat_only` 这一项就是证明「预算测的是数据间隔，不是总时长」。

### 4. 限流（429——等一会儿就好，与「配置坏了」分开说）

| mode | 操作 | 期望（后端） | 期望（界面） |
| --- | --- | --- | --- |
| `ratelimit` | 发消息 | `429` + `Retry-After: 30` + 错误码 **2007**（不是 2006） | 错误气泡 **「上游限流，稍后重试」** |
| `ratelimit_create` | 点「新会话」 | 建会话腿 `429` + 2007 | toast **「上游限流，稍后重试」** |

### 5. 相邻形态（顺手验，属 2006「上游失败」一类）

| mode | 操作 | 期望（后端） | 期望（界面） |
| --- | --- | --- | --- |
| `http500` | 发消息 | `502` + 2006，message 带桩的 JSON 诊断 | 错误气泡（上游英文诊断，便于定位） |
| `bad_content_type` | 发消息 | 200 但回 JSON → 引擎判「不是事件流」→ `502` + 2006 | 同上 |

## 三、凭据可见性（门槛 2 / 12）

演练桩不校验 Key，正好用来确认**平台从不把 Key 送出去**：

1. 系统管理 → provider → 导出 JSON：**不含 apiKey**（模板里只有 `{{user.apiKey}}`）。
2. `GET /api/v1/assistant/my-agents`：secret 项只回键名（业务参数里没有 `apiKey` 的值）。
3. 抽屉「设置」卡：把 API Key 填进去 → 保存 → 再打开，输入框是「已配置」态而非明文。
4. **回归**：把 `apiKey` 塞进 `params` 提交（而不是 `secrets`）→ 必须 `400`
   （`param "apiKey" is a secret field: send it in "secrets"`）。
   ```bash
   curl -sX PUT localhost:3000/api/v1/assistant/my-agents/<providerId> \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"params":{"agentId":"1","apiKey":"leak-me"}}'
   ```
5. 浏览器网络面板里跑一次对话：请求/响应与 SSE 帧里**没有** Key。

## 四、与 13.5 验收门槛的对应

| 门槛 | 对应演练项 |
| --- | --- |
| 2 对话过程网络面板里没有上游 API Key | 第三节 5 |
| 3 `PROCESSING` 工具行如实显示工具名 | 第 1 节 `ok` |
| 5 上游停机：本地指令仍可用 + 聊天通道给出明确错误气泡 | 全部异常项（气泡）+ 各模式下跑一条 `/主题 深色` |
| 12 apiKey 任何响应不可见（写库即密、只回已配置） | 第三节 1–4 |
| 13 无 stop 能力的 provider 停止按钮不出现 | 与本演练无关（协议配置面） |
| 14 上游停机时 `/登出`、`/改密码`、`/设置` 可用 | 各异常模式下跑一遍三条账号指令 |

`/主题`、`/语言` 会写平台 API（故障时 toast 报错），`/帮助`、`/打开`、`/项目`、`/设置`、
`/改密码`、`/登出` 全本地、与上游无关。
