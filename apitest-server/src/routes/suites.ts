import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { recordAssetVersion, testSuiteSnapshot } from "../lib/assetVersions.js";
import { AUDIT_ACTIONS, auditFields, writeAuditLogAsync } from "../lib/audit.js";
import { cancelSuiteRun } from "../lib/enqueue.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import {
  concurrencyBudget, environmentBelongs, environmentSnapshot, failTrigger, loadSuite,
  resolveMembers, toExecutionConfig, triggerSuiteRun,
} from "../lib/trigger.js";
import { isUuid } from "../lib/uuid.js";
import {
  toSelectionConfig, validateSelection, validateSuite, validateSuiteNotify,
  type SelectionInput, type SuiteInput,
} from "../lib/validateSuite.js";
import {
  mapExecution, mapExecutionStep, mapSuiteExecution, mapTestSuite, normalizeSuiteNotify, normalizeSuiteSelection,
  SUITE_MAX_MEMBERS,
  type SuiteExecutionConfig,
} from "../models/types.js";

/**
 * 测试套件（P2-4）。范围与边界见 DEVELOPMENT_PLAN.md 5.0.11。
 *
 * 套件只编排**成员**：成员是接口用例或流程，各自是一次独立执行，成员之间不传变量
 * ——需要传值的链路本来就该建成一条流程（5.0.6）。所以这里没有请求定义、没有变量
 * 映射、没有前后置脚本，只有「选谁」和「怎么跑」。
 *
 * 执行入口在这里，执行本体在 `lib/suiteRun.ts`（P2-4.2）：成员在套件自己的 worker 槽内
 * 进程内扇出，不单独入队。
 */

/**
 * 列表投影（P11 归属列，边界 7/9）：`LEFT JOIN users` 带出 email 快照，基表显式
 * `su.*`——裸 `*` 会在两表同名的 id / name / created_at 上取到 users 的值。
 */
const SELECT_SUITE = `SELECT su.*, creator.email AS created_by_email, updater.email AS updated_by_email FROM test_suites su
  LEFT JOIN users creator ON creator.id = su.created_by
  LEFT JOIN users updater ON updater.id = su.updated_by`;

/**
 * 校验与归一已提取到 `lib/validateSuite.ts`（P5-5b，边界 8 的同一笔账）：MCP 的
 * create_suite / update_suite 与这些路由跑同一份校验。此处仅留路由壳。
 */

/** 最近一次运行，供套件列表显示「最近结果」（与流程列表同款）。 */
async function latestRuns(suiteIds: string[]) {
  if (!suiteIds.length) return new Map<string, ReturnType<typeof mapSuiteExecution>>();
  const result = await pool.query(
    `SELECT DISTINCT ON (suite_id) * FROM suite_executions
      WHERE suite_id = ANY($1::uuid[]) ORDER BY suite_id, created_at DESC`,
    [suiteIds],
  );
  return new Map(result.rows.map((row) => [String(row.suite_id), mapSuiteExecution(row)]));
}

/**
 * P10-6：把一次套件写（`... RETURNING *`）与它的版本快照包进一个事务（计划 14.3 边界）。
 * 无行时回滚并回 `undefined`，调用方据此回 404。
 */
async function writeSuiteWithVersion(
  context: { project: { id: string }; user: { id: string } },
  changeSummary: string,
  write: (client: PoolClient) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await write(client);
    if (!result.rowCount) { await client.query("ROLLBACK"); return undefined; }
    const suite = mapTestSuite(result.rows[0]);
    await recordAssetVersion(client, {
      projectId: context.project.id, assetType: "test_suite", assetId: suite.id,
      snapshot: testSuiteSnapshot(suite), changeSummary, createdBy: context.user.id,
    });
    await client.query("COMMIT");
    return suite;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function suiteRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; tag?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/test-suites", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    /* 服务端分页（边界 14，与执行记录同一套约定）：套件多起来后一次全表扫描 + 一屏
       读不完的表没有任何好处。keyword/tag 过滤留在 SQL 里，命中覆盖全量而不止本页。 */
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id]; const clauses = ["su.project_id = $1"];
    const keyword = request.query.keyword?.trim();
    /* Filtering in SQL so a keyword matches every suite, not just a loaded page. */
    if (keyword) { params.push(`%${keyword}%`); clauses.push(`(su.name ILIKE $${params.length} OR su.description ILIKE $${params.length})`); }
    if (request.query.tag?.trim()) { params.push(request.query.tag.trim()); clauses.push(`$${params.length} = ANY(su.tags)`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM test_suites su WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(`${SELECT_SUITE} WHERE ${where} ORDER BY su.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const suites = result.rows.map(mapTestSuite);
    const runs = await latestRuns(suites.map((suite) => suite.id));
    /* 刻意不在列表里解析 tag/all 的成员数：那要为每一行跑两条查询，而列表能显示的
       只是「标签: x, y」这类条件本身。真实成员数由 preview 给出。 */
    const data = suites.map((suite) => ({ ...suite, lastRun: runs.get(suite.id) }));
    return success(data, { page, pageSize, total: Number(count.rows[0].total) });
  });

  app.get<{ Params: { id: string; suiteId: string } }>("/api/v1/projects/:id/test-suites/:suiteId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const suite = await loadSuite(context.project.id, request.params.suiteId);
    if (!suite) return fail(reply, 404, 2001, "test suite not found");
    return success(suite);
  });

  app.post<{ Params: { id: string }; Body: SuiteInput }>("/api/v1/projects/:id/test-suites", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const invalid = validateSuite(request.body);
    if (invalid) return fail(reply, 400, 1001, invalid);
    const execution = toExecutionConfig(request.body.execution);
    if (!await environmentBelongs(context.project.id, execution.environmentId)) return fail(reply, 400, 1001, "environment must belong to the project");
    const invalidNotify = await validateSuiteNotify(context.project.id, request.body?.notify);
    if (invalidNotify) return fail(reply, 400, 1001, invalidNotify);

    const suiteId = randomUUID();
    const suite = await writeSuiteWithVersion(context, "创建", (client) => client.query(
      `INSERT INTO test_suites (id, project_id, name, description, selection_type, selection_config, execution_config, notify_config, tags, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10) RETURNING *`,
      [
        suiteId, context.project.id, request.body.name!.trim(), request.body.description?.trim() ?? "",
        request.body.selection!.type, JSON.stringify(toSelectionConfig(request.body.selection!)),
        JSON.stringify(execution), JSON.stringify(normalizeSuiteNotify(request.body?.notify ?? {})), request.body.tags ?? [],
        context.user.id,
      ],
    ));
    if (!suite) return fail(reply, 404, 2001, "test suite not found");
    /* P11-9 审计（边界 5/6）：detail 只有字段名。 */
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.testSuiteCreate, targetType: "test_suite", targetId: suite.id,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return reply.code(201).send(success(suite));
  });

  app.put<{ Params: { id: string; suiteId: string }; Body: SuiteInput }>("/api/v1/projects/:id/test-suites/:suiteId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.suiteId)) return fail(reply, 404, 2001, "test suite not found");
    const invalid = validateSuite(request.body, true);
    if (invalid) return fail(reply, 400, 1001, invalid);
    const invalidNotify = await validateSuiteNotify(context.project.id, request.body?.notify);
    if (invalidNotify) return fail(reply, 400, 1001, invalidNotify);

    /* selection 与 execution 都是整块替换而不是深合并：一个「把标签选择改成手动选择」
       的保存必须能丢掉旧的 tags，深合并会把它们留在库里，下次读出来形状对不上。
       notify 同理（P3-11）：归一后整块写，缺省键落默认值。 */
    const selection = request.body.selection ? JSON.stringify(toSelectionConfig(request.body.selection)) : null;
    let execution: string | null = null;
    if (request.body.execution) {
      const config = toExecutionConfig(request.body.execution);
      if (!await environmentBelongs(context.project.id, config.environmentId)) return fail(reply, 400, 1001, "environment must belong to the project");
      execution = JSON.stringify(config);
    }
    const notify = request.body.notify === undefined ? null : JSON.stringify(normalizeSuiteNotify(request.body.notify));
    const suite = await writeSuiteWithVersion(context, "更新", (client) => client.query(
      `UPDATE test_suites SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         selection_type = COALESCE($3, selection_type),
         selection_config = COALESCE($4::jsonb, selection_config),
         execution_config = COALESCE($5::jsonb, execution_config),
         notify_config = COALESCE($6::jsonb, notify_config),
         tags = COALESCE($7, tags),
         updated_by = $10,
         updated_at = now()
       WHERE id = $8 AND project_id = $9 RETURNING *`,
      [
        request.body.name?.trim() ?? null,
        request.body.description?.trim() ?? null,
        request.body.selection?.type ?? null, selection, execution, notify,
        request.body.tags ?? null,
        request.params.suiteId, context.project.id,
        context.user.id,
      ],
    ));
    if (!suite) return fail(reply, 404, 2001, "test suite not found");
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.testSuiteUpdate, targetType: "test_suite", targetId: request.params.suiteId,
      projectId: context.project.id, userId: context.user.id,
      detail: { fields: auditFields(request.body) }, ip: request.ip,
    });
    return success(suite);
  });

  /**
   * 删除套件保留它跑过的历史：`suite_executions.suite_id` 是 ON DELETE SET NULL，
   * `suite_name` 已快照（Spec 4.4 历史保留）。引用它的用例/流程成员在 P2-4.5 由
   * 删除方反向摘除。
   *
   * P3 起套件多了两类引用者：调度与 Webhook 触发（它们的 `target_id` 无外键——
   * 按 target_type 多态，P3-1 的决定）。悬空的调度会每拍到点就记一行 failed、悬空
   * 的 Webhook 会对外返回触发失败，所以这里与 environments 的 usage 扫描同款：
   * 先 409 给清单，`?force=true` 才连带删掉引用者。
   */
  app.delete<{ Params: { id: string; suiteId: string }; Querystring: { force?: string } }>("/api/v1/projects/:id/test-suites/:suiteId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.suiteId)) return fail(reply, 404, 2001, "test suite not found");
    const referencingSchedules = await pool.query(
      "SELECT id, name FROM schedules WHERE project_id = $1 AND target_type = 'suite' AND target_id = $2",
      [context.project.id, request.params.suiteId],
    );
    const referencingTriggers = await pool.query(
      "SELECT id, name FROM webhook_triggers WHERE project_id = $1 AND target_type = 'suite' AND target_id = $2",
      [context.project.id, request.params.suiteId],
    );
    if ((referencingSchedules.rowCount || referencingTriggers.rowCount) && request.query.force !== "true") {
      return reply.code(409).send({
        code: 2003,
        message: "test suite is referenced by schedules or webhook triggers",
        data: {
          schedules: referencingSchedules.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
          webhookTriggers: referencingTriggers.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
        },
      });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      /* 连带删除是 force 语义的一部分：留着就是每分钟报错的僵尸。报告历史不受影响
         ——execution_index.trigger_ref_* 无外键且带名字快照（边界 13）。 */
      if (request.query.force === "true") {
        await client.query("DELETE FROM schedules WHERE project_id = $1 AND target_type = 'suite' AND target_id = $2", [context.project.id, request.params.suiteId]);
        await client.query("DELETE FROM webhook_triggers WHERE project_id = $1 AND target_type = 'suite' AND target_id = $2", [context.project.id, request.params.suiteId]);
      }
      const result = await client.query("DELETE FROM test_suites WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.suiteId, context.project.id]);
      await client.query("COMMIT");
      if (!result.rowCount) return fail(reply, 404, 2001, "test suite not found");
      writeAuditLogAsync({
        action: AUDIT_ACTIONS.testSuiteDelete, targetType: "test_suite", targetId: String(result.rows[0].id),
        projectId: context.project.id, userId: context.user.id, ip: request.ip,
      });
      /* 连带删掉的引用调度 / Webhook 触发各落一行 delete：MCP 删除路径同款。 */
      for (const row of referencingSchedules.rows) {
        writeAuditLogAsync({
          action: AUDIT_ACTIONS.scheduleDelete, targetType: "schedule", targetId: String(row.id),
          projectId: context.project.id, userId: context.user.id,
          detail: { fields: [], cascadeFrom: request.params.suiteId }, ip: request.ip,
        });
      }
      for (const row of referencingTriggers.rows) {
        writeAuditLogAsync({
          action: AUDIT_ACTIONS.webhookTriggerDelete, targetType: "webhook_trigger", targetId: String(row.id),
          projectId: context.project.id, userId: context.user.id,
          detail: { fields: [], cascadeFrom: request.params.suiteId }, ip: request.ip,
        });
      }
      return success({ id: result.rows[0].id });
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally {
      client.release();
    }
  });

  /**
   * 解析「这个套件现在会跑哪些成员」。
   *
   * 标签/全部是动态选择，成员随项目里的用例和流程变化，所以配置页必须能在保存前
   * 看到真实清单——而入队时会把同一份解析冻进 `member_snapshot`，报告才可复现。
   *
   * 请求体可选：带 selection 就预览「还没保存的这份配置」，不带就预览已存的那份。
   * 前者是编辑页改一下就看一眼的用法，没有它用户只能靠保存来试。
   */
  app.post<{ Params: { id: string; suiteId: string }; Body: { selection?: SelectionInput; execution?: Partial<SuiteExecutionConfig> } }>("/api/v1/projects/:id/test-suites/:suiteId/preview", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const suite = await loadSuite(context.project.id, request.params.suiteId);
    if (!suite) return fail(reply, 404, 2001, "test suite not found");

    let selection = suite.selection;
    if (request.body?.selection) {
      const invalid = validateSelection(request.body.selection);
      if (invalid) return fail(reply, 400, 1001, invalid);
      /* 走存库时的同一条归一路径（写 → 归一 → 解析），预览才不会比保存后更宽松。 */
      selection = normalizeSuiteSelection(request.body.selection.type, toSelectionConfig(request.body.selection));
    }
    /* 并发同理可以预览「还没保存的那个值」：改并发正是为了看峰值提示怎么变。 */
    const concurrency = request.body?.execution?.concurrency === undefined ? suite.execution.concurrency : Number(request.body.execution.concurrency);

    const resolved = await resolveMembers(context.project.id, selection);
    const warnings: string[] = [];
    /* 超过上限不静默截断（与循环迭代 >100 同一原则）：这里只报，执行入队时拒绝。 */
    if (resolved.members.length > SUITE_MAX_MEMBERS) warnings.push(`resolved ${resolved.members.length} members, over the limit of ${SUITE_MAX_MEMBERS}`);
    if (resolved.missing.length) warnings.push(`${resolved.missing.length} referenced member(s) no longer exist`);
    /* 并发峰值：用调度器同一份算法（lib/suiteRun.ts `memberTokenDemand`）算出来的声明
       需求，超过池容量就明确写出来——用户看得见，才不会把一份被分批发出的报告当成
       并发结论。 */
    const budget = await concurrencyBudget(context.project.id, resolved.members, Math.max(1, concurrency));
    if (budget.over) warnings.push(`member "${budget.over.member.name}" needs ${budget.over.demand} concurrent requests at once, over the platform budget of ${budget.budget}; it cannot run`);
    else if (budget.peak > budget.budget) warnings.push(`declared concurrency adds up to ${budget.peak}, over the platform budget of ${budget.budget}; requests will go out in batches`);
    return success({
      members: resolved.members,
      total: resolved.members.length,
      missing: resolved.missing,
      memberLimit: SUITE_MAX_MEMBERS,
      /* 峰值与预算一并返回，界面才能画出「声明 X / 上限 Y」而不是只有一句文字。 */
      concurrency: { declared: Math.max(1, concurrency), peak: budget.peak, budget: budget.budget },
      warnings,
    });
  });

  /**
   * 运行一个套件。
   *
   * 请求体可选带 `execution`：这是「改了并发/环境策略但还没保存就想跑一次」的用法，与
   * 用例、流程的执行同一条规则（交互文档 3.1.3）——覆盖值会被执行并记录，但不落到套件
   * 定义上。成员清单不接受覆盖：选谁由定义说，随手指定一批成员是「批量执行」而不是
   * 「运行这个套件」。
   *
   * `variables` 是触发时的变量覆盖（P3-2，计划 6.5 泳道第二层）：冻进 run_spec、按下发给
   * 每个成员，压过环境变量。只接受字符串值、键匹配 ^[A-Za-z_][A-Za-z0-9_]*$（共享
   * 校验，调度配置 P3-6 与 Webhook 同一个入口）。触发参数里不要放密钥（边界 17）：
   * 它按明文冻进 run_spec 并出现在执行快照里。
   *
   * 校验与入队在 `lib/trigger.ts`（P3-3 边界 5）：手动、调度（P3-4）、Webhook（P3-6）
   * 共用同一条路径，错误码与 P2 完全一致（验收 6.7.1）。
   */
  app.post<{ Params: { id: string; suiteId: string }; Body: { execution?: Partial<SuiteExecutionConfig>; variables?: Record<string, string> } }>("/api/v1/projects/:id/test-suites/:suiteId/execute", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    try {
      const suiteExecutionId = await triggerSuiteRun({
        projectId: context.project.id,
        suiteId: request.params.suiteId,
        execution: request.body?.execution,
        variables: request.body?.variables,
        /* 手动触发带上人（P9-1 收件口径）：站内通知据此定点发。 */
        trigger: { source: "manual", userId: context.user.id },
      });
      /* 202: an accepted run, not a verdict. The client follows it on the stream. */
      const queued = await pool.query("SELECT * FROM suite_executions WHERE id = $1", [suiteExecutionId]);
      return reply.code(202).send(success(mapSuiteExecution(queued.rows[0])));
    } catch (error) {
      return failTrigger(reply, error, "suite could not be started");
    }
  });

  /** 一个套件跑过的运行记录（编辑页侧栏与列表页「最近结果」的分页版本）。 */
  app.get<{ Params: { id: string; suiteId: string }; Querystring: { status?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/test-suites/:suiteId/executions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.suiteId)) return fail(reply, 404, 2001, "test suite not found");
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id, request.params.suiteId]; const clauses = ["project_id = $1", "suite_id = $2"];
    if (request.query.status && request.query.status !== "all") { params.push(request.query.status); clauses.push(`status = $${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM suite_executions WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(`SELECT * FROM suite_executions WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return success(result.rows.map(mapSuiteExecution), { page, pageSize, total: Number(count.rows[0].total) });
  });

  /**
   * 一次套件执行 + 每个成员的证据行。
   *
   * `executionSteps` 是成员行（用例成员带 `httpExecutionId`，流程成员带 `childIndexId`），
   * `runs` 是用例成员那几行 `executions`——抽屉展开一个用例成员就要看响应，逐行再拉一次
   * 会让一个 50 成员的套件发 50 个请求。流程成员的内层步骤**不**在这里返回：那是一整棵
   * 子树，按需拉（`/execution-index/:childIndexId`）才不会让抽屉一开就很重。
   */
  app.get<{ Params: { id: string; executionId: string } }>("/api/v1/projects/:id/suite-executions/:executionId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.executionId)) return fail(reply, 404, 2001, "suite execution not found");
    /* 触发三列来自父索引（边界 15：报告/列表/告警三处都读 execution_index，不各自
       join schedule_runs）。运行抽屉的「谁触发的」那一行也要同一份口径。 */
    const result = await pool.query(
      `SELECT se.*, ei.trigger_source, ei.trigger_ref_id, ei.trigger_ref_name
         FROM suite_executions se
         JOIN execution_index ei ON ei.id = se.execution_index_id
        WHERE se.id = $1 AND se.project_id = $2`,
      [request.params.executionId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "suite execution not found");
    const row = result.rows[0];
    const indexId = row.execution_index_id;
    const steps = indexId
      ? await pool.query("SELECT * FROM execution_steps WHERE index_id = $1 AND parent_step_id IS NULL ORDER BY position, created_at", [indexId])
      : { rows: [] as Record<string, unknown>[] };
    const httpIds = steps.rows.map((step) => step.http_execution_id).filter(Boolean);
    const runs = httpIds.length
      ? await pool.query("SELECT * FROM executions WHERE id = ANY($1::uuid[])", [httpIds])
      : { rows: [] as Record<string, unknown>[] };
    return success({
      ...mapSuiteExecution(row),
      triggerSource: row.trigger_source ? String(row.trigger_source) : "manual",
      triggerRefId: row.trigger_ref_id ? String(row.trigger_ref_id) : undefined,
      triggerRefName: row.trigger_ref_name ? String(row.trigger_ref_name) : undefined,
      executionSteps: steps.rows.map(mapExecutionStep),
      runs: runs.rows.map(mapExecution),
    });
  });

  app.post<{ Params: { id: string; executionId: string } }>("/api/v1/projects/:id/suite-executions/:executionId/cancel", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.executionId)) return fail(reply, 404, 2001, "suite execution not found");
    const canceled = await cancelSuiteRun(context.project.id, request.params.executionId);
    /* Already terminal: reported as a conflict rather than pretending the cancel
       did something (same as cancelling a single run or a flow). */
    if (!canceled) return fail(reply, 409, 2004, "suite execution is already finished");
    const result = await pool.query("SELECT * FROM suite_executions WHERE id = $1", [request.params.executionId]);
    return success(mapSuiteExecution(result.rows[0]));
  });
}
