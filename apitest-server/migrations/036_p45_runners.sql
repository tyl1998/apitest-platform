/*
 * P4.5-1: 自研 Runner 的注册凭据与 Runner 池。范围与边界见 DEVELOPMENT_PLAN.md 8.0/8.1。
 *
 * 核心模型：**Runner 主动外连平台，平台永不反向连接**（8.2）。所以这里没有任何「平台
 * 记住了怎么连到那台机器」的列——没有地址、没有端口、没有回调 URL。一台自托管 Runner
 * 只需要能出站 443。
 *
 * **不复用 `workers` 表**（迁移 009/010/027，边界「三条与既有实现的关系」）：那张表是
 * 平台自己 BullMQ worker 的注册表——id 是 `hostname:pid`、无 token、无信任边界、心跳靠
 * 直写 Postgres、掉线只影响调度。Runner 是自托管的、需注册凭据、心跳走 HTTP、掉线要判
 * `aborted` 并回收租约。两者的信任模型与 liveness 语义都不同，塞进一张表会让「离线」
 * 这个词在同一列上有两种含义。
 *
 * 编号说明：计划原写 `006_p45_schema.sql` 为过时命名，实际接在 035 之后；且**一批一个
 * 主题**（8.1），本文件只有注册这一件事，CI 任务在 037、执行账本在 038。
 */

/*
 * Runner 注册 Token。明文形状 `apirunner_<random>`，`Authorization: Bearer` 携带。
 *
 * **系统级，刻意不带 `project_id`**（8.1）：一台自托管机器服务的是一个**网段**，而网段上
 * 可能有多个项目的被测服务。绑到项目上会逼用户为每个项目在同一台机器上各起一个 Runner
 * 进程。项目隔离靠 `labels` + 后续的分区准入，不靠 token 归属。
 * （对比 `ingest_tokens` 确实带 `project_id`——那是因为一份上报**必然**属于一个项目，
 * `/ingest` 从 token 反查 `project_id` 是它的核心机制；这里项目是从 job 来的。）
 *
 * **AES-GCM 可逆加密存储**（2026-09-28 起，取代原 scrypt 哈希），格式与
 * `ingest_tokens.secret_encrypted` / Webhook 密钥同款：产品要求凭据能重新复制，管理页
 * 按前缀取回明文即可，丢了不必吊销重发。代价：库被读走时加密的凭据能被主密钥解开。
 *
 * `labels` 放在 token 上而**不只**放在 Runner 上，注册时校验子集关系（见下）。
 *
 * 吊销是软删（留 `revoked_at`）：`runners` 引用它，硬删之后「那台机器是拿哪张 token
 * 注册的」就答不出来了。
 */
CREATE TABLE IF NOT EXISTS runner_tokens (
  id UUID PRIMARY KEY,
  /* 人给的名字，「办公内网 01」。用于面板辨认，不参与任何逻辑。 */
  name TEXT NOT NULL,
  secret_encrypted BYTEA,         -- AES-256-GCM(明文 token)，可解回供重新复制
  /* 明文的 `apirunner_` + 随机段前 8 位。供列表辨认，也让鉴权按前缀取候选行而不是
     全表解密——全表比对会让心跳这条热路径随 token 总数线性变慢。它不足以反推 token，
     也不参与校验本身。 */
  token_prefix TEXT NOT NULL,
  /* 这张 token 允许声明的分区（P2-8 的同一套 `runner_label` 命名空间）。 */
  labels TEXT[] NOT NULL DEFAULT ARRAY['default'],
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runner_tokens_created_at_idx ON runner_tokens(created_at DESC);
/* 与 `ingest_tokens_prefix_idx` 同款部分索引：吊销行被索引条件排除，所以吊销即时生效。 */
CREATE INDEX IF NOT EXISTS runner_tokens_prefix_idx ON runner_tokens(token_prefix) WHERE revoked_at IS NULL;

/*
 * 一台已注册的 Runner。
 *
 * `id` 是**平台发的 UUID**，不是 `hostname:pid`（对比 `workers`）：Runner 在自己那台机器
 * 上重启后要用同一个身份回来，而 pid 每次都变。
 *
 * **`labels ⊆ runner_tokens.labels`，注册时在路由层校验**（8.1）。否则任何一台拿到 token
 * 的机器都能声明 `labels=['prod-dmz']` 并开始领生产网段的任务——这正是 P2-8 边界 6
 * 「认领语句加分区防御」担心的那件事，只是那里的攻击面是「job 被投错队列」，这里是
 * 「机器自称在别的网段」，后者更严重。校验放路由层而不是 CHECK：跨表的子集关系 CHECK
 * 表达不了，且错误信息要能说清多声明了哪几个标签。
 *
 * **`sandbox_modes` 由 Runner 自报**（探测本机有没有 docker）。它让「任务配了容器档但
 * 这个标签下的在线 Runner 都只支持进程档」这个错误能在**触发时**就报出来（复用 `2004` /
 * `failNoRunner` 的形状），而不是等 claim 之后 Runner 自己失败——那会得到一条 `failed`
 * 的 run 和一段看不懂的日志。
 *
 * **`last_seen_at` 只回答「这台机器在不在线」**，不回答「这个任务还活着吗」（边界 5）。
 * 后者是 `pipeline_runs.lease_expires_at`（迁移 038）：一台 Runner 可以进程还活着、心跳
 * 照发，但某个 job 的子进程已经僵死。判据必须挂在任务上，机器在线只用于面板与入队前检查。
 *
 * `status='draining'`（交互文档 3.12.4 的「下线」）：不再参与 claim，但在跑的任务跑完。
 * 它是本表唯一一个**人可以改**的列。
 */
CREATE TABLE IF NOT EXISTS runners (
  id UUID PRIMARY KEY,
  runner_token_id UUID NOT NULL REFERENCES runner_tokens(id) ON DELETE CASCADE,
  /* Runner 自报的 hostname，仅显示。与 `runner_token_id` 一起构成幂等键（见下）。 */
  name TEXT NOT NULL,
  labels TEXT[] NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,
  sandbox_modes TEXT[] NOT NULL DEFAULT ARRAY['process'],
  version TEXT NOT NULL DEFAULT '',
  protocol_version TEXT NOT NULL DEFAULT '1.0',
  status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'draining', 'offline')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/*
 * `register` 幂等于 `(runner_token_id, name)`（8.2 约定 3）。
 *
 * Runner 重启后用同一个 `runner_id` 回来，否则每次重启都在面板上留一行僵尸。约束放在
 * 数据库而不是靠路由里「先 SELECT 再 INSERT」：Runner 崩溃重启后并发重注册时，那种两步
 * 式会双双通过。
 */
CREATE UNIQUE INDEX IF NOT EXISTS runners_token_name_idx ON runners(runner_token_id, name);
/* Runner 池面板按在线状态与标签看。 */
CREATE INDEX IF NOT EXISTS runners_last_seen_at_idx ON runners(last_seen_at DESC);
