/*
 * P2-6: 高级节点（循环 / 短等待 / 子流程）。
 *
 * 只有一处数据层改动：`execution_steps` 需要能表达**嵌套步骤**。
 *
 * 循环体与子流程都是「在一个节点内部跑一整张图」，那张图里的每一步同样需要可
 * 复盘的证据行——否则一次失败的循环只留下一句「第 3 次迭代失败」，用户无从知道
 * 是里面哪个请求失败、失败在哪。所以子步骤仍写进同一张 execution_steps，用
 * `parent_step_id` 指回容器节点那一行，用 `iteration` 记录它属于第几次迭代
 * （子流程只跑一次，为 NULL）。
 *
 * `step_type` 本来就没有 CHECK，wait / loop / subflow 不需要扩枚举。
 *
 * 唯一键必须重建。015 的 UNIQUE (index_id, step_id, position) 里 `position` 是
 * 节点在图中的**声明下标**——`lib/flowGraph.ts` 用它做同层同名写冲突的确定性裁决，
 * 所以不能改成「按启动顺序自增」。于是循环体里同一个内层节点被跑 20 次会得到 20 个
 * (step_id, position) 相同的行，撞旧约束。改为两条分区唯一索引：顶层步骤仍保持
 * 原来的唯一性，嵌套步骤按 (容器行, 节点, 声明下标, 迭代号) 唯一。`iteration`
 * 用 COALESCE 兜住 NULL，避免 NULL 在唯一索引里彼此不相等而放过重复行。
 *
 * 父级计数只统计顶层步骤：execution_index / flow_executions 的 total 是顶层节点数，
 * 把嵌套步骤也算进 success/failed 会出现「12/5 步通过」。取消、worker 兜底与回收的
 * 聚合都加 parent_step_id IS NULL 过滤，本迁移只提供它们需要的列与索引。
 */

ALTER TABLE execution_steps ADD COLUMN IF NOT EXISTS parent_step_id UUID REFERENCES execution_steps(id) ON DELETE CASCADE;
ALTER TABLE execution_steps ADD COLUMN IF NOT EXISTS iteration INTEGER;

ALTER TABLE execution_steps DROP CONSTRAINT IF EXISTS execution_steps_index_id_step_id_position_key;

CREATE UNIQUE INDEX IF NOT EXISTS execution_steps_toplevel_unique_idx
  ON execution_steps(index_id, step_id, position) WHERE parent_step_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS execution_steps_nested_unique_idx
  ON execution_steps(parent_step_id, step_id, position, COALESCE(iteration, -1)) WHERE parent_step_id IS NOT NULL;

/* 取详情时按容器步骤取子步骤；同时服务「只要顶层」的过滤与排序。 */
CREATE INDEX IF NOT EXISTS execution_steps_parent_idx ON execution_steps(parent_step_id, iteration, position) WHERE parent_step_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS execution_steps_index_toplevel_idx ON execution_steps(index_id, position) WHERE parent_step_id IS NULL;
