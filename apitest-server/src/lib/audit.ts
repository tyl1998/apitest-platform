import { pool } from "../db.js";

/**
 * 审计日志通用设施（P4.5-8，计划 8.1 的 `audit_logs`）。
 *
 * 纪律（8.1 的列注释，验收门槛 9 也点名它）：**`detail` 绝不放 secret 值**。审计日志
 * 天然会被广泛读取，是最容易发生「顺手把 payload 整个塞进去」的地方——Runner Token
 * 的明文、仓库凭据、secrets 的 value 一个都不能进 detail。放的是**决策证据**：
 * 勾了几个 key、触发来源、token 的名字（名字不是凭据）。
 *
 * 写入是 fire-and-forget（`.catch(() => {})`）：审计失败不该让业务请求 500——它记的是
 * 「谁在什么时候做了什么」，一次写失败损失的是一条历史，拦下请求损失的是用户当下的
 * 操作。这与 `authenticateRunner` 里 `last_used_at` 的更新同一条取舍。
 *
 * `project_id` 可空：Runner Token 签发是系统级动作，不属于任何项目。
 */

export const AUDIT_ACTIONS = {
  /** CI 任务触发。target = ci_task，detail 带勾选的 key 数量而不是全量 key 列表（§8.3）。 */
  ciTaskTrigger: "ci_task.trigger",
  /** Runner 注册 Token 签发。target = runner_token，系统级（project_id 为空）。 */
  runnerTokenCreate: "runner_token.create",
  /** Runner 注册 Token 吊销。target = runner_token，系统级。 */
  runnerTokenRevoke: "runner_token.revoke",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type AuditInput = {
  action: AuditAction;
  targetType: string;
  targetId: string;
  /** 可空：系统级动作（如 Runner Token 签发）没有项目归属。 */
  projectId?: string | null;
  /** 可空：调度器 / Webhook 之类的非人触发源没有 user。 */
  userId?: string | null;
  /** 决策证据，不是 payload 转储；secret 值一律不进。 */
  detail?: Record<string, unknown>;
  /** 缺省空串（列 NOT NULL DEFAULT ''，显式传空保持同一形状）。 */
  ip?: string;
};

/** detail 的护栏：JSON 序列化后超过 4KB 视为调用方在转储 payload，截断而不是照单全收。 */
const DETAIL_MAX_BYTES = 4096;

export async function writeAuditLog(input: AuditInput): Promise<void> {
  let detail = JSON.stringify(input.detail ?? {});
  if (Buffer.byteLength(detail, "utf8") > DETAIL_MAX_BYTES) {
    detail = JSON.stringify({ truncated: true, note: "detail exceeded 4KB; likely a payload dump — not recorded" });
  }
  await pool.query(
    `INSERT INTO audit_logs (project_id, user_id, action, target_type, target_id, detail, ip)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      input.projectId ?? null,
      input.userId ?? null,
      input.action,
      input.targetType,
      input.targetId,
      detail,
      input.ip ?? "",
    ],
  );
}

/** fire-and-forget 包装：业务路径调用这一个，错误吞掉（见文件头注释的取舍）。 */
export function writeAuditLogAsync(input: AuditInput): void {
  void writeAuditLog(input).catch(() => {});
}
