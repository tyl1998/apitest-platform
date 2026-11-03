-- 079：助手上游预置去厂商化（2026-11-03，开源前清洗）。
--
-- 背景：历史预置行按厂商名命名，协议里还带着该厂商的成功码。
-- 开源后仓库里不应出现第三方厂商名——这两个字面量既暴露接入方，也不是协议
-- 必需：预置行本来就是「通用协议模板的一个样例」。
--
-- 两处就地改名（该行是用户从存量库升级上来的历史数据，与仓库里的出厂值无关），
-- 幂等、重复执行无副作用：
--   1. 预置行 <旧名>-agent → `agent-platform`（名字是管理员的运维资产，但这是
--      出厂名，且 seed 清单已同步改名——不改会让此后启动又插出一行重复上游）；
--   2. 成功码 `0000` → `0`（与随包样例协议 `data/assistant-providers/*.json`
--      同一口径；前端示例文案同步改成 `0`）。
-- 管理员自己改过名字 / 成功码的行不受影响：名字匹配范围限定在出厂命名形状
-- （`*-agent`），成功码只认出厂值。

UPDATE assistant_providers
SET name = 'agent-platform',
    updated_at = now()
WHERE name ~* '-agent$'
  AND lower(name) <> 'agent-platform'
  AND NOT EXISTS (SELECT 1 FROM assistant_providers WHERE lower(name) = 'agent-platform');

UPDATE assistant_providers
SET protocol = jsonb_set(protocol, '{successCode,value}', '"0"'::jsonb),
    updated_at = now()
WHERE protocol->'successCode'->>'field' = 'code'
  AND protocol->'successCode'->>'value' = '0000';
