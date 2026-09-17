import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, auditFields, writeAuditLogAsync } from "../lib/audit.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapSpecModule } from "../models/types.js";

/** 树深上限（计划 11.0 边界 2）：顶层为第 1 层，最深第 6 层。 */
const MAX_MODULE_DEPTH = 6;

type SpecModuleBody = { name?: string; parentId?: string | null; position?: number };

/**
 * path 的段数：'/'（虚拟根）= 0，'/模块A/' = 1，'/模块A/子模块/' = 2。
 * path 以 '/' 起止且模块名不含 '/'（校验见 normalizeName），所以 split 计数是精确的。
 */
function countSegments(path: string): number {
  return path.split("/").length - 2;
}

/**
 * 模块名的校验与归一。'/' 是 path 的分隔符（也是 Excel 模板目录路径的分隔符，
 * 计划 11.5 验收 4），名字里出现它会让物化 path 与导入解析二义——直接拒绝，
 * 与大小写自由（身份是 path 不是名字）不同，这是结构字符。
 */
function normalizeName(input: string | undefined): { name?: string; error?: string } {
  if (input === undefined) return {};
  const name = input.trim();
  if (!name) return { error: "module name is required" };
  if (name.includes("/")) return { error: "module name must not contain '/'" };
  return { name };
}

/**
 * 加载父模块（body 里的引用，照 suites 的 environmentBelongs 先例：不存在/不属于
 * 本项目一律 400 + 1001，而不是 404——404 留给 URL 上的资源本身）。
 * 返回 null 表示 body.parentId 不是合法 uuid。
 */
async function loadParent(projectId: string, parentId: string) {
  if (!isUuid(parentId)) return null;
  const result = await pool.query("SELECT id, path FROM spec_modules WHERE id = $1 AND project_id = $2", [parentId, projectId]);
  return result.rowCount ? { id: String(result.rows[0].id), path: String(result.rows[0].path) } : null;
}

export async function specModuleRoutes(app: FastifyInstance) {
  /**
   * 树全量（viewer 可读）：拍平的模块列表 + 每模块**直属**用例计数，前端按
   * parentId 挂接成森林（没有「根节点」行，见迁移 052）。计数含全部状态——
   * 树是导航，deprecated 的用例也要能在树上被找到清理；「自动化覆盖率」只用
   * active，那是 P7-3 的口径。按 path 排序即深度优先序，同级内由前端按
   * (position, name) 排。计数走分组子查询挂在父行上（dashboard 同款，避免
   * 兄弟表互 JOIN 造成行数翻倍）。
   *
   * P7-6 增补：`active_count`（直属 active 用例数）与 `automated_count`（其中
   * 有 ≥1 条**非 endpoint** 绑定的条数——边界 11 的覆盖口径分子）。两数都只在
   * 直属口径上数，子树求和由前端算（与 caseCount 同一纪律）；树面板据此显示
   * 「自动化覆盖率」读数。三个计数同一个分组子查询，不付额外 JOIN。
   */
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/spec-modules", async (request, reply) => {
    const context = await requireProjectAccess(request, reply);
    if (!context) return;
    const result = await pool.query(
      `SELECT m.*, COALESCE(c.total, 0)::int AS case_count,
              COALESCE(c.active_total, 0)::int AS active_count,
              COALESCE(c.automated_total, 0)::int AS automated_count
       FROM spec_modules m
       LEFT JOIN (
         SELECT module_id,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'reviewed')::int AS active_total,
                COUNT(*) FILTER (WHERE status = 'reviewed' AND EXISTS (
                  SELECT 1 FROM spec_case_links l WHERE l.spec_case_id = spec_cases.id AND l.target_type <> 'endpoint'
                ))::int AS automated_total
           FROM spec_cases WHERE project_id = $1 GROUP BY module_id
       ) c ON c.module_id = m.id
       WHERE m.project_id = $1
       ORDER BY m.path`,
      [context.project.id],
    );
    return success(result.rows.map(mapSpecModule));
  });

  app.post<{ Params: { id: string }; Body: SpecModuleBody }>("/api/v1/projects/:id/spec-modules", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    const name = normalizeName(request.body.name);
    if (name.error) return fail(reply, 400, 1001, name.error);
    if (!name.name) return fail(reply, 400, 1001, "module name is required");
    const position = request.body.position;
    if (position !== undefined && !Number.isInteger(position)) return fail(reply, 400, 1001, "position must be an integer");

    /* parentId 缺省或 null 都是顶层；给了 uuid 就必须是本项目里真实存在的模块。 */
    let parentPath = "/";
    if (typeof request.body.parentId === "string") {
      const parent = await loadParent(context.project.id, request.body.parentId);
      if (!parent) return fail(reply, 400, 1001, "parent module not found in this project");
      parentPath = parent.path;
    }

    if (countSegments(parentPath) + 1 > MAX_MODULE_DEPTH) {
      return fail(reply, 400, 1001, `tree depth limit is ${MAX_MODULE_DEPTH}`);
    }

    const path = `${parentPath}${name.name}/`;
    /* 同 parent 下同名 → 同 path → 撞 UNIQUE (project_id, path)（同层不同分支可
       重名，身份是 path）。先查是为了给出干净的话术，约束兜底并发。 */
    const duplicate = await pool.query("SELECT 1 FROM spec_modules WHERE project_id = $1 AND path = $2", [context.project.id, path]);
    if (duplicate.rowCount) return fail(reply, 409, 2003, "a module with this name already exists at this level");

    const result = await pool.query(
      "INSERT INTO spec_modules (id, project_id, parent_id, name, path, position, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [randomUUID(), context.project.id, typeof request.body.parentId === "string" ? request.body.parentId : null, name.name, path, position ?? 0, context.user.id],
    );
    /* P11-9 审计（边界 5/6）：detail 只有字段名。 */
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.specModuleCreate, targetType: "spec_module", targetId: String(result.rows[0].id),
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return reply.code(201).send(success(mapSpecModule(result.rows[0])));
  });

  /**
   * 改名 / 移动 / 调 position，一次请求可组合。path 是物化的，所以三种操作最终
   * 都是同一件事：整棵子树换前缀——一条 UPDATE 里 `newPrefix || substring(path,
   * oldLen + 1)` 同时改根与全部后代（spec_cases 只存 module_id 不存 path，用例
   * 行完全不用动；test_plan_items 存的是快照，也不受影响）。
   *
   * parentId 三态（不能用 COALESCE）：缺省 = 不动；null = 移到顶层；uuid = 移过去。
   */
  app.patch<{ Params: { id: string; moduleId: string }; Body: SpecModuleBody }>("/api/v1/projects/:id/spec-modules/:moduleId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.moduleId)) return fail(reply, 404, 2001, "spec module not found");

    const existing = await pool.query("SELECT * FROM spec_modules WHERE id = $1 AND project_id = $2", [request.params.moduleId, context.project.id]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "spec module not found");
    const current = existing.rows[0];
    const oldPrefix = String(current.path);

    const name = normalizeName(request.body.name);
    if (name.error) return fail(reply, 400, 1001, name.error);

    let position = Number(current.position ?? 0);
    if (request.body.position !== undefined) {
      if (!Number.isInteger(request.body.position)) return fail(reply, 400, 1001, "position must be an integer");
      position = request.body.position;
    }

    /* 新父：缺省时从自身 path 反推（parentPath + name + '/' 的逆运算），省一次查询。 */
    let newParentId = current.parent_id ? String(current.parent_id) : null;
    let newParentPath = oldPrefix.slice(0, oldPrefix.length - String(current.name).length - 1);
    if (request.body.parentId === null) {
      newParentId = null;
      newParentPath = "/";
    } else if (typeof request.body.parentId === "string") {
      const parent = await loadParent(context.project.id, request.body.parentId);
      if (!parent) return fail(reply, 400, 1001, "parent module not found in this project");
      newParentId = parent.id;
      newParentPath = parent.path;
    }

    if (newParentId === request.params.moduleId) return fail(reply, 400, 1001, "cannot move a module under itself");
    /* 目的地在自家子树里（含自身路径）：整树前缀替换会把祖先搬进后代下面。 */
    if (newParentPath.startsWith(oldPrefix)) return fail(reply, 400, 1001, "cannot move a module under itself or its descendant");

    const newName = name.name ?? String(current.name);
    const newPrefix = `${newParentPath}${newName}/`;

    /* 只有真正换父才可能变深：改名不动深度。子树最深行决定整棵子树挪过去后是否越界。 */
    if (newParentId !== (current.parent_id ? String(current.parent_id) : null)) {
      const deepest = await pool.query(
        "SELECT MAX(array_length(string_to_array(path, '/'), 1))::int AS units FROM spec_modules WHERE project_id = $1 AND starts_with(path, $2)",
        [context.project.id, oldPrefix],
      );
      const subtreeMaxSegments = Number(deepest.rows[0].units ?? 3) - 2;
      const currentSegments = countSegments(oldPrefix);
      const newRootSegments = countSegments(newParentPath) + 1;
      if (newRootSegments + (subtreeMaxSegments - currentSegments) > MAX_MODULE_DEPTH) {
        return fail(reply, 400, 1001, `tree depth limit is ${MAX_MODULE_DEPTH}`);
      }
    }

    /* 目的地前缀必须整块空着（排除自家子树行——它们的 path 还是旧前缀）：
       精确撞名、撞上别人的后代、或别人的路径落进新前缀里（会让 parent_id 与
       path 前缀关系断裂）都算占用。用 starts_with 而不是 LIKE：模块名可以含
       '%'/'_'，它们是 LIKE 的元字符、不是 starts_with 的。 */
    if (newPrefix !== oldPrefix) {
      const collision = await pool.query(
        "SELECT 1 FROM spec_modules WHERE project_id = $1 AND starts_with(path, $2) AND NOT starts_with(path, $3)",
        [context.project.id, newPrefix, oldPrefix],
      );
      if (collision.rowCount) return fail(reply, 409, 2003, "a module already exists at the target path");
    }

    const result = await pool.query(
      `UPDATE spec_modules
       SET name = CASE WHEN id = $1 THEN $2 ELSE name END,
           parent_id = CASE WHEN id = $1 THEN $3 ELSE parent_id END,
           position = CASE WHEN id = $1 THEN $4 ELSE position END,
           /* $6 必须显式 ::int：pg 以 unknown 类型传参时，substring 的重载
              解析会选 (text, text) 的正则变体（unknown 优先 text 类别），
              '数字' 当正则匹配不上 → NULL → path 整列被写成 NULL 撞
              NOT NULL（㉓：脑图内目录改名首次踩中，此前这条 UPDATE 从
              没被任何调用方执行过）。 */
           path = $5 || substring(path, $6::int),
           updated_by = $9,
           updated_at = now()
       WHERE project_id = $7 AND starts_with(path, $8)
       RETURNING *`,
      [request.params.moduleId, newName, newParentId, position, newPrefix, oldPrefix.length + 1, context.project.id, oldPrefix, context.user.id],
    );
    /* RETURNING 无序，根行用 id 认领；找不到说明并发下已被删——如实回 404。 */
    const row = result.rows.find((r: Record<string, unknown>) => String(r.id) === request.params.moduleId);
    if (!row) return fail(reply, 404, 2001, "spec module not found");
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.specModuleUpdate, targetType: "spec_module", targetId: request.params.moduleId,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return success(mapSpecModule(row));
  });

  /**
   * 扫引用再删（environments 同款语义）：子树里还有用例就 409 + 清单，客户端
   * 给用户看过之后带 `?force=true` 重发才真删。空的子模块结构随根一起级联——
   * 「删一个空目录树」不是破坏性操作，只有用例是内容。
   */
  app.delete<{ Params: { id: string; moduleId: string }; Querystring: { force?: string } }>("/api/v1/projects/:id/spec-modules/:moduleId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.moduleId)) return fail(reply, 404, 2001, "spec module not found");

    const existing = await pool.query("SELECT path FROM spec_modules WHERE id = $1 AND project_id = $2", [request.params.moduleId, context.project.id]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "spec module not found");
    const prefix = String(existing.rows[0].path);

    const usage = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM spec_modules WHERE project_id = $1 AND starts_with(path, $2)) AS module_count,
         (SELECT COUNT(*)::int FROM spec_cases WHERE project_id = $1 AND module_id IN (SELECT id FROM spec_modules WHERE project_id = $1 AND starts_with(path, $2))) AS case_count`,
      [context.project.id, prefix],
    );
    const caseCount = Number(usage.rows[0].case_count);
    const moduleCount = Number(usage.rows[0].module_count);
    if (caseCount > 0 && request.query.force !== "true") {
      return reply.code(409).send({
        code: 2003,
        message: "spec module (or its submodules) still contains cases",
        data: { moduleId: request.params.moduleId, caseCount, moduleCount, blocked: true },
      });
    }

    /* 用例没了，计划项（ON DELETE CASCADE）随之消散——快照纪律只保「计划项读得
       通」，不阻止内容本身被删；被删用例的计划行没有继续存在的语义。 */
    const result = await pool.query("DELETE FROM spec_modules WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.moduleId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "spec module not found");
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.specModuleDelete, targetType: "spec_module", targetId: String(result.rows[0].id),
      projectId: context.project.id, userId: context.user.id, ip: request.ip,
    });
    return success({ id: result.rows[0].id });
  });

  /**
   * 同级批量重排（P7-6 拖拽调序的后端）：一次请求写平**一个父级下全部直属子模块**
   * 的 position（0..n-1，即调用方给出的完整顺序）。单个 PATCH 换邻居的算法在拖拽
   * 下会连发多次、且「挤进中间」要一串连锁换位——拖拽的语义本来就是「给出这一层
   * 的最终顺序」，直接全量提交。
   *
   * 校验：moduleIds 必须恰好等于该父级（parentId null = 顶层）当前的直属集合
   * （多/少/混入别家的都 400——顺序数组是快照，过期就拒绝重拖，不静默部分应用）。
   * position 整层一次成型，读写并发下最坏也只是覆盖后拖的那次（后写覆盖，全站
   * 既有口径）。
   */
  app.post<{ Params: { id: string }; Body: { parentId?: string | null; moduleIds?: string[] } }>("/api/v1/projects/:id/spec-modules/reorder", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    const moduleIds = [...new Set(request.body?.moduleIds ?? [])];
    if (!moduleIds.length || moduleIds.some((id) => !isUuid(id))) {
      return fail(reply, 400, 1001, "moduleIds must be a non-empty array of UUIDs");
    }

    /* parentId 三态在这里只有两态：缺省或 null = 顶层；uuid = 那个模块。 */
    let parentClause = "parent_id IS NULL";
    const params: unknown[] = [context.project.id];
    if (typeof request.body?.parentId === "string") {
      if (!isUuid(request.body.parentId)) return fail(reply, 400, 1001, "parentId must be a UUID");
      params.push(request.body.parentId);
      parentClause = `parent_id = $${params.length}`;
    }

    const current = await pool.query(`SELECT id FROM spec_modules WHERE project_id = $1 AND ${parentClause}`, params);
    const currentIds = current.rows.map((row: Record<string, unknown>) => String(row.id)).sort();
    /* 排序后逐一比对：集合相等（不看顺序——顺序正是要写的那个东西）。 */
    if (currentIds.join(",") !== [...moduleIds].sort().join(",")) {
      return fail(reply, 400, 1001, "moduleIds must cover exactly the current children of the parent");
    }

    /* 一层最多几十个模块，逐行 UPDATE 在一个事务里足够；CASE 大拼接反而难读。 */
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let index = 0; index < moduleIds.length; index++) {
        await client.query("UPDATE spec_modules SET position = $1, updated_by = $4, updated_at = now() WHERE project_id = $2 AND id = $3", [index, context.project.id, moduleIds[index], context.user.id]);
      }
      await client.query("COMMIT");
      /* 整层重排是一次批量写：与接口批量删除同款，落**一行**带数量（边界 6）。 */
      writeAuditLogAsync({
        action: AUDIT_ACTIONS.specModuleUpdate, targetType: "spec_module", targetId: null,
        projectId: context.project.id, userId: context.user.id,
        detail: { fields: ["position"], ids: moduleIds.length }, ip: request.ip,
      });
      return success({ updated: moduleIds.length });
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, 400, 1001, error instanceof Error ? error.message : "modules could not be reordered");
    } finally {
      client.release();
    }
  });
}
