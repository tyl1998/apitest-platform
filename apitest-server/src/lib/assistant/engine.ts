/**
 * 通用协议引擎（P9-4b，2026-09-14 修订）：按 provider 行上的协议配置调上游 agent
 * 平台，产出归一事件——取代 P9-2 的「每平台一个 adapter 文件 + 注册表」。换平台 =
 * 管理员填 4 个接口（建会话 / 发消息 SSE / 停止 / 历史）+ SSE 映射 + 认证模板，
 * 这里零改动。
 *
 * 模板语法（有意的最小词汇表）：`{{user.agentId}}` / `{{conversationId}}` /
 * `{{message}}` / `{{index}}` / `{{limit}}`。值整体是一个占位符且渲染结果是数字时
 * 按数字进 JSON（数字型 agentId / conversationId 靠这条）；其余按字符串。
 *
 * 终态纪律：done/error 收尾；上游断流无终态时合成
 * done（token 累计值）或 error（一个字都没收到）；消费方提前 return()（客户端
 * 断开）只做清理、不合成——没人听的事件没有意义。
 *
 * 上游异常（P9-8）：三种形态各有交代——① 限流（HTTP 429）：抛
 * `AssistantUpstreamError`（带 status / Retry-After），路由据此回独立错误码与
 * 重试提示；② 静默（接了请求却一个字不发）：聊天腿有**静默预算**
 * （STREAM_IDLE_TIMEOUT_MS），超预算以 `upstream_silent` 错误终态收尾——没有
 * 这条兜底时这条流只靠客户端断开结束，上游挂死即永久占用连接与心跳；③ 上游
 * 自报 ERROR 事件 / success:false：按错误终态映射，文案是上游说的话，原样透出。
 */
import type {
  AssistantAttachment,
  AssistantChatMessage,
  AssistantEndpoint,
  AssistantEvent,
  AssistantHistoryEndpoint,
  AssistantHistoryOptions,
  AssistantMessageInput,
  AssistantMessagePart,
  AssistantProtocol,
  AssistantProviderRuntime,
  AssistantSuccessRule,
  AssistantUserAgentRuntime,
} from "./types.js";
import { SseDataParser, type SsePayload } from "./sse.js";

/** 工具结果正文的截断上限（2026-10-22）：一次调用的输出可能几十 KB，界面里只当证据看。 */
const TOOL_OUTPUT_MAX_CHARS = 4000;

/** 一问一答接口（建会话 / 停止 / 历史）的预算。 */
const JSON_TIMEOUT_MS = 15_000;

/**
 * 聊天腿的**静默预算**（P9-8）：上游响应头已到、但连续这么久一块数据都没有。
 * 一问一答腿有 AbortSignal.timeout 兜底，流式腿不能挂整体超时（长回答本就该慢慢
 * 流），只需要「还活着吗」的判据——上游心跳（被 ignore 映射吸收但照样重置预算）
 * 与模型吐字都算活着。60s 比上游 15s 心跳宽裕，又不至于让用户对着空气等太久。
 */
const STREAM_IDLE_TIMEOUT_MS = 60_000;

/** 错误消息截断：上游偶发把整页 HTML 塞进错误体，原样透传只会淹没日志。 */
const MAX_ERROR_TEXT = 300;

/**
 * 上游 HTTP 层的失败（P9-8）：带 status 与 Retry-After，让路由分得清「限流，
 * 等会儿再来」与「真坏了」（429 与 500 对用户的处置动作完全不同）。业务码型
 * 失败（HTTP 200 + successCode 不匹配）也走这里，status 如实是 200。
 */
export class AssistantUpstreamError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "AssistantUpstreamError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** 上游静默（读超时）：不是传输错误——连接还在，只是没有数据。 */
class UpstreamSilentError extends Error {}

const STREAM_SILENT_MESSAGE = `assistant upstream went silent (no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s)`;

type RenderContext = {
  user: Record<string, string>;
  conversationId?: string;
  message?: string;
  index?: string;
  limit?: string;
  /** 确认答复用（2026-10-22）：`{{confirmId}}` / `{{tool}}` / `{{accepted:boolean}}`。 */
  confirmId?: string;
  tool?: string;
  accepted?: string;
  /** 会话级自动批准开关（2026-10-22）：`{{autoApprove:boolean}}`。 */
  autoApprove?: string;
};

function brief(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat ? `: ${flat.slice(0, MAX_ERROR_TEXT)}` : "";
}

/** Retry-After 归一成秒数（RFC 允许秒数或 HTTP-date 两种形态；上限一小时——
    上游给的天文数字不该变成用户要等的时长）。解析不出就不带提示。 */
function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  const clamp = (value: number) => Math.min(Math.max(Math.round(value), 0), 3600);
  if (Number.isFinite(seconds) && seconds >= 0) return clamp(seconds);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : clamp((date - Date.now()) / 1000);
}

/** 429 → 限流（可带 Retry-After 秒数）；其余失败 undefined（按普通上游失败处理）。
    只认 429：503 也可能带 Retry-After，但那是「服务不可用」，告诉用户「稍后重试」
    会把排查方向带偏。 */
export function upstreamRateLimit(error: unknown): { retryAfter?: number } | undefined {
  if (!(error instanceof AssistantUpstreamError) || error.status !== 429) return undefined;
  return { retryAfter: error.retryAfter };
}

/** 点路径取值（不 travers 数组、不支持转义——协议配置是管理员写的受信输入）。
    `root` 返回整棵树：事件名本身就是载荷时（`data:"MESSAGE"`）用它。 */
function pick(source: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  if (path === "root") return source;
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 事件种类归一：各家把种类放在事件名、`data.event`、`data.type` 甚至载荷本身。
    全部转成大写串比较，方言差异由协议配置的 `on` 吸收。
    ⚠️ 点路径取不到值时**退回 SSE 的 `event:` 行**（2026-10-22）：标准 SSE 把种类放在
    事件行里（`event: delta` + `data: {"text":"…"}`），此时 `eventField` 只是给配置
    一个占位（写成 `event` 即可），不该因为它取不到值就把整帧当噪音丢掉。 */
function kindOf(source: unknown, path: string, eventName?: string): string {
  const value = pick(source, path);
  const fromPayload = value === undefined || value === null ? "" : String(value).trim().toUpperCase();
  if (fromPayload) return fromPayload;
  return String(eventName ?? "").trim().toUpperCase();
}

function sameKind(value: unknown, expected: string | undefined): boolean {
  return expected !== undefined && String(value ?? "").trim().toUpperCase() === expected.trim().toUpperCase();
}

/** 文本候选路径 `a|b|c`：按序取第一个**非空串**的值（数字/布尔也算，统一 String）。
    同一家平台常把正文放在 `data.text` / `data.content` / `content` 之一，配置一处
    写全，代码不为方言分支。 */
function firstOf(source: unknown, candidates: string): string | undefined {
  for (const candidate of candidates.split("|")) {
    const path = candidate.trim();
    if (!path) continue;
    const value = pick(source, path);
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (text !== "") return path;
  }
  return undefined;
}

/** 占位符语法：`{{path}}`，可选类型提示 `{{path:boolean}}` / `{{path:number}}`（2026-10-22）。 */
const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)(?::(boolean|number))?\s*\}\}/g;

/** 字符串模板渲染：{{path}} 展开；缺值渲染为空串（必填项由路由层先验过）。 */
function render(template: string, context: RenderContext): string {
  return template.replace(PLACEHOLDER, (_, path: string, kind?: string) => {
    const value = path === "user" ? undefined : pick(context, path);
    if (value === undefined || value === null) return "";
    const text = String(value);
    /* 显式类型提示（`{{accepted:boolean}}`）：把 "true"/"1"/"0"/"false" 归一成合法 JSON
       标量文本，供 renderBody 还原成原始布尔/数字。上游的 `z.boolean()` 拒收字符串
       "true"，而"渲染结果恰好能被 JSON.parse"是隐式且脆的契约——两种都认。 */
    if (kind === "boolean") {
      const lower = text.trim().toLowerCase();
      if (lower === "true" || lower === "1" || lower === "yes") return "true";
      if (lower === "false" || lower === "0" || lower === "no" || lower === "") return "false";
      return text;
    }
    if (kind === "number") {
      const parsed = Number(text);
      return Number.isFinite(parsed) ? String(parsed) : text;
    }
    return text;
  });
}

/** 请求体模板渲染：字符串值整体是占位符且渲染结果可解析为 JSON 标量时用标量
    （数字型 id / 布尔 accepted 不加引号），否则保持字符串；非字符串值原样透传。 */
function renderBody(body: Record<string, unknown> | undefined, context: RenderContext): Record<string, unknown> | undefined {
  if (!body) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") { result[key] = value; continue; }
    const rendered = render(value, context);
    const whole = value.trim().match(/^\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)(?::(boolean|number))?\s*\}\}$/);
    if (whole) {
      const kind = whole[2];
      if (kind === "boolean" && (rendered === "true" || rendered === "false")) {
        result[key] = rendered === "true";
        continue;
      }
      if (kind === "number" && rendered !== "" && Number.isFinite(Number(rendered))) {
        result[key] = Number(rendered);
        continue;
      }
      try {
        const scalar = JSON.parse(rendered) as unknown;
        if (typeof scalar === "number" || typeof scalar === "boolean" || scalar === null) {
          result[key] = scalar;
          continue;
        }
      } catch { /* 保持字符串 */ }
    }
    result[key] = rendered;
  }
  return result;
}

/**
 * 信封失败判定（2026-10-22 通用化）：`successCode` 是旧形状的简写，归一成一条
 * {@link AssistantSuccessRule}；两条都配时 `success` 说了算（新形状的表达力是它的
 * 超集），只配 `successCode` 时行为与旧版逐字一致。不配任何一条 = 只看 HTTP 状态码。
 */
function successRuleOf(protocol: AssistantProtocol): AssistantSuccessRule | undefined {
  const explicit = protocol.success;
  const legacy = protocol.successCode;
  if (explicit) return explicit;
  if (legacy && legacy.field && legacy.value !== undefined) return { field: legacy.field, ok: [String(legacy.value)] };
  return undefined;
}

/** 按规则判信封是否失败；规则缺省/形状不全时按成功（与旧行为逐字一致）。
    两条并列：`ok`（取值不在成功集合里 = 失败，**或**取不到值 = 失败）与
    `not`（等于该值 = 失败）。都配时任一命中即失败。 */
function violatesSuccessRule(rule: AssistantSuccessRule | undefined, source: unknown): boolean {
  if (!rule || !rule.field) return false;
  const actual = pick(source, rule.field);
  const asText = actual === undefined || actual === null ? "" : String(actual);
  const missing = actual === undefined || actual === null;
  if (rule.ok?.length) {
    if (missing) return true;
    if (!rule.ok.map((item) => String(item)).includes(asText)) return true;
  }
  if (rule.not !== undefined) {
    const asBool = typeof actual === "boolean" ? actual : asText.trim().toLowerCase() === "true";
    if (actual === rule.not || asBool === rule.not) return true;
  }
  return false;
}

function endpointUrl(provider: AssistantProviderRuntime, endpoint: AssistantEndpoint, context: RenderContext): string {
  return `${provider.protocol.baseUrl.replace(/\/+$/, "")}${render(endpoint.path, context)}`;
}

function authHeaders(provider: AssistantProviderRuntime, context: RenderContext): Record<string, string> {
  const auth = provider.protocol.auth;
  if (!auth) return {};
  /* header 名进 Headers 前压成小写（fetch 本来也会归一），值模板带用户凭据。 */
  return { [auth.header.toLowerCase()]: render(auth.value, context) };
}

/**
 * 一问一答接口的公共腿：渲染 → fetch → 等 JSON 信封 → {@link violatesSuccessRule} 判定
 * （HTTP 200 但业务码/布尔标记不对是这类平台的常态错误形状；都没配则只看 HTTP）。
 * 返回**响应根对象**——协议里的响应路径（conversationId / messages）都是根相对的，
 * 不在这里预剥 data（剥了会让「路径填 data」再解一层、数字型 id 当场取空——
 * 2026-09-14 用户实测踩中）。
 */
async function callJson(provider: AssistantProviderRuntime, endpoint: AssistantEndpoint, context: RenderContext): Promise<unknown> {
  const init: RequestInit = {
    method: endpoint.method.toUpperCase(),
    headers: { accept: "application/json", ...authHeaders(provider, context) },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  };
  const body = renderBody(endpoint.body, context);
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(endpointUrl(provider, endpoint, context), init);
  const text = await response.text().catch(() => "");
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    parsed = undefined;
  }
  const businessOk = !violatesSuccessRule(successRuleOf(provider.protocol), parsed);
  if (!response.ok || !businessOk) {
    throw new AssistantUpstreamError(
      `assistant upstream request failed (HTTP ${response.status})${brief(parsed?.message ? String(parsed.message) : text)}`,
      response.status,
      retryAfterSeconds(response.headers),
    );
  }
  return parsed;
}

/** 建会话：会话 id 在响应信封的点路径上（conversationId 配置项）。 */
export async function engineCreateConversation(provider: AssistantProviderRuntime, agent: AssistantUserAgentRuntime): Promise<string> {
  const context: RenderContext = { user: agent.params };
  /* 响应路径是根相对的（callJson 不预剥 data）：填 data 或 id 取决于上游信封形状。 */
  const envelope = await callJson(provider, provider.protocol.createConversation, context);
  const conversationId = pick(envelope, provider.protocol.createConversation.conversationId);
  const text = conversationId === undefined || conversationId === null ? "" : String(conversationId).trim();
  /* 空值在这里拦下，别让一个空串混进映射表。 */
  if (!text) throw new Error("assistant upstream did not return a conversation id");
  return text;
}

export async function engineStop(provider: AssistantProviderRuntime, agent: AssistantUserAgentRuntime, upstreamConversationId: string): Promise<void> {
  const endpoint = provider.protocol.stop;
  if (!endpoint) throw new Error("this provider does not define a stop endpoint");
  await callJson(provider, endpoint, { user: agent.params, conversationId: upstreamConversationId });
}

/** 删上游会话本体（协议配了 delete 端点才可调，路径里用 `{{conversationId}}`）。
 *  本地映射行由路由层删——两处删除的事务性不追求：上游失败不该留住本地映射。 */
export async function engineDeleteConversation(provider: AssistantProviderRuntime, agent: AssistantUserAgentRuntime, upstreamConversationId: string): Promise<void> {
  const endpoint = provider.protocol.delete;
  if (!endpoint) throw new Error("this provider does not define a delete endpoint");
  await callJson(provider, endpoint, { user: agent.params, conversationId: upstreamConversationId });
}

/** 历史单次请求的条数上限（**只看上限、不看默认**）：上游一次能给更多就多拿，与路由的
 *  `limit`（界面一页）分开——路由不传条数时，这里按「尽量全取」发（2026-10-22）。 */
const HISTORY_MAX_LIMIT = 500;

/**
 * 一次历史读的响应 → `{rows, total, hasMore}`。
 * - `total`：`totalPath` 取到**数字**时是总条数；取不到/不是数字 ⇒ `null`。
 * - `hasMore`：`totalPath` 取到**布尔**时就是它（上游不报总数、只报"还有没有更早的"，
 *   例如 `data.hasMore`——2026-10-22 与 doubleA 对齐时定下的形状）。
 */
function readHistoryEnvelope(
  envelope: unknown,
  endpoint: AssistantHistoryEndpoint,
): { rows: unknown[]; total: number | null; hasMore: boolean | null; envelope: unknown } {
  const rows = pick(envelope, endpoint.messages);
  const rawTotal = endpoint.totalPath ? pick(envelope, endpoint.totalPath) : undefined;
  const total = typeof rawTotal === "number" && Number.isFinite(rawTotal)
    ? Math.max(Math.trunc(rawTotal), 0)
    : typeof rawTotal === "string" && /^\d+$/.test(rawTotal.trim()) ? Number(rawTotal.trim()) : null;
  const hasMore = typeof rawTotal === "boolean" ? rawTotal : null;
  return { rows: Array.isArray(rows) ? rows : [], total, hasMore, envelope };
}

/**
 * 回传确认答复（2026-10-22）：上游在流里给了 `confirmId`、协议又配了 `elicitRespond`
 * 时走这里；否则调用方不该调它（前端卡片此时走本地 REST 的旧路径）。
 *
 * 返回 `{applied, conversationId}`：
 * - `applied === false` ⇒ 上游 200 + 成功信封，但「没人在等这个 id」（超时/已被处理/
 *   迟到点击）——**正常终局，不是失败**，调用方应如实记录并不重试；
 * - `applied === null` ⇒ 协议没配 `applied` 路径，只看 HTTP + success 规则；
 * - 非 2xx / 信封失败 ⇒ 抛 `AssistantUpstreamError`（调用方转 `failUpstream`）。
 *
 * `accepted` 以**原始布尔**进请求体（模板写 `{{accepted:boolean}}` 或裸 `{{accepted}}`
 * 都能落到布尔——见 renderBody）。
 */
export async function engineRespondElicitation(
  provider: AssistantProviderRuntime,
  agent: AssistantUserAgentRuntime,
  upstreamConversationId: string,
  answer: { confirmId: string; tool: string; accepted: boolean },
): Promise<{ applied: boolean | null; conversationId: string | null }> {
  const endpoint = provider.protocol.elicitRespond;
  if (!endpoint) throw new Error("this provider does not define an elicitRespond endpoint");
  const envelope = await callJson(provider, endpoint, {
    user: agent.params,
    conversationId: upstreamConversationId,
    confirmId: answer.confirmId,
    tool: answer.tool,
    accepted: answer.accepted ? "true" : "false",
  });
  const rawApplied = endpoint.applied ? pick(envelope, endpoint.applied) : undefined;
  const applied = typeof rawApplied === "boolean"
    ? rawApplied
    : rawApplied === "true" ? true : rawApplied === "false" ? false : null;
  const rawId = endpoint.id ? pick(envelope, endpoint.id) : undefined;
  return { applied, conversationId: rawId === undefined || rawId === null ? null : String(rawId) };
}

/**
 * 会话级自动批准开关（2026-10-22）：下发到上游，让它在**本会话**里不再发 confirm 事件。
 * 返回上游回显的当前状态（`result` 路径取不到就是 `null`——只看 HTTP + 成功信封）。
 *
 * 「关」永远允许：上游若因为 Key 没有自动批准权限拒绝「开」，这里会抛
 * `AssistantUpstreamError`（403），路由把它转成可读错误——**不要**静默当成成功，
 * 否则前端开关会显示开着、实际逐次弹卡。
 */
export async function engineSetAutoApprove(
  provider: AssistantProviderRuntime,
  agent: AssistantUserAgentRuntime,
  upstreamConversationId: string,
  enabled: boolean,
): Promise<{ enabled: boolean | null }> {
  const endpoint = provider.protocol.autoApprove;
  if (!endpoint) throw new Error("this provider does not define an autoApprove endpoint");
  const envelope = await callJson(provider, endpoint, {
    user: agent.params,
    conversationId: upstreamConversationId,
    autoApprove: enabled ? "true" : "false",
  });
  const raw = endpoint.result ? pick(envelope, endpoint.result) : undefined;
  const value = typeof raw === "boolean" ? raw : raw === "true" ? true : raw === "false" ? false : null;
  return { enabled: value };
}

/** 标量转非空字符串（游标类字段用；空/缺 ⇒ undefined）。 */
function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

/** 一页里的**第一条**消息的 id（`beforeId` 形态的游标 = 上一页第一条的 id，时间正序）。 */
function firstIdOf(rows: unknown[], endpoint: AssistantHistoryEndpoint): string | undefined {
  const first = rows[0];
  return first === undefined ? undefined : textOf(pick(first, endpoint.fields.id));
}

/**
 * 一页 → 下一轮的游标（2026-10-22 与 doubleA 对齐：**根相对点路径**与**行内列**都支持）。
 * 优先级：`cursorParam` 在**响应根**上取（`data.nextCursor` 这种服务端算好的值）⇒
 * 取不到再按 `cursorSource: "rows"` 取本页第一条的那一列 ⇒ 最后退回消息 id。
 * 这样"游标到底从哪来"完全由配置表达，代码不假设上游的分页协议。
 */
function nextCursorOf(
  page: { rows: unknown[]; envelope: unknown },
  endpoint: AssistantHistoryEndpoint,
  path: string | undefined,
): string | undefined {
  if (path) {
    const fromEnvelope = textOf(pick(page.envelope, path));
    if (fromEnvelope) return fromEnvelope;
    const firstRow = page.rows[0];
    if (firstRow !== undefined) {
      const fromRow = textOf(pick(firstRow, path));
      if (fromRow) return fromRow;
    }
  }
  return endpoint.indexParam || endpoint.cursorParam ? firstIdOf(page.rows, endpoint) : undefined;
}

/**
 * 历史读取（2026-10-22 通用化：语义写进协议，代码不认任何一家）：
 * - **分页式**（`indexParam` 配了）：按 `direction` 取/回填游标——
 *   `cursor`（缺省，原样透传）· `offset`（从第几条）· `cursorFromEnd`（距末尾第几条）；
 * - **全量式**（没配 `indexParam`）：一次请求，上限 `HISTORY_MAX_LIMIT`；
 * - **聚合一页**（`pageSizeParam` 配了，如 doubleA 的 `limitParam: "limit"`）：上游单次
 *   条数被限死（≤100）而客户端要一页 500 时，按 `pageSizeParam` 的值逐页回填
 *   `cursorParam` 直到够数或 `hasMore === false`；`maxPages` 兜底防死循环。
 */
/**
 * 一行的片段数组 → 归一片段（2026-10-22）。`parts` 路径没配 ⇒ 空数组（历史只有正文）。
 *
 * 路径都以**该行**为根：`parts: "parts"`（doubleA 的 `timeline`）或
 * `parts: "content.tool_calls"`（`full` 模式下只取工具卡）都行。`type` 的取值两边都
 * 大写比较，所以 `TEXT`/`text`、`TOOL`/`tool` 不必在配置里区分大小写。
 * 认不出的片段类型**跳过**（不是错误——上游加类型时旧配置继续工作）。
 */
function readParts(row: unknown, endpoint: AssistantHistoryEndpoint): AssistantMessagePart[] {
  const path = endpoint.fields.parts;
  if (!path) return [];
  const raw = pick(row, path);
  if (!Array.isArray(raw)) return [];
  const at = (item: unknown, key: string) => {
    const sub = endpoint.fields[key];
    return sub ? pick(item, sub) : undefined;
  };
  const textAt = (item: unknown, key: string) => {
    const value = at(item, key);
    return value === undefined || value === null ? "" : String(value);
  };
  const parts: AssistantMessagePart[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const kind = String(at(item, "partsType") ?? "").trim().toUpperCase();
    if (kind === "TEXT") {
      const text = textAt(item, "partsText");
      if (text) parts.push({ type: "text", text });
    } else if (kind === "THINKING") {
      const text = textAt(item, "partsText");
      if (text) parts.push({ type: "thinking", text });
    } else if (kind === "TOOL") {
      /* 工具卡：`partsToolName`/`partsToolStatus` 优先；没配就退到「元素本身是工具对象」
         （`full` 模式的 `content.tool_calls[]` 直接就是工具，没有外层 `tool` 键）。 */
      const nested = at(item, "partsTool") ?? item;
      const name = String(pick(nested, endpoint.fields.partsToolName ?? "toolName") ?? "").trim();
      const status = String(pick(nested, endpoint.fields.partsToolStatus ?? "status") ?? "").trim();
      if (!name) continue;
      const input = pick(nested, endpoint.fields.partsToolInput ?? "inputSummary");
      const output = pick(nested, endpoint.fields.partsToolOutput ?? "output");
      parts.push({
        type: "tool",
        name,
        status: status || "unknown",
        ...(input === undefined || input === null || input === "" ? {} : { input: String(input) }),
        ...(output === undefined || output === null || output === "" ? {} : { output: String(output) }),
      });
    }
  }
  return parts;
}

export async function engineHistory(
  provider: AssistantProviderRuntime,
  agent: AssistantUserAgentRuntime,
  upstreamConversationId: string,
  options: AssistantHistoryOptions,
): Promise<{ messages: AssistantChatMessage[]; total: number | null; hasMore: boolean | null }> {
  const endpoint: AssistantHistoryEndpoint | undefined = provider.protocol.history;
  if (!endpoint) throw new Error("this provider does not define a history endpoint");

  const fetchOne = async (cursor: string | undefined, limit: number | undefined): Promise<{ rows: unknown[]; total: number | null; hasMore: boolean | null; envelope: unknown }> => {
    const context = {
      user: agent.params,
      conversationId: upstreamConversationId,
      index: cursor,
      limit: limit === undefined ? undefined : String(limit),
    };
    /* query 模板逐项渲染，空值丢掉（游标缺省时不该留下 "index="）。 */
    const query = new URLSearchParams();
    for (const [key, template] of Object.entries(endpoint.query ?? {})) {
      const rendered = render(template, context);
      if (rendered) query.set(key, rendered);
    }
    /* 2026-10-22：游标/条数的**参数名**由协议给（`indexParam` / `pageSizeParam`），不必
       再要求管理员把同一件事在 `query` 模板里写第二遍——没写模板时才自动补上。 */
    if (endpoint.indexParam && cursor && !(endpoint.indexParam in (endpoint.query ?? {}))) {
      query.set(endpoint.indexParam, render(cursor, context));
    }
    const sizeParam = endpoint.pageSizeParam ?? endpoint.limitParam;
    if (sizeParam && limit !== undefined && !(sizeParam in (endpoint.query ?? {}))) {
      query.set(sizeParam, render(String(limit), context));
    }
    const base = endpointUrl(provider, endpoint, { user: agent.params, conversationId: upstreamConversationId });
    /* 2026-10-22：`path` 里可以自带 query（如 `…/messages?parts=full`）——参数表要**接在
       它后面**（用 `&`），否则拼出 `?a=1?b=2`，上游把整段当成一个值。 */
    const separator = base.includes("?") ? "&" : "?";
    const url = `${base}${query.size ? `${separator}${query.toString()}` : ""}`;
    const init: RequestInit = {
      method: endpoint.method.toUpperCase(),
      headers: { accept: "application/json", ...authHeaders(provider, { user: agent.params }) },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    };
    const response = await fetch(url, init);
    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) as unknown : undefined;
    } catch {
      parsed = undefined;
    }
    const root = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
    const businessOk = !violatesSuccessRule(successRuleOf(provider.protocol), parsed);
    if (!response.ok || !businessOk) {
      throw new AssistantUpstreamError(
        `assistant upstream request failed (HTTP ${response.status})${brief(root?.message ? String(root.message) : text)}`,
        response.status,
        retryAfterSeconds(response.headers),
      );
    }
    /* messages 路径与建会话的 conversationId 同款：根相对（不预剥 data）。 */
    return readHistoryEnvelope(parsed, endpoint);
  };

  const toMessage = (row: unknown): AssistantChatMessage => {
    const role = String(pick(row, endpoint.fields.role) ?? "").toUpperCase() === "USER" ? "user" as const : "assistant" as const;
    const time = pick(row, endpoint.fields.time);
    const parts = readParts(row, endpoint);
    return {
      id: String(pick(row, endpoint.fields.id) ?? ""),
      role,
      text: String(pick(row, endpoint.fields.text) ?? ""),
      ...(time === undefined || time === null ? {} : { time: String(time) }),
      ...(parts.length ? { parts } : {}),
    };
  };

  /* 全量式：一次请求，`from: "end"` 要最近的一批，向前翻要更早的一批（同样按条数）。 */
  if (!endpoint.indexParam) {
    const limit = Math.min(options.limit ?? HISTORY_MAX_LIMIT, HISTORY_MAX_LIMIT);
    const page = await fetchOne(undefined, limit);
    return { messages: page.rows.map(toMessage), total: page.total, hasMore: page.hasMore };
  }

  /* 分页式：从 `from` 位置按 `limit` 取一页。`cursor` 是客户端给的游标值，
     方向由 `direction` 决定——绝不假设它和上游 index 同义。 */
  /* 单次给上游的条数：协议显式配了就用它（上游有硬上限时配小的值更稳），否则跟着
     客户端那一页走——`limitValue` / `limitParam` 是旧键名，仍认。 */
  const upstreamPageSize = endpoint.pageSize ?? endpoint.limitValue;
  const pageSize = Math.max(1, Math.min(upstreamPageSize ?? options.limit ?? 50, HISTORY_MAX_LIMIT));
  const direction = endpoint.direction ?? "cursor";
  const from = options.from ?? "end";
  let cursor: string | undefined;
  if (direction === "offset") {
    /* offset 语义：客户端给「从第几条开始」。向前翻（要更早）时不知道总数，就用**大偏移**
       让上游自己截断，再退化成按条数取——这是唯一不引入额外请求的通用做法。 */
    cursor = from === "start" ? (options.cursor ?? "0") : undefined;
  } else if (direction === "cursorFromEnd") {
    /* 上游 index = 距末尾第几条：要最近的一批 = index 0；向前翻 = 客户端给的游标。 */
    cursor = from === "start" ? (options.cursor ?? "0") : undefined;
  } else {
    cursor = from === "start" ? options.cursor : undefined;
  }

  const first = await fetchOne(cursor, pageSize);
  const collected: unknown[] = [...first.rows];
  let hasMore = first.hasMore;
  /* 聚合（`pageSizeParam` 配了才有）：上游单次上限比客户端要的页小 ⇒ 拿**最后一条的 id**
     当下一轮的游标继续往回取，直到够数 / 上游说没有更早的 / 触到 `maxPages`。 */
  if (endpoint.pageSizeParam ?? endpoint.limitParam) {
    const maxPages = Math.max(1, Math.min(endpoint.maxPages ?? 10, 50));
    let nextCursor: string | undefined = nextCursorOf(first, endpoint, endpoint.cursorParam);
    for (let page = 1; page < maxPages && hasMore !== false && collected.length < pageSize && nextCursor; page += 1) {
      const more = await fetchOne(nextCursor, pageSize - collected.length);
      if (!more.rows.length) { hasMore = false; break; }
      /* 游标不前进 ⇒ 上游忽略了这个参数：停止，免得死循环。 */
      const progressed = more.rows.some((row) => !collected.includes(row));
      collected.push(...more.rows);
      hasMore = more.hasMore ?? (more.rows.length > 0);
      if (!progressed) break;
      nextCursor = nextCursorOf(more, endpoint, endpoint.cursorParam);
    }
  }
  return { messages: collected.map(toMessage), total: first.total, hasMore };
}

/**
 * 一条上游 SSE 载荷 → 归一事件；未映射/被忽略/解析失败返回 undefined（协议噪音
 * 不转发——上游加事件类型时旧配置不掉线）。
 *
 * 2026-10-22 通用化要点（方言差异全部落在协议配置里，代码不认任何一家）：
 * - 事件种类：`on` 可以是 `"MESSAGE"`（种类在同一个 JSON 里）或 `"MESSAGE@event"`
 *   （种类来自 SSE `event:` 行，`data` 里只有正文）；比较前两边都大写去空格。
 * - 文本：`text` 支持 `a|b` 候选路径（先命中的先用）——同一家平台常把正文放在
 *   `data.text` 或 `data.content`。
 * - 失败判定：`done.success`（旧形状，布尔/字符串 "false"）与
 *   `done|token|error.success`（{@link AssistantSuccessRule}）都认，任一判失败即转
 *   error 终态。`token` 的规则用于「HTTP 200 + 首帧即错误信封」的方言。
 * - `elicit`：判别字段与取值都可省（省了则该事件名整类都是确认表单），不假设它
 *   与 token 同 kind。
 *
 * `toolInputs` 是本回合「工具名 → 最近一次入参」的记忆：elicit 事件（MRTR 确认
 * 表单）靠它带出删除目标——确认事件本身不带入参，入参在它前面的工具事件里。
 */
function translatePayload(
  protocol: AssistantProtocol,
  payload: string,
  accumulated: string,
  toolInputs: Map<string, Record<string, unknown>>,
  eventName?: string,
): { event?: AssistantEvent; fullTextDelta?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return {};
  }
  const mapping = protocol.sse;
  const kind = kindOf(parsed, mapping.eventField, eventName);
  if (!kind) return {};
  if (mapping.ignore?.some((name) => sameKind(kind, name))) return {};

  /* elicit 先于 token 判：两者可能同 kind，靠判别字段分流；判别值不匹配时落到
     token——同一条流里普通文字与确认表单混着来。判别字段缺省时整类都算表单。 */
  if (mapping.elicit && sameKind(kind, mapping.elicit.on)) {
    const matches = !mapping.elicit.type
      || sameKind(pick(parsed, mapping.elicit.type), mapping.elicit.typeValue ?? "");
    if (matches) {
      const tool = String(pick(parsed, mapping.elicit.tool) ?? "").trim() || "unknown";
      const schema = mapping.elicit.schema ? pick(parsed, mapping.elicit.schema) : undefined;
      const allowResume = mapping.elicit.allowResume ? pick(parsed, mapping.elicit.allowResume) : undefined;
      /* 答复所需的三件事（2026-10-22）：confirmId（回传主键）、expiresAt（倒计时唯一
         依据）、source（只影响文案）。没配路径 / 取不到值就整个不给——卡片据此判定
         「能不能回传上游」。 */
      const textOf = (path: string | undefined): string | undefined => {
        if (!path) return undefined;
        const value = pick(parsed, path);
        const text = value === undefined || value === null ? "" : String(value).trim();
        return text || undefined;
      };
      const confirmId = textOf(mapping.elicit.confirmId);
      const expiresAt = textOf(mapping.elicit.expiresAt);
      const source = textOf(mapping.elicit.source);
      const inputSummary = textOf(mapping.elicit.inputSummary);
      const rawDuplicate = mapping.elicit.duplicate ? pick(parsed, mapping.elicit.duplicate) : undefined;
      const duplicate = rawDuplicate === true || rawDuplicate === "true";
      return {
        event: {
          type: "elicit",
          text: String(pick(parsed, firstOf(parsed, mapping.elicit.text)) ?? "").trim(),
          tool,
          ...(toolInputs.get(tool) ? { input: toolInputs.get(tool) } : {}),
          ...(schema !== undefined ? { schema } : {}),
          ...(typeof allowResume === "boolean" ? { allowResume } : {}),
          ...(confirmId ? { confirmId } : {}),
          ...(expiresAt ? { expiresAt } : {}),
          ...(source ? { source } : {}),
          ...(inputSummary ? { inputSummary } : {}),
          ...(duplicate ? { duplicate: true } : {}),
        },
      };
    }
  }

  if (mapping.token && sameKind(kind, mapping.token.on)) {
    if (mapping.token.success && violatesSuccessRule(mapping.token.success, parsed)) {
      /* 握手 200、首帧却是失败信封：按错误终态落地（上游说的话原样透出）。 */
      return { event: { type: "error", message: String(pick(parsed, firstOf(parsed, mapping.token.text)) ?? "").trim() || "assistant upstream reported an error" } };
    }
    const text = String(pick(parsed, firstOf(parsed, mapping.token.text)) ?? "");
    return text ? { event: { type: "token", text }, fullTextDelta: text } : {};
  }

  if (mapping.thinking && sameKind(kind, mapping.thinking.on)) {
    /* 思考增量（2026-10-22）：`text` 是**增量**，拼起来才是全文（与 token 同语义）。
       `newSegment` 只在段首帧出现，前端据此另起一个折叠块。 */
    const text = String(pick(parsed, mapping.thinking.text) ?? "");
    if (!text) return {};
    const newSegment = mapping.thinking.newSegment ? pick(parsed, mapping.thinking.newSegment) : undefined;
    return { event: { type: "thinking", text, ...(newSegment === true || newSegment === "true" ? { newSegment: true } : {}) } };
  }

  if (mapping.tool && sameKind(kind, mapping.tool.on)) {
    const name = String((mapping.tool.name ? pick(parsed, mapping.tool.name) : undefined) ?? "").trim()
      || String(pick(parsed, mapping.tool.nameFallback ?? "") ?? "").trim()
      || "unknown";
    const status = String((mapping.tool.status ? pick(parsed, mapping.tool.status) : undefined) ?? "").trim() || "unknown";
    /* 同一次调用会推多帧（RUNNING → SUCCESS/ERROR）：`callId` 让前端合并成一行；
       `kind`（MCP/SANDBOX/BUILTIN 之类）原样透出，供工具行区分来源。
       **没配 `callId` 路径时用「工具名」当键**（2026-10-22）：只按名字合并，至少让
       「开始→完成」两帧不各占一行；上游没给 id 却真有同名并行调用时会被合并成一个
       （可接受的降级——比每帧新增一行更好读）。 */
    const callId = String((mapping.tool.callId ? pick(parsed, mapping.tool.callId) : undefined) ?? "").trim() || name;
    const toolKind = String((mapping.tool.kind ? pick(parsed, mapping.tool.kind) : undefined) ?? "").trim();
    /* 记下入参：对象形状直接用；**字符串形状先试 JSON.parse**（2026-10-22——不少平台把
       入参以"序列化后的 JSON 字符串"给出，可能被截断）。parse 失败就不记，elicit 事件
       会另外把这段原文以 `inputSummary` 带出去，前端降级显示原文。 */
    if (mapping.tool.input) {
      const raw = pick(parsed, mapping.tool.input);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        toolInputs.set(name, raw as Record<string, unknown>);
      } else if (typeof raw === "string" && raw.trim().startsWith("{")) {
        try {
          const parsedInput = JSON.parse(raw) as unknown;
          if (parsedInput && typeof parsedInput === "object" && !Array.isArray(parsedInput)) {
            toolInputs.set(name, parsedInput as Record<string, unknown>);
          }
        } catch { /* 截断/非法：不记（原文另走 inputSummary）。 */ }
      }
    }
    /* 结果正文（2026-10-22）：点路径可配；对象形状先序列化（上游常把结果给成 JSON）。
       截断到 `TOOL_OUTPUT_MAX_CHARS`——它是给人看的证据，不是传输通道。 */
    const rawOutput = mapping.tool.output ? pick(parsed, mapping.tool.output) : undefined;
    const output = typeof rawOutput === "string"
      ? rawOutput
      : rawOutput && typeof rawOutput === "object" ? JSON.stringify(rawOutput) : "";
    const trimmedOutput = output.trim();
    return {
      event: {
        type: "tool",
        name,
        status,
        ...(callId ? { callId } : {}),
        ...(toolKind ? { kind: toolKind } : {}),
        ...(trimmedOutput
          ? { output: trimmedOutput.length > TOOL_OUTPUT_MAX_CHARS ? `${trimmedOutput.slice(0, TOOL_OUTPUT_MAX_CHARS)}…` : trimmedOutput }
          : {}),
      },
    };
  }

  if (mapping.done && sameKind(kind, mapping.done.on)) {
    /* `text` 可省：没有全文的方言留空 ⇒ 用累计 delta（见下方 fullText 兜底）。 */
    const text = String(pick(parsed, firstOf(parsed, mapping.done.text ?? "")) ?? "");
    const legacyFlag = mapping.done.success ? pick(parsed, mapping.done.success) : undefined;
    /* 三种失败表达都能配（2026-10-22）：
       - 旧形状：该字段取到布尔 false / 字符串 "false"；
       - 新形状：`done.successRule`（`{field, ok[]}` 或 `{field, not}`）——例如
         终态字段 `finishReason` 只有 `"COMPLETE"` 算成功。
       `successRule` **只在字段真的存在时判**：终端/中间帧经常不带 `finishReason`，
       缺字段按白名单规则会判失败（那是 token 首帧的正确口径），但对 `done` 来说
       等于把正常收尾误报成错误——`done` 缺字段时状态未知，按成功处理。 */
    const failedByLegacy = legacyFlag === false || (mapping.done.success && legacyFlag === "false");
    const doneRuleApplies = Boolean(mapping.done.successRule)
      && pick(parsed, mapping.done.successRule!.field) !== undefined
      && pick(parsed, mapping.done.successRule!.field) !== null;
    const failedByRule = doneRuleApplies
      ? violatesSuccessRule(mapping.done.successRule, parsed)
      : false;
    if (failedByLegacy || failedByRule) {
      /* 部分方言的失败不以 error 事件落地、而是终态事件带失败标记——按错误终态映射。 */
      return { event: { type: "error", message: text || "assistant upstream reported an error" } };
    }
    /* done 的 fullText 必须能独立渲染整条回复：text 缺失时退回累计值。 */
    return { event: { type: "done", fullText: text || accumulated } };
  }

  if (mapping.error && sameKind(kind, mapping.error.on)) {
    if (mapping.error.success && !violatesSuccessRule(mapping.error.success, parsed)) {
      /* 该事件名既报成功又报失败（同一信封打两种标记）：这里是成功帧，当噪音丢掉。 */
      return {};
    }
    return { event: { type: "error", message: String(pick(parsed, mapping.error.message) ?? "").trim() || "assistant upstream reported an error" } };
  }
  return {};
}

/**
 * 发消息（SSE 流式）。**两段式**：Promise 在上游接受请求（响应头到达且状态 OK 且
 * 是事件流）时 resolve——此前抛错让路由在 hijack 之前回干净的 JSON 错误；resolve
 * 出的流逐个产出归一事件，以 done / error 收尾。中途的传输级失败从迭代中抛出。
 */
export async function engineStreamMessage(
  provider: AssistantProviderRuntime,
  agent: AssistantUserAgentRuntime,
  upstreamConversationId: string,
  input: AssistantMessageInput,
): Promise<AsyncIterable<AssistantEvent>> {
  /* `autoApprove` 预置成 false（2026-10-22）：协议若在 chat body 里写了
     `"autoApprove": "{{autoApprove:boolean}}"`，发送时它必须落到**原始布尔**而不是空串——
     空串会被上游当成「非法布尔」或者被 JSON.parse 成 `""`。会话级开关由
     `autoApprove` 端点单独下发（请求级不重复携带），所以这里恒为 false 也语义正确：
     「这条 chat 请求本身不要求跳过确认」。 */
  const context: RenderContext = { user: agent.params, conversationId: upstreamConversationId, message: input.message, autoApprove: "false" };
  const endpoint = provider.protocol.chat;
  const init: RequestInit = {
    method: endpoint.method.toUpperCase(),
    headers: { accept: "text/event-stream", ...authHeaders(provider, context) },
    signal: input.signal,
  };
  const body = renderBody(endpoint.body, context);
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    /* 只在有附件时并进数组（协议开了 attachments）：空数组在一些实现里被当成清空。
       字段名可配（`attachmentsField`，缺省 attachments）——同名约定之外的上游也能接。 */
    const field = provider.protocol.attachmentsField?.trim() || "attachments";
    const withAttachments = input.attachments?.length && provider.protocol.attachments
      ? { ...body, [field]: input.attachments satisfies AssistantAttachment[] }
      : body;
    init.body = JSON.stringify(withAttachments);
  }
  const response = await fetch(endpointUrl(provider, endpoint, context), init);
  /* 两段式的第一段：这里抛的错让路由在 hijack 前回 JSON。 */
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    let message = "";
    try {
      message = String((JSON.parse(text) as { message?: unknown })?.message ?? "");
    } catch {
      message = text;
    }
    throw new AssistantUpstreamError(
      `assistant upstream chat request failed (HTTP ${response.status})${brief(message)}`,
      response.status,
      retryAfterSeconds(response.headers),
    );
  }
  const contentType = String(response.headers.get("content-type") ?? "");
  /* 200 但不是事件流：多半是网关把错误页/JSON 错误当 200 回了——按上游失败处理，
     用 400 而不是 200 报出去（这不是「上游拒绝」，也不是「限流」，是握手内容不对）。 */
  if (!contentType.includes("text/event-stream")) {
    const text = await response.text().catch(() => "");
    throw new AssistantUpstreamError(
      `assistant upstream returned "${contentType || "unknown content-type"}" instead of an event stream${brief(text)}`,
      response.status === 200 ? 400 : response.status,
    );
  }
  return translateStream(provider.protocol, response.body);
}

/**
 * 带静默预算的读（P9-8）：上游响应头到了却不再发数据时，光等是等不来终态的。
 * 每调用一次起一个预算定时器、读到数据即销毁——预算衡量的是**两块数据之间的
 * 间隔**，不是整体时长（长回答本就该慢慢流）。
 *
 * 超时抛 UpstreamSilentError，这里**不** cancel：谁拥有 reader 谁负责清理
 * （translateStream 的 finally 干这件事）。超时后那次 read 悬在管道上，cancel 时
 * 会被兑现成 {done:true} 不漏；Promise.race 给两个输入都挂了处理函数，迟到的
 * 拒绝不会变成未处理拒绝。
 */
async function readWithIdleBudget(reader: ReadableStreamDefaultReader<Uint8Array>, budgetMs: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UpstreamSilentError(STREAM_SILENT_MESSAGE)), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 第二段：把上游 SSE 体翻译成归一事件流。终态纪律见文件头。终态后直接 return：
 * 终态事件之后的任何载荷都是协议噪音，读下去只浪费连接。
 *
 * 读的每一步都挂静默预算（P9-8）：超时抛 UpstreamSilentError，由这里换成带
 * `upstream_silent` 码的错误终态（而不是让路由把它当传输错误报出去）——文案要能
 * 被前端本地化，就不能让它在路由层被拼成通用上游错误。
 */
async function* translateStream(protocol: AssistantProtocol, body: ReadableStream<Uint8Array>): AsyncIterable<AssistantEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseDataParser();
  let fullText = "";
  let sawTerminal = false;
  /* 本回合的工具入参记忆（elicit 事件取删除目标的来源，见 translatePayload）。 */
  const toolInputs = new Map<string, Record<string, unknown>>();
  const consume = function* (payload: SsePayload): Generator<AssistantEvent> {
    const { event, fullTextDelta } = translatePayload(protocol, payload.data, fullText, toolInputs, payload.event);
    if (fullTextDelta) fullText += fullTextDelta;
    if (!event) return;
    if (event.type === "done" || event.type === "error") sawTerminal = true;
    yield event;
  };
  /* `streamEnd: "continue"`：终帧之后上游仍不断流的方言，读到连接结束为止（终态后
     的载荷全当噪音丢掉），避免提前 cancel 让上游记一笔异常断开。缺省 "close"
     保持旧行为：终态即 return，finally 里 cancel。 */
  const closeOnTerminal = protocol.streamEnd !== "continue";
  try {
    while (true) {
      const { done, value } = await readWithIdleBudget(reader, STREAM_IDLE_TIMEOUT_MS);
      if (done) break;
      for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
        for (const event of consume(payload)) yield event;
        if (sawTerminal && closeOnTerminal) return;
      }
    }
    /* TextDecoder 收尾（跨 chunk 的多字节字符）+ 缺空行结尾的最后一个事件。 */
    const tail = decoder.decode();
    for (const payload of [...(tail ? parser.push(tail) : []), ...parser.flush()]) {
      for (const event of consume(payload)) yield event;
      if (sawTerminal && closeOnTerminal) return;
    }
  } catch (error) {
    if (error instanceof UpstreamSilentError) {
      /* 静默不是「上游报错」，但连接确实不再有结果——按终态收尾，已收到的半截
         回复留在前面的事件里（前端把错误块接在文字块后面，半截不撒谎）。 */
      yield { type: "error", message: STREAM_SILENT_MESSAGE, code: "upstream_silent" };
      return;
    }
    throw error;
  } finally {
    /* 正常读完是 no-op；提前 return / abort 时释放上游连接。cancel 的拒绝吞掉——
       主动断开不该再报一次错。 */
    reader.cancel().catch(() => {});
  }
  if (!sawTerminal) {
    yield fullText
      ? { type: "done", fullText }
      : { type: "error", message: "assistant upstream stream ended without a result", code: "stream_incomplete" };
  }
}
