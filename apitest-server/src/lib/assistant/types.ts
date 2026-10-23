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
 *
 * ⚠️ **平台中立（2026-10-22）**：本契约只描述「一次上游的 HTTP/SSE 形状」，
 * 不绑定任何具体 agent 平台。协议里每个字段都必须对**任意**符合该形状的上游成立；
 * 某家产品的接口路径、事件名、信封只是**配置值**，不进默认值、注释示例或文案。
 */

/**
 * 归一事件——代理路由与前端唯一认知的事件形状。
 *
 * - `token`：文字增量，前端逐 token 追加进气泡；
 * - `tool`：工具执行状态（「正在调用 list_endpoints…」——用户能看见 AI 在调什么
 *   工具，信任的关键）；
 * - `elicit`：上游转述的 **MRTR 确认表单**（2026-09-15，P9-5 增补）。agent 的
 *   delete_* 类写工具被 /mcp 的 MRTR 闸门拦下后（首轮回 input_required 表单），
 *   上游运行时把确认请求转述进聊天 SSE。形状由 `sse.elicit` 配置（判别字段 + 取值 +
 *   各点路径，见 {@link AssistantSseMapping}）——**不假设**事件名、判别字段或路径，
 *   也不假设它与 token 是否同 kind。`tool` 是工具名，`input` 是该工具本回合最近
 *   一次调用的入参（从工具事件里记下，见 `sse.tool.input`——确认卡靠它定位删除
 *   目标），`schema` 是表单形状（MRTR 闸门恒为 boolean confirm）。确认动作不走上游
 *   （第三方 resume 通道不通用），走**本人 JWT 的既有 REST**——与 proposal 卡同一
 *   教义（P9-5 边界 3：写不经过 agent）。
 * - `done`：终态，`fullText` 是完整回复；
 * - `error`：终态，错误气泡。`code`（P9-8）只给**平台自己**分得清类别的失败打标
 *   （限流 / 上游静默 / 流无终态——见 AssistantErrorCode），前端按码换本地化文案；
 *   上游自己报的错（ERROR 事件、success:false）不带码，文案原样透出——那是上游
 *   说的话，平台不该替它改写。
 */
export type AssistantEvent =
  | { type: "token"; text: string }
  /** 思考增量（2026-10-22）：`text` 是**增量**（与 token 同语义，拼起来才是全文）；
   *  `newSegment` = 这一帧开启新的思考段（只有段首帧出现），前端据此另起一个折叠块。 */
  | { type: "thinking"; text: string; newSegment?: boolean }
  /** 工具执行状态更新。`callId` 是上游的工具调用 id（同一 id 多次推送 = 状态机流转，
   *  前端按它**合并**而不是每帧新增一行）；`kind` 是工具来源（MCP / SANDBOX / BUILTIN
   *  之类的上游字面量，原样透出）；`output` 是**脱敏后的结果正文**（2026-10-22，
   *  与历史 `parts` 的 `tool.output` 同形，前端折叠展示）。 */
  | { type: "tool"; name: string; status: string; callId?: string; kind?: string; output?: string }
  | {
    type: "elicit";
    text: string;
    tool: string;
    input?: Record<string, unknown>;
    schema?: unknown;
    allowResume?: boolean;
    /** 上游给这次确认的唯一 id（2026-10-22）：有它 + 配了 `elicitRespond` 才能回传。 */
    confirmId?: string;
    /** 上游的等待截止时刻（ISO 8601）——卡片倒计时**只**读它，超时后置灰。 */
    expiresAt?: string;
    /** 触发方（若上游给）：如 `PLATFORM` / `SERVER`；只用于文案选择，不参与判定。 */
    source?: string;
    /** 上游给的**入参摘要原文**（已抹敏、可能被截断）：确认卡靠它定位「哪个对象」。 */
    inputSummary?: string;
    /** 上游说这张卡是「同轮重放已执行过的工具」（2026-10-22）：确认卡要写清楚会再跑一次。 */
    duplicate?: boolean;
  }
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

/**
 * 历史端点：响应里消息数组的点路径 + 每条消息的字段点路径（id/role/text/time）。
 *
 * 分页能力（2026-10-22，全部可选）——**不配 `indexParam` 就按「一次全量取」处理**：
 * - `indexParam`：游标参数名（如 `index` / `beforeId` / `offset`）。配了才走分页。
 * - `pageSizeParam`（原名 `limitParam`，仍兼容）：**上游单次**条数参数名（如 `limit`）。
 * - `pageSize`（原名 `limitValue`，仍兼容）：每次请求给上游的条数（缺省 = 客户端要的
 *   那一页）。上游有硬上限（如 100）时，客户端要 500 ⇒ 引擎按 `indexParam`/游标
 *   **逐页回填并聚合**，最多 `maxPages` 页（缺省 10、上限 50）。

 * - `direction`：上游游标与「更早/更新」的关系——`cursor`（缺省：原样双向透传）、
 *   `offset`（从第几条开始）、`cursorFromEnd`（index = 距末尾第几条）。
 * - `totalPath`：响应里「还有没有更早的 / 总数」的点路径——取到布尔 ⇒ 当 `hasMore`，
 *   取到数字 ⇒ 当总数（两种都支持，不要求上游二选一）。
 *
 * query 模板（`query`）仍可用 `{{index}}` / `{{limit}}`；**不写模板也能工作**——
 * `indexParam` / `pageSizeParam` 会按参数名自动补进 query。
 */
export type AssistantHistoryEndpoint = AssistantEndpoint & {
  query?: Record<string, string>;
  messages: string;
  /**
   * 每行消息各列的点路径（`id` / `role` / `text` / `time` 必填，其余可选）：
   * - `parts`（2026-10-22，可选）：该行**片段数组**的点路径（如 `parts` 或
   *   `content.tool_calls`）——配了它历史就能把工具卡/思考放回原位；
   * - 片段元素里各列的点路径：`partsType`（判别，值大小写不敏感地匹配
   *   `text`/`thinking`/`tool`）、`partsText`（正文/思考文本）、`partsTool`（工具对象
   *   挂在哪一列，缺省 = 元素本身）、`partsToolName`/`partsToolStatus`/
   *   `partsToolInput`/`partsToolOutput`（缺省 `toolName`/`status`/`inputSummary`/`output`）。
   */
  fields: Record<string, string>;
  indexParam?: string;
  /** @deprecated 用 {@link pageSizeParam}（两者等义，读的时候取任一）。 */
  limitParam?: string;
  /** @deprecated 用 {@link pageSize}。 */
  limitValue?: number;
  pageSizeParam?: string;
  pageSize?: number;
  /**
   * 游标**来源**（两种写法，2026-10-22 与 doubleA 对齐后都支持）：
   * - `envelope`（缺省）：本页响应里"下一页该用的值"的**根相对点路径**最优先
   *   （如 `data.nextCursor`——服务端自己算好的，不必从数组推）；
   * - `rows`：本页**第一条**消息里的某一列（如 `id`，即 `beforeId` 形态）。
   * 两者都配时先试 envelope，取不到再退回 rows。
   */
  cursorSource?: "envelope" | "rows";
  cursorParam?: string;
  maxPages?: number;
  direction?: "cursor" | "offset" | "cursorFromEnd";
  totalPath?: string;
};

/**
 * 上游失败判定（**可选**，2026-10-22 通用化）：默认只看 HTTP 状态与信封 `success`
 * 字段之外的形状都算成功。两家常见方言都能用同一条配置表达：
 * - 业务码：`{ field: "code", ok: ["0"] }`（`code` 落在成功集合里即成功）；
 * - 布尔标记：`{ field: "success", not: true }`（该字段等于 `not` 即失败，其余成功）。
 * 两者可同时写（先看 ok，再看 not）；`ok` 为空且没写 `not` 时该条不生效。
 * `field` 是**根相对**点路径（信封不预剥 data，见 engine.ts#callJson）。
 */
export type AssistantSuccessRule = {
  field: string;
  ok?: string[];
  not?: boolean;
};

/** SSE 事件 → 归一事件的映射：eventField 是上游的事件类型字段。 */
export type AssistantSseMapping = {
  eventField: string;
  /** `success`（2026-10-22）：流式腿的失败判定——握手 HTTP 200 但正文是失败信封时
   *  （多数平台的常态错误形状），按协议配置在**首帧之前**拦成干净的 JSON 错误。 */
  token?: { on: string; text: string; success?: AssistantSuccessRule };
  /** 思考增量（2026-10-22）：`text` 是增量文本的点路径，`newSegment` 是「新段首帧」
   *  布尔点路径（可选）。不配 = 这一家的流没有思考帧。 */
  thinking?: { on: string; text: string; newSegment?: string };
  /** 工具帧映射。`status` 可省（缺 ⇒ `unknown`）；`callId` 用于同一次调用多帧合并；
   *  `kind` 是工具来源字面量；`input` 是入参的点路径——elicit 事件靠它带出删除目标；
   *  `output`（2026-10-22）是结果正文的点路径（可选，前端折叠展示）。 */
  tool?: { on: string; name: string; status?: string; nameFallback?: string; input?: string; callId?: string; kind?: string; output?: string };
  /** MRTR 确认表单的识别（2026-09-15，2026-10-22 通用化）：`on` 是事件名、`type` +
   *  `typeValue` 是同一条流里的判别字段与取值（判别字段可省——省了则该事件名
   *  整类都是表单）。命中判别值时按表单处理，否则继续走 token 映射。
   *  `tool` / `text` 必有；`schema` / `allowResume` 可选（见同名注释）。 */
  elicit?: {
    on: string;
    type?: string;
    typeValue?: string;
    text: string;
    tool: string;
    schema?: string;
    /** 上游是否回显「用户能否直接确认」（boolean 点路径）；缺省 = 平台自己判。 */
    allowResume?: string;
    /** 确认唯一 id 的点路径（2026-10-22）：有它才能把答复回传上游（见 `elicitRespond`）。 */
    confirmId?: string;
    /** 等待截止时刻的点路径（ISO 8601）——卡片倒计时读它。 */
    expiresAt?: string;
    /** 触发方的点路径（可选，只用于文案）。 */
    source?: string;
    /** 入参摘要的点路径（2026-10-22，推荐配）：卡片按它定位对象，parse 失败就显示原文。 */
    inputSummary?: string;
    /** 「同轮重复执行」标记的点路径（2026-10-22，可选）：`true` 时卡片提示会再跑一次。 */
    duplicate?: string;
  };
  done?: {
    on: string;
    text?: string;
    /** 旧形状：这个点路径取到 `false` / `"false"` 即失败。 */
    success?: string;
    /** 新形状（2026-10-22）：完整失败判定——如 `{field:"finishReason", ok:["COMPLETE"]}`。 */
    successRule?: AssistantSuccessRule;
  };
  /** `success`（2026-10-22）：error 事件本身也是 200 信封时的失败判定。 */
  error?: { on: string; message: string; success?: AssistantSuccessRule };
  ignore?: string[];
};

/**
 * 确认答复端点（**可选**，2026-10-22）：上游把「等用户点头」做成流里的确认卡时，
 * 答复走这条 HTTP，上游继续跑同一条流。不配 = 确认动作不走上游（保持旧行为）。
 *
 * 模板上下文：`{{conversationId}}` / `{{confirmId}}` / `{{tool}}` / `{{accepted}}`
 * （`{{accepted:boolean}}` 渲染成原始布尔，供 zod `z.boolean()` 的请求体）。
 */
export type AssistantElicitRespondEndpoint = AssistantEndpoint & {
  /** 响应里「是否真的生效」的点路径；`false` = 没人在等这个 id（**正常终局，不是失败**）。 */
  applied?: string;
  /** 响应里的会话 id 点路径（可选，只用于日志/自检）。 */
  id?: string;
};

/**
 * 会话级自动批准开关（**可选**，2026-10-22）：上游提供「本会话不再逐个确认」的端点时配它。
 * 开关状态在上游（会话级、过期自动复位），我们只负责下发开/关并回显结果。
 *
 * 与卡片上的本地「自动批准」的区别：本地那档是**代点确认**（仍然发 `POST /elicit`），
 * 这档是让上游**根本不发 confirm 事件**——配了这个就优先走它。
 */
export type AssistantAutoApproveEndpoint = AssistantEndpoint & {
  /** 响应里「当前开关状态」的点路径（布尔）：用来确认生效并按它回显开关。 */
  result?: string;
};

/**
 * 一份通用协议配置（provider 行的 `protocol` 列）。形状由 engine.ts 消费；写入侧
 * 只做浅校验（baseUrl/必备端点/事件字段），深对错由测试连接用真上游回答——与
 * P9-3 的取舍一致：schema 校验说不了「配置能用」。
 */
export type AssistantProtocol = {
  baseUrl: string;
  auth?: { header: string; value: string };
  /** 旧版业务码形状（=`{ field, ok: [value] }` 的简写）。新配置用 {@link success}。 */
  successCode?: { field: string; value: string };
  /** 信封失败判定（**可选**，2026-10-22）。不配 = 只看 HTTP 状态码。 */
  success?: AssistantSuccessRule;
  createConversation: AssistantCreateEndpoint;
  chat: AssistantEndpoint;
  stop?: AssistantEndpoint;
  /** 删上游会话本体（可选；有则抽屉删除时顺带清上游，没有则只删本地映射行）。 */
  delete?: AssistantEndpoint;
  history?: AssistantHistoryEndpoint;
  /** 消息带附件时是否把 attachments 数组并进 chat 请求体。 */
  attachments?: boolean;
  /** 确认答复端点（可选；不配则确认不走上游）。 */
  elicitRespond?: AssistantElicitRespondEndpoint;
  /** 会话级自动批准端点（可选；配了「自动批准」就是开关而不是代点确认）。 */
  autoApprove?: AssistantAutoApproveEndpoint;
  /** `attachmentsField`（2026-10-22）：附件数组并进 chat 请求体的字段名，缺省
   *  `attachments`。附件元素形状固定为 `{ fileUrl, fileName?, mimeType }`。 */
  attachmentsField?: string;
  /** `streamEnd`（2026-10-22）：终帧之后上游**仍不断流**时怎么办。
   *  `"close"`（缺省）= 收到 done/error 后主动断开；`"continue"` = 读到流结束。 */
  streamEnd?: "close" | "continue";
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
/**
 * 历史里的一条消息的**片段**（2026-10-22）：上游把"正文 / 思考 / 工具卡"按时间线
 * 拍平在同一个数组里（如 doubleA 的 `?parts=timeline` 的 `parts[]`）。形状由上游定，
 * 平台只把 `type` 归一成三种：
 * - `text`：正文片段（拼在正文里，位置就是它出现的位置）；
 * - `thinking`：思考片段（折叠展示）；
 * - `tool`：工具卡（名称 + 状态 + 可选入参/输出）。
 * 认不出的类型**原样忽略**（上游加新片段类型时旧配置不掉线）。
 */
export type AssistantMessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; status: string; input?: string; output?: string };

export type AssistantChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  time?: string;
  /** 按上游时间线的片段；只有协议配了 `history.fields.parts` 才有。 */
  parts?: AssistantMessagePart[];
};

export type AssistantHistoryOptions = {
  /** 前端游标（含义由协议 `history.direction` 决定）；`from: "end"` 时忽略。 */
  index?: string;
  limit?: number;
  /**
   * 取哪一头（2026-10-22）：`end`（缺省）= 最近的一批；`start` = 继续往更早/更新的方向
   * 翻（方向由 `direction` 与 `cursor` 决定）。前端「加载更早」用 `start` + `cursor`。
   */
  from?: "end" | "start";
  cursor?: string;
};
