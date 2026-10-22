import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, auditFields } from "./audit.js";
import {
  auditMcpAction, auditMcpResource,
  requiredUuidArg, stringArg, toolError, toolResult,
} from "./mcpToolResult.js";
import type { McpToolDefinition } from "./mcpServer.js";
import { scriptUsage } from "./scripts.js";
import { inspectLibrarySource } from "./scriptContract.js";
import { collectReferences } from "./resolve.js";
import {
  CREATABLE_SCRIPT_KINDS, validateScript, type ScriptInput,
} from "./validateScript.js";
import { mapEndpoint, mapScript } from "../models/types.js";

/**
 * 公共脚本 CRUD 与环境删除（P5-6，2026-09-09 扩界 44 → 55 的后批）。
 *
 * **公共脚本**：`list_scripts` 从「只读」升级为完整 CRUD——create 幂等键
 * `(project, name)`（同 `create_suite` 先例：重名按更新处理，模型重述需求不该产出
 * 第二条同名脚本）；update 走 `lib/validateScript.ts` 同款校验（kind 不可改、库
 * 内容过 `inspectLibrarySource`、依赖整块替换且只能指 library）；delete 一次执行，
 * 回执带追随者清单（`scriptUsage` 的清单，REST force 删除的信息等价物），确认由
 * 客户端按 `destructiveHint` 在调用前完成。
 * 匿名脚本没有通路（它们是用例/流程的附属物，改公共脚本才是对追随者负责的动作）。
 *
 * **delete_environment**：`upsert_environment` 只补了变量通路，删除一直缺。删除
 * 语义照 REST——先扫独占变量引用（`scanUsage` 同款：只有本环境能供的变量被接口
 * 引用才算 blocked），回执里给清单；历史执行的名字快照在删前回填
 * （executions.environment_name），与 REST 删除路由同一条纪律。secret 管理仍
 * 无通路（契约第 7 条：secret 只能人在 UI 里录）。
 */

/**
 * 重写脚本的依赖列表（REST replaceDependencies 同款：只能指本项目的 library、库
 * 不能依赖库——组合只有一层深，位置即拼接序）。搬移而不是 import：REST 版返回
 * `string | undefined` 且直接写库，两处签名的 caller 形状不同；判据逐字保持一致。
 */
async function replaceDependencies(
  db: Pick<PoolClient, "query">,
  projectId: string,
  scriptId: string,
  kind: string,
  dependencies: string[],
): Promise<string | undefined> {
  const ids = [...new Set(dependencies.filter(Boolean))];
  if (kind === "library" && ids.length) return "a library cannot depend on another library; keep composition one level deep";

  if (ids.length) {
    const libraries = await db.query(
      "SELECT id, kind FROM scripts WHERE id = ANY($1::uuid[]) AND project_id = $2",
      [ids, projectId],
    );
    if (libraries.rowCount !== ids.length) return "a referenced library does not exist in this project";
    if (libraries.rows.some((row) => String(row.kind) !== "library")) return "only library scripts can be referenced as dependencies";
  }

  await db.query("DELETE FROM script_deps WHERE script_id = $1", [scriptId]);
  for (const [position, id] of ids.entries()) {
    await db.query(
      "INSERT INTO script_deps (script_id, depends_on_id, position) VALUES ($1, $2, $3)",
      [scriptId, id, position],
    );
  }
  return undefined;
}

/** Library ids a script declares, in concatenation order. */
async function dependencyIds(scriptId: string, db: Pick<PoolClient, "query"> = pool): Promise<string[]> {
  const result = await db.query(
    "SELECT depends_on_id FROM script_deps WHERE script_id = $1 ORDER BY position",
    [scriptId],
  );
  return result.rows.map((row) => String(row.depends_on_id));
}

export const WRITE_EXTRA_TOOLS: readonly McpToolDefinition[] = [
  /* ── 公共脚本 ─────────────────────────────────────────────────────────── */

  {
    name: "create_script",
    description: "Create a named public script (kind: hook | response | library | node — 'assertion' is retired and not creatable). Idempotency key is (project, name): an existing script with the same name is UPDATED instead of duplicated, which changes every follower at once. library content is declarations-only (inspected: functions/classes/constants, side-effect-free initializers). dependencies (max 10) reference existing library scripts of this project, concatenated in order; a library itself may not depend on libraries. Read get_script_contract BEFORE writing a script — scripts are not bare JavaScript.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "unique in the project, at most 100 characters" },
        content: { type: "string", description: "JavaScript following the ctx.* contract, at most 20000 characters" },
        kind: { type: "string", description: "hook | response | library | node, default response" },
        dependencies: { type: "array", items: { type: "string" }, description: "library script ids, max 10, replaced whole" },
      },
      required: ["name", "content"],
    },
    handler: async (args, identity) => {
      const input = args as unknown as ScriptInput;
      const invalid = validateScript(input);
      if (invalid) return toolError(`${invalid} (1001)`);
      const kind = input.kind ?? "response";
      if (!CREATABLE_SCRIPT_KINDS.includes(kind)) return toolError(`kind must be one of ${CREATABLE_SCRIPT_KINDS.join(", ")} (1001)`);
      if (kind === "library") {
        const inspected = inspectLibrarySource(input.content!);
        if (inspected.error) return toolError(`${inspected.error} (1001)`);
      }

      /* 幂等键 `(project, name)`：重名按更新处理（create_suite 先例）。改的是公共
         脚本＝改全部追随者，REST PATCH 的「先看过 usage」在这里由 message 与
         update 的 followers 回执承担。 */
      const existing = await pool.query("SELECT id FROM scripts WHERE project_id = $1 AND name = $2", [identity.projectId, input.name!.trim()]);
      const created = !existing.rowCount;
      const scriptId = created ? randomUUID() : String(existing.rows[0].id);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = created
          ? await client.query(
              `INSERT INTO scripts (id, project_id, name, language, kind, content, owner_case_id, created_by)
               VALUES ($1, $2, $3, 'javascript', $4, $5, NULL, $6) RETURNING *`,
              [scriptId, identity.projectId, input.name!.trim(), kind, input.content!, identity.createdBy ?? null],
            )
          : await client.query(
              `UPDATE scripts SET content = $2, updated_by = $4, updated_at = now()
                WHERE id = $1 AND project_id = $3 AND name IS NOT NULL RETURNING *`,
              [scriptId, input.content!, identity.projectId, identity.createdBy ?? null],
            );
        if (!result.rowCount) {
          await client.query("ROLLBACK");
          return toolError("script not found (2001)");
        }
        const dependencyError = await replaceDependencies(client, identity.projectId, scriptId, kind, input.dependencies ?? []);
        if (dependencyError) {
          await client.query("ROLLBACK");
          return toolError(`${dependencyError} (1001)`);
        }
        const dependencies = await dependencyIds(scriptId, client);
        await client.query("COMMIT");
        auditMcpAction("mcp_tool.write", "create_script", identity, scriptId, { outcome: created ? "created" : "updated" });
        /* P11-9：资源级审计并行落一行（detail 只有字段名，脚本正文绝不进）。 */
        auditMcpResource(created ? AUDIT_ACTIONS.scriptCreate : AUDIT_ACTIONS.scriptUpdate, "script", identity, scriptId, { fields: auditFields(input) });
        return toolResult({ script: mapScript({ ...result.rows[0], dependencies }), outcome: created ? "created" : "updated" });
      } catch (error) {
        await client.query("ROLLBACK");
        return toolError(error instanceof Error ? `${error.message} (1001)` : "script could not be saved (1001)");
      } finally {
        client.release();
      }
    },
  },
  {
    name: "update_script",
    description: "Patch one public script by id: name, content, dependencies (replaced whole when present). kind is deliberately NOT editable — flipping a script's kind changes the meaning of its `return` for every follower at once; re-create it instead. Editing content changes every follower at once; the result carries the follower list (cases/flows/scripts) so the consequence is visible. Anonymous case-owned scripts cannot be patched here (they follow their owner case's save).",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        scriptId: { type: "string" },
        name: { type: "string" },
        content: { type: "string" },
        dependencies: { type: "array", items: { type: "string" }, description: "library script ids, replaced whole when present" },
      },
      required: ["scriptId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "scriptId", "script");
      if ("error" in id) return toolError(id.error);
      const input = args as unknown as ScriptInput;
      const invalid = validateScript(input, true);
      if (invalid) return toolError(`${invalid} (1001)`);

      const existing = await pool.query("SELECT * FROM scripts WHERE id = $1 AND project_id = $2 AND name IS NOT NULL", [id.value, identity.projectId]);
      if (!existing.rowCount) return toolError("script not found (2001)");
      const currentKind = String(existing.rows[0].kind ?? "assertion");

      if (input.name !== undefined) {
        const duplicate = await pool.query(
          "SELECT id FROM scripts WHERE project_id = $1 AND name = $2 AND id <> $3",
          [identity.projectId, input.name.trim(), id.value],
        );
        if (duplicate.rowCount) return toolError("a script with this name already exists (2003)");
      }
      if (currentKind === "library" && input.content !== undefined) {
        const inspected = inspectLibrarySource(input.content);
        if (inspected.error) return toolError(`${inspected.error} (1001)`);
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `UPDATE scripts SET name = COALESCE($1, name), content = COALESCE($2, content), updated_by = $5, updated_at = now()
           WHERE id = $3 AND project_id = $4 AND name IS NOT NULL RETURNING *`,
          [input.name?.trim() ?? null, input.content ?? null, id.value, identity.projectId, identity.createdBy ?? null],
        );
        if (!result.rowCount) {
          await client.query("ROLLBACK");
          return toolError("script not found (2001)");
        }
        if (input.dependencies !== undefined) {
          const dependencyError = await replaceDependencies(client, identity.projectId, id.value, currentKind, input.dependencies);
          if (dependencyError) {
            await client.query("ROLLBACK");
            return toolError(`${dependencyError} (1001)`);
          }
        }
        const dependencies = await dependencyIds(id.value, client);
        await client.query("COMMIT");
        const followers = await scriptUsage(identity.projectId, id.value);
        auditMcpAction("mcp_tool.write", "update_script", identity, id.value, { followers: followers.length });
        auditMcpResource(AUDIT_ACTIONS.scriptUpdate, "script", identity, id.value, { fields: auditFields(input) });
        return toolResult({ ...mapScript({ ...result.rows[0], dependencies }), followers, followerCount: followers.length });
      } catch (error) {
        await client.query("ROLLBACK");
        return toolError(error instanceof Error ? `${error.message} (1001)` : "script could not be updated (1001)");
      } finally {
        client.release();
      }
    },
  },
  {
    name: "delete_script",
    description: "Delete a named public script — this changes every follower at once. Irreversible and marked destructive, so the client asks the human before calling; once called it deletes in one round. Followers stop working at their next run with 'script content is missing'. Use get_script-level reads or update_script's follower list first if the human needs to see the followers before deciding.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { scriptId: { type: "string" } },
      required: ["scriptId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "scriptId", "script");
      if ("error" in id) return toolError(id.error);
      const existing = await pool.query("SELECT * FROM scripts WHERE id = $1 AND project_id = $2 AND name IS NOT NULL", [id.value, identity.projectId]);
      if (!existing.rowCount) return toolError("script not found (2001)");

      const followers = await scriptUsage(identity.projectId, id.value);

      const result = await pool.query(
        "DELETE FROM scripts WHERE id = $1 AND project_id = $2 AND name IS NOT NULL RETURNING id",
        [id.value, identity.projectId],
      );
      if (!result.rowCount) return toolError("script not found (2001)");
      auditMcpAction("mcp_tool.write", "delete_script", identity, id.value, { outcome: "deleted", affectedFollowers: followers.length });
      auditMcpResource(AUDIT_ACTIONS.scriptDelete, "script", identity, id.value, { fields: [] });
      return toolResult({ id: id.value, deleted: true, affectedFollowers: followers.length, followers });
    },
  },

  /* ── 环境删除 ─────────────────────────────────────────────────────────── */

  {
    name: "delete_environment",
    description: "Delete an environment. Reports the endpoints that reference variables ONLY this environment supplies (sibling environments providing the same key keep those endpoints working) and how many executions ran with it; historical executions keep their environment name snapshot. Irreversible and marked destructive, so the client asks the human before calling; once called it deletes in one round. Cannot delete or read secrets (secret values are entered by humans in the UI and never leave the server).",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { environmentId: { type: "string" } },
      required: ["environmentId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "environmentId", "environment");
      if ("error" in id) return toolError(id.error);
      const environment = await pool.query("SELECT * FROM environments WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!environment.rowCount) return toolError("environment not found (2001)");
      const row = environment.rows[0];

      /* 独占变量引用扫描（REST scanUsage 同款）：耦合是按变量名而不是 FK——
         「哪些接口只有这个环境能供」才是删除的实际后果。 */
      const provided = new Set([
        ...Object.keys((row.variables ?? {}) as Record<string, string>),
        ...Object.keys((row.secrets ?? {}) as Record<string, string>),
      ]);
      const siblings = await pool.query("SELECT variables, secrets FROM environments WHERE project_id = $1 AND id <> $2", [identity.projectId, id.value]);
      const elsewhere = new Set<string>();
      for (const sibling of siblings.rows) {
        for (const key of Object.keys((sibling.variables ?? {}) as Record<string, string>)) elsewhere.add(key);
        for (const key of Object.keys((sibling.secrets ?? {}) as Record<string, string>)) elsewhere.add(key);
      }
      const exclusive = [...provided].filter((name) => !elsewhere.has(name));

      const endpointRows = await pool.query("SELECT * FROM endpoints WHERE project_id = $1", [identity.projectId]);
      const endpoints = endpointRows.rows.map(mapEndpoint).map((endpoint) => {
        const referenced = collectReferences([
          endpoint.url, endpoint.headers, endpoint.queryParams, endpoint.pathParams,
          endpoint.body, endpoint.bodyText, endpoint.auth,
        ]);
        const variables = [...referenced].filter((name) => exclusive.includes(name)).sort();
        return { id: endpoint.id, name: endpoint.name, method: endpoint.method, url: endpoint.url, variables };
      }).filter((endpoint) => endpoint.variables.length > 0);
      const executions = await pool.query("SELECT COUNT(*)::int AS total FROM executions WHERE environment_id = $1", [id.value]);

      const summary = endpoints.length
        ? `${endpoints.length} endpoint(s) reference variables only this environment supplies: ${endpoints.map((endpoint) => `${endpoint.method} ${endpoint.url} (${endpoint.variables.join(", ")})`).join("; ")}.`
        : "No endpoint depends exclusively on this environment.";

      /* 删前回填执行历史的名字快照（REST 删除同款）：FK 置空后名字仍在。 */
      await pool.query("UPDATE executions SET environment_name = COALESCE(environment_name, (SELECT name FROM environments WHERE id = $1)) WHERE environment_id = $1", [id.value]);
      const result = await pool.query("DELETE FROM environments WHERE id = $1 AND project_id = $2 RETURNING id", [id.value, identity.projectId]);
      if (!result.rowCount) return toolError("environment not found (2001)");
      auditMcpAction("mcp_tool.write", "delete_environment", identity, id.value, {
        outcome: "deleted",
        blockedEndpoints: endpoints.length,
        executionsTotal: Number(executions.rows[0].total),
      });
      auditMcpResource(AUDIT_ACTIONS.environmentDelete, "environment", identity, id.value, { fields: [] });
      return toolResult({ id: id.value, deleted: true, affectedEndpoints: endpoints.length, endpointsWithExclusiveVariables: endpoints, consequence: summary });
    },
  },
];
