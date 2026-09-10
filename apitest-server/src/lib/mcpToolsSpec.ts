import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import {
  auditMcpAction, mrtrGate, mrtrRequired, MRTR_REFUSED_MESSAGE,
  pageArgs, requiredUuidArg, stringArg, toolError, toolResult,
  type MrtrContext,
} from "./mcpToolResult.js";
import type { McpToolDefinition } from "./mcpServer.js";
import {
  normalizeSteps, normalizeTags, nextItemKey, validateSpecCase,
  type SpecCaseBody,
} from "./validateSpecCase.js";
import { mapSpecCase, mapSpecModule } from "../models/types.js";

/**
 * 文本用例与模块的 MCP 工具（P5-6，用户 2026-09-09 要求扩界 44 → 55 的主批）。
 *
 * 语义与 REST 面（routes/specCases.ts / specModules.ts）逐字同源：校验走提取后的
 * `lib/validateSpecCase.ts`（边界 8），编号（item_key）服务端生成且不可改，删除语义
 * 照 REST——文本用例直接删（绑定行与计划项 CASCADE，无 409/force），模块带用例就
 * MRTR 确认回合（等价 REST 的 409/force，force 不是工具入参）。
 *
 * 不做的（description 里写清）：模块改名/移动/重排（物化路径子树改写是对结构的
 * 大动作，REST 面的 depth/collision 检查复杂，先不复制）；批量更新/删除（一次
 * 调一个，模型本来就是逐条对话）；绑定（links）——绑定牵涉四类目标的归属判定与
 * repo_case 的 key 语义，REST 面专属；导入/导出（文件流，MCP 没有合理的载荷形态）。
 */

/** delete_spec_module 的 MRTR 闸门三态（mcpToolsWriteCrud.gateDelete 同款，本文件内一份）。 */
function gateDelete(mcpReq: MrtrContext, message: string):
  | { refused: ReturnType<typeof toolError> }
  | { required: ReturnType<typeof mrtrRequired> }
  | { confirmed: true } {
  const gate = mrtrGate(mcpReq);
  if (gate.phase === "first") return { required: mrtrRequired(message) };
  if (gate.phase === "refused") return { refused: toolError(MRTR_REFUSED_MESSAGE) };
  return { confirmed: true };
}

export const READ_SPEC_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "list_spec_cases",
    description: "List text (spec) test cases — design-only assets with title/preconditions/steps/expected, distinct from executable API cases. Filters: keyword (title/itemKey), moduleId, path (module path prefix including all sublevels), priority (P0-P3), status (unreviewed|reviewed|deprecated), automation (yes/no; a case counts as automated when it has at least one non-endpoint binding). Rows are summaries with modulePath, linkCount and automated — use get_spec_case for one full definition. Cannot create, modify or delete spec cases.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "substring match against title and item_key" },
        moduleId: { type: "string", description: "restrict to direct cases of one module" },
        path: { type: "string", description: "module path prefix, e.g. '/模块A/'; includes all sublevels" },
        priority: { type: "string", description: "P0 | P1 | P2 | P3" },
        status: { type: "string", description: "unreviewed | reviewed | deprecated" },
        automation: { type: "string", description: "yes | no" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    handler: async (args, identity) => {
      const { page, pageSize, offset } = pageArgs(args);
      const params: unknown[] = [identity.projectId];
      const clauses = ["c.project_id = $1"];
      const keyword = stringArg(args, "keyword");
      if (keyword) {
        params.push(`%${keyword}%`);
        clauses.push(`(c.title ILIKE $${params.length} OR c.item_key ILIKE $${params.length})`);
      }
      const path = stringArg(args, "path");
      if (path) {
        params.push(path);
        clauses.push(`starts_with(m.path, $${params.length})`);
      }
      const moduleId = stringArg(args, "moduleId");
      if (moduleId) {
        const id = requiredUuidArg(args, "moduleId", "module");
        if ("error" in id) return toolError(id.error);
        params.push(id.value);
        clauses.push(`c.module_id = $${params.length}`);
      }
      const priority = stringArg(args, "priority");
      if (priority) {
        if (!["P0", "P1", "P2", "P3"].includes(priority)) return toolError("priority must be one of P0, P1, P2, P3 (1001)");
        params.push(priority);
        clauses.push(`c.priority = $${params.length}`);
      }
      const status = stringArg(args, "status");
      if (status) {
        if (!["unreviewed", "reviewed", "deprecated"].includes(status)) return toolError("status must be one of unreviewed, reviewed, deprecated (1001)");
        params.push(status);
        clauses.push(`c.status = $${params.length}`);
      }
      const automation = stringArg(args, "automation");
      if (automation === "yes" || automation === "no") {
        clauses.push(`${automation === "yes" ? "" : "NOT "}EXISTS (SELECT 1 FROM spec_case_links l WHERE l.spec_case_id = c.id AND l.target_type <> 'endpoint')`);
      }
      const where = clauses.join(" AND ");
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM spec_cases c JOIN spec_modules m ON m.id = c.module_id WHERE ${where}`, params);
      params.push(pageSize, offset);
      const result = await pool.query(
        `SELECT c.*, m.path AS module_path,
                (SELECT COUNT(*)::int FROM spec_case_links l WHERE l.spec_case_id = c.id) AS link_count,
                EXISTS (SELECT 1 FROM spec_case_links l WHERE l.spec_case_id = c.id AND l.target_type <> 'endpoint') AS automated
           FROM spec_cases c
           JOIN spec_modules m ON m.id = c.module_id
          WHERE ${where}
          ORDER BY m.path, COALESCE(c.item_key, ''), c.title, c.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return toolResult({
        cases: result.rows.map(mapSpecCase),
        page, pageSize, total: Number(count.rows[0].total),
      });
    },
  },
  {
    name: "get_spec_case",
    description: "One text (spec) case's full definition: title, preconditions, steps [{step, expected}], priority, tags, status, plus its links[] to automation assets (endpoint / case / flow / repo_case with target name and last automation result, joined at read time). itemKey (TC-###) is system identity, never editable. Cannot create, modify or delete spec cases or their links.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { caseId: { type: "string", description: "spec case id from list_spec_cases" } },
      required: ["caseId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "caseId", "spec case");
      if ("error" in id) return toolError(id.error);
      const result = await pool.query(
        `SELECT c.*, m.path AS module_path
           FROM spec_cases c JOIN spec_modules m ON m.id = c.module_id
          WHERE c.id = $1 AND c.project_id = $2`,
        [id.value, identity.projectId],
      );
      if (!result.rowCount) return toolError("spec case not found (2001)");
      /* 绑定清单：REST 详情同一条 LINK_READ_SQL（target 名 + 最近结果，读时关联绝不回写）。
         复刻而不是 import：该 SQL 在路由文件里耦合 $2 顺序与 fallback 逻辑，提取面大；
         工具面只需要名字与 id，不带 lastResult 的完整拼串。 */
      const links = await pool.query(
        `SELECT l.*,
           CASE l.target_type
             WHEN 'endpoint'  THEN (SELECT e.name FROM endpoints e WHERE e.id = l.target_id AND e.project_id = $2)
             WHEN 'case'      THEN (SELECT tc.name FROM test_cases tc WHERE tc.id = l.target_id AND tc.project_id = $2)
             WHEN 'flow'      THEN (SELECT f.name FROM flows f WHERE f.id = l.target_id AND f.project_id = $2)
             WHEN 'repo_case' THEN (SELECT c2.name FROM repo_test_cases c2 WHERE c2.id = l.target_id AND c2.project_id = $2)
           END AS target_name
         FROM spec_case_links l WHERE l.spec_case_id = $1 ORDER BY l.created_at, l.id`,
        [id.value, identity.projectId],
      );
      return toolResult({
        ...mapSpecCase(result.rows[0]),
        links: links.rows.map((row) => ({
          id: String(row.id),
          targetType: String(row.target_type),
          targetId: String(row.target_id),
          targetName: row.target_name === undefined || row.target_name === null ? undefined : String(row.target_name),
        })),
      });
    },
  },
];

export const WRITE_SPEC_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "create_spec_case",
    description: "Create a text (spec) test case under a module — design content only (title/preconditions/steps/expected), never executed by the platform. itemKey (TC-###) is generated server-side and returned. Idempotency: NO auto-dedup (two identical creates make two cases; a case with the same itemKey or import path is only merged by the xmind/excel import path). moduleId must exist in this project. Cannot bind automation assets (links are a REST UI action) or import files.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        moduleId: { type: "string", description: "parent module id (see list_spec_modules)" },
        title: { type: "string" },
        preconditions: { type: "string" },
        steps: { type: "array", items: { type: "object", properties: { step: { type: "string" }, expected: { type: "string" } } }, description: "[{step, expected}] pairs; rows where both are empty are dropped" },
        priority: { type: "string", description: "P0 | P1 | P2 | P3, default P2" },
        tags: { type: "array", items: { type: "string" } },
        status: { type: "string", description: "unreviewed (default) | reviewed | deprecated" },
      },
      required: ["moduleId", "title"],
    },
    handler: async (args, identity) => {
      const moduleId = requiredUuidArg(args, "moduleId", "module");
      if ("error" in moduleId) return toolError(moduleId.error);
      const module = await pool.query("SELECT id FROM spec_modules WHERE id = $1 AND project_id = $2", [moduleId.value, identity.projectId]);
      if (!module.rowCount) return toolError("module not found in this project (1001)");

      const input = args as unknown as SpecCaseBody;
      const invalid = validateSpecCase(input);
      if (invalid) return toolError(`${invalid} (1001)`);

      /* 编号并发撞号（23505）重取号重试至多 3 次——REST 手工建同款。 */
      for (let attempt = 0; ; attempt++) {
        const itemKey = await nextItemKey(identity.projectId);
        try {
          const result = await pool.query(
            `INSERT INTO spec_cases (id, project_id, module_id, item_key, title, preconditions, steps, priority, tags, status, source, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'manual', $11) RETURNING *`,
            [
              randomUUID(), identity.projectId, moduleId.value, itemKey,
              input.title!.trim(), input.preconditions?.trim() ?? "",
              JSON.stringify(normalizeSteps(input.steps) ?? []), input.priority ?? "P2",
              normalizeTags(input.tags) ?? [], input.status ?? "unreviewed", identity.createdBy ?? null,
            ],
          );
          auditMcpAction("mcp_tool.write", "create_spec_case", identity, String(result.rows[0].id), { outcome: "created", moduleId: moduleId.value });
          return toolResult({ case: mapSpecCase(result.rows[0]), outcome: "created" });
        } catch (error) {
          if ((error as { code?: string }).code === "23505" && attempt < 2) continue;
          throw error;
        }
      }
    },
  },
  {
    name: "update_spec_case",
    description: "Patch one text (spec) case by id: title, preconditions, steps (replaced whole), priority, tags, status, moduleId (move). itemKey is not editable (system identity); source is not editable. Absent keys keep their values. Cannot touch links or test plans.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        caseId: { type: "string" },
        moduleId: { type: "string", description: "move the case to this module (must exist in this project)" },
        title: { type: "string" },
        preconditions: { type: "string" },
        steps: { type: "array", items: { type: "object", properties: { step: { type: "string" }, expected: { type: "string" } } }, description: "replaced whole when present" },
        priority: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        status: { type: "string", description: "unreviewed | reviewed | deprecated" },
      },
      required: ["caseId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "caseId", "spec case");
      if ("error" in id) return toolError(id.error);
      const input = args as unknown as SpecCaseBody;
      const invalid = validateSpecCase(input, true);
      if (invalid) return toolError(`${invalid} (1001)`);

      const existing = await pool.query("SELECT id FROM spec_cases WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!existing.rowCount) return toolError("spec case not found (2001)");

      /* moduleId 两态：缺省不动；给了就要属于本项目（REST PATCH 同款 400 语义）。 */
      let moduleGiven = false;
      if (input.moduleId !== undefined) {
        const module = await pool.query("SELECT id FROM spec_modules WHERE id = $1 AND project_id = $2", [input.moduleId, identity.projectId]);
        if (!module.rowCount) return toolError("module not found in this project (1001)");
        moduleGiven = true;
      }

      const result = await pool.query(
        `UPDATE spec_cases SET
            module_id = CASE WHEN $1 THEN $2::uuid ELSE module_id END,
            title = COALESCE($3, title),
            preconditions = COALESCE($4, preconditions),
            steps = COALESCE($5::jsonb, steps),
            priority = COALESCE($6, priority),
            tags = COALESCE($7, tags),
            status = COALESCE($8, status),
            updated_at = now()
          WHERE id = $9 AND project_id = $10 RETURNING *`,
        [
          moduleGiven, moduleGiven ? input.moduleId! : null,
          input.title?.trim() ?? null,
          input.preconditions?.trim() ?? null,
          input.steps !== undefined ? JSON.stringify(normalizeSteps(input.steps) ?? []) : null,
          input.priority ?? null,
          input.tags !== undefined ? (normalizeTags(input.tags) ?? []) : null,
          input.status ?? null,
          id.value, identity.projectId,
        ],
      );
      if (!result.rowCount) return toolError("spec case not found (2001)");
      auditMcpAction("mcp_tool.write", "update_spec_case", identity, id.value, {});
      return toolResult(mapSpecCase(result.rows[0]));
    },
  },
  {
    name: "delete_spec_case",
    description: "Delete one text (spec) case — irreversible (its links and test plan items cascade with it; plan items keep title snapshots so plans stay readable), so it always asks the human behind the client to confirm first (retry the identical call with the confirmed inputResponses to delete). No dependency scan is needed: links and plan items are part of the case and never block deletion. There is no force parameter.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { caseId: { type: "string" } },
      required: ["caseId"],
    },
    handler: async (args, identity, mcpReq) => {
      const id = requiredUuidArg(args, "caseId", "spec case");
      if ("error" in id) return toolError(id.error);
      const existing = await pool.query(
        `SELECT c.title, c.item_key, (SELECT COUNT(*)::int FROM spec_case_links l WHERE l.spec_case_id = c.id) AS link_count
           FROM spec_cases c WHERE c.id = $1 AND c.project_id = $2`,
        [id.value, identity.projectId],
      );
      if (!existing.rowCount) return toolError("spec case not found (2001)");
      const row = existing.rows[0];
      const label = `${row.item_key ? `${String(row.item_key)} ` : ""}"${String(row.title)}"`;

      const gate = gateDelete(mcpReq, `Delete spec case ${label}? It has ${Number(row.link_count)} link(s); links and test plan items referencing it cascade with it.`);
      if ("refused" in gate) return gate.refused;
      if ("required" in gate) return gate.required;

      const result = await pool.query("DELETE FROM spec_cases WHERE id = $1 AND project_id = $2 RETURNING id", [id.value, identity.projectId]);
      if (!result.rowCount) return toolError("spec case not found (2001)");
      auditMcpAction("mcp_tool.write", "delete_spec_case", identity, id.value, { outcome: "deleted" });
      return toolResult({ id: id.value, deleted: true });
    },
  },

  /* ── 模块：文本用例的目录树。读全量 + 建子模块；改/删的语义见文件头注释。 ── */

  {
    name: "list_spec_modules",
    description: "List the spec-case module tree as a flat list (front-end attaches by parentId; there is no root row). Rows carry path ('/'-bounded materialized path), position, and DIRECT child counts: caseCount (all statuses), activeCount (reviewed), automatedCount (reviewed with at least one non-endpoint link) — subtree sums are the client's job. Ordered by path = depth-first. Cannot create, modify or delete modules.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "substring match against module name" },
      },
    },
    handler: async (args, identity) => {
      const params: unknown[] = [identity.projectId];
      const keyword = stringArg(args, "keyword");
      /* SQL 过滤而不是读后过滤：keyword 命中全量而不是当前列表（树不需要分页，
         REST 面本来也是全量拍平）。 */
      const where = keyword
        ? (params.push(`%${keyword}%`), "m.project_id = $1 AND m.name ILIKE $2")
        : "m.project_id = $1";
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
         WHERE ${where}
         ORDER BY m.path`,
        params,
      );
      return toolResult({ modules: result.rows.map(mapSpecModule), total: result.rowCount ?? 0 });
    },
  },
  {
    name: "create_spec_module",
    description: "Create a spec-case module (directory tree node) — omit parentId for top level, pass a module id for a child. Max depth 6. Name must not contain '/'. Idempotency key is (parent, name): a module with the same name at the same level is returned as-is instead of duplicated (same-name at different levels is allowed). Cannot rename, move, reorder or delete modules — those structural operations are REST UI actions.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "module name, must not contain '/'" },
        parentId: { type: ["string", "null"], description: "omit or null for top level" },
        position: { type: "integer", description: "sibling order, default 0" },
      },
      required: ["name"],
    },
    handler: async (args, identity) => {
      const name = stringArg(args, "name");
      if (!name) return toolError("module name is required (1001)");
      if (name.includes("/")) return toolError("module name must not contain '/' (1001)");
      const position = args.position;
      if (position !== undefined && !Number.isInteger(position)) return toolError("position must be an integer (1001)");

      /* parentId 缺省或 null 都是顶层；给了 uuid 就必须是本项目里真实存在的模块
         （REST 同款 body 引用语义：400/1001 而不是 404）。 */
      let parentPath = "/";
      if (typeof args.parentId === "string") {
        const parent = await pool.query("SELECT id, path FROM spec_modules WHERE id = $1 AND project_id = $2", [args.parentId, identity.projectId]);
        if (!parent.rowCount) return toolError("parent module not found in this project (1001)");
        parentPath = String(parent.rows[0].path);
      }
      if (parentPath.split("/").length - 2 + 1 > 6) return toolError("tree depth limit is 6 (1001)");

      const path = `${parentPath}${name}/`;
      /* 幂等键 `(parent, name)` = 同 path：重名重读既有行。UNIQUE (project_id, path)
         兜底并发；这里先查是为了干净的话术。 */
      const existing = await pool.query("SELECT * FROM spec_modules WHERE project_id = $1 AND path = $2", [identity.projectId, path]);
      if (existing.rowCount) {
        return toolResult({ module: mapSpecModule(existing.rows[0]), outcome: "skipped", conflict: true });
      }

      const result = await pool.query(
        "INSERT INTO spec_modules (id, project_id, parent_id, name, path, position) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        [randomUUID(), identity.projectId, typeof args.parentId === "string" ? args.parentId : null, name, path, position ?? 0],
      );
      auditMcpAction("mcp_tool.write", "create_spec_module", identity, String(result.rows[0].id), { outcome: "created" });
      return toolResult({ module: mapSpecModule(result.rows[0]), outcome: "created" });
    },
  },
];
