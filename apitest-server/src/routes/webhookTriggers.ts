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

/** 前端基地址（报告跳转链接用）：优先 `WEB_ORIGIN` 环境变量，缺省本地 dev 的 5173。 */
function webOrigin(): string {
  return (process.env.WEB_ORIGIN ?? "http://localhost:5173").replace(/\/+$/, "");
}

/** 目标类型 → 那张表（代码常量三选一，不是输入拼接；见 validateTarget）。 */
const TARGET_TABLES: Record<WebhookTargetType, string> = { flow: "flows", suite: "test_suites", ci_task: "ci_tasks" };

/** 带目标名的一行（目标被删后 LEFT JOIN 得 NULL，仍读得通）。 */
/* P11 归属列（边界 7/9）：`LEFT JOIN users` 带出 email 快照。常量被列表与详情共用；
   基表已显式 `w.*`，加 join 不会污染投影。 */
const SELECT_TRIGGER = `SELECT w.*, COALESCE(f.name, ts.name, ct.name) AS target_name, creator.email AS created_by_email, updater.email AS updated_by_email,
  COALESCE(se.status, pr.status, fe.status) AS last_run_status,
  CASE WHEN w.last_run_id IS NOT NULL THEN COALESCE(
    se.status, pr.status, fe.status
  ) END AS last_run_status_resolved
FROM webhook_triggers w
  LEFT JOIN flows f ON w.target_type = 'flow' AND f.id = w.target_id
  LEFT JOIN test_suites ts ON w.target_type = 'suite' AND ts.id = w.target_id
  LEFT JOIN ci_tasks ct ON w.target_type = 'ci_task' AND ct.id = w.target_id
  LEFT JOIN users creator ON creator.id = w.created_by
  LEFT JOIN users updater ON updater.id = w.updated_by
  LEFT JOIN suite_executions se ON w.target_type = 'suite' AND se.id = w.last_run_id
  LEFT JOIN pipeline_runs pr ON w.target_type = 'ci_task' AND pr.id = w.last_run_id
  LEFT JOIN flow_executions fe ON w.target_type = 'flow' AND fe.id = w.last_run_id`;

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
    /* `_trigger_url` 是保留键（触发来源链接，见触发分支），不当作变量注入。 */
    if (key === "_trigger_url") continue;
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

  /** 读取密钥明文（2026-09-26 验收需求）：列表行「复制 curl」需要真实密钥才能拼出可直接
      运行的脚本。密钥对项目内可写成员本就可得（轮换/更新都在这一层），读一次明文不扩大
      爆炸半径；审计记一次字段名。 */
  app.get<{ Params: { id: string; triggerId: string } }>("/api/v1/projects/:id/webhook-triggers/:triggerId/secret", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.triggerId)) return fail(reply, 404, 2001, "webhook trigger not found");
    const result = await pool.query("SELECT secret_encrypted FROM webhook_triggers WHERE id = $1 AND project_id = $2", [request.params.triggerId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "webhook trigger not found");
    let secret: string;
    try { secret = decryptSecret(result.rows[0].secret_encrypted as Buffer); }
    catch { return fail(reply, 500, 5001, "webhook secret could not be decrypted"); }
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.webhookTriggerReadSecret, targetType: "webhook_trigger", targetId: request.params.triggerId,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: ["secret"] }, ip: request.ip,
    });
    return success({ id: request.params.triggerId, secret });
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
      /* 请求体里可带一个保留键 `_trigger_url`（第三方 CI 放本次任务地址），记为触发来源
         链接；不校验协议，只取字符串。scalarOverrides 会跳过它（`_` 开头键名合法但语义
         保留给来源，不进变量）。 */
      let sourceUrl: string | undefined;
      try {
        const parsedBody = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
        if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) && typeof (parsedBody as Record<string, unknown>)._trigger_url === "string") {
          sourceUrl = (parsedBody as Record<string, unknown>)._trigger_url as string;
        }
      } catch { /* 非 JSON 请求体没有来源链接，准入靠签名不靠格式 */ }
      const trigger = { source: "webhook" as const, refId: String(row.id), refName: String(row.name), sourceUrl };
      const targetType = String(row.target_type);
      try {
        /* 三分支**显式**分派（P4.5-12 改掉了原来的 `if flow / else suite` 落空写法）：
           那种写法下一个未知的 target_type 会被静默当套件跑一遍，而 CHECK 之外的值只可能
           来自有人手改过行——按未知拒绝才对。 */
        if (targetType === "flow") {
          /* 请求体顶层标量注入为流程变量覆盖（边界 7）。非 JSON 的请求体注入为空而不是
             报错——准入靠签名，不靠格式。 */
          let body: unknown;
          try { body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined; } catch { body = undefined; }
          const flowExecutionId = await triggerFlowRun({
            projectId, flowId: String(row.target_id), environmentId,
            variableOverrides: scalarOverrides(body),
            trigger,
          });
          await pool.query("UPDATE webhook_triggers SET last_run_id = $2 WHERE id = $1", [row.id, flowExecutionId]);
          return reply.code(202).send(success({
            flowExecutionId,
            reportUrl: `${webOrigin()}/projects/${projectId}/execution-index/${flowExecutionId}`,
          }));
        }
        if (targetType === "suite") {
          /* 请求体的顶层标量作为**变量覆盖**传入（2026-09-26 验收需求）：套件成员与
             环境默认头都能引用变量（如 `defaultHeaders: {"X-Env-Tag": "{{lane}}"}`），
             触发时注入 `{"lane":"A"}` 就能按请求体分流到对应环境。与流程同用
             `scalarOverrides` 展开——只取顶层字符串/数字/布尔，嵌套对象与非法键跳过。 */
          let body: unknown;
          try { body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined; } catch { body = undefined; }
          const suiteExecutionId = await triggerSuiteRun({
            projectId, suiteId: String(row.target_id), environmentId,
            variables: scalarOverrides(body),
            trigger,
          });
          await pool.query("UPDATE webhook_triggers SET last_run_id = $2 WHERE id = $1", [row.id, suiteExecutionId]);
          return reply.code(202).send(success({
            suiteExecutionId,
            reportUrl: `${webOrigin()}/projects/${projectId}/suite-reports/${suiteExecutionId}`,
          }));
        }
        if (targetType === "ci_task") {
          /**
           * CI 任务目标（P4.5-12）。走 `triggerCiTaskRun`——无在线 Runner 的 2004、沙箱档
           * 可满足性、任务停用这些检查与手动触发共用一份（P3 边界 5）。
           *
           * **把请求体的顶层标量作为 `parameters` 透传（2026-09-26 验收需求）**：脚本想
           * 区分目标环境（如 `X=A`）就靠它——`parameters` 会以环境变量形式出现在 Runner
           * 的 shell 里（`lib/jobSpec.ts` 合并进 env），脚本读变量即可分流。只取顶层的
           * 字符串/数字/布尔（与流程的 `scalarOverrides` 同一套展开），嵌套对象与非法键
           * 直接跳过——一个字段不合规不该让整次触发失败。**不进 audit 明文**：parameters
           * 只记键名（`triggerCiTaskRun` 落 `parameterKeys`），值可能含用户数据。
           *
           * 幂等键的来源只能是 nonce，而 nonce 已经在上面挡掉重放了；再加一层只是把同一
           * 个不变量说第二遍，且 `IdempotentReplayError` 不被 `failTrigger` 认作失败，
           * 落到下面的 catch 里会变成一个 500。
           */
          let body: unknown;
          try { body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined; } catch { body = undefined; }
          const run = await triggerCiTaskRun({
            projectId, ciTaskId: String(row.target_id), trigger,
            parameters: scalarOverrides(body),
          });
          await pool.query("UPDATE webhook_triggers SET last_run_id = $2 WHERE id = $1", [row.id, run.id]);
          return reply.code(202).send(success({
            pipelineRunId: run.id, runNumber: run.runNumber,
            reportUrl: `${webOrigin()}/projects/${projectId}/pipeline-runs/${run.id}`,
          }));
        }
        return fail(reply, 400, 1001, `unsupported webhook target type "${targetType}"`);
      } catch (error) {
        return failTrigger(reply, error, "webhook trigger failed");
      }
    });

    /**
     * 运行状态查询（2026-09-26 验收需求）：外部 CI 触发后轮询等结果，走同一套 HMAC 签名
     * （不需要另配 API key / JWT）。GET 无 body，签名原文是 `timestamp.nonce.`（末尾空）。
     *
     * 校验与 POST 触发完全同款：时间窗 ±300s + nonce 防重放 + HMAC-SHA256。runId 必须
     * 属于这条 webhook 的目标（防跨触发器窥探）。
     */
    scope.get<{ Params: { publicId: string; runId: string } }>("/webhooks/:publicId/runs/:runId", async (request, reply) => {
      const found = await pool.query("SELECT * FROM webhook_triggers WHERE public_id = $1", [request.params.publicId]);
      if (!found.rowCount) return fail(reply, 404, 2001, "webhook trigger not found");
      const row = found.rows[0];

      const timestamp = request.headers["x-apitest-timestamp"];
      const nonce = request.headers["x-apitest-nonce"];
      const signature = request.headers["x-apitest-signature"];
      if (typeof timestamp !== "string" || typeof nonce !== "string" || typeof signature !== "string") {
        return fail(reply, 401, 1002, "X-Apitest-Timestamp, X-Apitest-Nonce and X-Apitest-Signature headers are required");
      }
      const seconds = Number(timestamp);
      if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > SIGNATURE_WINDOW_SECONDS) {
        return fail(reply, 401, 1002, "signature timestamp is outside the allowed window");
      }
      /* GET 无 body：签名原文 = `timestamp.nonce.`（末尾点后为空串）。 */
      let expected: string;
      try {
        expected = createHmac("sha256", decryptSecret(row.secret_encrypted as Buffer)).update(`${timestamp}.${nonce}.`).digest("hex");
      } catch {
        return fail(reply, 500, 5001, "webhook secret could not be decrypted");
      }
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return fail(reply, 401, 1002, "signature mismatch");
      }

      /* 按目标类型查运行状态；runId 必须属于这条触发器的目标。 */
      const runId = request.params.runId;
      const targetType = String(row.target_type);
      if (!isUuid(runId)) return fail(reply, 404, 2001, "run not found");

      if (targetType === "suite") {
        const r = await pool.query(
          "SELECT status, total, success_count, failed_count, skipped_count FROM suite_executions WHERE id = $1 AND suite_id = $2",
          [runId, String(row.target_id)],
        );
        if (!r.rowCount) return fail(reply, 404, 2001, "run not found");
        const d = r.rows[0];
        return reply.code(200).send(success({
          status: String(d.status), total: Number(d.total),
          successCount: Number(d.success_count), failedCount: Number(d.failed_count), skippedCount: Number(d.skipped_count),
        }));
      }
      if (targetType === "ci_task") {
        const r = await pool.query(
          "SELECT status, case_total, passed_count, failed_count, skipped_count, run_number, error FROM pipeline_runs WHERE id = $1 AND ci_task_id = $2",
          [runId, String(row.target_id)],
        );
        if (!r.rowCount) return fail(reply, 404, 2001, "run not found");
        const d = r.rows[0];
        return reply.code(200).send(success({
          status: String(d.status), runNumber: Number(d.run_number),
          total: Number(d.case_total), successCount: Number(d.passed_count),
          failedCount: Number(d.failed_count), skippedCount: Number(d.skipped_count),
          error: d.error ? String(d.error) : undefined,
        }));
      }
      if (targetType === "flow") {
        const r = await pool.query(
          "SELECT status, total, success_count, failed_count, skipped_count FROM flow_executions WHERE id = $1 AND flow_id = $2",
          [runId, String(row.target_id)],
        );
        if (!r.rowCount) return fail(reply, 404, 2001, "run not found");
        const d = r.rows[0];
        return reply.code(200).send(success({
          status: String(d.status), total: Number(d.total),
          successCount: Number(d.success_count), failedCount: Number(d.failed_count), skippedCount: Number(d.skipped_count),
        }));
      }
      return fail(reply, 400, 1001, `unsupported webhook target type "${targetType}"`);
    });
  });
}
