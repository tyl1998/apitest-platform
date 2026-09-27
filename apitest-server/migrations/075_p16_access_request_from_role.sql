/*
 * P16-1：成员提权申请（P14-2 审批流扩展）——`access_requests` 补 from_role 快照列。
 *
 * P14 第一版只服务「非成员申请加入」，from 为空；P16-1 放开成员提权（viewer/developer
 * 申请严格更高的角色）后，审批列表要能区分「加入」与「提权」并读出「从什么角色提」。
 * 这里存**申请提交时**的角色快照，不读时 JOIN user_project_roles——批准后角色已变，
 * JOIN 会把「viewer → developer」显示成「developer → developer」（历史要读得出当时
 * 的事实，与 executions 的 name 快照同一取舍）。
 *
 * NULL = 非成员加入申请（含历史行：069 时代的申请全部是加入申请，无需回填）。
 * CHECK 词汇与 069 的 suggested_role / 001 的 user_project_roles.role 同三档；
 * system_admin 不落本列（它是运行时角色，且任何申请都不比它高，提权口子进不来）。
 */
ALTER TABLE access_requests
  ADD COLUMN IF NOT EXISTS from_role TEXT CHECK (from_role IN ('project_admin', 'developer', 'viewer'));
