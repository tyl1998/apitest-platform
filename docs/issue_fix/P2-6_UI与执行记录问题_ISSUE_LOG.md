# P2-6 循环 / FlowRunDrawer / 侧栏对齐 / 执行记录刷新 — 问题记录

> **验收状态**：待验收。

> 记录循环/子流程（P2-6）相关 UI 与执行记录链路在本次修复迭代中发现的问题。仅收录 bug 本身：现象、根因、修法、状态。按修复顺序排列。

---

## #1 流程历史侧栏展开后与画布框头不齐

**发现阶段**：视觉验收。折叠 rail 时顶部对齐，展开侧栏后顶部偏低。

**现象**：流程编辑器里，历史侧栏折叠为竖向 rail 时与画布框头平齐；展开后侧栏卡片因 `.panel` 默认 `margin-top` 比画布低一截，视觉上对不齐。

**根因**：`.history-card` 继承 `.panel { margin-top: var(--s5) }`，而 `.flow-body` 已经把顶部间距统一放在容器上，卡片不应再额外加 margin。

**修法**：`.flow-body .history-card { margin-top: 0; }`。

**状态**：已修复（`apitest-web/src/design-system.css`）

---

## #2 接口编辑器折叠 rail 与主面板 header 不齐

**发现阶段**：视觉验收。接口编辑器里折叠 rail 与 URL 编辑区 header 不在同一水平线。

**现象**：接口编辑器（EndpointWorkspace）主 `.panel` 有 `margin-top: var(--s5)`，但折叠后的 `history-rail` 直接贴到 `.workbench` 顶部，导致 rail 比主面板 header 高/低。

**根因**：`history-rail` 的 `top` 是 `var(--s4)`，且没有与 `.panel` header 对齐的 margin。

**修法**：
- `.history-rail` 的 `top` 改为 `var(--s5)`；
- `.workbench .history-rail { margin-top: var(--s5); }`。

**状态**：已修复（`apitest-web/src/design-system.css`）

---

## #3 FlowRunDrawer 行样式、展开内容与批量调试不一致

**发现阶段**：UI 走查。流程运行抽屉与批量调试抽屉样式存在差异。

**现象**：
- FlowRunDrawer 每行多了 `run-step-kind` 类型前缀；
- 时间写法是 `{durationMs.toFixed(1)} ms`（带空格），批量调试是 `{durationMs}ms`；
- Drawer 宽度 760px，批量调试是 720px；
- 请求并发容器未被识别为可展开容器。

**根因**：FlowRunDrawer 在复用 `.batch-item` 样式时加了额外前缀，宽度未统一，且容器判定只写了 loop/subflow。

**修法**：
- 移除行内 `run-step-kind` 前缀；
- 时间格式与批量调试统一；
- Drawer 宽度改为 720px；
- 容器判定扩展为「loop / subflow / 任何 `output.iterations` 非空的步骤」，兼容请求并发容器。

**状态**：已修复（`apitest-web/src/components/FlowRunDrawer.tsx`、`apitest-web/src/design-system.css`）

---

## #4 循环展开后每步对应不到具体执行

**发现阶段**：功能验收。循环迭代展开后，里面请求步骤点不开请求/响应快照。

**现象**：循环→迭代→请求步骤，点开只显示步骤 `output` JSON，没有 ExecutionDetail 的请求/响应快照；行内状态码也是 `—`。

**根因**：
- 后端：普通单次请求（含循环体内的单次请求）运行时，`executeRequestStep` 只要传了 `containerStepId` 就会创建子步骤行并把 `http_execution_id` 挂在子步骤上，真正展示的那一行 `http_execution_id` 为空；
- 前端：`NestedStepList` 只按 `step.httpExecutionId` 查找 execution，且没有处理请求并发容器。

**修法**：
- 后端：`childStepId` 只在并发迭代（`iteration !== undefined`）时创建，普通单次请求直接写当前步骤的 `http_execution_id`；
- 前端：`NestedStepList` 支持请求并发容器递归展开；嵌套行优先用 execution 的 statusCode/durationMs；切换父步骤时清空展开状态。

**状态**：已修复（`apitest-server/src/lib/flowGraph.ts`、`apitest-web/src/components/NestedStepList.tsx`、`apitest-web/src/components/FlowRunDrawer.tsx`）

**遗留说明**：旧 run 的 `http_execution_id` 已为空，无法 retroactive 回填，只能在新 run 中生效。

---

## #5 流程执行完成后侧栏记录没有刷新

**发现阶段**：功能验收。新跑一次流程后，右侧运行记录侧栏仍显示旧列表。

**现象**：点击「运行流程」或流程到达终态后，历史侧栏不会自动出现最新记录。

**根因**：侧栏加载 effect 只依赖项目/流程/筛选条件/分页，未在「开始新运行」或「收到终态事件」时触发刷新。

**修法**：
- 抽出 `loadHistory` 并 memo；
- `start()` 后调用 `loadHistory()`；
- 流执行收到终态事件后调用 `loadHistory()`。

**状态**：已修复（`apitest-web/src/components/FlowWorkspace.tsx`）

---

## #6 循环体内单次请求实际仍取不到结果

**发现阶段**：复测 #4 时再次发现。循环体里的单次请求步骤状态码仍显示 `—`，展开只能看到 `output` JSON。

**现象**：同 #4，但 #4 只修复了前端容器判定，未修复后端 `http_execution_id` 挂错行的问题。

**根因**：`apitest-server/src/lib/flowGraph.ts` 中 `executeRequestStep` 对 `concurrency === 1` 的常规请求也错误地创建了子步骤，导致 `http_execution_id` 未挂到展示行。

**修法**：`const childStepId = containerStepId && iteration !== undefined ? randomUUID() : undefined;`——只有请求并发迭代才创建子步骤。

**状态**：已修复（`apitest-server/src/lib/flowGraph.ts`）

**遗留说明**：同 #4，旧 run 不可恢复，需新 run 验证。
