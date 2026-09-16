import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { currentUser } from "../lib/auth.js";
import { composeForwardedMessage, normalizePageContext, stripContextPrefix } from "../lib/assistant/context.js";
import { engineCreateConversation, engineDeleteConversation, engineHistory, engineStop, engineStreamMessage, upstreamRateLimit } from "../lib/assistant/engine.js";
import { loadEnabledDefaultUserAgent, loadProviderById, loadUserAgentForProvider } from "../lib/assistant/providers.js";
import type { AssistantEvent, AssistantProviderRuntime, AssistantUserAgentRuntime } from "../lib/assistant/types.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapAssistantConversation } from "../models/types.js";

/**
 * 站内助手——用户级五条会话路由（P9-2 起家、P9-4b 通用化、2026-09-16 用户级化）。
 * 平台在这条链里是哑管道：
 *
 *     浏览器 → 这里（只转发 SSE）→ 外部 agent 平台（协议配置驱动）→ 平台 /mcp → 库
 *
 * - **对话是「人」的（2026-09-16 用户定位修订，迁移 062）**：不挂在项目下、不做
 *   项目角色闸——登录即用（currentUser 守卫），会话按 user_id 归属。从哪个页面
 *   发消息只影响随消息携带的页面上下文（P9-4c 围栏前缀），不影响会话归属；
 * - **凭据是用户级的（P9-4b，迁移 059）**：每个用户在抽屉「设置」里按 provider 的
 *   user_params 自配 agent（agentId/apiKey 等，secret 项加密）；没配默认 agent 时
 *   整组 503/2005「未配置」，前端圆钮引导去设置卡（边界 15 的用户级落点）；
 * - **会话按行上的 provider_id 收发**（门槛 13）：用户换默认 agent 后旧会话仍按
 *   原 provider + 该 provider 上的凭据收发；
 * - **对话正文不落库**（边界 2）：映射表只有一行指针，transcript 全在上游，历史
 *   代理转发；topic 是首条消息的自动摘要（一行标题不算 transcript）；
 * - **SSE 是 hijack 的原始流**（写法照 routes/stream.ts）：上游心跳被引擎按 ignore
 *   映射吸收，保活由这里按 15s 发注释行（边界 1）。
 * - **上游异常分三类回答**（P9-8）：限流 429/2007（Retry-After 如实转发，用户的
 *   动作是「稍后重试」）、其它上游失败 502/2006（动作是「查配置/找管理员」）、
 *   未配置或凭据读不出 503/2005（动作是「去设置卡重填」）。hijack 之前一律干净
 *   JSON，之后只剩 error 终态帧（断流/静默由引擎合成，见 engine.ts）。
 */

/** 15s 保活（计划 13.0 边界 1）：代理自己发注释行，不依赖上游心跳。 */
const HEARTBEAT_MS = 15_000;

const MAX_MESSAGE_CHARS = 32_768;
const MAX_ATTACHMENTS = 10;

/** 会话标题长度：首条消息折叠空白后截断（下拉里要一眼读出「这段聊的是什么」）。 */
const TOPIC_MAX_CHARS = 30;

/* 错误码沿 failNoRunner/2004 的取舍——不同处置动作不共用一句文案：
 * 2005 = 助手未配置（503，用户还没配自己的 agent，或会话的 provider 被停用——
 *        前者去抽屉设置卡，后者找管理员）；
 * 2006 = 上游调用失败（502，agent 平台报错或不可达，看错误消息定位）；
 * 2007 = 上游限流（429，P9-8：等一会儿再发就行——与 2006 的「去修配置」是两个
 *        处置动作，混成一句会把用户的第一个反应带偏；Retry-After 如实转发上游）。 */
const CODE_NOT_CONFIGURED = 2005;
const CODE_UPSTREAM = 2006;
const CODE_RATE_LIMIT = 2007;

const NO_DEFAULT_AGENT = "assistant is not configured: set up your agent in the assistant settings";

/** 用户级凭据解不出来（DATA_SOURCE_ENCRYPTION_KEY 换过）时的问答：处置动作是
 *  「重新填一次」，与「还没配」同路，所以照样是 503/2005 而不是 500。 */
const CREDENTIAL_UNREADABLE = "assistant credentials could not be read: re-enter your agent settings";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 上游失败的唯一出口（P9-8）：限流（429）与其它失败（502）分开报——前端据此
    决定说「稍后重试」还是「去查配置」。 */
function failUpstream(reply: FastifyReply, error: unknown) {
  const limited = upstreamRateLimit(error);
  if (limited) {
    if (limited.retryAfter !== undefined) reply.header("Retry-After", String(limited.retryAfter));
    return fail(reply, 429, CODE_RATE_LIMIT, `assistant upstream rate limited this request: ${errorMessage(error)}`);
  }
  return fail(reply, 502, CODE_UPSTREAM, `assistant upstream error: ${errorMessage(error)}`);
}

/**
 * 取我的默认 agent；取不到（未配置 / 凭据解密不了）时**直接回 503/2005 并回
 * undefined**——调用方只要 `if (!resolved) return;`。解密失败原本会冒成 500，
 * 但用户看到的处置动作与「未配置」一致（去设置卡重填），500 只会让人去找运维；
 * 原因进服务端日志就够（解密失败是部署级线索，不该出现在用户界面）。
 */
async function loadResolvedDefaultAgent(reply: FastifyReply, userId: string) {
  try {
    return await loadEnabledDefaultUserAgent(userId);
  } catch (error) {
    reply.log.warn({ err: errorMessage(error) }, "assistant credentials could not be decrypted");
    fail(reply, 503, CODE_NOT_CONFIGURED, CREDENTIAL_UNREADABLE);
    return undefined;
  }
}

/** 首条消息 → 会话标题：折叠空白、截断加省略号（display-only，不进上游）。 */
function topicFromMessage(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > TOPIC_MAX_CHARS ? `${flat.slice(0, TOPIC_MAX_CHARS)}…` : flat;
}

/** 会话按 (id, user) 取——「我的」会话；别人的 id 一律 404 不泄露存在性。 */
async function loadMyConversation(conversationId: string, userId: string): Promise<Record<string, unknown> | undefined> {
  const result = await pool.query(
    "SELECT * FROM assistant_conversations WHERE id = $1 AND user_id = $2",
    [conversationId, userId],
  );
  return result.rows[0];
}

/**
 * 会话的收发三元组：会话行 → (provider, 我的 agent)。任何一个环节缺失都按
 * 「未配置」回答——用户删了 agent / provider 被停用，旧会话打不开是配置事实，
 * 不是 404（行还在）也不是 500（没人做错什么）。
 */
async function resolveConversationEndpoints(
  conversation: Record<string, unknown>,
): Promise<{ provider: AssistantProviderRuntime; agent: AssistantUserAgentRuntime } | { error: string }> {
  const provider = await loadProviderById(String(conversation.provider_id));
  if (!provider) return { error: "conversation not found" };
  if (!provider.enabled) return { error: "the provider of this conversation is disabled" };
  try {
    const agent = await loadUserAgentForProvider(String(conversation.user_id), provider.id);
    if (!agent) return { error: NO_DEFAULT_AGENT };
    return { provider, agent };
  } catch {
    /* 凭据解密失败（P9-8）：与「没配」同一个处置动作，走 503/2005 分支。 */
    return { error: CREDENTIAL_UNREADABLE };
  }
}

type AttachmentInput = { fileUrl?: unknown; fileName?: unknown; mimeType?: unknown };
type MessageBody = { message?: unknown; attachments?: AttachmentInput[]; context?: unknown };

function validateMessage(body: MessageBody, attachmentsSupported: boolean): string | undefined {
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return "message is required";
  if (message.length > MAX_MESSAGE_CHARS) return `message is too long (max ${MAX_MESSAGE_CHARS} characters)`;
  if (body.attachments === undefined) return undefined;
  if (!Array.isArray(body.attachments)) return "attachments must be an array";
  if (!attachmentsSupported) return "this provider does not support attachments";
  if (body.attachments.length > MAX_ATTACHMENTS) return `too many attachments (max ${MAX_ATTACHMENTS})`;
  for (const [index, attachment] of (body.attachments as AttachmentInput[]).entries()) {
    const fileUrl = typeof attachment.fileUrl === "string" ? attachment.fileUrl.trim() : "";
    if (!/^https?:\/\//.test(fileUrl)) return `attachments[${index}].fileUrl must be an http(s) URL`;
    if (fileUrl.length > 2048) return `attachments[${index}].fileUrl is too long`;
    if (attachment.fileName !== undefined && (typeof attachment.fileName !== "string" || attachment.fileName.length > 255)) {
      return `attachments[${index}].fileName must be a string of at most 255 characters`;
    }
    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    if (!mimeType || mimeType.length > 128) return `attachments[${index}].mimeType is required`;
  }
  return undefined;
}

function writeSseEvent(raw: ServerResponse, event: AssistantEvent): void {
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function assistantRoutes(app: FastifyInstance) {
  /**
   * 我的会话列表——读映射表，不调上游（13.2：上游「会话列表」接口刻意不用，抽屉
   * 列表就是这一份；未配置信号在这里跑是为了给前端一个统一状态）。
   */
  app.get("/api/v1/assistant/conversations", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    if (!await loadResolvedDefaultAgent(reply, user.id)) return;
    const result = await pool.query(
      /* 协议随行带出（P9-4b）：mapper 按协议形状派生能力面（停止按钮显隐 / 历史加载，
         门槛 13）。INNER JOIN 安全——provider 删除时会话行级联删（迁移 057）。 */
      `SELECT c.*, p.protocol AS provider_protocol
       FROM assistant_conversations c
       JOIN assistant_providers p ON p.id = c.provider_id
       WHERE c.user_id = $1
       ORDER BY c.last_active_at DESC`,
      [user.id],
    );
    return success(result.rows.map(mapAssistantConversation), { total: result.rowCount });
  });

  /** 创建会话——按我的默认 agent 转发上游建会话，落一行映射。 */
  app.post("/api/v1/assistant/conversations", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    const resolved = await loadResolvedDefaultAgent(reply, user.id);
    if (!resolved) return;
    let upstreamConversationId: string;
    try {
      upstreamConversationId = await engineCreateConversation(resolved.provider, resolved.agent);
    } catch (error) {
      return failUpstream(reply, error);
    }
    const result = await pool.query(
      `INSERT INTO assistant_conversations (id, provider_id, user_id, upstream_conversation_id, topic)
       VALUES ($1, $2, $3, $4, '') RETURNING *`,
      [randomUUID(), resolved.provider.id, user.id, upstreamConversationId],
    );
    /* 能力面建会话时已知（provider 行就在手上），调用点补上——省一次回读 JOIN。 */
    return reply.code(201).send(success(mapAssistantConversation({ ...result.rows[0], provider_protocol: resolved.provider.protocol })));
  });

  /**
   * 发消息——SSE 流回。两段式（契约见 lib/assistant/types.ts）：上游接了请求
   * （响应头 OK）才 hijack，那之前的失败还能回干净的 JSON；hijack 之后的失败
   * 只能以 error 终态帧送出——这正是门槛 5「上游停机给出明确错误气泡」的通道。
   */
  app.post<{ Params: { conversationId: string }; Body: MessageBody }>(
    "/api/v1/assistant/conversations/:conversationId/message",
    async (request, reply) => {
      const user = await currentUser(request, reply); if (!user) return;
      if (!await loadResolvedDefaultAgent(reply, user.id)) return;
      if (!isUuid(request.params.conversationId)) return fail(reply, 404, 2001, "conversation not found");
      const conversation = await loadMyConversation(request.params.conversationId, user.id);
      if (!conversation) return fail(reply, 404, 2001, "conversation not found");
      const resolved = await resolveConversationEndpoints(conversation);
      if ("error" in resolved) {
        return resolved.error === "conversation not found"
          ? fail(reply, 404, 2001, "conversation not found")
          : fail(reply, 503, CODE_NOT_CONFIGURED, resolved.error);
      }
      const invalid = validateMessage(request.body ?? {}, Boolean(resolved.provider.protocol.attachments));
      if (invalid) return fail(reply, 400, 1001, invalid);

      /* 客户端断开检测挂在 reply.raw 上（不是 request.raw）：POST 的请求体进 handler
         前就被 Fastify 消费完，request.raw 的 close 信号不可靠；响应流的 close 才是
         「这条 SSE 没人听了」。error 兼作兜底——向已断 socket write 只会 emit error，
         挂着 listener 才不会以未处理事件炸掉进程。 */
      const abort = new AbortController();
      let clientGone = false;
      const onClientClose = () => { clientGone = true; abort.abort(); };
      reply.raw.on("close", onClientClose);
      reply.raw.on("error", onClientClose);

      let stream: AsyncIterable<AssistantEvent>;
      try {
        const attachments = (request.body?.attachments as AttachmentInput[] | undefined)?.map((attachment) => ({
          fileUrl: String(attachment.fileUrl).trim(),
          ...(typeof attachment.fileName === "string" && attachment.fileName ? { fileName: attachment.fileName } : {}),
          mimeType: String(attachment.mimeType).trim(),
        }));
        /* 页面上下文（P9-4c）：归一后封围栏前缀拼进转发 message——「当前接口」类指代
           靠它解析；协议配置零改动（{{message}} 渲染拼好的全文）。topic 仍用原文
           （下面的 fire-and-forget 读的就是 body.message，不受这里拼接影响）。 */
        const userMessage = String(request.body?.message).trim();
        stream = await engineStreamMessage(resolved.provider, resolved.agent, String(conversation.upstream_conversation_id), {
          message: composeForwardedMessage(userMessage, normalizePageContext(request.body?.context)),
          attachments: attachments?.length ? attachments : undefined,
          signal: abort.signal,
        });
      } catch (error) {
        return failUpstream(reply, error);
      }

      /* 接管原始响应（写法照 routes/stream.ts）：CORS 头必须手动搬——hijack 之后
         @fastify/cors 不再走发送流程，浏览器会直接拦掉这条跨域流，curl 看不出。 */
      const inherited = Object.fromEntries(
        Object.entries(reply.getHeaders())
          .filter(([key]) => key.startsWith("access-control-") || key === "vary")
          .map(([key, value]) => [key, String(value)]),
      );
      reply.hijack();
      reply.raw.writeHead(200, {
        ...inherited,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        /* nginx 默认缓冲代理响应，会把事件攒着一起发，实时性直接归零。 */
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": connected\n\n");
      const heartbeat = setInterval(() => { if (!clientGone) reply.raw.write(": ping\n\n"); }, HEARTBEAT_MS);

      try {
        for await (const event of stream) {
          if (clientGone) break;
          writeSseEvent(reply.raw, event);
          /* 终态帧后停止消费：adapter 契约保证 done/error 之后没有有意义的事件。 */
          if (event.type === "done" || event.type === "error") break;
        }
      } catch (error) {
        if (!clientGone) {
          /* hijack 之后只剩终态帧。带码（P9-8）：断流是平台判定的类别，前端据此
             说「连接中断，回复未完成」而不是贴一句上游的英文传输错误。 */
          writeSseEvent(reply.raw, {
            type: "error",
            message: `assistant upstream error: ${errorMessage(error)}`,
            code: "upstream_stream_failed",
          });
        }
      } finally {
        clearInterval(heartbeat);
        if (!clientGone) reply.raw.end();
        /* 对话确实发生过了：活跃时间照记；首条消息顺带落会话标题（P9-4 修订之四——
           下拉里只有时间戳读不出「这段聊的是什么」，topic 是首条消息的折叠摘要）。
           fire-and-forget：bump 不成不该把已经送出去的流标成失败，标题同理。 */
        const messageText = String(request.body?.message ?? "").trim();
        pool.query(
          "UPDATE assistant_conversations SET last_active_at = now(), topic = CASE WHEN topic = '' THEN $2 ELSE topic END WHERE id = $1",
          [request.params.conversationId, topicFromMessage(messageText)],
        ).catch(() => {});
        /* for-await 提前 break 时让上游读循环也停下来（正常收尾时是 no-op）。 */
        abort.abort();
      }
    },
  );

  /** 停止生成——行能力面没开 stop（JSON 导入可收窄）或 adapter 未实现时 400。 */
  app.post<{ Params: { conversationId: string } }>(
    "/api/v1/assistant/conversations/:conversationId/stop",
    async (request, reply) => {
      const user = await currentUser(request, reply); if (!user) return;
      if (!await loadResolvedDefaultAgent(reply, user.id)) return;
      if (!isUuid(request.params.conversationId)) return fail(reply, 404, 2001, "conversation not found");
      const conversation = await loadMyConversation(request.params.conversationId, user.id);
      if (!conversation) return fail(reply, 404, 2001, "conversation not found");
      const resolved = await resolveConversationEndpoints(conversation);
      if ("error" in resolved) {
        return resolved.error === "conversation not found"
          ? fail(reply, 404, 2001, "conversation not found")
          : fail(reply, 503, CODE_NOT_CONFIGURED, resolved.error);
      }
      /* 停止能力 = 协议里定义了 stop 端点（门槛 13：没定义就 400，按钮本就不该出现）。 */
      if (!resolved.provider.protocol.stop) {
        return fail(reply, 400, 1001, "this provider does not support stopping generation");
      }
      try {
        await engineStop(resolved.provider, resolved.agent, String(conversation.upstream_conversation_id));
      } catch (error) {
        return failUpstream(reply, error);
      }
      return success({ stopped: true });
    },
  );

  /**
   * 记录 MRTR 确认结果（2026-09-15，P9-5 增补）：确认卡的动作走本人 JWT 的既有
   * REST（删除本身有自己的审计），上游 transcript 不知道这件事——结果落映射行的
   * elicit_log，历史回放时由 messages 路由并回。追加式 append；失败不回滚删除
   * （记录丢一条只是回放少一行，业务事实以删除的审计为准）。
   */
  app.post<{ Params: { conversationId: string }; Body: { tool?: unknown; input?: unknown; outcome?: unknown } }>(
    "/api/v1/assistant/conversations/:conversationId/elicit",
    async (request, reply) => {
      const user = await currentUser(request, reply); if (!user) return;
      if (!isUuid(request.params.conversationId)) return fail(reply, 404, 2001, "conversation not found");
      const conversation = await loadMyConversation(request.params.conversationId, user.id);
      if (!conversation) return fail(reply, 404, 2001, "conversation not found");
      const tool = typeof request.body?.tool === "string" ? request.body.tool.trim() : "";
      if (!tool || tool.length > 100) return fail(reply, 400, 1001, "tool must be a string of 1-100 characters");
      const outcome = request.body?.outcome;
      if (outcome !== "confirmed" && outcome !== "declined") return fail(reply, 400, 1001, "outcome must be confirmed or declined");
      const input = request.body?.input;
      if (input !== undefined && (typeof input !== "object" || Array.isArray(input))) {
        return fail(reply, 400, 1001, "input must be an object");
      }
      const entry = { tool, ...(input ? { input } : {}), outcome, at: new Date().toISOString() };
      await pool.query(
        "UPDATE assistant_conversations SET elicit_log = elicit_log || $2::jsonb, last_active_at = now() WHERE id = $1",
        [conversation.id, JSON.stringify([entry])],
      );
      return success({ recorded: true });
    },
  );

  /**
   * 历史代理——转发上游按会话查历史（平台不存 transcript，刷新/换设备的回放全靠
   * 它）。index/limit 是上游的分页游标，这里只校验形状后透传。带缓存头：历史是
   * 已发生的事实，允许浏览器短暂缓存省一次代理往返。
   */
  app.get<{ Params: { conversationId: string }; Querystring: { index?: string; limit?: string } }>(
    "/api/v1/assistant/conversations/:conversationId/messages",
    async (request, reply) => {
      const user = await currentUser(request, reply); if (!user) return;
      if (!await loadResolvedDefaultAgent(reply, user.id)) return;
      if (!isUuid(request.params.conversationId)) return fail(reply, 404, 2001, "conversation not found");
      const conversation = await loadMyConversation(request.params.conversationId, user.id);
      if (!conversation) return fail(reply, 404, 2001, "conversation not found");
      const resolved = await resolveConversationEndpoints(conversation);
      if ("error" in resolved) {
        return resolved.error === "conversation not found"
          ? fail(reply, 404, 2001, "conversation not found")
          : fail(reply, 503, CODE_NOT_CONFIGURED, resolved.error);
      }
      /* 历史能力 = 协议里定义了 history 端点。 */
      if (!resolved.provider.protocol.history) return fail(reply, 400, 1001, "this provider does not support message history");
      const { index, limit } = request.query;
      if (index !== undefined && !/^\d+$/.test(index)) return fail(reply, 400, 1001, "index must be a numeric cursor");
      const historyLimit = limit === undefined ? 50 : Number(limit);
      if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 100) {
        return fail(reply, 400, 1001, "limit must be an integer between 1 and 100");
      }
      let messages;
      try {
        messages = await engineHistory(resolved.provider, resolved.agent, String(conversation.upstream_conversation_id), { index, limit: historyLimit });
      } catch (error) {
        return failUpstream(reply, error);
      }
      /* MRTR 确认结果并回（2026-09-15）：上游 transcript 不知道确认动作，平台的
         记录（elicit_log）在这里变成 system 行交给前端渲染。确认发生在上游消息
         之后，按时间戳插回各自位置（从尾回扫，找第一个「可解析且不晚于记录」的
         行插其后——确认后又聊过几句的场景记录才不会缀到最新消息后面）；上游行
         没时间（或格式不认）就缀尾——宁可次序保守也不丢记录。有确认记录时关掉
         短缓存：刚记的确认被 60s 缓存吞掉，用户看到的还是「没有这个记录」。 */
      const elicitLog = Array.isArray(conversation.elicit_log) ? conversation.elicit_log as Record<string, unknown>[] : [];
      const rows: { id: string; role: string; text: string; time?: string; elicit?: unknown }[] = messages.map((row) => ({ ...row, text: stripContextPrefix(row.text) }));
      for (const [indexAt, entry] of elicitLog.entries()) {
        const at = typeof entry.at === "string" ? new Date(entry.at).getTime() : Number.NaN;
        const record = {
          id: `${String(conversation.id)}:elicit:${indexAt}`,
          role: "system",
          text: "",
          elicit: { tool: String(entry.tool ?? ""), outcome: entry.outcome === "declined" ? "declined" : "confirmed", ...(entry.input && typeof entry.input === "object" ? { input: entry.input } : {}) },
        };
        let position = rows.length;
        if (Number.isFinite(at)) {
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            /* 取到局部 const 再判：let 索引的元素访问不做跨语句窄化。 */
            const rowTime = rows[i].time;
            const time = rowTime ? new Date(rowTime).getTime() : Number.NaN;
            if (Number.isFinite(time) && time <= at) { position = i + 1; break; }
          }
        }
        rows.splice(position, 0, record);
      }
      reply.header("Cache-Control", elicitLog.length ? "no-store" : "private, max-age=60");
      return success(rows, { total: rows.length });
    },
  );

  /**
   * 删除会话（P9-4 后续：清理脏数据）——删两处：本地映射行 + 上游会话本体。
   * 上游有删除接口就调（协议里配了 delete 端点），没配则只删映射行（上游侧留痕
   * 不碍事——那本来就不是我们的数据）；上游删除失败不阻断本地删除——映射行没了
   * 这段对话在本平台就不可达，上游残留只是它自己多一行会话。
   */
  app.delete<{ Params: { conversationId: string } }>(
    "/api/v1/assistant/conversations/:conversationId",
    async (request, reply) => {
      const user = await currentUser(request, reply); if (!user) return;
      if (!isUuid(request.params.conversationId)) return fail(reply, 404, 2001, "conversation not found");
      const conversation = await loadMyConversation(request.params.conversationId, user.id);
      if (!conversation) return fail(reply, 404, 2001, "conversation not found");
      let upstreamDeleted = false;
      const resolved = await resolveConversationEndpoints(conversation);
      if (!("error" in resolved)) {
        try {
          await engineDeleteConversation(resolved.provider, resolved.agent, String(conversation.upstream_conversation_id));
          upstreamDeleted = true;
        } catch (error) {
          /* 上游删除失败（没配删除端点 / 上游报错）：不阻断——本地映射行照删，
             response 里如实报告上游侧结果。 */
          request.log.warn({ err: errorMessage(error) }, "assistant upstream conversation delete failed");
        }
      }
      const deleted = await pool.query(
        "DELETE FROM assistant_conversations WHERE id = $1 AND user_id = $2 RETURNING id",
        [request.params.conversationId, user.id],
      );
      if (!deleted.rowCount) return fail(reply, 404, 2001, "conversation not found");
      return success({ id: deleted.rows[0].id, upstreamDeleted });
    },
  );
}
