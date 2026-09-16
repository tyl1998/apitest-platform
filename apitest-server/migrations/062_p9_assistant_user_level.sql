/*
 * P9-6（2026-09-16 用户定位修订）：对话用户级化。
 *
 * 会话是「人」的，不是「项目 × 人」的——助手抽屉全局常驻后，对话不因所在页面
 * 归属任何项目；页面上下文（P9-4c）按消息随发随带（围栏前缀拼进转发正文），
 * 与会话归属无关。路由组同步搬出 /projects/:id 前缀（routes/assistant.ts）。
 *
 * project_id 直接删除：项目未发布，无历史数据要保（AGENTS.md Data Compatibility
 * ——干净 schema 优先）。既有行上的 project_id 语义本来就无人消费（列表/收发都
 * 只按 user_id 过滤）。
 */
ALTER TABLE assistant_conversations DROP COLUMN IF EXISTS project_id;
