import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, auditFields, type AuditAction } from "./audit.js";
import { toFlowNode, validateFlowGraph } from "./flow.js";
import { checkFlowReferences } from "./flowRefs.js";
import { resolveBinding, type McpIdentity } from "./mcpAuth.js";
import { rejectCredentialNamedVariables, rejectLiteralSecrets, rejectLiteralSecretsInSnapshot } from "./mcpSecretGuard.js";
import { auditMcpAction, auditMcpResource, requiredUuidArg, stringArg, toolError, toolResult } from "./mcpToolResult.js";
import type { McpToolDefinition } from "./mcpServer.js";
import { persistCaseLifecycleScripts, persistFlowScripts } from "./scripts.js";
import { DEFAULT_RUNNER_LABEL } from "./queue.js";
import { resourcesBelong } from "./trigger.js";
import { isUuid } from "./uuid.js";
import { validateCase, validateEndpoint, type CaseInput, type EndpointInput } from "./validate.js";
import {
  mapEndpoint, mapEnvironment, mapFlow, mapTestCase, type HookConfig,
  type RequestSnapshot, type ResponseScriptConfig,
} from "../models/types.js";

/**
 * 核心写工具（P5-5a 的 5 个 + 2026-09-06 增补的 upsert_environment，共 6 个）：
 * endpoint / case / flow / 环境（普通变量）的建改。
 *
 * 三条纪律（9.0 边界 3/8/15）：
 * - **可逆写直接执行、全审计**：每个工具落一笔 `audit_logs`（`mcp_tool.write`，detail 带
 *   目标与动作，绝不带 payload——secret 拒绝之外仍可能有业务数据）。
 * - **校验复用提取到 lib/ 的同一份函数**（边界 8）：MCP 建出来的资产能过 MCP 的
 *   校验却存不进 REST 的形状，这件事从这里开始就不允许发生。
 * - **幂等是第一等公民但不建幂等表**（边界 15）：`create_endpoint` 按
 *   `(project, method, url)` 判重后走 `conflictStrategy`（更新/跳过，复用 import 的语
 *   义），`create_case` 按 `(endpoint, name)`、`upsert_flow` / `upsert_environment` 按
 *   `(project, name)`——模型会重试，同一个意图被调两次不该产出两行。
 *
 * `upsert_environment`（2026-09-06，上限 43→44 的第一笔）：只动**普通变量**。secret
 * 无参数、无通路——敏感值只能人在 UI 里录（契约第 7 条）；凭据名字的普通变量也被
 * `rejectCredentialNamedVariables` 指名拒绝（明文变量所有工具可读，不是放敏感值的地方）。
 */

/** 与 REST 面 `endpoints.ts` 的 WRITE_COLUMNS 同一份列清单（INSERT 与 UPDATE 不许漂移）。 */
const ENDPOINT_WRITE_COLUMNS = "name, description, method, url, headers, query_params, path_params, body_type, body, body_text, auth, tags, default_environment_id, created_by";

/** `writeValues` 与 REST 路由逐字段相同（lib/validate 之外这是唯一共享的写形状）。 */
function endpointWriteValues(input: EndpointInput, createdBy: string | null) {
  return [
    input.name!.trim(),
    input.description?.trim() ?? "",
    input.method!.toUpperCase(),
    input.url!.trim(),
    JSON.stringify(input.headers ?? {}),
    JSON.stringify(input.queryParams ?? {}),
    JSON.stringify(input.pathParams ?? {}),
    input.bodyType ?? (input.body === undefined ? "none" : "json"),
    input.body === undefined ? null : JSON.stringify(input.body),
    input.bodyText ?? null,
    JSON.stringify(input.auth ?? { type: "none" }),
    input.tags ?? [],
    input.defaultEnvironmentId ?? null,
    /* P11 归属：Token 签发人（`identity.createdBy`，边界 4）。它不是「操作者伪造的
       头」——token 归人、绑定归项目（P12），签发人就是这条写路径上唯一的人。 */
    createdBy,
  ];
}

/** REST 面 `endpoints.ts` 的 `validEnvironment` 同款（环境必须属于本项目）。 */
async function validEnvironment(projectId: string, environmentId: string | null | undefined): Promise<boolean> {
  if (!environmentId) return true;
  const result = await pool.query("SELECT 1 FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  return Boolean(result.rowCount);
}

/**
 * endpoint 的幂等落库（`create_endpoint` 与 `copy_endpoint` 共用）：键
 * `(project, method, url)`（边界 15）。重试、上下文截断、用户重述都会让同一意图被调
 * 两次，判重后按 `conflictStrategy` 分派，与 REST import 的语义逐字相同。
 */
async function upsertEndpoint(
  projectId: string,
  input: EndpointInput,
  strategy: "update" | "skip",
  createdBy: string | null,
): Promise<{ row: Record<string, unknown>; outcome: "created" | "updated" | "skipped"; conflict: boolean }> {
  const existing = await pool.query(
    "SELECT * FROM endpoints WHERE project_id = $1 AND method = $2 AND url = $3 LIMIT 1",
    [projectId, input.method!.toUpperCase(), input.url!.trim()],
  );
  if (existing.rowCount) {
    if (strategy === "skip") return { row: existing.rows[0], outcome: "skipped", conflict: true };
    const updated = await pool.query(
      `UPDATE endpoints SET name = $1, description = $2, headers = $3::jsonb, query_params = $4::jsonb, path_params = $5::jsonb,
         body_type = $6, body = $7::jsonb, body_text = $8, auth = $9::jsonb, tags = $10, default_environment_id = COALESCE($11, default_environment_id), updated_by = $13, updated_at = now()
       WHERE id = $12 RETURNING *`,
      [
        input.name!.trim(), input.description?.trim() ?? "",
        JSON.stringify(input.headers ?? {}), JSON.stringify(input.queryParams ?? {}), JSON.stringify(input.pathParams ?? {}),
        input.bodyType ?? (input.body === undefined ? "none" : "json"),
        input.body === undefined ? null : JSON.stringify(input.body), input.bodyText ?? null,
        JSON.stringify(input.auth ?? { type: "none" }), input.tags ?? [], input.defaultEnvironmentId ?? null,
        String(existing.rows[0].id),
        createdBy,
      ],
    );
    return { row: updated.rows[0], outcome: "updated", conflict: true };
  }
  const inserted = await pool.query(
    `INSERT INTO endpoints (id, project_id, ${ENDPOINT_WRITE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14, $15, $16) RETURNING *`,
    [randomUUID(), projectId, ...endpointWriteValues(input, createdBy)],
  );
  return { row: inserted.rows[0], outcome: "created", conflict: false };
}

/** REST 面 `cases.ts` 的 `toSnapshot` 同款：补齐客户端可省略的字段，存下的快照恒完整。 */
function toSnapshot(request: Partial<RequestSnapshot>): RequestSnapshot {
  return {
    method: request.method!.toUpperCase(),
    url: request.url!.trim(),
    headers: request.headers ?? {},
    queryParams: request.queryParams ?? {},
    pathParams: request.pathParams ?? {},
    bodyType: request.bodyType ?? (request.body === undefined ? "none" : "json"),
    body: request.body,
    bodyText: request.bodyText,
    auth: request.auth ?? { type: "none" },
  };
}

/** 写审计（共用件 `auditMcpAction` 的本地别名，三个参数对齐调用点）。 */
function auditWrite(tool: string, identity: Parameters<typeof auditMcpAction>[2], targetId: string, detail: Record<string, unknown>) {
  auditMcpAction("mcp_tool.write", tool, identity, targetId, detail);
}

/**
 * P11-9：资源级审计的本地入口——与 `auditWrite` 并排落一行，让该资产的「变更历史」
 * 也看得到这次 MCP 写入（与 REST 面同名动作、同一 detail 形状）。
 */
function auditResource(action: AuditAction, targetType: string, identity: McpIdentity, targetId: string | null, body: unknown) {
  auditMcpResource(action, targetType, identity, targetId, { fields: auditFields(body) });
}

/** `create_case` / `update_case` 的保存事务：用例行 + 生命周期脚本同进退（REST 同款）。 */
async function saveCase(projectId: string, caseId: string, endpointId: string, input: CaseInput, createdBy: string | null): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO test_cases (id, project_id, endpoint_id, environment_id, environment_name, name, description, request_snapshot, assertions, tags, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, '[]'::jsonb, $9, $10)`,
      [
        caseId, projectId, endpointId,
        input.environmentId ?? null,
        await environmentName(projectId, input.environmentId),
        input.name!.trim(), input.description?.trim() ?? "",
        JSON.stringify(toSnapshot(input.request!)), input.tags ?? [],
        createdBy,
      ],
    );
    const lifecycle = await persistCaseLifecycleScripts(client, projectId, caseId, {
      hooks: input.preRequestHooks ?? [],
      responseScripts: input.responseScripts ?? [],
    }, createdBy);
    const result = await client.query(
      `UPDATE test_cases SET assertions = $1::jsonb, pre_request_hooks = $2::jsonb,
         extracts = $3::jsonb, response_scripts = $4::jsonb WHERE id = $5 RETURNING *`,
      [
        JSON.stringify(input.assertions ?? []), JSON.stringify(lifecycle.hooks),
        JSON.stringify(input.extracts ?? []), JSON.stringify(lifecycle.responseScripts), caseId,
      ],
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 环境名快照（Spec 4.4：环境改名/删除后历史仍读得通）。返回 undefined = 环境不属于本项目。 */
async function environmentName(projectId: string, environmentId: string | null | undefined): Promise<string | null | undefined> {
  if (!environmentId) return null;
  const result = await pool.query("SELECT name FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  return result.rowCount ? String(result.rows[0].name) : undefined;
}

/** flow 保存的事务骨架（建/改共用）：行先落、脚本后接、节点树回写。 */
async function persistFlow(projectId: string, flowId: string, write: (client: PoolClient) => Promise<void>, nodes: ReturnType<typeof toFlowNode>[], createdBy: string | null): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await write(client);
    const persisted = await persistFlowScripts(client, projectId, flowId, nodes, createdBy);
    const result = await client.query("UPDATE flows SET nodes = $1::jsonb WHERE id = $2 RETURNING *", [JSON.stringify(persisted), flowId]);
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const WRITE_CORE_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "create_endpoint",
    description: "Create an endpoint, or resolve a (method, url) conflict per conflictStrategy: 'update' overwrites the existing definition (import semantics), 'skip' returns the existing row untouched. Idempotency key is (method, url) — the same intent called twice never produces two rows. Literal credential values (Authorization headers, token/secret/password-like fields) are REJECTED: create the secret in an environment and reference it as {{name}}. Cannot execute the endpoint (run_endpoint) or manage environments/secrets.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        method: { type: "string", description: "GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS" },
        url: { type: "string", description: "may reference {{variables}}" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        queryParams: { type: "object", additionalProperties: { type: "string" } },
        pathParams: { type: "object", additionalProperties: { type: "string" } },
        bodyType: { type: "string", description: "none | json | form | text" },
        /* 联合类型 ["object","null"] 会被智能体平台翻译成 String（windowMinutes/
           environmentId 同证），模型会再次生成字符串。改单类型 object：SDK 直接拒绝
           字符串，他们那边显示 object。body 的 null 清空本就未在描述中承诺，不再放行。 */
        body: { type: "object", description: "parsed JSON payload (object), used when bodyType is json" },
        bodyText: { type: "string", description: "raw payload for form/text bodies" },
        auth: { type: "object", description: "{type:'none'} | {type:'bearer',token:'{{var}}'} | {type:'basic',...} | {type:'apiKey',...}" },
        tags: { type: "array", items: { type: "string" } },
        defaultEnvironmentId: { type: "string" },
        conflictStrategy: { type: "string", description: "update (default) | skip — what to do when (method, url) already exists" },
      },
      required: ["name", "method", "url"],
    },
    handler: async (args, identity) => {
      const input = args as unknown as EndpointInput;
      const invalid = validateEndpoint(input);
      if (invalid) return toolError(`${invalid} (1001)`);
      const leaked = rejectLiteralSecrets(input);
      if (leaked) return toolError(leaked);
      if (!await validEnvironment(identity.projectId, input.defaultEnvironmentId)) {
        return toolError("default environment must belong to the project (1001)");
      }

      const strategy = stringArg(args, "conflictStrategy") === "skip" ? "skip" : "update";
      const { row, outcome, conflict } = await upsertEndpoint(identity.projectId, input, strategy, identity.createdBy ?? null);
      auditWrite("create_endpoint", identity, String(row.id), { outcome, method: input.method, url: input.url });
      if (outcome !== "skipped") auditResource(outcome === "created" ? AUDIT_ACTIONS.endpointCreate : AUDIT_ACTIONS.endpointUpdate, "endpoint", identity, String(row.id), input);
      return toolResult({ endpoint: mapEndpoint(row), outcome, ...(conflict ? { conflict: true } : {}) });
    },
  },
  {
    name: "copy_endpoint",
    description: "Copy one endpoint definition from a project this token can read into the project given by projectId (destination). Cross-project copy is the only cross-project capability: the copy is a NEW endpoint in the destination (idempotency key is (destination project, method, url), resolved per conflictStrategy exactly like create_endpoint), and `fromProjectId` must be a different project this token is also bound to. The source's default environment is deliberately NOT copied — environments are project-scoped. Literal credential-looking values in the source are rejected (spreading a literal secret into another project is what the platform must not do); use {{name}} references. This is a copy, not a reference: later edits to either side do not affect the other, and flow nodes still cannot point at another project's endpoints.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        fromProjectId: { type: "string", description: "source project id; must be bound to this token and differ from projectId" },
        endpointId: { type: "string", description: "endpoint id in the source project (from list_endpoints there)" },
        conflictStrategy: { type: "string", description: "update (default) | skip — what to do when (method, url) already exists in the destination" },
      },
      required: ["fromProjectId", "endpointId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "endpointId", "endpoint");
      if ("error" in id) return toolError(id.error);
      const fromProjectId = stringArg(args, "fromProjectId");
      if (!fromProjectId) return toolError("fromProjectId is required (1001)");
      if (!isUuid(fromProjectId)) return toolError("fromProjectId must be a UUID — project not found (2001)");
      if (fromProjectId === identity.projectId) return toolError("fromProjectId must differ from the destination projectId (1001)");
      /* 源项目也必须是绑定集里的一员（边界 3：绑定是过滤器）——目标项目已由闸门②③④
         判过，源项目没有闸门可依，在这里显式判一次。 */
      const sourceBinding = resolveBinding(identity.bindings, fromProjectId);
      if (!sourceBinding) return toolError("fromProjectId is not bound to this token (2001)");
      if (!sourceBinding.scope.includes("read")) return toolError("this token's binding on the source project does not allow read (1003)");

      const source = await pool.query("SELECT * FROM endpoints WHERE id = $1 AND project_id = $2", [id.value, fromProjectId]);
      if (!source.rowCount) return toolError("endpoint not found (2001)");
      const row = source.rows[0];
      /* 源行 → 写形状。`default_environment_id` 刻意不搬（环境 id 是项目级的，边界 11
         不做跨项目引用）；其余逐字段照搬。 */
      const input: EndpointInput = {
        name: String(row.name),
        description: String(row.description ?? ""),
        method: String(row.method),
        url: String(row.url),
        headers: (row.headers ?? {}) as Record<string, string>,
        queryParams: (row.query_params ?? {}) as Record<string, string>,
        pathParams: (row.path_params ?? {}) as Record<string, string>,
        bodyType: row.body_type ? String(row.body_type) as EndpointInput["bodyType"] : undefined,
        body: row.body ?? undefined,
        bodyText: row.body_text === null || row.body_text === undefined ? undefined : String(row.body_text),
        auth: (row.auth ?? { type: "none" }) as EndpointInput["auth"],
        tags: Array.isArray(row.tags) ? (row.tags as unknown[]).map(String) : [],
      };
      const invalid = validateEndpoint(input);
      if (invalid) return toolError(`the source endpoint is not a valid endpoint definition: ${invalid} (1001)`);
      /* 跨项目传播凭据字面量是平台最不该做的事（边界 4 的字面量拒绝在这里多一层意义）。 */
      const leaked = rejectLiteralSecrets(input);
      if (leaked) return toolError(`the source endpoint carries a literal credential value, so it cannot be copied across projects: ${leaked}`);

      const strategy = stringArg(args, "conflictStrategy") === "skip" ? "skip" : "update";
      const { row: saved, outcome, conflict } = await upsertEndpoint(identity.projectId, input, strategy, identity.createdBy ?? null);
      auditWrite("copy_endpoint", identity, String(saved.id), {
        outcome, fromProjectId, fromEndpointId: id.value, method: input.method, url: input.url,
      });
      if (outcome !== "skipped") auditResource(outcome === "created" ? AUDIT_ACTIONS.endpointCreate : AUDIT_ACTIONS.endpointUpdate, "endpoint", identity, String(saved.id), input);
      return toolResult({
        endpoint: mapEndpoint(saved),
        outcome,
        ...(conflict ? { conflict: true } : {}),
        copiedFrom: { projectId: fromProjectId, endpointId: id.value },
      });
    },
  },
  {
    name: "update_endpoint",
    description: "Patch one endpoint by id — only the keys present are written (partial update, idempotent by id). Same literal-secret rejection as create_endpoint. bodyText and defaultEnvironmentId are tri-state: absent keeps, null clears, a value sets. Cannot change project ownership or execute the endpoint.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        method: { type: "string" },
        url: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        queryParams: { type: "object", additionalProperties: { type: "string" } },
        pathParams: { type: "object", additionalProperties: { type: "string" } },
        bodyType: { type: "string" },
        body: { type: "object" },
        bodyText: { type: "string" },
        auth: { type: "object" },
        tags: { type: "array", items: { type: "string" } },
        defaultEnvironmentId: { type: ["string", "null"] },
      },
      required: ["endpointId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "endpointId", "endpoint");
      if ("error" in id) return toolError(id.error);
      const input = args as unknown as EndpointInput;
      const invalid = validateEndpoint(input, true);
      if (invalid) return toolError(`${invalid} (1001)`);
      const leaked = rejectLiteralSecrets(input);
      if (leaked) return toolError(leaked);
      if ("defaultEnvironmentId" in input && !await validEnvironment(identity.projectId, input.defaultEnvironmentId)) {
        return toolError("default environment must belong to the project (1001)");
      }

      /* REST PATCH 同款：body/bodyText/defaultEnvironmentId 可空，COALESCE 分不清
         「不动」与「清空」，这三个键只在出现时写。 */
      const result = await pool.query(
        `UPDATE endpoints SET
           name = COALESCE($1, name),
           description = COALESCE($2, description),
           method = COALESCE($3, method),
           url = COALESCE($4, url),
           headers = COALESCE($5::jsonb, headers),
           query_params = COALESCE($6::jsonb, query_params),
           path_params = COALESCE($7::jsonb, path_params),
           body_type = COALESCE($8, body_type),
           body = CASE WHEN $9::boolean THEN $10::jsonb ELSE body END,
           body_text = CASE WHEN $11::boolean THEN $12 ELSE body_text END,
           auth = COALESCE($13::jsonb, auth),
           tags = COALESCE($14, tags),
           default_environment_id = CASE WHEN $15::boolean THEN $16 ELSE default_environment_id END,
           updated_by = $19,
           updated_at = now()
         WHERE id = $17 AND project_id = $18 RETURNING *`,
        [
          input.name?.trim() || null,
          input.description ?? null,
          input.method?.toUpperCase() || null,
          input.url?.trim() || null,
          input.headers ? JSON.stringify(input.headers) : null,
          input.queryParams ? JSON.stringify(input.queryParams) : null,
          input.pathParams ? JSON.stringify(input.pathParams) : null,
          input.bodyType ?? null,
          "body" in input, input.body === undefined ? null : JSON.stringify(input.body),
          "bodyText" in input, input.bodyText ?? null,
          input.auth ? JSON.stringify(input.auth) : null,
          input.tags ?? null,
          "defaultEnvironmentId" in input, input.defaultEnvironmentId ?? null,
          id.value, identity.projectId,
          identity.createdBy ?? null,
        ],
      );
      if (!result.rowCount) return toolError("endpoint not found (2001)");
      auditWrite("update_endpoint", identity, id.value, {});
      auditResource(AUDIT_ACTIONS.endpointUpdate, "endpoint", identity, id.value, input);
      return toolResult(mapEndpoint(result.rows[0]));
    },
  },
  {
    name: "create_case",
    description: "Create a test case under an endpoint, freezing the request snapshot (later endpoint edits never change what this case runs). Idempotency key is (endpoint, name): an existing case with the same name under the same endpoint is returned as-is instead of duplicated. Validation scripts go into responseScripts — script assertions (type 'script') are retired and rejected here. Literal credentials in the request are rejected; reference {{name}} instead.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        environmentId: { type: ["string", "null"], description: "pins the case to one environment; omit for none" },
        request: { type: "object", description: "the frozen request snapshot: method, url, headers, queryParams, pathParams, bodyType, body, bodyText, auth" },
        assertions: { type: "array", description: "declarative assertions (status/header/jsonPath/jsonSchema); script type is rejected" },
        preRequestHooks: { type: "array" },
        extracts: { type: "array" },
        responseScripts: { type: "array", description: "the only place custom JavaScript may live (see get_script_contract)" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["endpointId", "name", "request"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "endpointId", "endpoint");
      if ("error" in id) return toolError(id.error);
      const endpoint = await pool.query("SELECT id FROM endpoints WHERE id = $1 AND project_id = $2", [id.value, identity.projectId]);
      if (!endpoint.rowCount) return toolError("endpoint not found (2001)");

      const input = args as unknown as CaseInput;
      const invalid = validateCase(input);
      if (invalid) return toolError(`${invalid} (1001)`);
      const leaked = rejectLiteralSecretsInSnapshot(input.request);
      if (leaked) return toolError(leaked);
      if (await environmentName(identity.projectId, input.environmentId) === undefined) {
        return toolError("environment must belong to the project (1001)");
      }

      /* 幂等键 `(endpoint, name)`：同名同归处的重复创建读回既有行。用例名在本项目
         不唯一，但同一个 endpoint 下两条同名用例对人不可区分——按这一对判重。 */
      const existing = await pool.query(
        "SELECT * FROM test_cases WHERE endpoint_id = $1 AND project_id = $2 AND name = $3 LIMIT 1",
        [id.value, identity.projectId, input.name!.trim()],
      );
      if (existing.rowCount) {
        return toolResult({ case: mapTestCase(existing.rows[0]), outcome: "skipped", conflict: true });
      }

      const caseId = randomUUID();
      const row = await saveCase(identity.projectId, caseId, id.value, input, identity.createdBy ?? null);
      auditWrite("create_case", identity, caseId, { endpointId: id.value, outcome: "created" });
      auditResource(AUDIT_ACTIONS.testCaseCreate, "test_case", identity, caseId, input);
      return toolResult({ case: mapTestCase(row), outcome: "created" });
    },
  },
  {
    name: "update_case",
    description: "Patch one test case by id (partial update, idempotent). The request snapshot, assertions, hooks, extracts and responseScripts are each replaced whole when present. environmentId is tri-state: absent keeps, null clears, a value moves. Script assertions are rejected — validation scripts only live in responseScripts.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        caseId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        environmentId: { type: ["string", "null"] },
        request: { type: "object" },
        assertions: { type: "array" },
        preRequestHooks: { type: "array" },
        extracts: { type: "array" },
        responseScripts: { type: "array" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["caseId"],
    },
    handler: async (args, identity) => {
      const id = requiredUuidArg(args, "caseId", "case");
      if ("error" in id) return toolError(id.error);
      const input = args as unknown as CaseInput;
      const invalid = validateCase(input, true);
      if (invalid) return toolError(`${invalid} (1001)`);
      const leaked = rejectLiteralSecretsInSnapshot(input.request);
      if (leaked) return toolError(leaked);

      const environmentGiven = Object.prototype.hasOwnProperty.call(input, "environmentId");
      let name: string | null | undefined;
      if (environmentGiven) {
        name = await environmentName(identity.projectId, input.environmentId);
        if (name === undefined) return toolError("environment must belong to the project (1001)");
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        /* 归属先于脚本写入（REST PATCH 同款）：FK 只证明用例存在，不证明它属于本项目。 */
        const owner = await client.query(
          "SELECT id, pre_request_hooks, response_scripts FROM test_cases WHERE id = $1 AND project_id = $2 FOR UPDATE",
          [id.value, identity.projectId],
        );
        if (!owner.rowCount) {
          await client.query("ROLLBACK");
          return toolError("case not found (2001)");
        }

        const lifecycleGiven = input.preRequestHooks !== undefined || input.responseScripts !== undefined;
        const lifecycle = lifecycleGiven ? await persistCaseLifecycleScripts(client, identity.projectId, id.value, {
          hooks: input.preRequestHooks ?? ((owner.rows[0].pre_request_hooks ?? []) as HookConfig[]),
          responseScripts: input.responseScripts ?? ((owner.rows[0].response_scripts ?? []) as ResponseScriptConfig[]),
        }, identity.createdBy ?? null) : undefined;

        const result = await client.query(
          `UPDATE test_cases SET
             name = COALESCE($1, name),
             description = COALESCE($2, description),
             environment_id = CASE WHEN $3 THEN $4 ELSE environment_id END,
             environment_name = CASE WHEN $3 THEN $5 ELSE environment_name END,
             request_snapshot = COALESCE($6::jsonb, request_snapshot),
             assertions = COALESCE($7::jsonb, assertions),
             pre_request_hooks = COALESCE($8::jsonb, pre_request_hooks),
             extracts = COALESCE($9::jsonb, extracts),
             response_scripts = COALESCE($10::jsonb, response_scripts),
             tags = COALESCE($11, tags),
             updated_by = $14,
             updated_at = now()
           WHERE id = $12 AND project_id = $13 RETURNING *`,
          [
            input.name?.trim() ?? null,
            input.description?.trim() ?? null,
            environmentGiven, input.environmentId ?? null, name ?? null,
            input.request ? JSON.stringify(toSnapshot(input.request)) : null,
            input.assertions ? JSON.stringify(input.assertions) : null,
            lifecycle ? JSON.stringify(lifecycle.hooks) : null,
            input.extracts ? JSON.stringify(input.extracts) : null,
            lifecycle ? JSON.stringify(lifecycle.responseScripts) : null,
            input.tags ?? null,
            id.value, identity.projectId,
            identity.createdBy ?? null,
          ],
        );
        await client.query("COMMIT");
        auditWrite("update_case", identity, id.value, {});
        auditResource(AUDIT_ACTIONS.testCaseUpdate, "test_case", identity, id.value, input);
        return toolResult(mapTestCase(result.rows[0]));
      } catch (error) {
        await client.query("ROLLBACK");
        return toolError(error instanceof Error ? `${error.message} (1001)` : "case could not be saved (1001)");
      } finally {
        client.release();
      }
    },
  },
  {
    name: "upsert_flow",
    description: "Create a flow or overwrite one by name (idempotency key is (project, name)). The DAG is validated before anything is written: topology runs the same plan the canvas uses, so cycles, orphan nodes and cross-flow recursion are rejected before the row lands. Node types: request / database / script / condition / wait / subflow / loop. Request-node snapshots are copies — later endpoint edits never change a stored flow. Literal credentials in any request node are rejected; reference {{name}}.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        environmentId: { type: ["string", "null"] },
        nodes: { type: "array", description: "flow nodes; request nodes carry a full request snapshot" },
        edges: { type: "array", description: "connections; only condition-node edges carry on: true/false" },
        variables: { type: "object", additionalProperties: { type: "string" }, description: "seed variables" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name", "nodes"],
    },
    handler: async (args, identity) => {
      const name = stringArg(args, "name");
      if (!name) return toolError("name is required (1001)");
      const input = args as unknown as {
        description?: string; environmentId?: string | null; nodes?: Parameters<typeof toFlowNode>[0][];
        edges?: unknown[]; variables?: Record<string, string>; tags?: string[];
      };
      /* 种子变量的形状校验（REST `flows.ts` 的 validate 同款）：键非空、值必须是字符串。 */
      if (input.variables !== undefined) {
        if (typeof input.variables !== "object" || input.variables === null || Array.isArray(input.variables)) {
          return toolError("variables must be an object (1001)");
        }
        for (const [key, value] of Object.entries(input.variables)) {
          if (!key.trim()) return toolError("a variable name cannot be empty (1001)");
          if (typeof value !== "string") return toolError(`variable "${key}" must be a string (1001)`);
        }
      }

      /* REST 保存同款校验链：图校验 → 环境归属 → 资源归属 → 跨流程环。写库前跑一遍
         plan（9.4 表格的 upsert_flow 行），环/孤儿节点在这里就被拒。 */
      const nodes = (input.nodes ?? []).map(toFlowNode);
      const graphInvalid = validateFlowGraph(nodes, input.edges ?? []);
      if (graphInvalid) return toolError(`${graphInvalid} (1001)`);
      const envName = await environmentName(identity.projectId, input.environmentId);
      if (envName === undefined) return toolError("environment must belong to the project (1001)");
      const owned = await resourcesBelong(identity.projectId, nodes);
      if (owned) return toolError(`${owned} (1001)`);

      /* 幂等键 `(project, name)`：同名即覆盖（upsert 语义——流程是整图替换的资产，
         「建一个新的还是改旧的」对模型来说是同一个意图）。判重在环检测之前，因为更新
         分支的引用链要以真实 flowId 为根。 */
      const existing = await pool.query("SELECT id FROM flows WHERE project_id = $1 AND name = $2 LIMIT 1", [identity.projectId, name]);
      const flowId = existing.rowCount ? String(existing.rows[0].id) : randomUUID();
      const created = !existing.rowCount;

      /* 跨流程环检测（REST 同款）：更新分支把本流程作为根放进引用链——子流程指回
         自己必须在这里被拒；新建分支链为空（新流程还没进库，没人能引用它）。 */
      const recursive = await checkFlowReferences(
        identity.projectId, nodes,
        created ? [] : [{ id: flowId, name }],
      );
      if (recursive) return toolError(`${recursive} (1001)`);

      /* 每个请求节点的快照都要过 secret 拒绝——流程一次携带 N 个请求，漏一个就等于
         把凭据写进 flows.nodes 的 JSONB 里（存库后才会被脱敏，而它压根不该进来）。 */
      for (const node of nodes) {
        if (node.type !== "request") continue;
        const leaked = rejectLiteralSecretsInSnapshot(node.request);
        if (leaked) return toolError(`node "${node.name}": ${leaked}`);
        /* 与 validateEndpoint 同款：json 请求体必须是对象，字符串（Java toString 之类）
           会在 JSON.stringify 时双重编码进 flows.nodes 的 JSONB——显式拒绝。 */
        if (node.request.bodyType === "json" && node.request.body !== undefined && node.request.body !== null && typeof node.request.body !== "object") {
          return toolError(`node "${node.name}": body must be an object when bodyType is json (1001)`);
        }
      }

      const insert = async (client: PoolClient) => {
        if (created) {
          await client.query(
            `INSERT INTO flows (id, project_id, name, description, environment_id, environment_name, nodes, edges, variables, tags, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7::jsonb, $8::jsonb, $9, $10)`,
            [
              flowId, identity.projectId, name, input.description?.trim() ?? "",
              input.environmentId ?? null, envName,
              JSON.stringify(input.edges ?? []), JSON.stringify(input.variables ?? {}), input.tags ?? [],
              identity.createdBy ?? null,
            ],
          );
          return;
        }
        await client.query(
          `UPDATE flows SET
             description = COALESCE($3, description),
             environment_id = CASE WHEN $4 THEN $5 ELSE environment_id END,
             environment_name = CASE WHEN $4 THEN $6 ELSE environment_name END,
             edges = COALESCE($7::jsonb, edges),
             variables = COALESCE($8::jsonb, variables),
             tags = COALESCE($9, tags),
             updated_by = $10,
             updated_at = now()
           WHERE id = $1 AND project_id = $2`,
          [
            flowId, identity.projectId,
            input.description?.trim() ?? null,
            Object.prototype.hasOwnProperty.call(input, "environmentId"), input.environmentId ?? null, envName,
            input.edges ? JSON.stringify(input.edges) : null,
            input.variables ? JSON.stringify(input.variables) : null,
            input.tags ?? null,
            identity.createdBy ?? null,
          ],
        );
      };

      const row = await persistFlow(identity.projectId, flowId, insert, nodes, identity.createdBy ?? null);
      auditWrite("upsert_flow", identity, flowId, { outcome: created ? "created" : "updated", nodeCount: nodes.length });
      auditResource(created ? AUDIT_ACTIONS.flowCreate : AUDIT_ACTIONS.flowUpdate, "flow", identity, flowId, input);
      return toolResult({ flow: mapFlow(row), outcome: created ? "created" : "updated" });
    },
  },
  {
    name: "upsert_environment",
    description: "Create an environment or replace its PLAIN variables, by name (idempotency key is (project, name), matched case-insensitively). `variables` replaces the whole plain-variable map when present — read list_environments first and write the merged map to keep keys you did not mean to drop. NEVER touches secrets: there is no secrets parameter, and credential-looking variable names (token/secret/password/apiKey/…) are rejected — sensitive values are entered by humans in the UI and referenced as {{name}}. runnerLabel and defaultHeaders stay UI-only. Deleting an environment is delete_environment; secrets and the project default environment remain UI-only.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "environment name; matched case-insensitively for the upsert" },
        variables: { type: "object", additionalProperties: { type: "string" }, description: "the full plain-variable map (e.g. {\"baseUrl\": \"https://api.example.com\"}); absent keeps the existing map" },
      },
      required: ["name"],
    },
    handler: async (args, identity) => {
      const name = stringArg(args, "name")?.trim();
      if (!name) return toolError("name is required (1001)");
      /* secrets 没有参数位：出现在入参里就指名拒绝，而不是静默忽略——静默忽略会让
         调用方以为录进去了。 */
      if ("secrets" in args) return toolError("secrets cannot be managed by tools; enter them in the platform UI (1001)");

      /* 与 REST `cleanVariables` 同一套归一：trim 键、丢空键；值在工具面上拒绝非字符串
         （JSON Schema 已声明 string，这里是兜底并给出可读错误）。 */
      let variables: Record<string, string> | undefined;
      if (args.variables !== undefined) {
        if (typeof args.variables !== "object" || args.variables === null || Array.isArray(args.variables)) {
          return toolError("variables must be an object (1001)");
        }
        variables = {};
        for (const [rawKey, value] of Object.entries(args.variables)) {
          const key = rawKey.trim();
          if (!key) continue;
          if (typeof value !== "string") return toolError(`variable "${key}" must be a string (1001)`);
          variables[key] = value;
        }
        const leaked = rejectCredentialNamedVariables(variables);
        if (leaked) return toolError(leaked);
      }

      /* 幂等键 `(project, name)`，大小写不敏感——REST 建重的判据就是 lower(name)，
         这里同一个口径，否则「Stg」与「stg」会拆成两个环境。 */
      const existing = await pool.query(
        "SELECT id FROM environments WHERE project_id = $1 AND lower(name) = lower($2) LIMIT 1",
        [identity.projectId, name],
      );
      const created = !existing.rowCount;
      const environmentId = created ? randomUUID() : String(existing.rows[0].id);

      /* runner_label / default_headers 用列默认值（'default' / '{}'）：分区与默认头是
         部署层配置，人在 UI 里定；新建环境只需要名字与普通变量。 */
      const result = created
        ? await pool.query(
            `INSERT INTO environments (id, project_id, name, variables, secrets, runner_label, default_headers, created_by)
             VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, $5, '{}'::jsonb, $6) RETURNING *`,
            [environmentId, identity.projectId, name, JSON.stringify(variables ?? {}), DEFAULT_RUNNER_LABEL, identity.createdBy ?? null],
          )
        : await pool.query(
            /* updated_at 写不得（environments 表没有这一列——迁移 001/027/030 都没加，
               ㉙：UPDATE 分支一执行就 500）。变量替换语义本身不依赖时间戳。
               P11-1 补的 `updated_by` 是个例外：它是列，不是时间戳，写它不会 500，
               也正好补上这张表原本完全没有的「谁改过」。 */
            `UPDATE environments SET variables = COALESCE($2::jsonb, variables), updated_by = $4
              WHERE id = $1 AND project_id = $3 RETURNING *`,
            [environmentId, variables ? JSON.stringify(variables) : null, identity.projectId, identity.createdBy ?? null],
          );
      auditWrite("upsert_environment", identity, environmentId, { outcome: created ? "created" : "updated" });
      auditResource(created ? AUDIT_ACTIONS.environmentCreate : AUDIT_ACTIONS.environmentUpdate, "environment", identity, environmentId, args);
      return toolResult({ environment: mapEnvironment(result.rows[0]), outcome: created ? "created" : "updated" });
    },
  },
];
