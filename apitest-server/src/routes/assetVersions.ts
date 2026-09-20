import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { diffSnapshots } from "../lib/assetDiff.js";
import { AssetRollbackError, recordAssetVersion, restoreAssetSnapshot } from "../lib/assetVersions.js";
import { AUDIT_ACTIONS, writeAuditLogAsync, type AuditAction } from "../lib/audit.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import { ASSET_VERSION_TABLES, mapAssetVersion, type AssetVersionType } from "../models/types.js";

/*
 * P10-5（计划 14.3 读侧，零新迁移）：资产版本的**读侧** —— 版本列表 + 改动内容 diff + 回滚。
 *
 * P10-4 已把四类资产（接口 / 接口用例 / 文本用例 / 环境）的每次保存落进 `asset_versions`
 * （写侧）。本批只读那张表，外加一条回滚写路径：
 *
 *   GET  .../versions                     版本列表（倒序，带谁在何时存的）
 *   GET  .../versions/:a/diff/:b          两版 diff（服务端算，逐字段 + 逐行）
 *   GET  .../versions/diff                默认相邻两版（最新与次新）的 diff
 *   POST .../versions/:versionNo/rollback 把该版快照写回资产 → 再产一个新版本
 *
 * 一条统一路由覆盖四类资产：`:assetType` 走枚举、`:assetId` 经 uuid 预检 + 源表归属校验
 * （`asset_id` 不是外键，见迁移 067）。刻意不给每类资产各挂一套——版本模型本就是一张表，
 * 读侧再拆四份就把「一套模型」这条决策在读侧又推翻了（迁移 067 头「为什么一张表」）。
 *
 * ★ 硬验收项：变更历史必须能看到「改成什么」，不只有时间与作者——由 `/diff` 承担（diff 在
 * 服务端算好下发）。环境 secret 只显示「键名增/删」，永不回显明文（Spec 4.6）。
 */

const ASSET_TYPES: AssetVersionType[] = [
  "endpoint", "test_case", "spec_case", "environment",
  /* P10-6 扩面：7 类用户编写型内容资产（与迁移 068 的 CHECK、ASSET_VERSION_TABLES 同步）。 */
  "mock", "script", "flow", "test_suite", "data_source", "sql_definition", "ci_task",
];

function isAssetType(value: string): value is AssetVersionType {
  return (ASSET_TYPES as string[]).includes(value);
}

/** 版本列表投影：JOIN users 带出「谁存的」email 快照（写路径只落 created_by uuid）。 */
const SELECT_VERSION = `SELECT v.*, author.email AS created_by_email FROM asset_versions v
  LEFT JOIN users author ON author.id = v.created_by`;

export async function assetVersionRoutes(app: FastifyInstance) {
  /**
   * 校验 `:assetType` 是已知枚举、`:assetId` 是本项目里该类型的真实资产。返回 `undefined`
   * 表示已回过 4xx，调用方直接 return。`asset_id` 不是外键，所以归属靠 ASSET_VERSION_TABLES
   * 回源表查一遍（表名来自代码写死的映射，不是请求值，可安全拼进 SQL）。
   */
  async function resolveAsset(
    request: { params: { id: string; assetType: string; assetId: string } },
    reply: Parameters<typeof fail>[0],
    projectId: string,
    write: boolean,
  ): Promise<AssetVersionType | undefined> {
    const { assetType, assetId } = request.params;
    if (!isAssetType(assetType)) { fail(reply, 400, 1001, "unknown asset type"); return undefined; }
    if (!isUuid(assetId)) { fail(reply, 404, 2001, "asset not found"); return undefined; }
    void write; // 归属校验与读写无关；写权限已由 requireProjectAccess 收口。
    const owned = await pool.query(`SELECT 1 FROM ${ASSET_VERSION_TABLES[assetType]} WHERE id = $1 AND project_id = $2`, [assetId, projectId]);
    if (!owned.rowCount) { fail(reply, 404, 2001, "asset not found"); return undefined; }
    return assetType;
  }

  /** 取某版本行（限定 project + type + id），带 created_by_email。 */
  async function loadVersion(projectId: string, assetType: AssetVersionType, assetId: string, versionNo: number) {
    const result = await pool.query(
      `${SELECT_VERSION} WHERE v.project_id = $1 AND v.asset_type = $2 AND v.asset_id = $3 AND v.version_no = $4`,
      [projectId, assetType, assetId, versionNo],
    );
    return result.rowCount ? result.rows[0] : undefined;
  }

  /**
   * 版本列表（viewer 可读）：倒序（最新在前），带「谁在何时存的」。
   *
   * 不分页：每资产版本数由保留策略封顶（ASSET_VERSION_RETENTION，默认 50），一次全给
   * 足够，前端选两版做 diff 也需要看到全序列。snapshot 一并下发——列表项点开即读某版内容，
   * 不再为详情多一次往返（单资产 ≤ 50 版 × 内容子集，量可忽略）。
   */
  app.get<{ Params: { id: string; assetType: string; assetId: string } }>("/api/v1/projects/:id/assets/:assetType/:assetId/versions", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const assetType = await resolveAsset(request, reply, context.project.id, false); if (!assetType) return;
    const result = await pool.query(
      `${SELECT_VERSION} WHERE v.project_id = $1 AND v.asset_type = $2 AND v.asset_id = $3 ORDER BY v.version_no DESC`,
      [context.project.id, assetType, request.params.assetId],
    );
    return success(result.rows.map(mapAssetVersion), { total: result.rowCount ?? 0 });
  });

  /**
   * 默认相邻两版 diff（最新与次新）——列表首屏「最近一次改了什么」的落点。
   *
   * 不足两版（只建过一次、没改过）时 `fields` 空、`identical` 为 true，前端显示「暂无改动
   * 可对比」，而不是 404。带上两侧版本号让前端标清对比的是哪两版。
   */
  app.get<{ Params: { id: string; assetType: string; assetId: string } }>("/api/v1/projects/:id/assets/:assetType/:assetId/versions/diff", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const assetType = await resolveAsset(request, reply, context.project.id, false); if (!assetType) return;
    const latest = await pool.query(
      `SELECT version_no, snapshot FROM asset_versions WHERE project_id = $1 AND asset_type = $2 AND asset_id = $3 ORDER BY version_no DESC LIMIT 2`,
      [context.project.id, assetType, request.params.assetId],
    );
    if (!latest.rowCount) return fail(reply, 404, 2001, "no versions found");
    const [newer, older] = latest.rows;
    /* 只有一版：与「空」比 —— 全字段算新增，即「这版新建了什么」。 */
    const beforeSnap = (older?.snapshot ?? {}) as Record<string, unknown>;
    const afterSnap = (newer.snapshot ?? {}) as Record<string, unknown>;
    return success({
      from: older ? Number(older.version_no) : null,
      to: Number(newer.version_no),
      diff: diffSnapshots(beforeSnap, afterSnap),
    });
  });

  /**
   * 任意两版 diff（viewer 可读）。`:a` `:b` 是版本号；服务端逐字段比对、逐行上色。
   *
   * `a` 作为「旧」侧、`b` 作为「新」侧，与前端「左旧右新」一致；两个版本号必须都真实存在于
   * 该资产（否则 404），不做「谁大谁小」的自动纠正——由前端保证选中顺序，服务端如实按参数比。
   */
  app.get<{ Params: { id: string; assetType: string; assetId: string; a: string; b: string } }>("/api/v1/projects/:id/assets/:assetType/:assetId/versions/:a/diff/:b", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const assetType = await resolveAsset(request, reply, context.project.id, false); if (!assetType) return;
    const a = Number(request.params.a);
    const b = Number(request.params.b);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return fail(reply, 400, 1001, "version numbers must be integers");
    const from = await loadVersion(context.project.id, assetType, request.params.assetId, a);
    const to = await loadVersion(context.project.id, assetType, request.params.assetId, b);
    if (!from || !to) return fail(reply, 404, 2001, "version not found");
    return success({
      from: a,
      to: b,
      diff: diffSnapshots((from.snapshot ?? {}) as Record<string, unknown>, (to.snapshot ?? {}) as Record<string, unknown>),
    });
  });

  /**
   * 回滚到某一版（写权限）。把该版快照写回资产 → **再产一个新版本**（changeSummary 记
   * 「回滚至 vN」），不删历史、不就地改写（计划 14.3 边界：回滚不改变「历史不可变」）。
   *
   * 走既有不可逆动作的确认语义由前端承担（二次确认对话框）。这里只负责事务化写回：
   * - 资产已被删（源表无行）→ 404；
   * - 当下库状态挡住回滚（如环境重名）→ 409（AssetRollbackError）；
   * - 环境回滚不复原 secret 值（快照只有键名），响应带 `secretsPreserved` 让前端提示。
   */
  app.post<{ Params: { id: string; assetType: string; assetId: string; versionNo: string } }>("/api/v1/projects/:id/assets/:assetType/:assetId/versions/:versionNo/rollback", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const assetType = await resolveAsset(request, reply, context.project.id, true); if (!assetType) return;
    const versionNo = Number(request.params.versionNo);
    if (!Number.isInteger(versionNo)) return fail(reply, 400, 1001, "version number must be an integer");
    const target = await loadVersion(context.project.id, assetType, request.params.assetId, versionNo);
    if (!target) return fail(reply, 404, 2001, "version not found");
    const snapshot = (target.snapshot ?? {}) as Record<string, unknown>;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const restored = await restoreAssetSnapshot(client, assetType, context.project.id, request.params.assetId, snapshot);
      if (!restored) {
        await client.query("ROLLBACK");
        return fail(reply, 404, 2001, "asset not found");
      }
      /* 回滚也是一次保存：落一个新版本（内容 = 目标版快照），编号继续单调递增。 */
      await recordAssetVersion(client, {
        projectId: context.project.id, assetType, assetId: request.params.assetId,
        snapshot, changeSummary: `回滚至 v${versionNo}`, createdBy: context.user.id,
      });
      await client.query("COMMIT");
      /* 审计：回滚是资源的一次写入，落 <asset>.update 让变更历史读得到这次动作。 */
      const auditAction = ROLLBACK_AUDIT_ACTIONS[assetType];
      if (auditAction) {
        writeAuditLogAsync({
          action: auditAction, targetType: assetType, targetId: request.params.assetId,
          projectId: context.project.id, userId: context.user.id,
          detail: { rolledBackTo: versionNo }, ip: request.ip,
        });
      }
      return success({ asset: restored.asset, rolledBackTo: versionNo, secretsPreserved: restored.secretsPreserved });
    } catch (error) {
      await client.query("ROLLBACK");
      /* 当下库状态挡住回滚（环境重名）：409 + 说明，让用户先改名，而不是一个说不清的 500。 */
      if (error instanceof AssetRollbackError) return fail(reply, 409, 2003, error.message);
      throw error;
    } finally {
      client.release();
    }
  });
}

/** 回滚落审计时用的动作码（与各资源自己的 update 动作同一枚举，变更历史一处可读）。 */
const ROLLBACK_AUDIT_ACTIONS: Partial<Record<AssetVersionType, AuditAction>> = {
  endpoint: AUDIT_ACTIONS.endpointUpdate,
  test_case: AUDIT_ACTIONS.testCaseUpdate,
  environment: AUDIT_ACTIONS.environmentUpdate,
  /* P10-6 扩面：这些资源的写路径本就落 <resource>.update 审计，回滚沿用同一动作码。 */
  mock: AUDIT_ACTIONS.mockUpdate,
  script: AUDIT_ACTIONS.scriptUpdate,
  flow: AUDIT_ACTIONS.flowUpdate,
  test_suite: AUDIT_ACTIONS.testSuiteUpdate,
  data_source: AUDIT_ACTIONS.dataSourceUpdate,
  sql_definition: AUDIT_ACTIONS.sqlDefinitionUpdate,
  /* spec_case / ci_task 无 update 审计动作（各自路由本就不写审计），故不落——留空。 */
};
