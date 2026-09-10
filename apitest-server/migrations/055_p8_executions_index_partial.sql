/*
 * P8-2 修复：executions 的 (created_at DESC) 单列全量索引抢走接口列表
 * LATERAL「最近运行」的执行计划（issue_fix/问题记录-P8-2索引抢计划.md）。
 *
 * 现象：GET /projects/:id/endpoints 从 ~50ms 涨到 700-950ms。EXPLAIN 显示
 * LATERAL 子查询（WHERE endpoint_id = X AND source <> 'flow_step'
 * ORDER BY created_at DESC LIMIT 1）弃用 executions_endpoint_created_at_idx
 * （按 endpoint 定位，0.4ms/行），改走 054 的单列索引从最新往回全表扫、边扫
 * 边滤 endpoint——接口的最近执行多半是旧行，每行扫掉 ~46k 无关行。
 *
 * 根因：planner 高估了「最新 1500 行里就能命中该 endpoint」——endpoint 与
 * created_at 相关（不同时期建的不同接口），估计与事实背离。
 *
 * 修法：全量单列索引换成 **partial**（WHERE status='failed'）。它本来就是给
 * stats 失败序列查询（TopN / Flaky / MTTR）铺路（边界 23），partial 形态
 * 更贴合那个读集（只扫失败行）且体积小得多；LATERAL 没有 status 谓词，
 * planner 无法选它，接口列表回到 endpoint 前缀索引。P8-4 上线 stats 路由时
 * 仍须逐条 EXPLAIN（边界 23 的既定纪律），届时按实测再精化。
 *
 * execution_index（301 行）与 pipeline_runs（65 行）的两条同款索引不动：
 * 表小，实测无受害查询；P8-4 复核时一并再看。
 */
DROP INDEX IF EXISTS executions_created_at_idx;
CREATE INDEX IF NOT EXISTS executions_failed_created_at_idx
  ON executions (created_at DESC) WHERE status = 'failed';
