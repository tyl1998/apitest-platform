/*
 * P8-2: 失败归因（计划十二章 12.1）。
 *
 * 两张表：
 * - `failure_categories`：归因分类字典，平台级一份（边界 5：项目不可改口径）。种子由
 *   迁移自带（`ON CONFLICT DO NOTHING`，幂等），不需要预置任何数据。`active=false`
 *   是管理面「停用」——停用后归因抽屉不出现该选项，但历史行与统计仍按名称聚合。
 * - `failure_attributions`：一条失败一个归因（边界 6：UNIQUE (target_type, target_id)，
 *   重打标 = UPDATE；边界 7：未归因不入库，没有行 = 未归因）。
 *
 * `target_id` 多态无 FK（三类目标删除语义各异）：`execution` / `pipeline_run_case` /
 * `execution_step`。悬空行读时排除（等价于未归因），不靠 FK 兜底。
 *
 * `created_at` 冗余记**归因时间**（非失败发生时间）——按失败发生时间的分布 join 目标表
 * 的 `created_at`（归因「按失败发生时间」的分布索引侧由本文件末尾四条覆盖）。
 *
 * 同迁移附带边界 23 的三条**纯读加速**单列索引：stats 全局窗口查询天然没有项目
 * 前缀，既有索引全是 `(project_id, created_at)` 前缀形态，无项目过滤即 Seq Scan。
 * 写放大一行一次 B-tree 插入（executions / execution_index 每终态一行），可接受；
 * pipeline_runs 频率低一个量级，无感。
 * 块注释里刻意不写 stats 路径通配符：Postgres 块注释可嵌套，路径尾的那两个字符
 * 会被当成嵌套注释开头，把外层闭合吞掉、整个文件掉进注释里（42601）。
 */
CREATE TABLE IF NOT EXISTS failure_categories (
  code TEXT PRIMARY KEY,                   -- 'product_bug' / 'test_defect' / 'env' / 'data'
                                           -- / 'flaky' / 'dependency' / 'other'
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO failure_categories (code, name, position) VALUES
  ('product_bug', '产品缺陷', 1),
  ('test_defect', '用例缺陷', 2),
  ('env', '环境问题', 3),
  ('data', '数据问题', 4),
  ('flaky', '不稳定', 5),
  ('dependency', '外部依赖', 6),
  ('other', '其他', 7)
ON CONFLICT (code) DO NOTHING;             -- 种子是字典数据，幂等

CREATE TABLE IF NOT EXISTS failure_attributions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('execution','pipeline_run_case','execution_step')),
  target_id UUID NOT NULL,                 -- 多态、无 FK（三类目标删除语义各异，悬空=未归因，读时排除）
  category TEXT NOT NULL REFERENCES failure_categories(code),
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','mcp')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id)
);
CREATE INDEX IF NOT EXISTS failure_attributions_project_idx
  ON failure_attributions (project_id, category);
CREATE INDEX IF NOT EXISTS failure_attributions_created_idx
  ON failure_attributions (created_at DESC);

/* ── 边界 23：全局统计窗口的无项目前缀查询先行索引 ── */
-- execution_index：stats 全局窗口扫描（既有 (project_id, created_at) 前缀用不上）
CREATE INDEX IF NOT EXISTS execution_index_created_at_idx ON execution_index (created_at DESC);
-- executions：失败 TopN 接口维 / Flaky / MTTR 的全局序列查询（同款理由）
CREATE INDEX IF NOT EXISTS executions_created_at_idx ON executions (created_at DESC);
-- pipeline_runs：仓库用例失败维——90 天窗口先收敛 run 集再 join cases
CREATE INDEX IF NOT EXISTS pipeline_runs_created_at_idx ON pipeline_runs (created_at DESC);
