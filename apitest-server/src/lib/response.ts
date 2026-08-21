import type { FastifyReply } from "fastify";

export function success<T>(data: T, meta?: Record<string, unknown>) {
  return { code: 0, message: "success", data, ...(meta ? { meta } : {}) };
}

export function fail(reply: FastifyReply, statusCode: number, code: number, message: string) {
  return reply.code(statusCode).send({ code, message, data: null });
}
