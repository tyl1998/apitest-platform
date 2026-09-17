import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, auditFields, writeAuditLogAsync } from "../lib/audit.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { createRedis } from "../lib/queue.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { VARIABLE_NAME_PATTERN } from "../lib/resolve.js";
import { fail, success } from "../lib/response.js";
import { environmentBelongs, failTrigger, triggerCiTaskRun, triggerFlowRun, triggerSuiteRun } from "../lib/trigger.js";
import { isUuid } from "../lib/uuid.js";
import { WEBHOOK_TARGET_TYPES, mapWebhookTrigger, type WebhookTargetType } from "../models/types.js";

/**
 * Webhook 触发（P3-6，计划 6.2，边界 6、7；P4.5-12 加 CI 任务目标，计划 8.7）。
 * 目标为流程、套件或 CI 任务（`WEBHOOK_TARGET_TYPES`）。
 *
 * 管理路由与其它资源同款（项目内、写操作要求非 viewer）；公开触发路由
 * `POST /webhooks/:publicId` 无鉴权，凭 HMAC 准入——形状照 P2-5 的 Mock 运行时
 * （`/mock/:publicId/*` 是本仓库唯一已有的「外部可直接调用」先例），差别是 Mock 只
 * 要猜中 public_id，这里还必须签对密钥：public_id 会出现在网关日志、浏览器历史与
 * 消息平台的回调配置里，不能当作秘密。
 *
 * 签名：`X-Apitest-Timestamp` / `-Nonce` / `-Signature` 三个头缺一不可，签名的原文是
 * `timestamp.nonce.<原始请求体字节>`（HMAC-SHA256，hex）。时间戳窗口 ±300 秒；nonce
 * 用 Redis `SET NX EX` 挡重放——窗口内的同一组 (publicId, nonce) 只被接受一次。密钥
 * AES-GCM 加密存库（验签必须拿明文，所以不能只存哈希），创建/轮换时回明文一次，之后
 * 管理接口只回 hasSecret。**HMAC 验证、时间窗、nonce 防重放在 P4.5-12 一处未改。**
 */

/** 时间戳窗口与 nonce 记忆时长（秒）：记忆比窗口长一倍，盖住两边的时钟偏差。 */
const SIGNATURE_WINDOW_SECONDS = 300;
const NONCE_TTL_SECONDS = SIGNATURE_WINDOW_SECONDS * 2;

/** 目标类型 → 那张表（代码常量三选一，不是输入拼接；见 validateTarget）。 */
const TARGET_TABLES: Record<WebhookTargetType, string> = { flow: "flows", suite: "test_suites", ci_task: "ci_tasks" };

/** 带目标名的一行（目标被删后 LEFT JOIN 得 NULL，仍读得通）。 */
/* P11 归属列（边界 7/9）：`LEFT JOIN users` 带出 email 快照。常量被列表与详情共用；
   基表已显式 `w.*`，加 join 不会污染投影。 */
const SELECT_TRIGGER = `SELECT w.*, COALESCE(f.name, ts.name, ct.name) AS target_name, creator.email AS created_by_email, updater.email AS updated_by_email FROM webhook_triggers w
  LEFT JOIN flows f ON w.target_type = 'flow' AND f.id = w.target_id
  LEFT JOIN test_suites ts ON w.target_type = 'suite' AND ts.id = w.target_id
  LEFT JOIN ci_tasks ct ON w.target_type = 'ci_task' AND ct.id = w.target_id
  LEFT JOIN users creator ON creator.id = w.created_by
  LEFT JOIN users updater ON updater.id = w.updated_by`;

type TriggerBody = {
  name?: string;
  targetType?: WebhookTargetType;
  targetId?: string;
  /** 触发级环境覆盖（边界 4）：null = 清掉。CI 目标上无意义（脚本自己选环境）。 */
  environmentId?: string | null;
  enabled?: boolean;
};

async function validateTarget(projectId: string, targetType: string, targetId: string): Promise<string | undefined> {
  if (!(WEBHOOK_TARGET_TYPES as readonly string[]).includes(targetType)) {
    return `targetType must be one of ${WEBHOOK_TARGET_TYPES.join(", ")}`;
  }
  if (!isUuid(targetId)) return "targetId must be a UUID";
  /* 表名从 TARGET_TABLES 取（代码常量），id 走参数。 */
  const found = await pool.query(
    `SELECT 1 FROM ${TARGET_TABLES[targetType as WebhookTargetType]} WHERE id = $1 AND project_id = $2`,
    [targetId, projectId],
  );
  if (!found.rowCount) return `targetId must reference a ${targetType === "ci_task" ? "CI task" : targetType} in this project`;
  return undefined;
}

/**
 * Webhook 请求体的变量注入（边界 7，仅流程）：只取顶层的字符串/数字/布尔，键匹配
 * 变量名约束；嵌套对象与非法键直接跳过——展开规则是流程变量该管的事，这里拒绝
 * 整个请求只会让调用方为一个小字段重发。
 */
function scalarOverrides(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!VARIABLE_NAME_PATTERN.test(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") overrides[key] = String(value);
  }
  return overrides;
}

/* nonce 防重放的 Redis 连接：惰性建连，注册管理路由不碰 Redis。 */
let nonceStore: Redis | undefined;
function nonceRedis(): Redis {
  nonceStore ??= createRedis();
  return nonceStore;
}

export async function webhookTriggerRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/webhook-triggers", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const result = await pool.query(`${SELECT_TRIGGER} WHERE w.project_id = $1 ORDER BY w.created_at DESC`, [context.project.id]);
    return success(result.rows.map(mapWebhookTrigger), { total: result.rowCount });
  });

  app.post<{ Params: { id: string }; Body: TriggerBody }>("/api/v1/projects/:id/webhook-triggers", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const name = request.body?.name?.trim();
    if (!name) return fail(reply, 400, 1001, "trigger name is required");
    if (!request.body?.targetType || !request.body?.targetId) return fail(reply, 400, 1001, "targetType and targetId are required");
    const invalidTarget = await validateTarget(context.project.id, request.body.targetType, request.body.targetId);
    if (invalidTarget) return fail(reply, 400, 1001, invalidTarget);
    if (request.body.environmentId !== undefined && request.body.environmentId !== null) {
      if (!isUuid(String(request.body.environmentId))) return fail(reply, 400, 1001, "environmentId must be a UUID");
      if (!await environmentBelongs(context.project.id, request.body.environmentId)) return fail(reply, 400, 1001, "environment must belong to the project");
    }

    /* 明文只在这一次响应里出现（边界 6）：之后管理接口只回 hasSecret，丢了只能轮换。 */
    const secret = randomBytes(32).toString("base64url");
    const result = await pool.query(
      `INSERT INTO webhook_triggers (id, project_id, name, target_type, target_id, environment_id, public_id, secret_encrypted, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [randomUUID(), context.project.id, name, request.body.targetType, request.body.targetId, request.body.environmentId ?? null, randomBytes(18).toString("base64url"), encryptSecret(secret), request.body.enabled ?? true, context.user.id],
    );
    /* P11-9 审计（边界 5/6）：detail 只有字段名，secret 明文绝不进。 */
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.webhookTriggerCreate, targetType: "webhook_trigger", targetId: String(result.rows[0].id),
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return reply.code(201).send(success({ ...mapWebhookTrigger(result.rows[0]), secret }));
  });

  app.get<{ Params: { id: string; triggerId: string } }>("/api/v1/projects/:id/webhook-triggers/:triggerId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.triggerId)) return fail(reply, 404, 2001, "webhook trigger not found");
    const result = await pool.query(`${SELECT_TRIGGER} WHERE w.id = $1 AND w.project_id = $2`, [request.params.triggerId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "webhook trigger not found");
    return success(mapWebhookTrigger(result.rows[0]));
  });

  app.put<{ Params: { id: string; triggerId: string }; Body: TriggerBody }>("/api/v1/projects/:id/webhook-triggers/:triggerId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.triggerId)) return fail(reply, 404, 2001, "webhook trigger not found");
    const existing = await pool.query("SELECT * FROM webhook_triggers WHERE id = $1 AND project_id = $2", [request.params.triggerId, context.project.id]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "webhook trigger not found");

    const name = request.body?.name?.trim();
    if (request.body?.name !== undefined && !name) return fail(reply, 400, 1001, "trigger name is required");
    /* 目标类型与目标 id 必须一起换：只换一个就是对不上的悬空引用。 */
    let targetType: string | undefined;
    let targetId: string | undefined;
    if (request.body?.targetType !== undefined || request.body?.targetId !== undefined) {
      targetType = request.body?.targetType ?? String(existing.rows[0].target_type);
      targetId = request.body?.targetId ?? String(existing.rows[0].target_id);
      const invalidTarget = await validateTarget(context.project.id, targetType, targetId);
      if (invalidTarget) return fail(reply, 400, 1001, invalidTarget);
    }
    if (request.body?.environmentId !== undefined && request.body.environmentId !== null) {
      if (!isUuid(String(request.body.environmentId))) return fail(reply, 400, 1001, "environmentId must be a UUID");
      if (!await environmentBelongs(context.project.id, request.body.environmentId)) return fail(reply, 400, 1001, "environment must belong to the project");
    }
    /* environmentId 三态：缺省不动，null 清掉，字符串换。 */
    const environmentId = request.body?.environmentId === undefined ? existing.rows[0].environment_id : request.body.environmentId;

    await pool.query(
      `UPDATE webhook_triggers SET name = COALESCE($1, name), target_type = COALESCE($2, target_type),
         target_id = COALESCE($3, target_id), environment_id = $4, enabled = COALESCE($5, enabled), updated_by = $8, updated_at = now()
       WHERE id = $6 AND project_id = $7`,
      [name ?? null, targetType ?? null, targetId ?? null, environmentId, request.body?.enabled ?? null, request.params.triggerId, context.project.id, context.user.id],
    );
    const updated = await pool.query(`${SELECT_TRIGGER} WHERE w.id = $1 AND w.project_id = $2`, [request.params.triggerId, context.project.id]);
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.webhookTriggerUpdate, targetType: "webhook_trigger", targetId: request.params.triggerId,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return success(mapWebhookTrigger(updated.rows[0]));
  });

  app.delete<{ Params: { id: string; triggerId: string } }>("/api/v1/projects/:id/webhook-triggers/:triggerId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.triggerId)) return fail(reply, 404, 2001, "webhook trigger not found");
    const result = await pool.query("DELETE FROM webhook_triggers WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.triggerId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "webhook trigger not found");
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.webhookTriggerDelete, targetType: "webhook_trigger", targetId: String(result.rows[0].id),
      projectId: context.project.id, userId: context.user.id, ip: request.ip,
    });
    return success({ id: result.rows[0].id });
  });

  /** 轮换密钥：旧密钥立刻作废（覆盖存库），明文只在本次响应出现一次。 */
  app.post<{ Params: { id: string; triggerId: string } }>("/api/v1/projects/:id/webhook-triggers/:triggerId/rotate-secret", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.triggerId)) return fail(reply, 404, 2001, "webhook trigger not found");
    const secret = randomBytes(32).toString("base64url");
    const result = await pool.query(
      "UPDATE webhook_triggers SET secret_encrypted = $2, updated_by = $4, updated_at = now() WHERE id = $1 AND project_id = $3 RETURNING id",
      [request.params.triggerId, encryptSecret(secret), context.project.id, context.user.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "webhook trigger not found");
    /* 轮换也是一次 update：字段名写死 "secret"，新旧明文都不进。 */
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.webhookTriggerUpdate, targetType: "webhook_trigger", targetId: String(result.rows[0].id),
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: ["secret"] }, ip: request.ip,
    });
    return success({ id: result.rows[0].id, secret });
  });

  /**
   * 公开触发路由（无鉴权，HMAC 准入）。
   *
   * 单独封装成子插件：内容类型解析器的作用域是注册它的实例，buffer 解析只影响这一条
   * 路由。签名必须对**原始字节**算——全局 JSON 解析器会把请求体变成对象，重序列化后
   * 的字节与对方签名的字节差一个空格就全错。
   */
  app.register(async (scope) => {
    /* Fastify 的子作用域会**克隆**父级解析器表，`*` 兜底盖不掉继承下来的
       application/json 具体解析器（getParser 先精确匹配后兜底）——所以 json 与
       text/plain 要显式重注册成 buffer，其余类型交给兜底。 */
    const asBuffer = (_request: unknown, body: Buffer, done: (err: Error | null, result?: unknown) => void) => done(null, body);
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, asBuffer);
    scope.addContentTypeParser("text/plain", { parseAs: "buffer" }, asBuffer);
    scope.addContentTypeParser("*", { parseAs: "buffer" }, asBuffer);
    scope.post<{ Params: { publicId: string } }>("/webhooks/:publicId", async (request, reply) => {
      const found = await pool.query("SELECT * FROM webhook_triggers WHERE public_id = $1 AND enabled = true", [request.params.publicId]);
      if (!found.rowCount) return fail(reply, 404, 2001, "webhook trigger not found");
      const row = found.rows[0];

      const timestamp = request.headers["x-apitest-timestamp"];
      const nonce = request.headers["x-apitest-nonce"];
      const signature = request.headers["x-apitest-signature"];
      if (typeof timestamp !== "string" || typeof nonce !== "string" || typeof signature !== "string") {
        return fail(reply, 401, 1002, "X-Apitest-Timestamp, X-Apitest-Nonce and X-Apitest-Signature headers are required");
      }
      /* 先判时间窗再碰 Redis：过期时间戳连 nonce 都不值得记。 */
      const seconds = Number(timestamp);
      if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > SIGNATURE_WINDOW_SECONDS) {
        return fail(reply, 401, 1002, "signature timestamp is outside the allowed window");
      }
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
      let expected: string;
      try {
        expected = createHmac("sha256", decryptSecret(row.secret_encrypted as Buffer)).update(`${timestamp}.${nonce}.${raw.toString("utf8")}`).digest("hex");
      } catch {
        return fail(reply, 500, 5001, "webhook secret could not be decrypted");
      }
      if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return fail(reply, 401, 1002, "signature does not match");
      }
      const replayKey = `webhook:nonce:${request.params.publicId}:${nonce}`;
      const store = nonceRedis();
      const first = await store.set(replayKey, "1", "EX", NONCE_TTL_SECONDS, "NX");
      if (first !== "OK") return fail(reply, 401, 1002, "nonce has already been used");

      /* last_triggered_at 记「准入成功」：外部调用方已经敲对了门，执行失败与否是
         执行的事，不该把一次被 2004 拒绝的触发显示成「从没来过」。

         `updated_by` 刻意不写（P11 边界 3）：这是外部调用方触发的运行事实，不是「谁
         改了这条配置」——它没有登录用户可写，硬塞成配置创建人会把「系统触发」答成
         「某人改过」。「触发人」这一问由执行记录回答（P11-6），不在这张表上。 */
      await pool.query("UPDATE webhook_triggers SET last_triggered_at = now() WHERE id = $1", [row.id]);

      const projectId = String(row.project_id);
      const environmentId = row.environment_id ? String(row.environment_id) : undefined;
      const trigger = { source: "webhook" as const, refId: String(row.id), refName: String(row.name) };
      const targetType = String(row.target_type);
      try {
        /* 三分支**显式**分派（P4.5-12 改掉了原来的 `if flow / else suite` 落空写法）：
           那种写法下一个未知的 target_type 会被静默当套件跑一遍，而 CHECK 之外的值只可能
           来自有人手改过行——按未知拒绝才对。 */
        if (targetType === "flow") {
          /* 请求体注入仅流程（边界 7）：套件与 CI 任务没有这个变量模型，body 整体忽略。
             非 JSON 的请求体注入为空而不是报错——准入靠签名，不靠格式。 */
          let body: unknown;
          try { body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined; } catch { body = undefined; }
          const flowExecutionId = await triggerFlowRun({
            projectId, flowId: String(row.target_id), environmentId,
            variableOverrides: scalarOverrides(body),
            trigger,
          });
          return reply.code(202).send(success({ flowExecutionId }));
        }
        if (targetType === "suite") {
          const suiteExecutionId = await triggerSuiteRun({
            projectId, suiteId: String(row.target_id), environmentId, trigger,
          });
          return reply.code(202).send(success({ suiteExecutionId }));
        }
        if (targetType === "ci_task") {
          /**
           * CI 任务目标（P4.5-12）。走 `triggerCiTaskRun`——无在线 Runner 的 2004、沙箱档
           * 可满足性、任务停用这些检查与手动触发共用一份（P3 边界 5）。
           *
           * **不注入请求体、不带 `Idempotency-Key`**：
           * - 请求体注入是流程独占（边界 7）。CI 任务确实有 `parameters` 这个同形的袋子，
           *   但把外部 POST 的顶层标量灌进 Runner 的环境变量是另一件事——那些值会进
           *   `env`、进日志（任务级 secret 已删，Runner 侧没有脱敏词表，见 8.11 的 B 类）。
           *   要带参数就在任务的 `env` 里写死，或者用调度的变量覆盖。
           * - 幂等键的来源只能是 nonce，而 nonce 已经在上面挡掉重放了；再加一层只是把同一
           *   个不变量说第二遍，且 `IdempotentReplayError` 不被 `failTrigger` 认作失败，
           *   落到下面的 catch 里会变成一个 500。
           */
          const run = await triggerCiTaskRun({
            projectId, ciTaskId: String(row.target_id), trigger,
          });
          return reply.code(202).send(success({ pipelineRunId: run.id, runNumber: run.runNumber }));
        }
        return fail(reply, 400, 1001, `unsupported webhook target type "${targetType}"`);
      } catch (error) {
        return failTrigger(reply, error, "webhook trigger failed");
      }
    });
  });
}
