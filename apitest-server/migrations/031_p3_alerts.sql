/*
 * P3: 告警通知。范围与边界见 DEVELOPMENT_PLAN.md 第六节（边界 8/9/10）。
 *
 * 模型：告警不侵入执行路径——lib/events.ts 已把每次状态变化广播到 Redis
 * executions:events，调度器进程订阅它，在事件到达时评估规则并投递（不用定时扫表，
 * 终态事件本来就会来）。本迁移只落三张表；评估与投递在 P3-5（lib/alerts.ts /
 * lib/notify.ts），路由在 P3-6。
 */

/*
 * 通知渠道：只做「POST 一段 JSON 到一个 URL」这一族（边界 8）——通用 Webhook /
 * 企业微信 / 钉钉 / Slack 四种，差别只在默认模板。Email 不做：SMTP 主机、发件人
 * 身份与投递重试是一套独立基础设施，塞进来只会做成一个发不出去的开关。
 *
 * secret_encrypted 可空：wecom/dingtalk 的加签密钥按需配置，webhook/slack 通常只要
 * URL。存法与 webhook_triggers / data_sources 同款——lib/crypto.ts 的 AES-GCM，
 * 明文只在写入方存在；接口只回「是否已配置」。key_version 为密钥轮换留位。
 *
 * template_prefix 是「可选的自定义前缀文案」而不是模板语言（明确不做：渠道有默认
 * 模板 + 前缀，引入模板语法等于再做一个沙箱）。
 */
CREATE TABLE IF NOT EXISTS notification_channels (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('webhook', 'wecom', 'dingtalk', 'slack')),
  url TEXT NOT NULL,
  secret_encrypted BYTEA,
  key_version INTEGER NOT NULL DEFAULT 1,
  template_prefix TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_channels_project_created_at_idx ON notification_channels(project_id, created_at DESC);

/*
 * 告警规则。
 *
 * 两类指标：事件型 execution_failed（「本次失败」，终态失败事件一到就评估，无窗口，
 * 验收门槛 6.7.4 的那条规则）；窗口型 consecutive_failures / success_rate /
 * avg_duration（在同一条事件上跑一次聚合查询，边界 9）。
 *
 * threshold 的单位按指标定：success_rate 用百分比 0–100，avg_duration 用毫秒，
 * consecutive_failures 用次数——路由按指标校验范围（P3-6）。comparator 只需要四个
 * 方向：成功率跌破用 lt，耗时/连败超过用 gt/gte。
 *
 * window_minutes 为空 = 事件型指标；窗口型必填，路由校验。
 *
 * cooldown_seconds 是压制窗口（边界 9）：没有冷却，一次雪崩会把渠道刷爆，而第 2 条
 * 到第 200 条通知不携带任何新信息。多实例竞争靠「冷却写回带 WHERE last_fired_at =
 * <读到的那个>」的行级认领，与 schedules.next_run_at 同一个惯用法，不引入第二套
 * 并发原语。last_fired_at 兼作冷却起点。
 *
 * channel_ids 是 UUID[]：数组无法携带真外键，归属校验（渠道必须属于同项目、且至少
 * 一个）在路由层做；删渠道前的引用扫描按数组包含查这张表。
 */
CREATE TABLE IF NOT EXISTS alert_rules (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('execution_failed', 'consecutive_failures', 'success_rate', 'avg_duration')),
  comparator TEXT NOT NULL CHECK (comparator IN ('gt', 'gte', 'lt', 'lte')),
  threshold DOUBLE PRECISION NOT NULL,
  window_minutes INTEGER,
  cooldown_seconds INTEGER NOT NULL,
  channel_ids UUID[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_fired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_rules_project_created_at_idx ON alert_rules(project_id, created_at DESC);

/*
 * 派发证据（边界 10）：通知是「发出去就看不见了」的动作，不留投递记录时「没收到
 * 告警」有三种同样可能的原因（规则没命中 / 渠道配错 / 对方 5xx），没有证据就只能猜。
 *
 * channel_id / rule_id / execution_index_id 全部 SET NULL：证据要活过被引用方的删除
 * （删掉配错的渠道后，那些 failed 行正是「为什么之前没收到」的答案），project_id
 * 冗余存一份让列表不必 join。status_code / error 记投递结果本身。
 *
 * payload 存实际 POST 出去的那份 JSON——复现「对方到底收到了什么」只能靠它。
 */
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES notification_channels(id) ON DELETE SET NULL,
  rule_id UUID REFERENCES alert_rules(id) ON DELETE SET NULL,
  execution_index_id UUID REFERENCES execution_index(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  status_code INTEGER,
  error TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_deliveries_project_created_at_idx ON notification_deliveries(project_id, created_at DESC);
