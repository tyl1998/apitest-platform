# 计划详情就地合行不动 summary（标结果后头部计数不推进）

- 日期：2026-09-09（计划详情第二轮反馈）
- 模块：apitest-web `TestPlans.tsx`（markItem / removeItem / 编辑弹窗合流）

## 现象

计划详情里标了结果，行内下拉变了，但头部 Readout（通过率 / 进度 / 未执行数）与
结果表头悬停的五态计数**不推进**，要整页刷新才对。另有一个同族潜伏坑：走「编辑」
弹窗改名称/描述/截止后，进度直接清成 `0/total`。

## 根因

详情是全量项 + 服务端算好的五计数（`PLAN_SUMMARY_SELECT`）。就地合行路径只替换了
项行、从未重算 `plan.summary`：

1. `withItem`（标结果 / 存备注）：`items` 换行了，`summary` 原样带过——头部一切
   读数都挂在 summary 上，行变了数不动；
2. `removeItem`（移出计划）：同上，被移走的项可能带着已标记结果；
3. 编辑弹窗 `onCreated`：`{ ...plan, ...updated }` 里 `updated` 是 PATCH 响应，
   而后端 PATCH 明确不带真实计数（「UPDATE 不动 items」），`mapTestPlan` 对缺席
   计数键兜底 0——一次改名就把 summary 铺成全零。

## 修法

前端就地重算（与后端 `PLAN_SUMMARY_SELECT` 同一口径：total = 项数，四值按
result 计数；详情本就是全量项，项行在手即真值，不必回服务端）：

- 新增 `summaryOf(items)`；`withItem` 与 `removeItem` 合行后用它重算；
- 编辑弹窗合流显式钉住 `summary: plan.summary`（PATCH 只动头字段，计数沿用
  手上这份——后端响应的零值不采信）。

## 状态

已修（`TestPlans.tsx` 三处，纯前端）。web 是 vite 热重载；待用户标一条结果看
头部计数与悬停计数同步推进。
