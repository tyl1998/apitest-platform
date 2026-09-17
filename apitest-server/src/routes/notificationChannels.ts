import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, auditFields, writeAuditLogAsync } from "../lib/audit.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { dispatchAlert, type AlertChannel } from "../lib/notify.js";
import { isUuid } from "../lib/uuid.js";
import { mapNotificationChannel, type NotificationChannelType } from "../models/types.js";

/**
 * 通知渠道（P3-6，计划 6.2，边界 8、10）。四种「POST 一段 JSON 到一个 URL」：通用
 * Webhook / 企业微信 / 钉钉 / Slack；差别只在投递时的默认模板与钉钉加签
 * （lib/notify.ts）。这里只管配置与「测试」——测试也走同一条投递路径并落证据行
 * （rule_id 为 NULL），这样「渠道配错」在派发记录里立刻可见，不用等第一条真告警。
 */

const CHANNEL_TYPES: NotificationChannelType[] = ["webhook", "wecom", "dingtalk", "slack"];

type ChannelBody = {
  name?: string;
  type?: string;
  url?: string;
  /** 加签密钥（钉钉用）：字符串 = 设置，null = 清除，缺省 = 不动（PUT）。 */
  secret?: string | null;
  /** 可选前缀文案，不是模板语言（边界 8）。 */
  templatePrefix?: string | null;
  enabled?: boolean;
};

function validateChannel(body: ChannelBody, partial: boolean): string | undefined {
  const name = body.name?.trim();
  if (!partial || body.name !== undefined) if (!name) return "channel name is required";
  if (!partial || body.type !== undefined) {
    if (!body.type || !CHANNEL_TYPES.includes(body.type as NotificationChannelType)) {
      return `type must be one of ${CHANNEL_TYPES.join(", ")}`;
    }
  }
  if (!partial || body.url !== undefined) {
    const url = body.url?.trim();
    /* 只收 http(s)：file://、ftp:// 之类对 fetch 是惊喜生成器，浏览器里也点不开。 */
    if (!url || !/^https?:\/\//.test(url)) return "url must be an http(s) URL";
  }
  if (body.secret !== undefined && body.secret !== null && typeof body.secret !== "string") return "secret must be a string or null";
  return undefined;
}

export async function notificationChannelRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/notification-channels", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    /* P11 归属列（边界 7/9）：join users 取 email 快照，基表显式 `nc.*`（见 alertRules 注释）。 */
    const result = await pool.query(
      `SELECT nc.*, creator.email AS created_by_email, updater.email AS updated_by_email
         FROM notification_channels nc
         LEFT JOIN users creator ON creator.id = nc.created_by
         LEFT JOIN users updater ON updater.id = nc.updated_by
        WHERE nc.project_id = $1 ORDER BY nc.created_at DESC`,
      [context.project.id],
    );
    return success(result.rows.map(mapNotificationChannel), { total: result.rowCount });
  });

  app.post<{ Params: { id: string }; Body: ChannelBody }>("/api/v1/projects/:id/notification-channels", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const invalid = validateChannel(request.body ?? {}, false);
    if (invalid) return fail(reply, 400, 1001, invalid);
    /* secret 明文不落日志、不回显：写库即加密，之后接口只回「是否已配置」。 */
    const encrypted = typeof request.body?.secret === "string" && request.body.secret ? encryptSecret(request.body.secret) : null;
    const result = await pool.query(
      `INSERT INTO notification_channels (id, project_id, name, type, url, secret_encrypted, template_prefix, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [randomUUID(), context.project.id, request.body!.name!.trim(), request.body!.type!, request.body!.url!.trim(), encrypted, request.body?.templatePrefix?.trim() || null, request.body?.enabled ?? true, context.user.id],
    );
    /* P11-9 审计（边界 5/6）：detail 只有字段名，url 与 secret 的值绝不进。 */
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.notificationChannelCreate, targetType: "notification_channel", targetId: String(result.rows[0].id),
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return reply.code(201).send(success(mapNotificationChannel(result.rows[0])));
  });

  app.put<{ Params: { id: string; channelId: string }; Body: ChannelBody }>("/api/v1/projects/:id/notification-channels/:channelId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.channelId)) return fail(reply, 404, 2001, "notification channel not found");
    const existing = await pool.query("SELECT * FROM notification_channels WHERE id = $1 AND project_id = $2", [request.params.channelId, context.project.id]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "notification channel not found");
    const invalid = validateChannel(request.body ?? {}, true);
    if (invalid) return fail(reply, 400, 1001, invalid);

    /* secret 是三态补丁：null 清除、字符串设置、缺省不动——客户端从来没有明文，发不回全量。 */
    const encrypted = request.body?.secret === undefined
      ? existing.rows[0].secret_encrypted
      : request.body.secret === null || request.body.secret === ""
        ? null
        : encryptSecret(request.body.secret);
    /* templatePrefix 同为三态：null = 清掉前缀。 */
    const templatePrefix = request.body?.templatePrefix === undefined
      ? existing.rows[0].template_prefix
      : request.body.templatePrefix === null ? null : request.body.templatePrefix.trim() || null;

    const result = await pool.query(
      `UPDATE notification_channels SET name = COALESCE($1, name), type = COALESCE($2, type), url = COALESCE($3, url),
         secret_encrypted = $4, template_prefix = $5, enabled = COALESCE($6, enabled), updated_by = $9, updated_at = now()
       WHERE id = $7 AND project_id = $8 RETURNING *`,
      [request.body?.name?.trim() ?? null, (request.body?.type as NotificationChannelType) ?? null, request.body?.url?.trim() ?? null, encrypted, templatePrefix, request.body?.enabled ?? null, request.params.channelId, context.project.id, context.user.id],
    );
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.notificationChannelUpdate, targetType: "notification_channel", targetId: request.params.channelId,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return success(mapNotificationChannel(result.rows[0]));
  });

  /**
   * 引用了这个渠道的告警规则（UUID[] 无外键，靠 containment 查）、套件通知配置
   * （P3-11：notify_config.channelIds 同样无外键）与仓库任务通知配置（P4.5-12，同款形状）。
   *
   * 删除语义与 environments 的 usage 扫描同款：先 409 给清单，?force=true 才执行。
   * force 顺带把三处配置里的悬空 id 摘掉——留着它，规则页/套件页/任务页会显示一个再也
   * 打不开的渠道。
   */
  app.delete<{ Params: { id: string; channelId: string }; Querystring: { force?: string } }>("/api/v1/projects/:id/notification-channels/:channelId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.channelId)) return fail(reply, 404, 2001, "notification channel not found");
    const referencing = await pool.query(
      "SELECT id, name FROM alert_rules WHERE project_id = $1 AND channel_ids @> ARRAY[$2]::uuid[]",
      [context.project.id, request.params.channelId],
    );
    /* 套件侧只列「开关开着」的：没开通知的套件里留一个悬空 id 只是历史残留，
       不构成「删除会改变行为」的理由。 */
    const referencingSuites = await pool.query(
      `SELECT id, name FROM test_suites
        WHERE project_id = $1 AND notify_config->'channelIds' @> to_jsonb(ARRAY[$2]::uuid[])
          AND (notify_config->>'onSuccess' = 'true' OR notify_config->>'onFailure' = 'true')`,
      [context.project.id, request.params.channelId],
    );
    /* 仓库任务侧同一条判据（P4.5-12）：`ci_tasks.notify_config` 与套件那一列形状逐字相同。 */
    const referencingTasks = await pool.query(
      `SELECT id, name FROM ci_tasks
        WHERE project_id = $1 AND notify_config->'channelIds' @> to_jsonb(ARRAY[$2]::uuid[])
          AND (notify_config->>'onSuccess' = 'true' OR notify_config->>'onFailure' = 'true')`,
      [context.project.id, request.params.channelId],
    );
    if ((referencing.rowCount || referencingSuites.rowCount || referencingTasks.rowCount) && request.query.force !== "true") {
      const rules = referencing.rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
      const suites = referencingSuites.rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
      const ciTasks = referencingTasks.rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
      return reply.code(409).send({ code: 2003, message: "notification channel is referenced by alert rules, suite notifications or CI task notifications", data: { rules, suites, ciTasks } });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      /* 这是人工删除（force 之后）的连带清理：规则的内容确实变了，所以 `updated_by`
         与 `updated_at` 一起写——只写其一会让「谁最后改的」与「改在什么时候」互相矛盾。
         同款的 test_suites / ci_tasks 摘除在下面那个循环里（各自按有无该列处理）。 */
      await client.query("UPDATE alert_rules SET channel_ids = array_remove(channel_ids, $1::uuid), updated_by = $3, updated_at = now() WHERE project_id = $2 AND channel_ids @> ARRAY[$1]::uuid[]", [request.params.channelId, context.project.id, context.user.id]);
      /* 套件与任务通知的 channelIds 是 JSONB 数组（jsonb_agg 重建，空集写 '[]'），与
         alert_rules 的 UUID[] 是两种摘法——同一条事务里各自做对。两张表的语句只差表名，
         循环而不是抄两遍：表名来自代码里的字面量数组，不是输入。

         `test_suites` 有 `updated_by`（P11-1），`ci_tasks` 没有（边界 2：天生带 created_by
         的表不补 updated_by）——归属后缀因此按表拼，与表名一样是代码决定的值。 */
      for (const table of ["test_suites", "ci_tasks"] as const) {
        const ownership = table === "test_suites" ? ", updated_by = $3, updated_at = now()" : "";
        await client.query(
          `UPDATE ${table} SET notify_config = jsonb_set(notify_config, '{channelIds}',
              COALESCE((
                SELECT jsonb_agg(entry.channel ORDER BY entry.ord)
                  FROM jsonb_array_elements(notify_config->'channelIds')
                       WITH ORDINALITY AS entry(channel, ord)
                 WHERE entry.channel <> to_jsonb($1::uuid)
              ), '[]'::jsonb), true)${ownership}
            WHERE project_id = $2 AND notify_config->'channelIds' @> to_jsonb(ARRAY[$1]::uuid[])`,
          table === "test_suites"
            ? [request.params.channelId, context.project.id, context.user.id]
            : [request.params.channelId, context.project.id],
        );
      }
      const deleted = await client.query("DELETE FROM notification_channels WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.channelId, context.project.id]);
      await client.query("COMMIT");
      if (!deleted.rowCount) return fail(reply, 404, 2001, "notification channel not found");
      /* 渠道删除连带改了规则与套件的配置：提交后逐条补 update 审计（同 cases.ts 摘成员）。 */
      writeAuditLogAsync({
        action: AUDIT_ACTIONS.notificationChannelDelete, targetType: "notification_channel", targetId: String(deleted.rows[0].id),
        projectId: context.project.id, userId: context.user.id, ip: request.ip,
      });
      for (const rule of referencing.rows) {
        writeAuditLogAsync({
          action: AUDIT_ACTIONS.alertRuleUpdate, targetType: "alert_rule", targetId: String(rule.id),
          projectId: context.project.id, userId: context.user.id,
          detail: { fields: ["channel_ids"], detachedChannel: request.params.channelId }, ip: request.ip,
        });
      }
      for (const suite of referencingSuites.rows) {
        writeAuditLogAsync({
          action: AUDIT_ACTIONS.testSuiteUpdate, targetType: "test_suite", targetId: String(suite.id),
          projectId: context.project.id, userId: context.user.id,
          detail: { fields: ["notify_config"], detachedChannel: request.params.channelId }, ip: request.ip,
        });
      }
      return success({ id: deleted.rows[0].id });
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally {
      client.release();
    }
  });

  /**
   * 测试投递：同一条投递路径（lib/notify.ts）、同一份证据行（rule_id 为 NULL）。
   * 同步等结果——「测试」的意义就是现在告诉你通不通，异步则要再去翻派发记录。
   */
  app.post<{ Params: { id: string; channelId: string } }>("/api/v1/projects/:id/notification-channels/:channelId/test", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.channelId)) return fail(reply, 404, 2001, "notification channel not found");
    const found = await pool.query("SELECT * FROM notification_channels WHERE id = $1 AND project_id = $2", [request.params.channelId, context.project.id]);
    if (!found.rowCount) return fail(reply, 404, 2001, "notification channel not found");
    const row = found.rows[0];
    /* 解密失败不拦测试：以未带签发出，渠道的报错（钉钉 401 之类）会落进证据行。 */
    const channel: AlertChannel = {
      id: String(row.id), name: String(row.name), type: String(row.type) as NotificationChannelType, url: String(row.url),
      secret: row.secret_encrypted ? (() => { try { return decryptSecret(row.secret_encrypted as Buffer); } catch { return undefined; } })() : undefined,
      templatePrefix: row.template_prefix ? String(row.template_prefix) : undefined,
    };
    const result = await dispatchAlert({
      projectId: context.project.id,
      channels: [channel],
      message: { title: "【接口自动化】渠道测试", lines: [`渠道: ${String(row.name)}`, "收到这条消息说明该渠道配置正确。", `时间: ${new Date().toISOString()}`] },
    });
    return success({ sent: result.sent, failed: result.failed });
  });
}
