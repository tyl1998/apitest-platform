/*
 * P1-2 Flow DAG 编排（DEVELOPMENT_PLAN 4.0.2）。
 *
 * 首轮范围（本次确认）：只有 request 节点，按边做拓扑排序后**顺序**执行，节点可配
 * 断言、失败策略与「从响应提取变量」，提取结果写入流程变量袋供后继节点 {{var}} 引用。
 * 条件/循环/脚本/等待/子流程节点按需排期。
 *
 * 执行存储模型（本次确认：父表 + 复用 executions）：
 * flow_executions 是父记录（类比 batch_executions），每个节点跑出来的仍是一条
 * executions 行。这样取消、卡死回收、at-most-once 认领、SSE、请求/响应快照抽屉、
 * 接口维度历史全部零改动继承，而不是为流程再写一套平行设施。
 *
 * 因此 request 节点**必须**关联一个接口（endpoint_id）：executions.endpoint_id 是
 * NOT NULL，且接口归属让流程步骤同样计入该接口的运行记录与用例覆盖统计。节点仍是
 * 完全快照隔离——request_snapshot 是副本，接口后续被改不会回溯影响已存流程。
 */
CREATE TABLE IF NOT EXISTS flows (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  /* 流程级环境。节点不各自选环境：一次流程跑在一套环境上，否则「上一步拿到的
     token 在下一步换了环境还能不能用」没有可解释的答案。 */
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  environment_name TEXT,
  /*
   * nodes / edges 是画布与执行定义的同一份真相：nodes[].position 只影响布局与
   * 并列节点的排序兜底，边决定依赖。存 JSONB 而不是拆两张表——节点没有独立的
   * 生命周期，也没有跨流程复用，拆表只会让一次保存变成 N 条 upsert 加一次删除对齐。
   */
  nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
  edges JSONB NOT NULL DEFAULT '[]'::jsonb,
  /* 流程初始变量，作为第一个节点可见的变量袋（优先级高于环境变量）。 */
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flows_project_created_at_idx ON flows(project_id, created_at DESC);
/*
 * 删除公共脚本前要扫「谁在引用我」。P1-1 只扫 test_cases.assertions，流程节点断言
 * 同样能引用公共脚本，所以 nodes 也要能被 containment 查询命中，否则删除确认会漏报
 * 依赖（lib/scripts.ts scriptUsage）。
 */
CREATE INDEX IF NOT EXISTS flows_nodes_gin_idx ON flows USING gin (nodes);

/*
 * 一次流程执行。
 *
 * flow_id 用 ON DELETE SET NULL 并快照 flow_name：删掉流程不该删掉它跑过的历史
 * （Spec 4.4 历史保留），与 executions.case_id / case_name 同款。
 */
CREATE TABLE IF NOT EXISTS flow_executions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  flow_id UUID REFERENCES flows(id) ON DELETE SET NULL,
  flow_name TEXT NOT NULL,
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  environment_name TEXT,
  /* 与 executions.status 同一套词汇：queued/running 不是结论，通过率必须排除。 */
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled')),
  /* 计划节点数。跳过数 = total - 实际跑出的步骤数。 */
  total INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  /*
   * 执行计划：[{ nodeId, name, endpointId }]，认领时写入，终态后保留。
   * run_spec 会被清空（含 auth 明文），但「本次原本要跑哪些节点、什么顺序」必须
   * 活得比它久——否则已完成的流程无法区分「节点未执行」与「节点不存在」。
   * 刻意只放标识与名称，不含请求定义与凭据。
   */
  plan JSONB NOT NULL DEFAULT '[]'::jsonb,
  /* 终态时的流程变量袋（已按环境 secret 掩码），用于复盘取值。 */
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  /* 待执行的 DAG 快照，含 auth 明文，落终态即置 NULL——理由同 executions.run_spec。 */
  run_spec JSONB,
  worker_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS flow_executions_project_created_at_idx ON flow_executions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS flow_executions_flow_created_at_idx ON flow_executions(flow_id, created_at DESC);
/* 认领与卡死回收都按 status 过滤，未终态的行只占很小比例。 */
CREATE INDEX IF NOT EXISTS flow_executions_pending_idx
  ON flow_executions(status, created_at) WHERE status IN ('queued', 'running');

/*
 * 第三类执行来源。流程节点执行与单步调试都记为 flow_step：
 * 前者 flow_execution_id 非空（属于某次流程执行），后者为空（画布上单独试跑一个节点）。
 */
ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_source_check;
ALTER TABLE executions ADD CONSTRAINT executions_source_check
  CHECK (source IN ('endpoint_debug', 'test_case', 'flow_step'));

/* SET NULL 而非 CASCADE，与 batch_id 一致：父记录消失不该带走执行历史。 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS flow_execution_id UUID REFERENCES flow_executions(id) ON DELETE SET NULL;
/* 节点 id 是流程文档内的字符串，不是表主键，所以没有外键可加。 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS flow_node_id TEXT;
/* 节点被改名或删除后历史仍要读得懂是哪一步跑的。 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS flow_node_name TEXT;

CREATE INDEX IF NOT EXISTS executions_flow_execution_idx ON executions(flow_execution_id, created_at);

/*
 * 匿名脚本的第二种归属（011 已预告）。
 *
 * 流程节点断言同样可以内联写脚本，这些脚本随流程生灭。多态 owner_type/owner_id
 * 不做——那种写法没有外键，删除必须手写清理，迟早漏；两列各自带 CASCADE 才是
 * 数据库能自己保证的。
 */
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS owner_flow_id UUID REFERENCES flows(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS scripts_owner_flow_id_idx ON scripts(owner_flow_id) WHERE owner_flow_id IS NOT NULL;

/* 011 的表级匿名 CHECK 由 Postgres 命名为 <table>_check。 */
ALTER TABLE scripts DROP CONSTRAINT IF EXISTS scripts_check;
ALTER TABLE scripts ADD CONSTRAINT scripts_ownership_check CHECK (
  /* 具名公共脚本：属于项目，没有宿主。 */
  (name IS NOT NULL AND owner_case_id IS NULL AND owner_flow_id IS NULL)
  /* 匿名脚本：恰好一个宿主（`<>` 在布尔上就是异或）。 */
  OR (name IS NULL AND (owner_case_id IS NOT NULL) <> (owner_flow_id IS NOT NULL))
);
