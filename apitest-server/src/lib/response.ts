import type { FastifyReply } from "fastify";

export function success<T>(data: T, meta?: Record<string, unknown>) {
  return { code: 0, message: "success", data, ...(meta ? { meta } : {}) };
}

export function fail(reply: FastifyReply, statusCode: number, code: number, message: string) {
  return reply.code(statusCode).send({ code, message, data: null });
}

/**
 * 目标执行分区没有在线执行器（P2-8，错误码 2004）。
 *
 * 与 `environments.ts` 的 2003 同一类刻意变体：失败响应仍带 `data`，因为客户端要用
 * `label` 说清是**哪个分区**没有执行器。不复用「执行队列不可用」那句文案——「Redis 挂了」
 * 与「这个网段没人服务」是两个完全不同的处置动作（去修队列 / 去那台机器起一个 worker），
 * 混成一句会把排查方向带偏。
 *
 * 503 而不是 400：输入没有任何问题，缺的是基础设施，与队列不可用同一档。
 */
export function failNoRunner(reply: FastifyReply, label: string, message: string) {
  return reply.code(503).send({ code: 2004, message, data: { label } });
}
