/**
 * 站内助手的通用协议契约（P9-4b，2026-09-14 修订——取代 P9-2 的 adapter 契约）。
 *
 * 平台不实现 agent：这条链路是
 *   浏览器 → 平台助手代理（只转发 SSE）→ 外部 agent 平台 → 平台 /mcp → 库
 *
 * **通用模式**：上游接入不再写 per-platform adapter 代码，而是管理员在系统管理里填
 * 一份**协议配置**（4 个接口 + SSE 事件映射 + 认证模板），引擎（engine.ts）按配置
 * 执行——换平台 = 填 4 个接口，零开发。凭据是**用户级**的：provider 行只带协议与
 * 「用户要填哪些参数」的模式（user_params），每个用户自配（assistant_user_agents
 * 表，secret 项 AES-GCM 加密），系统不存共享 Key。
 *
 * 归一事件（代理路由与前端唯一认知的事件形状）不变：
 * - `token`：文字增量；`tool`：工具执行状态；`done`：终态（fullText 权威全文）；
 *   `error`：终态。流必须以 done/error 收尾（上游断流无终态时由引擎合成）。
 */

/**
 * 归一事件——代理路由与前端唯一认知的事件形状。
 *
 * - `token`：文字增量，前端逐 token 追加进气泡；
 * - `tool`：工具执行状态（「正在调用 list_endpoints…」——用户能看见 AI 在调什么
 *   工具，信任的关键）；
 * - `elicit`：上游转述的 **MRTR 确认表单**（2026-09-15，P9-5 增补）。agent 的
 *   delete_* 类写工具被 /mcp 的 MRTR 闸门拦下后（首轮回 input_required 表单），
 *   上游运行时把确认请求转述进聊天 SSE（agent-vendor 形态：MESSAGE 事件 +
 *   `data.type=ELICITATION` + `elicitationSchema` + `toolCallId`）。`tool` 是工具
 *   名，`input` 是该工具本回合最近一次调用的入参（从 PROCESSING 事件里记下——
 *   确认卡靠它定位删除目标），`schema` 是表单形状（MRTR 闸门恒为 boolean
 *   confirm）。确认动作不走上游（第三方 resume 通道未开放），走**本人 JWT 的
 *   既有 REST**——与 proposal 卡同一教义（P9-5 边界 3：写不经过 agent）。
 * - `done`：终态，`fullText` 是完整回复；
 * - `error`：终态，错误气泡。`code`（P9-8）只给**平台自己**分得清类别的失败打标
 *   （限流 / 上游静默 / 流无终态——见 AssistantErrorCode），前端按码换本地化文案；
 *   上游自己报的错（ERROR 事件、success:false）不带码，文案原样透出——那是上游
 *   说的话，平台不该替它改写。
 */
export type AssistantEvent =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; status: string }
  | { type: "elicit"; text: string; tool: string; input?: Record<string, unknown>; schema?: unknown }
  | { type: "done"; fullText: string }
  | { type: "error"; message: string; code?: AssistantErrorCode };

/**
 * 平台能自己判定的错误类别（P9-8 上游异常演练）：
 * - `rate_limited`：上游 HTTP 429（可带 Retry-After）——等一会儿就好，不是坏配置；
 * - `upstream_silent`：上游接了请求但静默超时（见 STREAM_IDLE_TIMEOUT_MS）——连着
 *   却一个字不发，只靠客户端断开兜底会让这条流永远挂着；
 * - `stream_incomplete`：流正常结束但没有终态事件，且一个字都没收到——上游把连接
 *   收干净了却没给结果；
 * - `upstream_stream_failed`：流**中途**的传输级失败（连接被掐断、chunked 体截断）——
 *   路由层 catch 到的那一类。前三种由引擎判定，这一种只有路由知道（hijack 之后）。
 */
export type AssistantErrorCode = "rate_limited" | "upstream_silent" | "stream_incomplete" | "upstream_stream_failed";

/**
 * 用户参数模式（管理员在 provider 上定义，抽屉「设置」卡按它渲染表单）：
 * `key` 进模板占位符（{{user.agentId}}），`secret` 项加密落库、接口只回「已配置」。
 */
export type AssistantUserParam = {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
};

/** 一个接口端点的定义：方法 + 路径模板 + 请求体模板（值里的 {{…}} 渲染时展开）。 */
export type AssistantEndpoint = {
  method: string;
  path: string;
  body?: Record<string, unknown>;
};

/** 建会话端点：多一条「会话 id 在响应信封的哪个点路径」。 */
export type AssistantCreateEndpoint = AssistantEndpoint & { conversationId: string };

/** 历史端点：响应里消息数组的点路径 + 每条消息的字段点路径（id/role/text/time）。 */
export type AssistantHistoryEndpoint = AssistantEndpoint & {
  query?: Record<string, string>;
  messages: string;
  fields: Record<string, string>;
};

/** SSE 事件 → 归一事件的映射：eventField 是上游的事件类型字段（如 eventType）。 */
export type AssistantSseMapping = {
  eventField: string;
  token?: { on: string; text: string };
  /** `input`（2026-09-15）：工具调用入参的点路径——elicit 事件靠它带出删除目标
   *  （agent-vendor 的 PROCESSING 事件把入参放在 data.result.input）。 */
  tool?: { on: string; name: string; status: string; nameFallback?: string; input?: string };
  /** MRTR 确认表单的识别（2026-09-15）：与 token 同 kind，靠 data 里的判别字段区分
   *  （agent-vendor：kind=MESSAGE 且 data.type=ELICITATION）。未命中判别值时继续走 token
   *  映射——同一条 MESSAGE 流里两种事件混着来。 */
  elicit?: { on: string; type: string; typeValue: string; text: string; tool: string; schema: string };
  done?: { on: string; text: string; success?: string };
  error?: { on: string; message: string };
  ignore?: string[];
};

/**
 * 一份通用协议配置（provider 行的 `protocol` 列）。形状由 engine.ts 消费；写入侧
 * 只做浅校验（baseUrl/必备端点/事件字段），深对错由测试连接用真上游回答——与
 * P9-3 的取舍一致：schema 校验说不了「配置能用」。
 */
export type AssistantProtocol = {
  baseUrl: string;
  auth?: { header: string; value: string };
  successCode?: { field: string; value: string };
  createConversation: AssistantCreateEndpoint;
  chat: AssistantEndpoint;
  stop?: AssistantEndpoint;
  /** 删上游会话本体（可选；有则抽屉删除时顺带清上游，没有则只删本地映射行）。 */
  delete?: AssistantEndpoint;
  history?: AssistantHistoryEndpoint;
  /** 消息带附件时是否把 attachments 数组并进 chat 请求体。 */
  attachments?: boolean;
  sse: AssistantSseMapping;
};

/**
 * 一份可调度的 provider（providers.ts 从行解出）。协议原样携带；没有共享 Key——
 * 凭据在用户行上（AssistantUserAgentRuntime）。
 */
export type AssistantProviderRuntime = {
  id: string;
  name: string;
  protocol: AssistantProtocol;
  enabled: boolean;
  isDefault: boolean;
};

/** 一个用户的 agent 配置：params 是明文参数 + 解密后的 secret（只在调上游的这一
 *  瞬间存在，不进日志、不回响应）。 */
export type AssistantUserAgentRuntime = {
  providerId: string;
  params: Record<string, string>;
  isDefault: boolean;
};

/** 附件按上游契约原样转发（fileUrl 由上游拉取，平台不经手文件本体）。 */
export type AssistantAttachment = {
  fileUrl: string;
  fileName?: string;
  mimeType: string;
};

export type AssistantMessageInput = {
  message: string;
  attachments?: AssistantAttachment[];
  /** 客户端断开时由路由层触发——abort 既砍未完成的 fetch 也砍正在读的流。 */
  signal?: AbortSignal;
};

/** 历史消息的归一形态（上游字段名各异，协议配置的 fields 映射负责翻译）。 */
export type AssistantChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  time?: string;
};

export type AssistantHistoryOptions = {
  index?: string;
  limit?: number;
};
