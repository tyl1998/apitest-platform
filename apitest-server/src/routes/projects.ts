import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { currentUser } from "../lib/auth.js";
import { requireProjectAccess, requireProjectAdmin } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { mapProject } from "../models/types.js";
import { queryProjectList, type ProjectFilters } from "./dashboard.js";

export async function projectRoutes(app: FastifyInstance) {
  /**
   * Filtering happens in SQL, so the keyword matches every project the user
   * can see rather than only the rows already delivered to the client.
   * Metrics ship with the list so the project directory needs one request.
   *
   * 分页是 opt-in（与接口/环境列表同一契约，2026-08-30 项目管理页补齐）：不给 `pageSize`
   * 就回全量——项目切换器（projectStore）依赖无分页契约。给了则 total 是这份过滤
   * 命中的全量数，翻页器才画得出来。
   *
   * 2026-09-10 换到 queryProjectList（轻查询）：本路由的读者只要身份 + 资产计数，
   * 执行面聚合（executions 七表、P8-8 实测 817ms 的大头）与它无关，不再为它买单。
   */
  app.get<{ Querystring: ProjectFilters & { page?: string; pageSize?: string } }>("/api/v1/projects", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    if (request.query.pageSize === undefined) {
      const data = await queryProjectList(user, request.query);
      return success(data.projects, { total: data.total });
    }
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize)));
    const data = await queryProjectList(user, request.query, { page, pageSize });
    return success(data.projects, { page, pageSize, total: data.total });
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

  /* myRole 随详情下发（P6 边界 5）：前端只消费「当前项目我的角色」，projectStore
     预取详情即得，零额外请求。 */
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id", async (request, reply) => {
    const context = await requireProjectAccess(request, reply);
    return context && success({ ...context.project, myRole: context.myRole });
  });

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
    const result = await pool.query("SELECT default_environment_id, store_plaintext, mcp_enabled FROM project_settings WHERE project_id = $1", [context.project.id]);
    const row = result.rows[0];
    return success({
      defaultEnvironmentId: row?.default_environment_id ? String(row.default_environment_id) : undefined,
      storePlaintext: Boolean(row?.store_plaintext),
      /* 无行 = false（P5 计划 9.1）：那张表只在项目设置被 PUT 过一次时才有行，开关的
         默认值在迁移 050 的列默认上，不在行上。 */
      mcpEnabled: Boolean(row?.mcp_enabled),
    });
  });

  /* 项目设置写改挂 requireProjectAdmin（P6 边界 4）：默认环境 / store_plaintext /
     mcp_enabled 是项目级配置，project_admin 专属；资源 CRUD 仍走 developer 可写的
     requireProjectAccess。 */
  app.put<{ Params: { id: string }; Body: { defaultEnvironmentId?: string | null; storePlaintext?: boolean; mcpEnabled?: boolean } }>("/api/v1/projects/:id/settings", async (request, reply) => {
    const context = await requireProjectAdmin(request, reply); if (!context) return;
    const environmentId = request.body.defaultEnvironmentId ?? null;
    if (environmentId) {
      const environment = await pool.query("SELECT 1 FROM environments WHERE id = $1 AND project_id = $2", [environmentId, context.project.id]);
      if (!environment.rowCount) return fail(reply, 400, 1001, "default environment must belong to the project");
    }
    if (request.body.storePlaintext !== undefined && typeof request.body.storePlaintext !== "boolean") {
      return fail(reply, 400, 1001, "storePlaintext must be a boolean");
    }
    if (request.body.mcpEnabled !== undefined && typeof request.body.mcpEnabled !== "boolean") {
      return fail(reply, 400, 1001, "mcpEnabled must be a boolean");
    }
    /* `mcp_enabled` 与 `store_plaintext` 同款 COALESCE（计划 9.1 点名的坑）：只改默认
       环境的一次 PUT 不该把开关顺手清回 false——显式传 false 才是「关掉」。 */
    const result = await pool.query(
      `INSERT INTO project_settings (project_id, default_environment_id, store_plaintext, mcp_enabled) VALUES ($1, $2, COALESCE($3, false), COALESCE($4, false))
       ON CONFLICT (project_id) DO UPDATE SET
          default_environment_id = EXCLUDED.default_environment_id,
          store_plaintext = COALESCE(EXCLUDED.store_plaintext, project_settings.store_plaintext),
          mcp_enabled = COALESCE(EXCLUDED.mcp_enabled, project_settings.mcp_enabled)
       RETURNING default_environment_id, store_plaintext, mcp_enabled`,
      [context.project.id, environmentId, request.body.storePlaintext ?? null, request.body.mcpEnabled ?? null],
    );
    const row = result.rows[0];
    return success({
      defaultEnvironmentId: row.default_environment_id ? String(row.default_environment_id) : undefined,
      storePlaintext: Boolean(row.store_plaintext),
      mcpEnabled: Boolean(row.mcp_enabled),
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

  /* 项目删除是三类 requireProjectAdmin 路由之一（P6 边界 4）——删掉整个项目不是
     资源 CRUD，是管理动作。 */
  app.delete<{ Params: { id: string } }>("/api/v1/projects/:id", async (request, reply) => {
    const context = await requireProjectAdmin(request, reply); if (!context) return;
    await pool.query("DELETE FROM projects WHERE id = $1", [context.project.id]); return success({ id: context.project.id, deleted: true });
  });
}
