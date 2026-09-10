import type { FastifyInstance, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { writeAuditLogAsync } from "../lib/audit.js";
import { requireSystemAdmin } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { mapFailureCategory } from "../models/types.js";

/**
 * 归因分类字典管理（P8-2 增补：系统设置「归因类型」tab；系统管理员）。
 *
 * 计划 12.1 的原口径是「7 类固定、项目不可改」（边界 5）——平台级一份、跨项目可比。
 * 管理面落在这条边界**之内**：改的是平台那一分字典的措辞与启停，不是给项目开自定义。
 * 新增/停用/改名都允许；**code 是主键且被 `failure_attributions.category` 引用，
 * 不可改**——改 code 等于隐式把存量归因挪到另一个分类，统计口径悄悄变了。
 *
 * 删除语义对齐 environments / notificationChannels 的 usage 扫描：有归因行引用时
 * 409 + 计数；`?force=true` 才执行，且连带删除引用行（它们回到「未归因」——覆盖率
 * 下降是删除一个分类的诚实代价，不偷偷挂去「其他」：挂去哪里是管理员的决策，替他
 * 决定会把分布做假）。
 */

/** code 是给统计与 MCP 用的稳定标识：小写字母/数字/下划线，见校验。 */
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

type CategoryBody = { code?: string; name?: string; position?: number; active?: boolean };

function validateCreate(body: CategoryBody): string | undefined {
  if (typeof body.code !== "string" || !CODE_PATTERN.test(body.code)) {
    return "code must match /^[a-z][a-z0-9_]{0,39}$/ (lowercase identifier)";
  }
  if (!body.name?.trim()) return "name is required";
  if (body.position !== undefined && (!Number.isFinite(body.position) || body.position < 0)) return "position must be a non-negative number";
  return undefined;
}

export async function failureCategoryRoutes(app: FastifyInstance) {
  /**
   * 字典全量读（含停用行——管理面要能看到并重新启用它们）。`GET /projects/:id/failure-categories`
   * 是同一张表的「打标可用」视图（只回 active）；这条是管理视图，requireSystemAdmin。
   */
  app.get("/api/v1/system/failure-categories", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    const result = await pool.query("SELECT * FROM failure_categories ORDER BY position, code");
    return success(result.rows.map(mapFailureCategory), { total: result.rowCount });
  });

  app.post<{ Body: CategoryBody }>("/api/v1/system/failure-categories", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    const invalid = validateCreate(request.body ?? {});
    if (invalid) return fail(reply, 400, 1001, invalid);
    const body = request.body!;
    /* position 缺省排到队尾（MAX+1），不打乱既有顺序。 */
    const position = body.position ?? (await tailPosition());
    return insertCategory(reply, user.id, body, position, request.ip);
  });

  async function tailPosition(): Promise<number> {
    const tail = await pool.query("SELECT COALESCE(MAX(position), 0)::int + 1 AS next FROM failure_categories");
    return Number(tail.rows[0].next);
  }

  async function insertCategory(reply: FastifyReply, userId: string, body: CategoryBody, position: number, ip: string) {
    const duplicate = await pool.query("SELECT 1 FROM failure_categories WHERE code = $1", [body.code]);
    if (duplicate.rowCount) return fail(reply, 409, 2003, "a failure category with this code already exists");
    const name = body.name!.trim();
    const result = await pool.query(
      "INSERT INTO failure_categories (code, name, position, active) VALUES ($1, $2, $3, $4) RETURNING *",
      [body.code, name, position, body.active ?? true],
    );
    writeAuditLogAsync({ action: "failure_category.create", targetType: "failure_category", targetId: body.code!, userId, detail: { name, position, active: body.active ?? true }, ip });
    return reply.code(201).send(success(mapFailureCategory(result.rows[0])));
  }

  /**
   * 改名 / 调序 / 启停。**code 不可改**：PATCH 收到的 code 与路径不一致即 400——
   * 静默忽略会让人以为改成功了。partial：只写出现的键（COALESCE 同款语义）。
   */
  app.patch<{ Params: { code: string }; Body: CategoryBody }>("/api/v1/system/failure-categories/:code", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    const existing = await pool.query("SELECT * FROM failure_categories WHERE code = $1", [request.params.code]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "failure category not found");
    const body = request.body ?? {};
    if (body.code !== undefined && body.code !== request.params.code) return fail(reply, 400, 1001, "category code cannot be changed");
    if (body.name !== undefined && !body.name.trim()) return fail(reply, 400, 1001, "name cannot be empty");
    if (body.position !== undefined && (!Number.isFinite(body.position) || body.position < 0)) return fail(reply, 400, 1001, "position must be a non-negative number");
    const before = mapFailureCategory(existing.rows[0]);
    const result = await pool.query(
      `UPDATE failure_categories SET name = COALESCE($1, name), position = COALESCE($2, position), active = COALESCE($3, active)
        WHERE code = $4 RETURNING *`,
      [body.name?.trim() ?? null, body.position ?? null, body.active ?? null, request.params.code],
    );
    const after = mapFailureCategory(result.rows[0]);
    writeAuditLogAsync({
      action: "failure_category.update", targetType: "failure_category", targetId: request.params.code, userId: user.id,
      detail: { name: after.name, position: after.position, active: after.active, previous: { name: before.name, position: before.position, active: before.active } },
      ip: request.ip,
    });
    return success(after);
  });

  /**
   * 删除。引用计数 > 0 时 409 + `attributions` 计数；`?force=true` 连带删除那些归因行
   * （回未归因）。种子七类同受管理：平台从未发布、无历史包袱（AGENTS.md 数据兼容条款），
   * 删「其他」的权力交给管理员，不硬编码白名单——硬编码的例外迟早变成「为什么这项删不掉」。
   */
  app.delete<{ Params: { code: string }; Querystring: { force?: string } }>("/api/v1/system/failure-categories/:code", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    const existing = await pool.query("SELECT * FROM failure_categories WHERE code = $1", [request.params.code]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "failure category not found");
    const referencing = await pool.query("SELECT COUNT(*)::int AS total FROM failure_attributions WHERE category = $1", [request.params.code]);
    const attributions = Number(referencing.rows[0].total);
    if (attributions > 0 && request.query.force !== "true") {
      /* 刻意变体（response.ts 的既有先例）：失败响应带 data，客户端要用计数说清
         「删了它 N 条归因会消失」。 */
      return reply.code(409).send({ code: 2003, message: "failure category is referenced by attributions", data: { attributions } });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (attributions > 0) {
        await client.query("DELETE FROM failure_attributions WHERE category = $1", [request.params.code]);
      }
      await client.query("DELETE FROM failure_categories WHERE code = $1", [request.params.code]);
      await client.query("COMMIT");
      writeAuditLogAsync({
        action: "failure_category.delete", targetType: "failure_category", targetId: request.params.code, userId: user.id,
        detail: { removedAttributions: attributions }, ip: request.ip,
      });
      return success({ id: request.params.code, removed: true, removedAttributions: attributions });
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally {
      client.release();
    }
  });
}
