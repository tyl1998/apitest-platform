# 问题记录 — MCP 创建的接口在流程编辑器里显示为裸 id

日期：2026-09-06 · 触发场景：P5-5 MCP 写工具用户验收

## 现象

用 `create_endpoint`（MCP）创建接口、agent 用 `upsert_flow` 建了引用它的请求节点后，
打开流程编辑器：

1. 节点「来源接口」下拉里**找不到**新接口；
2. 该控件的当前值直接渲染成一个**裸 UUID**（接口的 endpointId），而不是
   `GET  接口名`。

接口行本身完好（name/method/url 均正确落库），接口列表页刷新后也能看到。

## 根因（两层叠加）

1. **store 不感知带外写入**：`projectStore.endpoints` 只在进项目时加载一次
   （`loadProject`），此后只有接口页自己的 REST 写路径会调 `reloadEndpoints()`。
   MCP 写工具改库不经过任何前端写路径，store 保持旧列表。
2. **Select 无兜底选项**：`FlowNodeDrawer` 的接口来源 Select
   （`value={current.endpointId}`，options 来自 store 列表）——antd Select 的 value
   不在 options 里时**直接把 value 本身渲染出来**，于是显示裸 UUID。同文件里
   case 来源的 Select 对「用例已删」有兜底选项（用 `sourceCaseName` 快照），
   endpoint 来源没有对应处理。

## 修法

- `FlowWorkspace.tsx`：进编辑器的既有引用数据 effect（dataSources / 标签建议，
  本就是每次进来现拉）里补 `reloadEndpoints()`——接口清单不该是唯一来自旧 store
  的例外；
- `FlowNodeDrawer.tsx`：接口来源 Select 增加「value 不在列表」的兜底选项
  （label 用节点自身的 `method + name`），与 case 来源的兜底同款——接口被删、
  或列表刷新前的窗口期，控件都可读而不是一串 UUID。

## 顺带核查（用户第二问）

CI 任务日志（`get_run_logs`）**无同类问题**：它没有「整体不给」分支——任务在则
run 在（`pipeline_runs` 级联），遮蔽集 = 该 CI 任务 env 当前值（任务存在时恒为数组，
空 env 等于原文），日志按尾部 200 行 + 64KB 返回。`get_execution` 那个「无环境执行
证据整体不给」的问题（当日已另行修订为按项目 secret 并集遮蔽后返回）在 CI 日志
路径上不存在。

## 状态

已修复（`pnpm check` 过；待用户刷新页面验证——进流程编辑器时接口清单会重新拉取，
新接口出现在下拉里，存量已保存节点不再显示裸 id）。
