/*
 * P3: 调度、Webhook 触发、套件报告名、环境默认头。范围与边界见 DEVELOPMENT_PLAN.md 第六节。
 *
 * 核心模型（6.0）：触发源写进 execution_index（唯一的报告/统计/告警查询入口），
 * 报告只是 suite_executions 上的一个入队时命名，调度去重靠 next_run_at 的行级认领。
 * 本迁移只落结构；触发路径（lib/trigger.ts）、调度器进程（src/scheduler.ts）、
 * 路由与前端分别在 P3-3/4/6/8/9 批次接入。
 */

/*
 * 定时调度。目标只有测试套件（边界 1）：要按时跑一条流程，把它放进一个只含它的套件。
 *
 * target_type 的 CHECK 只有 'suite' 一个值却保留整列，与迁移 010 的 workers.mode 同一条
 * 理由：P4.5 的 CI 任务接进来时不必回填历史行——回填时分不清某行当年指的是谁。
 *
 * target_id 刻意**无外键**（与 execution_index.target_id 同款）：引用是按 target_type
 * 多态的（现在指向 test_suites，P4.5 起可能指向 CI 任务），真 FK 无法表达。删除套件前
 * 的引用扫描与 force 后的连带清理由路由承担（P3-6，对齐 409 + 清单的删除语义）。
 *
 * environment_id 为空 = 用套件自己的环境配置；有值 = 触发时覆盖（边界 4，复用既有的
 * environmentStrategy='override' 链，不新造第三条环境选择逻辑）。换环境就是换分区
 * （P2-8），所以「白天手动跑得起来、夜里定时跑报 2004」是成立的。
 *
 * variables 是每次触发都带的变量覆盖（6.5 流量泳道）：一行 {"lane":"lane-b"} 就能让
 * 一条「夜里 2 点按 lane-b 跑冒烟」的调度成立，接口、用例、流程一个都不用改。
 * 键形约束（^[A-Za-z_][A-Za-z0-9_]*$）在路由层校验，错误要能回给用户。
 */
CREATE TABLE IF NOT EXISTS schedules (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'suite' CHECK (target_type IN ('suite')),
  target_id UUID NOT NULL,
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  cron TEXT NOT NULL,
  /* 用户写 cron 用的是墙上时钟；平台用户在同一时区，默认北京而不是 UTC，
     否则「0 2 * * *」会在上午十点触发。列存在是为了多时区需求不必回填。 */
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  enabled BOOLEAN NOT NULL DEFAULT true,
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  /* 去重锚点：UPDATE schedules SET next_run_at=<重算> WHERE id=$1 AND next_run_at=$2，
     rowCount 就是「我抢到了没有」（6.0）。禁用的调度置 NULL，不进到期扫描。 */
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schedules_project_created_at_idx ON schedules(project_id, created_at DESC);
/* 调度器 tick 的认领扫描：WHERE enabled AND next_run_at <= now()。 */
CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules(next_run_at) WHERE enabled;

/*
 * 调度触发记录。回答「调度自己有没有按时触发成功」，与执行历史是两个问题：
 * 漏跑（skipped）与触发失败（failed）根本没有执行，也就没有报告（边界 15）。
 *
 * 漏跑必须留痕（边界 2）：不留痕的话「昨晚没跑」与「昨晚跑了但没失败」无法区分。
 * 超过宽限期的到期时刻记 skipped 并把 next_run_at 快进，**不补跑**——补跑等于同一刻
 * 对被测系统打 40 发。触发失败不自动禁用调度（边界 3），记 failed 带原因即可。
 *
 * schedule_id 用 CASCADE：调度删除后它的触发记录没有查询方；真正的历史在
 * execution_index / suite_executions 里，靠无 FK 的 trigger_ref_id 活过删除。
 * project_id 冗余存一份，触发历史按项目直查不必 join。
 */
CREATE TABLE IF NOT EXISTS schedule_runs (
  id UUID PRIMARY KEY,
  schedule_id UUID NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  /* 这个到期时刻本身；skipped 行的 triggered_at 为空。 */
  planned_at TIMESTAMPTZ NOT NULL,
  triggered_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('triggered', 'skipped', 'failed')),
  /* 触发成功才指向产生的父执行；skipped/failed 为空。 */
  execution_index_id UUID REFERENCES execution_index(id) ON DELETE SET NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schedule_runs_schedule_planned_at_idx ON schedule_runs(schedule_id, planned_at DESC);

/*
 * Webhook 触发（边界 6）：公开无鉴权路由，凭 HMAC 准入，形状照 P2-5 的 Mock 运行时
 * （/mock/:publicId/ 下的通配路由是本仓库唯一已有的「外部可直接调用」先例）。
 *
 * target_type 仍支持流程（边界 1 末段）：外部系统把一次业务事件转成一次单链路执行，
 * 与「按时跑一批回归」不是同一件事，所以这里 CHECK 是 ('flow','suite')。
 *
 * secret_encrypted 用 lib/crypto.ts 的 AES-GCM：验签必须拿到明文，所以不能存哈希；
 * 创建时回明文一次，之后接口只回 hasSecret。key_version 与 data_sources 同款，
 * 为密钥轮换留位。
 *
 * target_id 同样无外键：按 target_type 多态（flow|suite），删除安全由路由扫描承担。
 */
CREATE TABLE IF NOT EXISTS webhook_triggers (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('flow', 'suite')),
  target_id UUID NOT NULL,
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  public_id TEXT NOT NULL UNIQUE,
  secret_encrypted BYTEA NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_triggers_project_created_at_idx ON webhook_triggers(project_id, created_at DESC);

/*
 * 触发源归属父索引，不加在三张执行表上（6.0）：execution_index 已经是报告/统计/告警
 * 的唯一查询入口，而可被触发的只有流程与套件，两者都有 index 行。叶子 executions 的
 * 触发源由父级回答，单接口调试永远是 manual。
 *
 * 'ci' 现在就写进 CHECK，尽管 P4.5 才产出它——理由与迁移 010/027 同款：等做出来再改
 * CHECK 就要回填，而回填时分不清历史行。
 *
 * trigger_ref_id 无 FK：调度/Webhook 被删后报告仍要说清「谁触发的」，靠 trigger_ref_name
 * 快照（边界 13）读得通。
 */
ALTER TABLE execution_index
  ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (trigger_source IN ('manual', 'scheduled', 'webhook', 'ci'));
ALTER TABLE execution_index ADD COLUMN IF NOT EXISTS trigger_ref_id UUID;
ALTER TABLE execution_index ADD COLUMN IF NOT EXISTS trigger_ref_name TEXT;

/* 报告列表 / 趋势按触发源过滤（P3-6），项目内再按时间排序。 */
CREATE INDEX IF NOT EXISTS execution_index_project_trigger_idx
  ON execution_index(project_id, trigger_source, created_at DESC);

/*
 * 报告名（边界 13）：「套件名_YYYYMMDD[_n]」，入队事务里一次定终身，不在读取端算。
 * 历史行为空——报告是 P3 起的派生物，只对新的执行生成。耗时不存列：finished_at -
 * started_at 已在表上，再存 duration_ms 只会在取消/回收路径上对不上。
 */
ALTER TABLE suite_executions ADD COLUMN IF NOT EXISTS report_name TEXT;

/*
 * 环境默认头（6.5 流量泳道第一层）：buildRequest 里以最低优先级合并进每一个 HTTP
 * 请求——buildRequest 是全平台唯一的请求组装点，放在别处必然漏掉一类。
 * 默认空对象 = 行为不变，P3-2 才接线。
 */
ALTER TABLE environments ADD COLUMN IF NOT EXISTS default_headers JSONB NOT NULL DEFAULT '{}'::jsonb;
