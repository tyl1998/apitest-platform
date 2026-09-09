import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { mapTestPlan, mapTestPlanItem } from "../models/types.js";

/**
 * 测试计划（P7-7，计划 11.0 边界 12~14）：一批文本用例的一次手工执行记录。
 * 计划项加进计划时冻结 title / module_path 快照——计划是历史，用例后来改名/移动
 * 旧计划仍读得通（spec_case_id CASCADE 只在用例被删时消散一项）。
 *
 * 结果五态：passed / failed / blocked / skipped 是 `result` 字段的四个值，NULL =
 * 未执行。通过率 = passed/total（2026-09-09 第三轮反馈改口径——分母是全部计划项，
 * 未执行也算未通过；此前 passed/(passed+failed) 已废弃）；进度 = 已标记 / 总数。
 * （自动化参考列 2026-09-09 整列删除——用户不需要这一读数，读时关联的 LATERAL
 * 一并移除。）
 */

const PLAN_STATUSES = ["open", "closed"];
const ITEM_RESULTS = ["passed", "failed", "blocked", "skipped"];
/* 批量加项 / 批量条「加入计划」的单次上限：与 spec-cases 批量动作同款（勾选集
   跨模块收集合法超过 100，500 是勾选集的现实上界）。 */
const MAX_ITEM_IDS = 500;

type PlanBody = {
  name?: string;
  description?: string;
  status?: string;
  owner?: string | null;
  startedOn?: string | null;
  dueOn?: string | null;
};

type PlanItemBody = {
  specCaseIds?: string[];
  assignee?: string | null;
  result?: string | null;
  note?: string;
  defectUrl?: string | null;
};

/**
 * 计划行 + 项计数汇总：五个计数出自同一个分组子查询挂在父行上（dashboard 同款
 * 纪律——兄弟表互 JOIN 会翻行数）；owner 名一次 LEFT JOIN 带出（member.granted_by
 * 同款）。汇总以 'p|f|b|s|total' 拼串出列，splitSummary 拆回——五列 COALESCE 要
 * 写五遍，拼串一遍带出（LINK_READ_SQL 的 'status|at|runId' 同一手法）。
 */
const PLAN_SUMMARY_SELECT = `
  SELECT p.*, COALESCE(u.name, '') AS owner_name, COALESCE(s.summary, '0|0|0|0|0') AS summary_raw
    FROM test_plans p
    LEFT JOIN users u ON u.id = p.owner
    LEFT JOIN (
      SELECT plan_id,
        COUNT(*) FILTER (WHERE result = 'passed')::int || '|' ||
        COUNT(*) FILTER (WHERE result = 'failed')::int || '|' ||
        COUNT(*) FILTER (WHERE result = 'blocked')::int || '|' ||
        COUNT(*) FILTER (WHERE result = 'skipped')::int || '|' ||
        COUNT(*)::int AS summary
      FROM test_plan_items GROUP BY plan_id
    ) s ON s.plan_id = p.id`;

/** 'p|f|b|s|total' 拼串拆回五个数（无 items 的计划由 COALESCE 兜底串解析）。 */
function splitSummary(raw: unknown) {
  const [passed, failed, blocked, skipped, total] = String(raw).split("|").map(Number);
  return { passed, failed, blocked, skipped, total };
}

/** 一行计划 + 拆好的汇总 → mapTestPlan 的入参（列表 / 详情 / 建后回填共用）。 */
function mapPlanRow(row: Record<string, unknown>) {
  return mapTestPlan({ ...row, ...splitSummary(row.summary_raw) });
}

/**
 * date 入参（startedOn / dueOn）：YYYY-MM-DD 之外的值给 400 干净话术——Postgres
 * DATE cast 会把 '2026-13-01' 直接抛错，别让校验错误变成 500。
 */
function isValidDate(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** 用户引用（owner / assignee）存在且 active——「指派一个已停用账号」没有语义。 */
async function loadActiveUser(userId: string) {
  const result = await pool.query("SELECT id FROM users WHERE id = $1 AND status = 'active'", [userId]);
  return result.rowCount ? String(result.rows[0].id) : null;
}

export async function testPlanRoutes(app: FastifyInstance) {
  /**
   * 列表（viewer 可读）：名称 keyword + status / owner 筛选 + 服务端分页；进度
   * 汇总一条 SQL 出全（通过率 / 进度由前端按同一口径展示，不做第二次查询）。
   */
  app.get<{ Params: { id: string }; Querystring: { keyword?: string; status?: string; owner?: string; page?: string; pageSize?: string } }>("/api/v1/projects/:id/test-plans", async (request, reply) => {
    const context = await requireProjectAccess(request, reply);
    if (!context) return;
    const page = Math.max(1, Number(request.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
    const params: unknown[] = [context.project.id]; const clauses = ["p.project_id = $1"];
    const keyword = request.query.keyword?.trim();
    if (keyword) { params.push(`%${keyword}%`); clauses.push(`p.name ILIKE $${params.length}`); }
    if (request.query.status) {
      if (!PLAN_STATUSES.includes(request.query.status)) return fail(reply, 400, 1001, `status must be one of ${PLAN_STATUSES.join(", ")}`);
      params.push(request.query.status); clauses.push(`p.status = $${params.length}`);
    }
    /* owner 是 uuid 筛选值：先验后查（规则 5）——坏值打到 uuid cast 会炸整条查询。 */
    if (request.query.owner) {
      if (!isUuid(request.query.owner)) return fail(reply, 400, 1001, "owner must be a UUID");
      params.push(request.query.owner); clauses.push(`p.owner = $${params.length}`);
    }
    const where = clauses.join(" AND ");
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM test_plans p WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(
      `${PLAN_SUMMARY_SELECT}
       WHERE ${where}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return success(result.rows.map(mapPlanRow), { page, pageSize, total: Number(count.rows[0].total) });
  });

  /**
   * 建（写权限）。可带初始 specCaseIds（批量条「加入计划」的「新建计划」分支与
   * 列表页建计划走同一接口）。owner 缺省当前用户；给定 owner 必须是本项目能找到
   * 的 active 用户（不做成员资格校验——执行人未必是项目成员，跨项目借人是真实
   * 场景，项目访问由标结果的人自己的账号权限把关）。
   */
  app.post<{ Params: { id: string }; Body: PlanBody & { specCaseIds?: string[] } }>("/api/v1/projects/:id/test-plans", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    const input = request.body ?? {};
    const name = input.name?.trim();
    if (!name) return fail(reply, 400, 1001, "plan name is required");
    if (input.description !== undefined && typeof input.description !== "string") return fail(reply, 400, 1001, "description must be a string");
    if (input.status !== undefined && !PLAN_STATUSES.includes(input.status)) return fail(reply, 400, 1001, `status must be one of ${PLAN_STATUSES.join(", ")}`);
    let owner: string = context.user.id;
    if (typeof input.owner === "string") {
      const found = await loadActiveUser(input.owner);
      if (!found) return fail(reply, 400, 1001, "owner must be an active user");
      owner = found;
    } else if (input.owner === null) {
      /* 计划没有 owner 就没人接——「不指派」没有语义（与 item 的 assignee 不同）。 */
      return fail(reply, 400, 1001, "owner is required");
    }
    for (const key of ["startedOn", "dueOn"] as const) {
      const value = input[key];
      if (value === undefined || value === null) continue;
      if (!isValidDate(value)) return fail(reply, 400, 1001, `${key} must be YYYY-MM-DD`);
    }

    const specCaseIds = [...new Set(input.specCaseIds ?? [])];
    if (specCaseIds.length > MAX_ITEM_IDS || specCaseIds.some((caseId) => !isUuid(caseId))) {
      return fail(reply, 400, 1001, `specCaseIds must contain at most ${MAX_ITEM_IDS} UUIDs`);
    }

    const planId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const plan = await client.query(
        `INSERT INTO test_plans (id, project_id, name, description, status, owner, started_on, due_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date) RETURNING *`,
        [planId, context.project.id, name, input.description?.trim() ?? "", input.status ?? "open", owner, input.startedOn ?? null, input.dueOn ?? null],
      );
      if (specCaseIds.length) {
        /* 归属预检（批量条同款纪律）：部分命中说明勾选集已过期，拒绝而不是建半份
           计划——用户看到的是一次失败，不是一份缺项的计划。 */
        const owned = await client.query("SELECT id FROM spec_cases WHERE project_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE", [context.project.id, specCaseIds]);
        if (owned.rowCount !== specCaseIds.length) {
          await client.query("ROLLBACK");
          return fail(reply, 400, 1001, "all cases must belong to the project");
        }
        /* 批插的 id 不能预生成（行数由 SQL 决定）；gen_random_uuid() 是 PG13+
           内置（迁移 011 已在用），不引 pgcrypto 扩展依赖。 */
        await client.query(
          `INSERT INTO test_plan_items (id, plan_id, spec_case_id, title_snapshot, module_path_snapshot)
           SELECT gen_random_uuid(), $1, c.id, c.title, m.path
             FROM spec_cases c JOIN spec_modules m ON m.id = c.module_id
            WHERE c.project_id = $2 AND c.id = ANY($3::uuid[])`,
          [planId, context.project.id, specCaseIds],
        );
      }
      await client.query("COMMIT");
      /* 建后回填与列表同一形状（owner_name 由本次 INSERT 的 owner 现查一次带出，
         汇总零值直给——刚建的计划全部未执行）。 */
      const ownerName = await pool.query("SELECT name FROM users WHERE id = $1", [owner]);
      return reply.code(201).send(success(mapPlanRow({
        ...plan.rows[0],
        owner_name: ownerName.rowCount ? String(ownerName.rows[0].name) : "",
        summary_raw: "0|0|0|0|0",
      })));
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, 400, 1001, error instanceof Error ? error.message : "plan could not be created");
    } finally {
      client.release();
    }
  });

  /**
   * 详情（viewer 可读）：计划头 + 全部计划项（不分页——通读「哪些没跑」不该
   * 翻页，套件成员明细同一纪律）。自动化参考列 2026-09-09 第二轮反馈整列删除
   * （读时关联的 LATERAL 连同 mapTestPlanItem 的 automation 字段一并移除——
   * 它也是当天两个缺陷的宿主：括号错位的 500 与 String(null) 的键名显示）。
   */
  app.get<{ Params: { id: string; planId: string } }>("/api/v1/projects/:id/test-plans/:planId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply);
    if (!context) return;
    if (!isUuid(request.params.planId)) return fail(reply, 404, 2001, "test plan not found");
    const plan = await pool.query(
      `${PLAN_SUMMARY_SELECT} WHERE p.id = $2 AND p.project_id = $1`,
      [context.project.id, request.params.planId],
    );
    if (!plan.rowCount) return fail(reply, 404, 2001, "test plan not found");

    /* 项行：assignee 名 / item_key / 用例现状态一次 JOIN 带出（key 与现状态是
       活数据不是快照——用例删了两者缺席，前端读「已删除」而不是报错）。排序：
       module_path 字典序（深度优先）→ 标题快照；表没有 created_at 列（迁移 052
       只定义了 executed_at），同 (plan, case) 有 UNIQUE 不存在并列行，两键已
       确定全序——不加第三序键。项目归属由上面 plan 行的查询把过关，这里只按
       plan_id 取项（参数只传一个：没被 SQL 引用的参数 Postgres 定不了类型——
       42P18「could not determine data type of parameter」，本轮验收踩中）。 */
    const items = await pool.query(
      `SELECT i.*, COALESCE(a.name, '') AS assignee_name, c.item_key, c.status AS spec_case_status
         FROM test_plan_items i
         LEFT JOIN users a ON a.id = i.assignee
         LEFT JOIN spec_cases c ON c.id = i.spec_case_id
        WHERE i.plan_id = $1
        ORDER BY i.module_path_snapshot, i.title_snapshot`,
      [request.params.planId],
    );

    return success({
      ...mapPlanRow(plan.rows[0]),
      items: items.rows.map((row: Record<string, unknown>) => mapTestPlanItem(row)),
    });
  });

  /**
   * CSV 导出（viewer 可导——纯读语义，P7-5 用例导出同款）：UTF-8 BOM 前缀
   * （Excel 双击直开中文不乱码，验收 12）；以快照列为主，item_key / assignee 名
   * LEFT JOIN 补列（用例已删时缺席、留空——快照纪律是「读得通」不是「补全」）。
   * 裸二进制流 + attachment（与日志/模板下载同款 envelope 例外）。
   */
  app.get<{ Params: { id: string; planId: string } }>("/api/v1/projects/:id/test-plans/:planId/export", async (request, reply) => {
    const context = await requireProjectAccess(request, reply);
    if (!context) return;
    if (!isUuid(request.params.planId)) return fail(reply, 404, 2001, "test plan not found");
    const plan = await pool.query(`${PLAN_SUMMARY_SELECT} WHERE p.id = $2 AND p.project_id = $1`, [context.project.id, request.params.planId]);
    if (!plan.rowCount) return fail(reply, 404, 2001, "test plan not found");
    const items = await pool.query(
      `SELECT i.*, COALESCE(a.name, '') AS assignee_name, c.item_key
         FROM test_plan_items i
         LEFT JOIN users a ON a.id = i.assignee
         LEFT JOIN spec_cases c ON c.id = i.spec_case_id
        WHERE i.plan_id = $1
        ORDER BY i.module_path_snapshot, i.title_snapshot`,
      [request.params.planId],
    );
    /* 引号/逗号/换行标准转义（RFC 4180）；结果列出原始词汇（passed/failed/…），
       本地化留给打开文件的人——CSV 是给 Excel 与脚本消费的机器格式。 */
    const csvEscape = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const lines = [
      "module_path,item_key,title,assignee,result,note,defect_url,executed_at",
      ...items.rows.map((row: Record<string, unknown>) => [
        String(row.module_path_snapshot ?? ""),
        row.item_key ? String(row.item_key) : "",
        String(row.title_snapshot ?? ""),
        String(row.assignee_name ?? ""),
        row.result === null || row.result === undefined ? "" : String(row.result),
        String(row.note ?? ""),
        String(row.defect_url ?? ""),
        row.executed_at ? new Date(String(row.executed_at)).toISOString() : "",
      ].map(csvEscape).join(",")),
    ];
    const buffer = Buffer.from(`\ufeff${lines.join("\r\n")}\r\n`, "utf8");
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="test-plan.csv"');
    return reply.send(buffer);
  });

  /**
   * 改（写权限）：name / description / status / owner / startedOn / dueOn 局部更新
   * （缺省键不动；date 键显式 null = 清空）。closed 只是标签不锁项编辑——标结果
   * 是执行动作，关计划后补一笔备注是真实场景，不发明 UI 拦不住的约束。
   */
  app.patch<{ Params: { id: string; planId: string }; Body: PlanBody }>("/api/v1/projects/:id/test-plans/:planId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.planId)) return fail(reply, 404, 2001, "test plan not found");
    const input = request.body ?? {};
    if (input.name !== undefined && !input.name.trim()) return fail(reply, 400, 1001, "plan name is required");
    if (input.description !== undefined && typeof input.description !== "string") return fail(reply, 400, 1001, "description must be a string");
    if (input.status !== undefined && !PLAN_STATUSES.includes(input.status)) return fail(reply, 400, 1001, `status must be one of ${PLAN_STATUSES.join(", ")}`);
    if (input.owner !== undefined && input.owner !== null) {
      if (!isUuid(input.owner)) return fail(reply, 400, 1001, "owner must be a UUID");
      if (!(await loadActiveUser(input.owner))) return fail(reply, 400, 1001, "owner must be an active user");
    }
    for (const key of ["startedOn", "dueOn"] as const) {
      const value = input[key];
      if (value === undefined || value === null) continue;
      if (!isValidDate(value)) return fail(reply, 400, 1001, `${key} must be YYYY-MM-DD`);
    }

    const result = await pool.query(
      `UPDATE test_plans SET
          name = COALESCE($3, name),
          description = COALESCE($4, description),
          status = COALESCE($5, status),
          /* owner / date 是三态（缺省不动 / null 清空 / 值写入），COALESCE 表达不了
             「显式 null」——CASE 认领（specModules 的 parentId 三态同款）。 */
          owner = CASE WHEN $6 THEN $7::uuid ELSE owner END,
          started_on = CASE WHEN $8 THEN $9::date ELSE started_on END,
          due_on = CASE WHEN $10 THEN $11::date ELSE due_on END,
          updated_at = now()
        WHERE id = $1 AND project_id = $2
        RETURNING *`,
      [
        request.params.planId, context.project.id,
        input.name !== undefined ? input.name.trim() : null,
        input.description !== undefined ? input.description.trim() : null,
        input.status ?? null,
        input.owner !== undefined, input.owner ?? null,
        input.startedOn !== undefined, input.startedOn ?? null,
        input.dueOn !== undefined, input.dueOn ?? null,
      ],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "test plan not found");
    /* 汇总不在 RETURNING 里（UPDATE 不动 items）；owner 名现查一次补上，前端
       就地更新不重拉。 */
    let ownerName = "";
    if (result.rows[0].owner) {
      const found = await pool.query("SELECT name FROM users WHERE id = $1", [result.rows[0].owner]);
      ownerName = found.rowCount ? String(found.rows[0].name) : "";
    }
    return success(mapTestPlan({ ...result.rows[0], owner_name: ownerName }));
  });

  /**
   * 删（写权限）：项 CASCADE 随计划消散（本表自己的语义，不存在别的表引用计划）；
   * 无 409/force——确认框文案在前端如实说明「已标记的结果一并删除」。
   */
  app.delete<{ Params: { id: string; planId: string } }>("/api/v1/projects/:id/test-plans/:planId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.planId)) return fail(reply, 404, 2001, "test plan not found");
    const result = await pool.query("DELETE FROM test_plans WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.planId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "test plan not found");
    return success({ id: result.rows[0].id });
  });

  /**
   * 加项（写权限）：specCaseIds 一批（批量条「加入计划」的既有计划分支）。归属
   * 预检（部分命中 400 整批拒绝）；**同计划重复项 ON CONFLICT DO NOTHING 跳过、
   * 其余照常插入**——「把 20 条加进计划、其中 3 条已经在里面」的正确读法是
   * 17 条进去、3 条没重复计，一次 409 拒掉整批会把正常操作变成错误。返回插入数
   * 让前端如实汇报。
   */
  app.post<{ Params: { id: string; planId: string }; Body: PlanItemBody }>("/api/v1/projects/:id/test-plans/:planId/items", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.planId)) return fail(reply, 404, 2001, "test plan not found");
    const plan = await pool.query("SELECT id FROM test_plans WHERE id = $1 AND project_id = $2", [request.params.planId, context.project.id]);
    if (!plan.rowCount) return fail(reply, 404, 2001, "test plan not found");
    const specCaseIds = [...new Set(request.body?.specCaseIds ?? [])];
    if (!specCaseIds.length) return fail(reply, 400, 1001, "specCaseIds must not be empty");
    if (specCaseIds.length > MAX_ITEM_IDS || specCaseIds.some((caseId) => !isUuid(caseId))) {
      return fail(reply, 400, 1001, `specCaseIds must contain at most ${MAX_ITEM_IDS} UUIDs`);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const owned = await client.query("SELECT id FROM spec_cases WHERE project_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE", [context.project.id, specCaseIds]);
      if (owned.rowCount !== specCaseIds.length) {
        await client.query("ROLLBACK");
        return fail(reply, 400, 1001, "all cases must belong to the project");
      }
      const inserted = await client.query(
        `INSERT INTO test_plan_items (id, plan_id, spec_case_id, title_snapshot, module_path_snapshot)
         SELECT gen_random_uuid(), $1, c.id, c.title, m.path
           FROM spec_cases c JOIN spec_modules m ON m.id = c.module_id
          WHERE c.project_id = $2 AND c.id = ANY($3::uuid[])
          ON CONFLICT (plan_id, spec_case_id) DO NOTHING
         RETURNING id`,
        [request.params.planId, context.project.id, specCaseIds],
      );
      await client.query("COMMIT");
      return reply.code(201).send(success({ inserted: inserted.rowCount ?? 0 }));
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, 400, 1001, error instanceof Error ? error.message : "items could not be added");
    } finally {
      client.release();
    }
  });

  /**
   * 标结果 / 指派 / 备注 / 缺陷链接（写权限——执行人是 developer 及以上，viewer
   * 不该标）。result 四值 + null（清回未执行）；**标结果写 executed_at，清结果
   * 一并清 executed_at**——不留「未执行但有执行时间」的脏态。note/defectUrl 是
   * 字符串（空串清空语义由 NULLIF 兜），assignee null = 取消指派。
   */
  app.patch<{ Params: { id: string; planId: string; itemId: string }; Body: Omit<PlanItemBody, "specCaseIds"> }>("/api/v1/projects/:id/test-plans/:planId/items/:itemId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.planId) || !isUuid(request.params.itemId)) return fail(reply, 404, 2001, "plan item not found");
    const input = request.body ?? {};
    if (input.result !== undefined && input.result !== null && !ITEM_RESULTS.includes(input.result)) {
      return fail(reply, 400, 1001, `result must be one of ${ITEM_RESULTS.join(", ")}`);
    }
    if (input.note !== undefined && typeof input.note !== "string") return fail(reply, 400, 1001, "note must be a string");
    if (input.defectUrl !== undefined && typeof input.defectUrl !== "string") return fail(reply, 400, 1001, "defectUrl must be a string");
    if (input.assignee !== undefined && input.assignee !== null) {
      if (!isUuid(input.assignee)) return fail(reply, 400, 1001, "assignee must be a UUID");
      if (!(await loadActiveUser(input.assignee))) return fail(reply, 400, 1001, "assignee must be an active user");
    }

    /* executed_at 的写清与 result 绑死：给了非空 result = now()；显式 null =
       清结果 → 清执行时间；没带 result 的请求不动它。 */
    const result = await pool.query(
      `UPDATE test_plan_items i SET
          assignee = CASE WHEN $3 THEN $4::uuid ELSE assignee END,
          result = CASE WHEN $5 THEN $6 ELSE result END,
          note = COALESCE($7, note),
          defect_url = CASE WHEN $8 THEN NULLIF($9, '') ELSE defect_url END,
          executed_at = CASE
            WHEN $6 IS NOT NULL THEN now()
            WHEN $5 AND $6 IS NULL THEN NULL
            ELSE executed_at END
        FROM test_plans p
        WHERE i.plan_id = p.id AND i.id = $1 AND p.id = $2 AND p.project_id = $10
        RETURNING i.*`,
      [
        request.params.itemId, request.params.planId,
        input.assignee !== undefined, input.assignee ?? null,
        input.result !== undefined, input.result ?? null,
        input.note !== undefined ? input.note : null,
        input.defectUrl !== undefined, input.defectUrl ?? "",
        context.project.id,
      ],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "plan item not found");
    return success(mapTestPlanItem(result.rows[0]));
  });

  /**
   * 删项（写权限）：从计划里移除一项（用例本身不动）。无引用扫描——计划项的
   * 全部存在意义就在这个计划里。
   */
  app.delete<{ Params: { id: string; planId: string; itemId: string } }>("/api/v1/projects/:id/test-plans/:planId/items/:itemId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true);
    if (!context) return;
    if (!isUuid(request.params.planId) || !isUuid(request.params.itemId)) return fail(reply, 404, 2001, "plan item not found");
    const result = await pool.query(
      `DELETE FROM test_plan_items i USING test_plans p
        WHERE i.id = $1 AND i.plan_id = p.id AND p.id = $2 AND p.project_id = $3 RETURNING i.id`,
      [request.params.itemId, request.params.planId, context.project.id],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "plan item not found");
    return success({ id: result.rows[0].id });
  });
}
