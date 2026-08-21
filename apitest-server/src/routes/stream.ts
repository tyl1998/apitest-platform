import type { FastifyInstance } from "fastify";
import { subscribeEvents } from "../lib/events.js";
import { requireProjectAccess } from "../lib/rbac.js";

/**
 * 心跳间隔。
 *
 * 空闲的 SSE 连接会被反向代理按 idle timeout 掐断（常见 60 秒），而排队中的
 * 执行本来就可能长时间无事发生。注释行不触发前端任何逻辑，只用来让连接看起来
 * 一直有流量。
 */
const HEARTBEAT_MS = 25_000;

export async function streamRoutes(app: FastifyInstance) {
  /**
   * 项目级执行事件流（P1-3）。
   *
   * 一条流覆盖单发调试、用例执行与批量调试：三者都只是「某个 execution 变了
   * 状态」，按入口各开一条流只会让前端维护三份重连逻辑。
   *
   * 载荷不含响应体——见 lib/events.ts。前端收到终态后按 id 拉详情。
   */
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/executions/stream", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;

    /**
     * 接管原始响应：SSE 是一条不结束的流，走不了正常的序列化与信封。
     *
     * CORS 头必须手动搬过来：hijack 之后 Fastify 不再走发送流程，
     * @fastify/cors 在 onRequest 里挂到 reply 上的头就不会被写出，浏览器会直接
     * 拦掉这条跨域流——前端于是只能退回轮询兜底，每次执行都白等一个轮询周期。
     * curl 看不出问题，因为它不检查 CORS。
     *
     * 只搬 CORS 相关的，不整包 spread：其余头是给 JSON 响应准备的，套到
     * event-stream 上只会带来意外。
     */
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

    const projectId = context.project.id;
    const unsubscribe = subscribeEvents((event) => {
      /* 一个 Redis 订阅扇出给所有连接，因此按项目过滤只能在这里做。 */
      if (event.projectId !== projectId) return;
      reply.raw.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), HEARTBEAT_MS);

    /* 关连接与定时器必须成对撤销，否则每次刷新页面都会漏一个订阅与一个 timer。 */
    const close = () => { clearInterval(heartbeat); unsubscribe(); };
    request.raw.on("close", close);
    request.raw.on("error", close);
  });
}
