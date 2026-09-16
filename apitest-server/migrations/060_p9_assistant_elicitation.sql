-- 060：agent-vendor 方言的 provider 协议补 MRTR 确认表单映射（2026-09-15，P9-5 增补）。
--
-- 背景：agent 调 delete_* 类写工具时，平台 /mcp 的 MRTR 闸门首轮回 input_required
-- 表单；agent-vendor 运行时接收后会把确认请求转述进聊天 SSE——形态是 MESSAGE 事件 +
-- data.type=ELICITATION + elicitationSchema（表单）+ toolCallId（工具名）。引擎
-- 原先只认 token 映射，确认表单被当普通文字吞进气泡、表单结构整个丢掉——用户
-- 看到 agent 说「已发送确认表单」但抽屉里什么都没有。
--
-- 这里给「token.on=MESSAGE 且 tool.on=PROCESSING」的协议行（agent-vendor 方言的形状
-- 签名，不点名 provider）补两块：
--   1. sse.elicit：elicit 事件的判别字段与取值路径；
--   2. sse.tool.input：工具入参路径（确认卡靠它拿删除目标 id）。
-- 形状签名不匹配或已配置 elicit 的行不动——重复执行无副作用。

UPDATE assistant_providers
SET protocol = jsonb_set(
      jsonb_set(protocol, '{sse,elicit}',
        '{"on":"MESSAGE","type":"data.type","typeValue":"ELICITATION","text":"data.text","tool":"data.toolCallId","schema":"data.elicitationSchema"}'::jsonb),
      '{sse,tool,input}', '"data.result.input"'::jsonb)
WHERE protocol->'sse'->'token'->>'on' = 'MESSAGE'
  AND protocol->'sse'->'tool'->>'on' = 'PROCESSING'
  AND protocol->'sse'->'elicit' IS NULL;
