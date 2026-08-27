/*
 * P2-8 执行分区（跨网段执行）。范围与边界见 DEVELOPMENT_PLAN.md 5.0.12。
 *
 * 问题：公司内网存在互不连通的网段（测试 / 生产），worker 只能从**自己所在网段**出站，
 * 所以指向生产的用例根本发不出去。现有模型里没有任何东西能表达「这次执行该从哪个网段
 * 发出」——被测地址只是 URL 里的 `{{var}}`，队列名是模块常量 `"executions"`，
 * `workers.mode` 只是上报标签、不参与路由。
 *
 * 解法：**environment 持有分区标签，队列按标签分裂，worker 声明自己服务哪些标签。**
 * 选 environment 承载，因为它是唯一天然携带「我指向哪套系统」的实体，且环境选择链
 * （用例绑定 → 接口默认 → 项目默认，计划 2.4）已被用例/接口/流程/套件/批量调试共用
 * ——环境定了分区就定了，不需要第二套选择逻辑。
 */

/*
 * 「这个环境指向的系统该从哪个网段发请求」。
 *
 * 格式约束（`^[a-z0-9][a-z0-9-]{0,31}$`）刻意**不放 CHECK**，放在路由层：它会进 Redis
 * key（`executions-<label>`），必须约束，但错误信息要能回给用户说清哪里不合法。
 */
ALTER TABLE environments ADD COLUMN IF NOT EXISTS runner_label TEXT NOT NULL DEFAULT 'default';

/* 执行器面板要列出「配了但没人服务」的分区，全集里有一项就是 DISTINCT runner_label。 */
CREATE INDEX IF NOT EXISTS environments_runner_label_idx ON environments(runner_label);

/*
 * 三张执行表各存一份标签快照。
 *
 * 理由与 `environment_name`（迁移 004）完全一致：环境改标签或被删之后，历史仍要说清
 * 这次执行是从哪个网段跑的。更关键的是**认领与取消都要靠这一列找队列**——回查
 * environment 会在标签被改后找错队列，而那一刻队列里的 job 还在老队列上。
 *
 * `suite_executions` 一起加：迁移 010 已经吃过「等做出来再加列就要回填、而回填时分不清
 * 历史行属于谁」这个亏。
 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS runner_label TEXT NOT NULL DEFAULT 'default';
ALTER TABLE flow_executions ADD COLUMN IF NOT EXISTS runner_label TEXT NOT NULL DEFAULT 'default';
ALTER TABLE suite_executions ADD COLUMN IF NOT EXISTS runner_label TEXT NOT NULL DEFAULT 'default';

/*
 * worker 声明自己服务哪些分区。
 *
 * 与 `mode` 是两个**正交轴**：本切片只让 `labels` 参与路由，`mode` 仍是上报标签。
 * 数组而不是单值，是为了让单机开发能用一个进程覆盖多个分区；生产上推荐一个进程一个
 * 标签（多标签进程必须按 `floor(WORKER_CONCURRENCY / 标签数)` 拆分并发，否则上报的
 * 容量会翻倍失真）。
 */
ALTER TABLE workers ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT ARRAY['default'];

/*
 * 分区过滤的补投扫描（worker.ts `requeueOrphans`：`WHERE runner_label = ANY($1)`）
 * 只关心未终态的行，与既有 pending 局部索引同一套取舍。
 */
CREATE INDEX IF NOT EXISTS executions_pending_label_idx
  ON executions(runner_label, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS flow_executions_pending_label_idx
  ON flow_executions(runner_label, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS suite_executions_pending_label_idx
  ON suite_executions(runner_label, created_at) WHERE status IN ('queued', 'running');
