# 问题记录 — settings 局部 PUT 互清开关

- 阶段：P9-2 联调期间发现（2026-09-11）；缺陷自 P5 的 `mcp_enabled` 起预存在，
  P9-3 给 settings 加 `assistantEnabled` 时沿袭了同一形状。
- 涉及：`apitest-server/src/routes/projects.ts` 的 `PUT /api/v1/projects/:id/settings`。

## 现象

只改一项开关的局部 PUT 会把**未传的其它开关清回 false**。实测序列
（e2e-assistant 项目，2026-09-11）：

1. `PUT {"mcpEnabled": true}` → 返回 `mcpEnabled: true`（此时 `assistant_enabled`
   未知地变回了 false——同一缺陷早先被触发过）；
2. `PUT {"assistantEnabled": true}` → 返回 `mcpEnabled: false`——上一步刚开的
   MCP 闸门被这次局部 PUT 清掉了。

任意两个开关之间互相影响（storePlaintext / mcpEnabled / assistantEnabled）。
skipped e2e 用例 `test_update_project_settings_store_plaintext` 的 docstring 早已
把这个行为当「现状」记下（`COALESCE 会把缺省布尔落回 false`）——是已知怪象，
不是新引入。

## 根因

upsert 的**两层 COALESCE 打架**：

```sql
VALUES ($1, $2, COALESCE($3, false), COALESCE($4, false), COALESCE($5, false))
ON CONFLICT (project_id) DO UPDATE SET
  mcp_enabled = COALESCE(EXCLUDED.mcp_enabled, project_settings.mcp_enabled)
```

VALUES 侧为了让**全新行**满足 NOT NULL，把缺省参数（null）COALESCE 成了
`false`；于是冲突路径上的 `EXCLUDED.mcp_enabled` 永远是 `false` 而非 `null`，
DO UPDATE 侧的 `COALESCE(EXCLUDED.x, existing)` 永远取 `false`——「保留既有
值」的设计从未生效过。注释写的正是这个意图（「只改默认环境的一次 PUT 不该把
开关顺手清回 false」），代码没兑现。

## 修法

DO UPDATE 侧改引**原始参数**（`$3/$4/$5`）而不是 EXCLUDED：插入路径仍靠 VALUES
侧 COALESCE 拿 NOT NULL 默认值，冲突路径用请求里的原始 null 判「未传」：

```sql
ON CONFLICT (project_id) DO UPDATE SET
  default_environment_id = EXCLUDED.default_environment_id,
  store_plaintext = COALESCE($3, project_settings.store_plaintext),
  mcp_enabled = COALESCE($4, project_settings.mcp_enabled),
  assistant_enabled = COALESCE($5, project_settings.assistant_enabled)
```

（`default_environment_id` 维持 EXCLUDED 全量覆盖——它本就是「PUT 即整体设置」
的语义，且列可空。）

## 验证

- `pnpm check` 通过；tsx watch 热载后实测：`PUT {"mcpEnabled": true,
  "assistantEnabled": true}` 两开关同开；随后 `PUT {"storePlaintext": false}`
  局部 PUT，两个开关保持 true——互清消失。
- 遗留：skipped 用例 `test_update_project_settings_store_plaintext` 断言的是
  修复前的坏现状（改默认环境后 `storePlaintext` 变 false），解封时需按修复后
  行为改断言（保持 true）。

## 状态

已修复（2026-09-11，随 P9-2 MCP 接线联调落地；e2e 零新增用例，解封既有
skipped 用例时按上条调整）。
