-- P9-4b（2026-09-14，用户模型修订）：助手上游通用化 + 用户级 agent 凭据。
--
-- 模型变化（ DEVELOPMENT_PLAN 13.0 的 2026-09-14 修订块第二条）：
-- 1. provider 从「每平台一个 adapter 代码 + 注册表」改为**通用协议配置**——管理员填
--    4 个接口（建会话 / 发消息 SSE / 停止 / 历史）+ SSE 事件映射 + 认证模板，换平台
--    零开发（原 type/config/capabilities/api_key_encrypted 列作废，adapter 注册表
--    与厂商专用 adapter 删除）；
-- 2. 凭据从系统行挪到**用户级**：系统共享 Key 作废，每个用户按 provider 的
--    user_params 模式自配（agentId / apiKey / mcpToken 等），明文不落库、secret 项
--    AES-GCM 加密；
-- 3. 存量厂商方言行原地翻译成标准协议配置（baseUrl 从原 config 继承），共享
--    agentId/Key 不再迁移——用户侧重新自配。
--
-- 编号顺延：本文件占用 059，P11 由 059 顺延为 060（16 章同步）。
ALTER TABLE assistant_providers ADD COLUMN IF NOT EXISTS protocol JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE assistant_providers ADD COLUMN IF NOT EXISTS user_params JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 存量厂商方言行 → 标准协议配置（唯一合法 type，CHECK 保证没有别的形状）。
UPDATE assistant_providers p SET
  protocol = jsonb_build_object(
    'baseUrl', p.config->>'baseUrl',
    'auth', jsonb_build_object('header', 'Authorization', 'value', 'Bearer {{user.apiKey}}'),
    'successCode', jsonb_build_object('field', 'code', 'value', '0'),
    'createConversation', jsonb_build_object(
      'method', 'POST', 'path', '/api/v1/chat/conversation/add',
      'body', jsonb_build_object('agentId', '{{user.agentId}}'),
      'conversationId', 'data'),
    'chat', jsonb_build_object(
      'method', 'POST', 'path', '/api/v1/chat/{{conversationId}}',
      'body', jsonb_build_object('conversationId', '{{conversationId}}', 'message', '{{message}}')),
    'stop', jsonb_build_object('method', 'POST', 'path', '/api/v1/chat/{{conversationId}}/stop'),
    'delete', jsonb_build_object('method', 'POST', 'path', '/api/v1/chat/conversation/{{conversationId}}/delete'),
    'history', jsonb_build_object(
      'method', 'GET', 'path', '/api/v1/chat/{{conversationId}}/messages',
      'query', jsonb_build_object('index', '{{index}}', 'limit', '{{limit}}'),
      'messages', 'data',
      'fields', jsonb_build_object('id', 'id', 'role', 'role', 'text', 'text', 'time', 'time')),
    'attachments', COALESCE((p.capabilities->>'attachments')::boolean, true),
    'sse', jsonb_build_object(
      'eventField', 'eventType',
      'token', jsonb_build_object('on', 'MESSAGE', 'text', 'data.text'),
      'tool', jsonb_build_object('on', 'PROCESSING', 'name', 'data.name', 'status', 'data.status', 'nameFallback', 'data.type'),
      'done', jsonb_build_object('on', 'FINAL_RESULT', 'text', 'data.outputText', 'success', 'data.success'),
      'error', jsonb_build_object('on', 'ERROR', 'message', 'data.error'),
      'ignore', jsonb_build_array('HEART_BEAT'))
  ),
  user_params = '[
    {"key": "agentId", "label": "agentId", "secret": false, "required": true},
    {"key": "apiKey", "label": "API Key", "secret": true, "required": true},
    {"key": "mcpToken", "label": "MCP Token", "secret": true, "required": false}
  ]'::jsonb
WHERE p.type = 'vendor-v1';

ALTER TABLE assistant_providers DROP CONSTRAINT IF EXISTS assistant_providers_type_check;
ALTER TABLE assistant_providers DROP COLUMN IF EXISTS type;
ALTER TABLE assistant_providers DROP COLUMN IF EXISTS config;
ALTER TABLE assistant_providers DROP COLUMN IF EXISTS capabilities;
ALTER TABLE assistant_providers DROP COLUMN IF EXISTS api_key_encrypted;

-- 用户级 agent：一行 = 「这个用户在这个上游上的参数」。params 存明文参数（agentId 等
-- 非敏感值），secrets 存敏感项（{key: base64 AES-GCM 密文}，读时解密、接口只回键名
-- ——environments 的 secretKeys 同款纪律）。(user, provider) 唯一：一个上游一份配置。
CREATE TABLE IF NOT EXISTS assistant_user_agents (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES assistant_providers(id) ON DELETE CASCADE,
  params JSONB NOT NULL DEFAULT '{}',
  secrets JSONB NOT NULL DEFAULT '{}',
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_id)
);
CREATE INDEX IF NOT EXISTS assistant_user_agents_user_idx ON assistant_user_agents (user_id);
