import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { currentUser } from "../lib/auth.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { mapProject } from "../models/types.js";
import { queryProjectMetrics, type ProjectFilters } from "./dashboard.js";

export async function projectRoutes(app: FastifyInstance) {
  /**
   * Filtering happens in SQL, so the keyword matches every project the user
   * can see rather than only the rows already delivered to the client.
   * Metrics ship with the list so the project directory needs one request.
   */
  app.get<{ Querystring: ProjectFilters }>("/api/v1/projects", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    const data = await queryProjectMetrics(user, request.query);
    return success(data, { total: data.length });
  });

  app.post<{ Body: { name?: string; description?: string } }>("/api/v1/projects", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    if (!request.body.name?.trim()) return fail(reply, 400, 1001, "project name is required");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("INSERT INTO projects (id, name, description, owner_id) VALUES ($1, $2, $3, $4) RETURNING *", [randomUUID(), request.body.name.trim(), request.body.description?.trim() ?? "", user.id]);
      await client.query("INSERT INTO user_project_roles (project_id, user_id, role) VALUES ($1, $2, 'project_admin')", [result.rows[0].id, user.id]);
      await client.query("COMMIT"); return reply.code(201).send(success(mapProject(result.rows[0])));
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  });

  app.get<{ Params: { id: string } }>("/api/v1/projects/:id", async (request, reply) => { const context = await requireProjectAccess(request, reply); return context && success(context.project); });

  /**
   * 项目里已经用过的标签，最常用的排在前面。
   *
   * 存在的理由是标签**无法从一页数据里枚举**：用例列表是分页的，从当前页收集出来的
   * 标签清单会漏掉其他页的，一个选项不全的标签下拉比没有下拉更容易误导。
   *
   * `scope=members` 汇总用例与流程的标签——套件「按标签」选择匹配的正是这两者；
   * `scope=suites` 只看套件自己的标签，用于给套件分类。两个来源分开，是因为「用来
   * 匹配成员的标签」和「用来归档套件的标签」是两套词汇，混在一起会互相污染建议。
   *
   * 顺序即热度：按使用次数倒序，所以调用方不需要拿到次数也能得到有用的排序。
   */
  app.get<{ Params: { id: string }; Querystring: { scope?: string } }>("/api/v1/projects/:id/tags", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const sources = request.query.scope === "suites"
      ? "SELECT unnest(tags) AS tag FROM test_suites WHERE project_id = $1"
      : `SELECT unnest(tags) AS tag FROM test_cases WHERE project_id = $1
         UNION ALL
         SELECT unnest(tags) AS tag FROM flows WHERE project_id = $1`;
    const result = await pool.query(
      `SELECT tag FROM (${sources}) used
        WHERE btrim(tag) <> ''
        GROUP BY tag
        ORDER BY COUNT(*) DESC, tag`,
      [context.project.id],
    );
    const data = result.rows.map((row) => String(row.tag));
    return success(data, { total: data.length });
  });

  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/settings", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const result = await pool.query("SELECT default_environment_id, store_plaintext FROM project_settings WHERE project_id = $1", [context.project.id]);
    const row = result.rows[0];
    return success({
      defaultEnvironmentId: row?.default_environment_id ? String(row.default_environment_id) : undefined,
      storePlaintext: Boolean(row?.store_plaintext),
    });
  });

  app.put<{ Params: { id: string }; Body: { defaultEnvironmentId?: string | null; storePlaintext?: boolean } }>("/api/v1/projects/:id/settings", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const environmentId = request.body.defaultEnvironmentId ?? null;
    if (environmentId) {
      const environment = await pool.query("SELECT 1 FROM environments WHERE id = $1 AND project_id = $2", [environmentId, context.project.id]);
      if (!environment.rowCount) return fail(reply, 400, 1001, "default environment must belong to the project");
    }
    if (request.body.storePlaintext !== undefined && typeof request.body.storePlaintext !== "boolean") {
      return fail(reply, 400, 1001, "storePlaintext must be a boolean");
    }
    const result = await pool.query(
      `INSERT INTO project_settings (project_id, default_environment_id, store_plaintext) VALUES ($1, $2, COALESCE($3, false))
       ON CONFLICT (project_id) DO UPDATE SET
         default_environment_id = EXCLUDED.default_environment_id,
         store_plaintext = COALESCE(EXCLUDED.store_plaintext, project_settings.store_plaintext)
       RETURNING default_environment_id, store_plaintext`,
      [context.project.id, environmentId, request.body.storePlaintext ?? null],
    );
    const row = result.rows[0];
    return success({
      defaultEnvironmentId: row.default_environment_id ? String(row.default_environment_id) : undefined,
      storePlaintext: Boolean(row.store_plaintext),
    });
  });

  /**
   * Archiving was removed as a product concept, so status is no longer
   * writable. The column still exists and defaults to 'active'; dropping it
   * would need a migration and buys nothing while nothing reads it.
   */
  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string } }>("/api/v1/projects/:id", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const body = request.body;
    if (body.name !== undefined && !body.name.trim()) return fail(reply, 400, 1001, "project name is required");
    const result = await pool.query("UPDATE projects SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id = $3 RETURNING *", [body.name?.trim() || null, body.description, context.project.id]);
    return success(mapProject(result.rows[0]));
  });

  app.delete<{ Params: { id: string } }>("/api/v1/projects/:id", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    await pool.query("DELETE FROM projects WHERE id = $1", [context.project.id]); return success({ id: context.project.id, deleted: true });
  });
}
