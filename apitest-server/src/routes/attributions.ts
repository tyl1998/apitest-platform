import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { writeAuditLogAsync } from "../lib/audit.js";
import {
  attributionCategoryExists, attributionTargetIsFailed, normalizeAttributionBugUrl, validateAttributionTarget,
} from "../lib/attribution.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { mapFailureAttribution, mapFailureCategory, type AttributionTargetType } from "../models/types.js";

/**
 * 失败归因 REST（P8-2，计划 12.2；前端入口在 P8-3，MCP 工具在 P8-7）。
 *
 * 四条路由，全部挂在项目前缀下（权限是形状的一部分）：
 * - `GET /failure-categories`：字典读，登录即可（viewer 也要能看归因结果）；
 * - `POST /failure-attribution`：单条打标/重打标（UNIQUE 冲突即 UPDATE，语义见下）；
 * - `POST /failure-attribution/batch`：批量——一次 CI 挂一片同因失败太常见（边界 4）；
 * - `DELETE /failure-attribution`：清除归因（没有行 = 未归因，边界 7 的逆操作）。
 *
 * 三条纪律来自边界 4/6/7：只在**叶子失败**上归因（三类目标，父级 run/suite 不收）；
 * 一条失败只有一个归因（重打标 = UPDATE，`created_by`/`source` 随之换人）；未归因
 * 不入库。目标校验「必须是本项目的一条失败」——给成功行打归因会把统计做假。
 *
 * 校验自 P8-7 起收敛在 `lib/attribution.ts`（MCP 的 set_failure_attribution 与这里
 * 同一份——边界 8「复用 REST 同一套校验」的字面实现）；本文件只保留 REST 特有的
 * 信封（400/1001）与审计形状。
 */

type AttributionBody = { targetType?: string; targetId?: string; category?: string; note?: string; bugUrl?: string };
type BatchAttributionBody = { targets?: { targetType?: string; targetId?: string }[]; category?: string; note?: string; bugUrl?: string };

export async function attributionRoutes(app: FastifyInstance) {
  /**
   * 字典读（计划 12.2：登录即可）。挂在项目前缀下只是让 viewer 过 requireProjectAccess
   * 的门——字典本身平台级一份，任何项目读到的都是同一份（边界 5）。
   */
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/failure-categories", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const result = await pool.query("SELECT * FROM failure_categories ORDER BY position, code");
    return success(result.rows.map(mapFailureCategory), { total: result.rowCount });
  });

  /**
   * 单条打标/重打标。INSERT … ON CONFLICT (target_type, target_id) DO UPDATE：
   * 一条失败只有一个归因（边界 6），「重打标换分类/换人/换 note」是一条 UPDATE，
   * 不是先删后插——两步之间有个未归因的窗口，统计会闪一下。
   */
  app.post<{ Params: { id: string }; Body: AttributionBody }>("/api/v1/projects/:id/failure-attribution", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const body = request.body ?? {};
    const target = validateAttributionTarget(body.targetType, body.targetId);
    if ("error" in target) return fail(reply, 400, 1001, target.error);
    if (typeof body.category !== "string" || !body.category.trim()) return fail(reply, 400, 1001, "category is required");
    if (body.note !== undefined && typeof body.note !== "string") return fail(reply, 400, 1001, "note must be a string");
    const bugUrl = normalizeAttributionBugUrl(body.bugUrl);
    if ("error" in bugUrl) return fail(reply, 400, 1001, bugUrl.error);
    if (!(await attributionCategoryExists(body.category))) return fail(reply, 400, 1001, "unknown or inactive failure category");
    if (!(await attributionTargetIsFailed(context.project.id, target.type, target.id))) {
      return fail(reply, 404, 2001, "attribution target not found in this project or is not a failure");
    }
    const note = (body.note ?? "").trim();
    const result = await pool.query(
      `INSERT INTO failure_attributions (id, project_id, target_type, target_id, category, note, bug_url, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'human', $8)
       ON CONFLICT (target_type, target_id) DO UPDATE
         SET category = $5, note = $6, bug_url = $7, source = 'human', created_by = $8, updated_at = now()
       RETURNING *`,
      [randomUUID(), context.project.id, target.type, target.id, body.category, note, bugUrl.url, context.user.id],
    );
    writeAuditLogAsync({
      action: "failure_attribution.set",
      targetType: "failure_attribution",
      targetId: target.id,
      projectId: context.project.id,
      userId: context.user.id,
      /* 决策证据不是 payload 转储：分类 + 目标类型回答「谁把什么失败归成了什么」；
         bug 链接是「归成了哪个 bug」的一部分（结构化短值，非 note 那种自由文本）。 */
      detail: { category: body.category, target: target.type, batch: false, ...(bugUrl.url ? { bugUrl: bugUrl.url } : {}) },
      ip: request.ip,
    });
    return reply.code(201).send(success(mapFailureAttribution(result.rows[0])));
  });

  /**
   * 批量打标：同一 category/note 应用到一批失败（边界 4——一次 CI 挂一片同因失败）。
   * 逐条校验而不是先聚合再判断：混进「非本项目/非失败/停用分类」时整批拒绝（1001），
   * 部分成功会留下「三条打了两条没打」这种说不清的中间态。上限 100，与批量调试同档。
   */
  app.post<{ Params: { id: string }; Body: BatchAttributionBody }>("/api/v1/projects/:id/failure-attribution/batch", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const body = request.body ?? {};
    if (!Array.isArray(body.targets) || !body.targets.length) return fail(reply, 400, 1001, "targets must be a non-empty array");
    if (body.targets.length > 100) return fail(reply, 400, 1001, "at most 100 targets per batch");
    if (typeof body.category !== "string" || !body.category.trim()) return fail(reply, 400, 1001, "category is required");
    if (body.note !== undefined && typeof body.note !== "string") return fail(reply, 400, 1001, "note must be a string");
    const bugUrl = normalizeAttributionBugUrl(body.bugUrl);
    if ("error" in bugUrl) return fail(reply, 400, 1001, bugUrl.error);
    if (!(await attributionCategoryExists(body.category))) return fail(reply, 400, 1001, "unknown or inactive failure category");
    const parsed: { type: AttributionTargetType; id: string }[] = [];
    for (const entry of body.targets) {
      const target = validateAttributionTarget(entry?.targetType, entry?.targetId);
      if ("error" in target) return fail(reply, 400, 1001, target.error);
      parsed.push(target);
    }
    /* 同一目标重复出现在批次里没有意义，先去重再校验存在性。 */
    const unique = [...new Map(parsed.map((each) => [`${each.type}:${each.id}`, each])).values()];
    for (const each of unique) {
      if (!(await attributionTargetIsFailed(context.project.id, each.type, each.id))) {
        return fail(reply, 404, 2001, `attribution target ${each.id} not found in this project or is not a failure`);
      }
    }
    const note = (body.note ?? "").trim();
    /* 逐条 upsert 同一事务：任何一条失败整体回滚，count 如实回报。 */
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let count = 0;
      for (const each of unique) {
        await client.query(
          `INSERT INTO failure_attributions (id, project_id, target_type, target_id, category, note, bug_url, source, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'human', $8)
           ON CONFLICT (target_type, target_id) DO UPDATE
             SET category = $5, note = $6, bug_url = $7, source = 'human', created_by = $8, updated_at = now()`,
          [randomUUID(), context.project.id, each.type, each.id, body.category, note, bugUrl.url, context.user.id],
        );
        count += 1;
      }
      await client.query("COMMIT");
      writeAuditLogAsync({
        action: "failure_attribution.set",
        targetType: "failure_attribution",
        targetId: unique[0].id,
        projectId: context.project.id,
        userId: context.user.id,
        detail: { category: body.category, target: unique[0].type, batch: true, count, ...(bugUrl.url ? { bugUrl: bugUrl.url } : {}) },
        ip: request.ip,
      });
      return reply.code(201).send(success({ updated: count, requested: body.targets.length }));
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally {
      client.release();
    }
  });

  /**
   * 清除归因（query 传目标）。删除目标行不存在时 404 而不是静默成功——「清掉了」与
   * 「本来就没有」在归因覆盖率统计上是同一结果，但调用方可能在拿旧 id 操作，静默成功
   * 会掩盖那个更早的 bug。
   */
  app.delete<{ Params: { id: string }; Querystring: { targetType?: string; targetId?: string } }>("/api/v1/projects/:id/failure-attribution", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const target = validateAttributionTarget(request.query.targetType, request.query.targetId);
    if ("error" in target) return fail(reply, 400, 1001, target.error);
    const deleted = await pool.query(
      "DELETE FROM failure_attributions WHERE target_type = $1 AND target_id = $2 AND project_id = $3 RETURNING id",
      [target.type, target.id, context.project.id],
    );
    if (!deleted.rowCount) return fail(reply, 404, 2001, "attribution not found");
    writeAuditLogAsync({
      action: "failure_attribution.clear",
      targetType: "failure_attribution",
      targetId: target.id,
      projectId: context.project.id,
      userId: context.user.id,
      detail: { target: target.type },
      ip: request.ip,
    });
    return success({ id: String(deleted.rows[0].id), removed: true });
  });
}
