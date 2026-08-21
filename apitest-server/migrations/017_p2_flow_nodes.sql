/*
 * P2-2: 流程节点补全（脚本节点 / 条件节点 / 受控并行）。
 *
 * 三类改动都是数据层准备，执行语义在 lib/flowRun.ts（ready-set 分层调度）：
 *
 * 1. execution_steps.status 增加 skipped —— 条件只激活命中分支，未命中的后继
 *    必须有「被跳过」的证据（5.5.2 验收：条件只激活命中分支；脚本/数据库/条件
 *    步骤都有可复盘结果）。旧的 CHECK 只认 queued/running/success/failed/
 *    canceled，直接扩枚举会撞到已存在的约束名，所以先删再建（幂等）。
 *
 * 2. scripts.kind 增加 node —— 脚本节点的脚本与断言/钩子契约不同：它读写
 *    ctx.variables，返回值合并进变量袋，不校验响应。挂到 scripts 表同一张表，
 *    owner_flow_id 随流程生灭，公共脚本仍可被引用。同样是删约束再建。
 */

ALTER TABLE execution_steps DROP CONSTRAINT IF EXISTS execution_steps_status_check;
ALTER TABLE execution_steps ADD CONSTRAINT execution_steps_status_check
  CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled', 'skipped'));

ALTER TABLE scripts DROP CONSTRAINT IF EXISTS scripts_kind_check;
ALTER TABLE scripts ADD CONSTRAINT scripts_kind_check
  CHECK (kind IN ('assertion', 'hook', 'library', 'node'));
