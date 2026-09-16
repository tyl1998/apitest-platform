# 问题记录：助手 MRTR 删除确认被当普通文字吞掉（2026-09-15）

> 验收场景：用户在助手抽屉里让 agent 删除一个环境（delete_environment 是 MRTR
> 闸门工具），agent 回复「系统已向你发送了一个确认表单」，但抽屉里**什么表单都没
> 有**——「删除操作没有正常返回」。本文按 现象 / 根因 / 修法 / 状态 归档。

## 现象

- 抽屉里让 agent「删除 test 环境」：`delete_environment` 工具行 EXECUTING→FINISHED，
  agent 文字说「已发送确认表单，请确认后我才能继续」——但消息流里没有任何可点的
  确认入口；用户在聊天里回「确认」也无效（LLM 重调工具，又被闸门拦下，循环）。
- 复现路径（2026-09-15，agent-vendor-stg + agentId 38 + read/write/execute 全 scope MCP
  Token）：直连上游 SSE 抓包可见确认请求确实到达了聊天流。

## 根因（链路三段，逐段实测定位）

1. **/mcp 侧（平台）工作正常**：delete_* 类工具首轮回 `input_required` + 表单
   （`mcpToolResult.ts` 的 `mrtrRequired`）。agent-vendor 运行时用**现代 per-request 线路**
   （2026-07-28 信封：`MCP-Protocol-Version` + `Mcp-Method/Mcp-Name` 头 +
   `params._meta.io.modelcontextprotocol/*`）调 /mcp，input_required 正常送达；
   运行时暂停动作（给 LLM 注入 `[ACTION PAUSED]`），把确认请求转述进聊天 SSE。
2. **转述形态**：不是独立 eventType，而是 `eventType: "MESSAGE"` 事件里
   `data.type === "ELICITATION"`，载荷带 `text`（确认文案）、`toolCallId`（工具名）、
   `elicitationSchema`（boolean confirm 表单）。
3. **平台引擎吞表单（真根因）**：`engine.ts` 的 token 映射（`MESSAGE → data.text`）
   把它当普通文字增量处理——文案混进气泡，**schema / 工具名整体丢弃**；前端无从
   渲染表单，也无从回传确认。

### 附带发现（上游侧，平台不可控）

- agent-vendor 第三方面的应答通道 `POST /api/v1/chat/resume-elicitation`
  （`{conversationId, inputResponses: {confirm: {action, content}}}`——其自家 UI 走
  `/api/agent/…` 同名端点 + 会话 Cookie）对 **API-Key 会话稳定回 5000「系统开小差」**
  （新会话 + 与其 UI 完全同形的 payload 多轮复现）。上游修复前，聊天内的确认动作
  无法经上游回传。

## 修法（2026-09-15 落地）

- **引擎识别确认表单**：协议映射新增 `sse.elicit`（判别字段 `data.type=ELICITATION`，
  与 token 同 kind、判别值分流；未配置的 provider 不受影响）+ `sse.tool.input`
  （工具入参路径，确认卡靠它拿删除目标 id）；产出新归一事件
  `{type:"elicit", text, tool, input, schema}`（`types.ts` / `engine.ts`）。
- **迁移 060**：给「token.on=MESSAGE 且 tool.on=PROCESSING」形状的 provider 协议
  （agent-vendor 方言签名，不点名）补上述两块映射。
- **前端确认表单卡**（`AssistantElicitationCard.tsx` + AssistantDock 落块渲染）：
  确认文案 + 后果摘要 + 「确认删除 / 放弃」；**确认动作不走上游**（第三方 resume
  通道 5000，见上），走**本人 JWT 的既有 REST**（`GET usage` → 无独占依赖直接删、
  有则列清单等「仍要删除」二段，与环境页同款语义）——与 P9-5 proposal 卡同一教义
  （边界 3：写不经过 agent，审计 created_by 是本人）。v1 工具枚举只
  `delete_environment`，未知工具渲染只读卡引导页面操作。
- **provider 编辑面板防回退**：`AssistantProvidersPanel` 的 `buildInput` 从零重建
  protocol，会把表单不认识的键（elicit / tool.input）在保存时悄悄剥掉——改为以
  原协议为底、表单管理的字段覆盖、未管理子键保留。
- 验证（2026-09-15 实测）：同链路重发删除请求，归一事件流出现
  `event: elicit`（text + tool + input.environmentId + schema 齐全）；前后端
  `pnpm check` 通过。上游 resume 通道恢复后可把确认动作切回 MCP 往返（代码形状已
  按「枚举映射」留好）。

## 状态

已修复（引擎映射 + 迁移 060 + 前端确认卡）。上游 `/api/v1/chat/resume-elicitation`
对 API-Key 会话 5000 的问题属 agent-vendor 侧，待其修复后可切回协议往返。

## 后续两轮（2026-09-15 用户实测确认卡后的反馈）

### ① 确认删除后聊天记录里没有这条记录

- **现象**：确认卡点「确认删除」、环境已删，但历史回放里确认记录消失。
- **根因**：确认动作走本人 JWT 的既有 REST，上游 transcript 不知道这件事；确认
  卡终态只存前端本地（elicitStates），回放整桶替换后自然消失。对话正文归上游，
  平台的确认动作却没有平台侧的落点。
- **修法**：`assistant_conversations` 加 `elicit_log` jsonb（迁移 061，追加式动作
  日志）；新路由 `POST …/conversations/:id/elicit` 记录 `{tool, input, outcome,
  at}`（写失败静默——业务事实以删除本身的审计为准）；历史代理把日志按时间戳并回
  成 system 行（从尾回扫插入；取不到时间缀尾），有记录时关掉 60s 短缓存免得刚记
  的确认被缓存吞掉；前端回放按 i18n 渲染系统气泡，确认落定时同步落本地系统气泡
  + 调记录接口。实测：POST 记录 → GET messages 出现 system 行（含 tool/outcome/
  input 结构化载荷）。
- **状态**：已修复。

### ② agent 回复里的 `<div><markdown-custom-process …/></div>` 裸标签

- **现象**：agent 最终回复（outputText）里夹 agent-vendor 自家的过程组件标记，抽屉里
  整段裸 HTML 进气泡。
- **根因**：react-markdown 默认不解析原始 HTML（安全底线，刻意不放开），标记按
  文本显示；工具执行状态我们另有呈现（PROCESSING 事件 → 工具行），这些标记对本
  平台是重复噪音。
- **修法**：`AssistantMarkdown` 进解析器前剥掉 `markdown-custom-process` 标记
  （覆盖自闭合与配对写法；只剥这一种已知标记，不做泛化 HTML 清洗——代码块里教
  HTML 的合法内容不该被误伤）。渲染层剥离同时覆盖实时 done 全文与历史回放两条
  路径。
- **状态**：已修复。
