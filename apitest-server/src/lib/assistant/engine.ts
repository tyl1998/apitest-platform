/**
 * 通用协议引擎（P9-4b，2026-09-14 修订）：按 provider 行上的协议配置调上游 agent
 * 平台，产出归一事件——取代 P9-2 的「每平台一个 adapter 文件 + 注册表」。换平台 =
 * 管理员填 4 个接口（建会话 / 发消息 SSE / 停止 / 历史）+ SSE 映射 + 认证模板，
 * 这里零改动。
 *
 * 模板语法（有意的最小词汇表）：`{{user.agentId}}` / `{{conversationId}}` /
 * `{{message}}` / `{{index}}` / `{{limit}}`。值整体是一个占位符且渲染结果是数字时
 * 按数字进 JSON（agent-vendor 的 Long 型 agentId/conversationId 靠这条）；其余按字符串。
 *
 * 终态纪律（与原 agent-vendor adapter 同款）：done/error 收尾；上游断流无终态时合成
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
  AssistantProtocol,
  AssistantProviderRuntime,
  AssistantUserAgentRuntime,
} from "./types.js";
import { SseDataParser } from "./sse.js";

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

/** 点路径取值（不 travers 数组、不支持转义——协议配置是管理员写的受信输入）。 */
function pick(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 字符串模板渲染：{{path}} 展开；缺值渲染为空串（必填项由路由层先验过）。 */
function render(template: string, context: RenderContext): string {
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g, (_, path: string) => {
    const value = path === "user" ? undefined : pick(context, path);
    return value === undefined || value === null ? "" : String(value);
  });
}

/** 请求体模板渲染：字符串值整体是占位符且渲染结果可解析为 JSON 标量时用标量
    （数字型 id 不加引号），否则保持字符串；非字符串值原样透传。 */
function renderBody(body: Record<string, unknown> | undefined, context: RenderContext): Record<string, unknown> | undefined {
  if (!body) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") { result[key] = value; continue; }
    const rendered = render(value, context);
    if (/^\{\{\s*[a-zA-Z][a-zA-Z0-9_.]*\s*\}\}$/.test(value)) {
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
 * 一问一答接口的公共腿：渲染 → fetch → 等 JSON 信封 → `successCode` 判定
 * （HTTP 200 但业务码不对是这类平台的常态错误形状；未配 successCode 则只看 HTTP）。
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
  const rule = provider.protocol.successCode;
  const businessOk = rule ? String(pick(parsed, rule.field) ?? "") === rule.value : true;
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
  /* 响应路径是根相对的（callJson 不预剥 data）：agent-vendor 填 data，裸返 {"id":…} 填 id。 */
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

/** 删上游会话本体（协议配了 delete 端点才可调；agent-vendor 是 POST …/{id}/delete）。
 *  本地映射行由路由层删——两处删除的事务性不追求：上游失败不该留住本地映射。 */
export async function engineDeleteConversation(provider: AssistantProviderRuntime, agent: AssistantUserAgentRuntime, upstreamConversationId: string): Promise<void> {
  const endpoint = provider.protocol.delete;
  if (!endpoint) throw new Error("this provider does not define a delete endpoint");
  await callJson(provider, endpoint, { user: agent.params, conversationId: upstreamConversationId });
}

export async function engineHistory(
  provider: AssistantProviderRuntime,
  agent: AssistantUserAgentRuntime,
  upstreamConversationId: string,
  options: AssistantHistoryOptions,
): Promise<AssistantChatMessage[]> {
  const endpoint: AssistantHistoryEndpoint | undefined = provider.protocol.history;
  if (!endpoint) throw new Error("this provider does not define a history endpoint");
  /* query 模板逐项渲染，空值丢掉（index 缺省时不该留下 "index="）。 */
  const query = new URLSearchParams();
  for (const [key, template] of Object.entries(endpoint.query ?? {})) {
    const rendered = render(template, {
      user: agent.params,
      conversationId: upstreamConversationId,
      index: options.index,
      limit: options.limit === undefined ? undefined : String(options.limit),
    });
    if (rendered) query.set(key, rendered);
  }
  const url = `${endpointUrl(provider, endpoint, { user: agent.params, conversationId: upstreamConversationId })}${query.size ? `?${query.toString()}` : ""}`;
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
  const rule = provider.protocol.successCode;
  const root = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  const businessOk = rule ? String(pick(parsed, rule.field) ?? "") === rule.value : true;
  if (!response.ok || !businessOk) {
    throw new AssistantUpstreamError(
      `assistant upstream request failed (HTTP ${response.status})${brief(root?.message ? String(root.message) : text)}`,
      response.status,
      retryAfterSeconds(response.headers),
    );
  }
  /* messages 路径与建会话的 conversationId 同款：根相对（不预剥 data）。 */
  const rows = pick(parsed, endpoint.messages);
  if (!Array.isArray(rows)) return [];
  /* 字段点路径翻译（fields 只认 id/role/text/time 四键，缺的键退空串）。 */
  return rows.map((row) => {
    const role = String(pick(row, endpoint.fields.role) ?? "").toUpperCase() === "USER" ? "user" as const : "assistant" as const;
    const time = pick(row, endpoint.fields.time);
    return {
      id: String(pick(row, endpoint.fields.id) ?? ""),
      role,
      text: String(pick(row, endpoint.fields.text) ?? ""),
      ...(time === undefined || time === null ? {} : { time: String(time) }),
    };
  });
}

/** 一条上游 SSE 载荷 → 归一事件；未映射/被忽略/解析失败返回 undefined（协议噪音
    不转发——上游加事件类型时旧配置不掉线）。done 映射带 success 字段且值为 false
    时按错误终态处理（agent-vendor「FINAL_RESULT success:false」的口径，通用化）。
    `toolInputs` 是本回合「工具名 → 最近一次入参」的记忆：elicit 事件（MRTR 确认
    表单）靠它带出删除目标——确认事件本身不带入参，入参在它前面的 PROCESSING 里。 */
function translatePayload(
  protocol: AssistantProtocol,
  payload: string,
  accumulated: string,
  toolInputs: Map<string, Record<string, unknown>>,
): { event?: AssistantEvent; fullTextDelta?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return {};
  }
  const mapping = protocol.sse;
  const kind = String(pick(parsed, mapping.eventField) ?? "");
  if (mapping.ignore?.includes(kind)) return {};
  /* elicit 必须先于 token 判：与 token 同 kind（都是 MESSAGE），靠判别字段分流；
     判别值不匹配时落到 token——同一条流里普通文字与确认表单混着来。 */
  if (mapping.elicit && kind === mapping.elicit.on
    && String(pick(parsed, mapping.elicit.type) ?? "").toUpperCase() === mapping.elicit.typeValue.toUpperCase()) {
    const tool = String(pick(parsed, mapping.elicit.tool) ?? "").trim() || "unknown";
    const schema = pick(parsed, mapping.elicit.schema);
    return {
      event: {
        type: "elicit",
        text: String(pick(parsed, mapping.elicit.text) ?? "").trim(),
        tool,
        ...(toolInputs.get(tool) ? { input: toolInputs.get(tool) } : {}),
        ...(schema !== undefined ? { schema } : {}),
      },
    };
  }
  if (mapping.token && kind === mapping.token.on) {
    const text = String(pick(parsed, mapping.token.text) ?? "");
    return text ? { event: { type: "token", text }, fullTextDelta: text } : {};
  }
  if (mapping.tool && kind === mapping.tool.on) {
    const name = String(pick(parsed, mapping.tool.name) ?? "").trim()
      || String(pick(parsed, mapping.tool.nameFallback ?? "") ?? "").trim()
      || "unknown";
    const status = String(pick(parsed, mapping.tool.status) ?? "").trim() || "unknown";
    /* 记下入参（只收对象形状——坏形状当没给）：EXECUTING/FINISHED 两帧都带，后到
       覆盖前到，elicit 到达时取到的就是该工具本回合的最终入参。 */
    if (mapping.tool.input) {
      const input = pick(parsed, mapping.tool.input);
      if (input && typeof input === "object" && !Array.isArray(input)) toolInputs.set(name, input as Record<string, unknown>);
    }
    return { event: { type: "tool", name, status } };
  }
  if (mapping.done && kind === mapping.done.on) {
    const text = String(pick(parsed, mapping.done.text) ?? "");
    const success = pick(parsed, mapping.done.success ?? "");
    if (success === false || (mapping.done.success && success === "false")) {
      /* 平台侧失败不以 ERROR 事件落地、而是终态事件带失败标记——按错误终态映射。 */
      return { event: { type: "error", message: text || "assistant upstream reported an error" } };
    }
    /* done 的 fullText 必须能独立渲染整条回复：text 缺失时退回累计值。 */
    return { event: { type: "done", fullText: text || accumulated } };
  }
  if (mapping.error && kind === mapping.error.on) {
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
  const context: RenderContext = { user: agent.params, conversationId: upstreamConversationId, message: input.message };
  const endpoint = provider.protocol.chat;
  const init: RequestInit = {
    method: endpoint.method.toUpperCase(),
    headers: { accept: "text/event-stream", ...authHeaders(provider, context) },
    signal: input.signal,
  };
  const body = renderBody(endpoint.body, context);
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    /* 只在有附件时并进数组（协议开了 attachments）：空数组在一些实现里被当成清空。 */
    const withAttachments = input.attachments?.length && provider.protocol.attachments
      ? { ...body, attachments: input.attachments satisfies AssistantAttachment[] }
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
  if (!contentType.includes("text/event-stream")) {
    /* 200 但不是事件流：多半是网关把错误页/JSON 错误当 200 回了。 */
    const text = await response.text().catch(() => "");
    throw new AssistantUpstreamError(
      `assistant upstream returned "${contentType || "unknown content-type"}" instead of an event stream${brief(text)}`,
      response.status,
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
  const consume = function* (payload: string): Generator<AssistantEvent> {
    const { event, fullTextDelta } = translatePayload(protocol, payload, fullText, toolInputs);
    if (fullTextDelta) fullText += fullTextDelta;
    if (!event) return;
    if (event.type === "done" || event.type === "error") sawTerminal = true;
    yield event;
  };
  try {
    while (true) {
      const { done, value } = await readWithIdleBudget(reader, STREAM_IDLE_TIMEOUT_MS);
      if (done) break;
      for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
        for (const event of consume(payload)) yield event;
        if (sawTerminal) return;
      }
    }
    /* TextDecoder 收尾（跨 chunk 的多字节字符）+ 缺空行结尾的最后一个事件。 */
    const tail = decoder.decode();
    for (const payload of [...(tail ? parser.push(tail) : []), ...parser.flush()]) {
      for (const event of consume(payload)) yield event;
      if (sawTerminal) return;
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
