# 计划详情自动化参考列显示 i18n 键名（specCases.links.result_null）

- 日期：2026-09-09（计划详情第一轮反馈第 1 项）
- 模块：apitest-server `src/routes/testPlans.ts`（详情自动化参考列）+ 前端显示面

## 现象

计划详情的「自动化参考」列，对**没有任何自动化记录**的用例显示字面量
`specCases.links.result_null`（缺失的 i18n 键名原样出现在单元格里），而不是
设计中的「—」。

## 根因

详情路由的自动化参考子查询是 `LEFT JOIN LATERAL (…union…) best ON true`：用例
没有任何可参考的自动化行时（没绑定、或绑定的资产从未执行），LATERAL 返回零行、
LEFT JOIN 把 `best.raw` 补成 NULL。路由层建映射时：

```ts
for (const row of references.rows) referenceByItem.set(String(row.item_id), String(row.raw));
```

`String(null)` = `"null"`（真值字符串），`mapTestPlanItem` 把它当
`'status|at|runId'` 拼串解析出 `status: "null"`，前端
`t("specCases.links.result_null")` 查不到键，i18next 按缺省行为把**键名本身**
渲染出来。已有自动化记录的行不受影响（raw 是真串）。

## 修法

NULL 不进 map（`row.raw === null || undefined` 跳过）——`mapTestPlanItem` 收到
`reference_raw: undefined`，`automation` 读成缺席，前端按既有设计显示「—」。
前端不动（`specCases.links.result_*` 现有八键覆盖全部真实状态：
success/failed/canceled/passed/skipped/queued/running/not_run，无新增状态）。

## 状态

已修（`apitest-server/src/routes/testPlans.ts` 一处）。api 是 `tsx watch`
自动热重载；待用户刷新计划详情复验（无自动化的行应显示「—」）。

**2026-09-09 追记**：同日第二轮用户反馈「删除自动化参考列」，参考列连同这条
LATERAL 整链路移除——本缺陷的宿主不复存在，修复记录留档。
