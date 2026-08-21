/*
 * 下线 P2-3 场景。
 *
 * 场景原本的定位是「按顺序串已有用例 + 传变量」，但它和流程编排解决的是同一个问题：
 * 一旦要跨接口传变量、写前置/后置脚本、在同一屏里看清上下文，场景就必须长出流程
 * 已经有的那套能力，而它的「步骤是引用」模型又让请求参数只能回到用例里去改——用户
 * 实测的结论是用流程能更好地表达同一条业务链路。与其维护两套语义相近、上下文割裂
 * 的编排资源，这里把场景整体撤回，编排统一由流程承担，批量回归由 P2-4 测试套件承担。
 *
 * 「后置 SQL 校验」一并撤回：它真正的需求是「请求之后紧跟一步查库校验」，流程里加一个
 * 数据库节点就是这件事，不需要一个只能挂在末尾、语义特殊的第二种校验位。
 *
 * 前向删除而不是改回 020：迁移一经应用就不会再跑，编辑旧文件对已有库毫无效果。
 *
 * 项目尚未上线，`scenario_step` 只存在于开发库里（AGENTS.md：不为历史数据写兼容代码），
 * 因此这里连带删掉那些执行行，让 `executions.source` 回到三个真实来源，而不是留一个
 * 永远不再产生、却要在每个筛选器里解释的死值。
 */

/* 父索引行与它的 execution_steps 一起走（后者 ON DELETE CASCADE）。 */
DELETE FROM execution_index WHERE kind = 'scenario';
DELETE FROM executions WHERE source = 'scenario_step';

/*
 * 先删列再删表：`scenario_execution_id` 上的外键归属于 executions，指向
 * scenario_executions。反过来做的话 DROP TABLE 会被这条依赖拦住（2BP01），
 * 而 DROP ... CASCADE 会连带删掉它碰到的任何东西，范围不可控。
 */
ALTER TABLE executions DROP COLUMN IF EXISTS scenario_execution_id;
ALTER TABLE executions DROP COLUMN IF EXISTS scenario_step_id;

DROP TABLE IF EXISTS scenario_executions;
DROP TABLE IF EXISTS scenarios;

/* 回到 012 的三个来源。留着 'scenario_step' 只会让「这个值什么时候会出现」永远没有答案。 */
ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_source_check;
ALTER TABLE executions ADD CONSTRAINT executions_source_check
  CHECK (source IN ('endpoint_debug', 'test_case', 'flow_step'));

/*
 * execution_index.kind 的 CHECK 保持不动。
 *
 * 'scenario' 已经没有写入方，而收窄它需要重建约束、且 P2-4 还要再改一次（suite 已在
 * 列表里）。留一个不会被写入的枚举值比来回改约束更省，代码侧不再引用它。
 */
