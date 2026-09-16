/*
 * P9-1: 站内助手的数据层（计划 13.1，DEVELOPMENT_PLAN_P6-P10.md 十三章）。
 *
 * 一张开关列 + 三张表，一次落齐（P9-2…P9-6 的运行期只写不改建）：
 *   - project_settings.assistant_enabled：项目级助手闸门（照 mcp_enabled 先例，
 *     默认 false——服务端真不服务，不是藏前端入口）；
 *   - assistant_providers：系统级 agent 平台配置（多 provider + AES-GCM 加密 Key，
 *     13.0 边界 4——上游配置是平台级运维资产，放 project_settings 是错的抽象层级）；
 *   - assistant_conversations：平台 ↔ 上游会话的映射行（对话正文不落库，边界 2——
 *     transcript 在 agent 方，这里只存「哪个项目哪个人在哪个 provider 开了哪个会话」）；
 *   - notifications：站内通知（边界 8——**不并入 notification_deliveries**，那张记的是
 *     外发 HTTP 投递证据，这张是给人看的消息，带已读态，语义不同）。
 *
 * 本批（P9-1）只激活 notifications 的读写与五个生产源（13.0 边界 9）；providers /
 * conversations 两张表先立结构，路由在 P9-2 / P9-3 落地。
 */

/*
 * 项目级助手开关（边界 4 的项目侧）：false 时助手路由组整组 404（与 /mcp 同款闸门，
 * P5 边界 12）。行只在项目设置被 PUT 过一次时才存在，读取按「无行 = false」处理。
 */
ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS assistant_enabled BOOLEAN NOT NULL DEFAULT false;

/*
 * agent 平台 provider（系统级，多份并存 + 默认切换，13.0 边界 4）。
 *
 * - type 必须是 adapter 注册表内已实现的值（v1 仅 'agent-vendor'，边界 13——资格线：建会话
 *   + SSE 流式 + 按会话查历史）。CHECK 在迁移里锁住 v1 词表；第二个 adapter 落地时
 *   新迁移放宽（枚举走 TEXT + CHECK 的既定纪律，不用 PG enum）。
 * - config 是类型特有参数（baseUrl / agentId 等）；capabilities 是能力面
 *   （{stop, history, attachments}——type 预设，JSON 导入可收窄）。
 * - api_key_encrypted：AES-GCM（lib/crypto.ts——要拿明文调上游，所以加密而非哈希）；
 *   只写不读，接口只回「已配置」。可空：测试连接之前允许先存一份没 Key 的草稿。
 * - name UNIQUE：默认 provider 的切换与管理面按名字找人。
 */
CREATE TABLE IF NOT EXISTS assistant_providers (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('agent-vendor')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  api_key_encrypted TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/*
 * 会话映射（边界 2/修订 4）：多轮上下文与历史全由 agent 方持有，平台只存这一行
 * 「指针」。provider 删除级联删会话（ON DELETE CASCADE——provider 没了，上游会话
 * 的可达性随之消失，留着映射行只会让抽屉里出现永远打不开的会话）。
 */
CREATE TABLE IF NOT EXISTS assistant_conversations (
  id UUID PRIMARY KEY,
  provider_id UUID NOT NULL REFERENCES assistant_providers(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_conversation_id TEXT NOT NULL,   -- 上游 conversationId（agent-vendor 为 Long 文本）
  topic TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assistant_conversations_user_idx
  ON assistant_conversations (user_id, last_active_at DESC);

/*
 * 站内通知（跨项目，用户级——收件人是「人」不是「项目的成员集合」）。
 *
 * kind 五值（13.0 边界 9）：member_change / plan_assign 是 P9 回补 P6/P7 的两个新源，
 * alert / suite_result / ci_result 挂在既有三个终态订阅点上。
 *
 * link 存站内相对路径（如 /projects/:id/members）——绝对地址由前端按当前 origin 拼，
 * 换部署域名不产生死链。project_id 可空 + SET NULL：通知要活过项目删除（「那个项目
 * 删了」本身仍是已发生的事实），行不随项目消失。
 */
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('member_change', 'plan_assign', 'alert', 'suite_result', 'ci_result')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',           -- 站内相对路径
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON notifications (user_id, created_at DESC);
