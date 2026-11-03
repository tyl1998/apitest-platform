# P1-2 Flow DAG 编排 — 问题记录

> 记录从首轮实现到多轮反馈修复期间发现的所有问题、根因、修法与关键取舍。
> 按发现顺序排列，每一条标注发现阶段与状态。

---

## 一、架构决策（实现前确认，3 项）

| # | 问题 | 选项与定案 | 状态 |
|---|---|---|---|
| 1 | Flow 执行与 `executions` 表的关系 | **父表 + 复用 executions**。新增 `flow_executions` 父记录（类比 `batch_executions`），每个节点的执行仍是一条 `executions` 行，`source` 扩出 `flow_step`。否决了「节点结果塞进父表 JSONB」——那样快照抽屉、取消、回收都要各写一套。 | 已定 |
| 2 | 首轮节点类型 | **只做 request 节点 + 变量提取**。条件/循环/脚本/等待/子流程按需排期。没有提取的 DAG 只是一串互不相关的请求，所以提取与请求节点同批交付。 | 已定 |
| 3 | 节点请求来源与隔离 | **快照隔离，可从接口/用例种入**。节点存 `request` 副本 + 断言 + 提取规则，`endpointId` 只表达来源与归属。接口后续被改不回溯影响已建流程——与 P1-1 用例同一条原则。 | 已定 |

---

## 二、首轮验收反馈（6 项）

触发场景：用户首次体验完成后的集中反馈。

### #4 提取失败无法定位具体值

**现象**：提取失败时只有一句 `could not extract: a, b`，用户不知道是路径写错、响应不是 JSON、还是字段确实是 null——三种原因的修法完全不同。

**根因**：`applyExtracts` 把失败压成一行 `missing: string[]`。

**修法**：
- 迁移 `013_p12_extract_results.sql`：`executions.extract_results JSONB` 逐条记录 `{ name, from, path, ok, value | reason }`
- `applyExtracts` 返回逐条结果，区分「路径不存在」与「字段为 null」
- 前端提取行下方直接显示 `= 值` 或具体原因

**状态**：已修复

---

### #5 节点只显示单步调试结果

**现象**：跑完整条流程后打开节点抽屉，显示的仍是旧的单步调试结果，不是流程那次运行的。

**根因**：抽屉的 `result` 状态只在单步调试时设置，跑整条流程后没有更新。

**修法**：
- 新增 `GET /flows/:flowId/nodes/executions?nodeId=`，返回流程步骤与单步调试混合历史（新→旧），抽屉取 `runs[0]`
- 面板标注「来自流程运行 / 来自单步调试」

**状态**：已修复

---

### #6 画布上不能删除节点

**现象**：删除一个步骤必须打开它，在抽屉里点删除。

**修法**：
- 节点悬停显示删除按钮（`nodrag` 避免被画布拖拽吞掉）
- 支持 Backspace/Delete 删除选中节点与连线
- `onNodesDelete` 回写文档（画布只持有位置，不回写节点会复活）

**状态**：已修复

---

### #7 节点不能引用用例

**现象**：节点只能从接口种入，不能从已有的测试用例种入。实际场景中用例往往比裸接口定义更接近一个步骤该有的样子（带着断言）。

**修法**：
- 新增 `GET /flows/node-source?endpointId=|caseId=`
- 节点来源可选「接口」或「用例」，用例来源连同断言一起带过来
- 仍是快照复制，来源后续被改不回溯

**状态**：已修复

---

### #8 提取不能快速选取

**现象**：写提取规则时只能手打 JSONPath。

**修法**：
- 复用 `JsonPathPicker` / `HeaderPicker`，从本节点最近一次响应勾选路径生成提取行
- 变量名按末段自动建议（`$.data.access_token` → `access_token`）
- 没跑过的节点禁用快速选取并说明原因

**状态**：已修复

---

### #9 变量引用容易记错（全局缺陷）

**现象**：流程的变量定义在三个地方（上游提取、流程初始变量、环境），打字拼错 `{{tokne}}` 不会报错，直接带着字面量发出去，变成了一个难以定位的 401。

**修法**：
- 新建 `VariablePicker` + `lib/flowVariables.ts`
- 按「上游步骤提取 → 流程变量 → 环境变量 → 内置动态变量」分组
- 上游只列真正在它之前执行的节点（沿边反向求祖先）；流程初始变量处整组隐藏步骤提取
- 环境 secret 只列名不列值

**状态**：已修复

---

## 三、关键实现缺陷（实现中自发现，4 项）

### #10 `run.ts` ⇄ `flow.ts` 循环依赖

**现象**：`flow.ts` import `run.ts` 的 `METHODS`/`BODY_TYPES`，而 `run.ts` 又 import `flow.ts` 的 `applyExtracts`。ESM 下函数调用时惰性求值可运行，但脆弱。

**修法**：`METHODS`/`BODY_TYPES` 抽到新文件 `lib/http.ts`，两端 import 同一处。

**状态**：已修复

---

### #11 节点 id 碰撞风险

**现象**：节点 id 用 `n${Date.now().toString(36)}` 生成。节点 id 是执行历史里标识步骤的字段、活得比流程文档久——同毫秒创建或复制流程会撞 id，两条流程的运行记录混在一起。

**修法**：改为 `crypto.randomUUID()`。

**状态**：已修复

---

### #12 `KeyValueEditor` 入参类型不匹配

**现象**：`KeyValueEditor` 接收 `Pair[]`，但变量、headers 等以 `Record<string,string>` 存储。直接传 Record 会编译失败。

**修法**：在 FlowNodeDrawer 和 FlowWorkspace 的调用点加 `toPairs`/`fromPairs` 状态管理，与 EndpointWorkspace 同款。

**状态**：已修复

---

### #13 Inflight 中断句柄作用域不足

**现象**：`inflight` Map 是 `worker.ts` 的私有变量。流程执行时每一步都创建一条独立的 `executions` 行，但 `cancelRun` 广播的是步骤的 executionId——`flowRun.ts` 无法登记这些句柄，取消某一步时只改了数据库状态，`fetch` 仍在跑。

**修法**：`inflight` 提成 `lib/inflight.ts` 共享模块。`worker.ts` 和 `flowRun.ts` 都通过 `registerInflight`/`releaseInflight` 操作同一个 Map。

**状态**：已修复

---

## 四、批量绑定包场景压力测试（1 项连锁发现）

触发场景：用户举例一个真实接口链路——生包 → 遍历 body 取出所有包号组成新 body → AES 加密给 body 做签名放 header → 绑定包 → 校验包返回与 DB 一致。

### #14 结构化变量缺陷 + 脚本节点缺失 + 无加密能力 + 无 DB 节点

**测试结果**：7 个环节中 3 个支持（顺序执行、sign 放请求头、断言返回成功），4 个不支持。

| 环节 | 问题 |
|---|---|
| 提取整数组重组 | 提取到的数组 `JSON.stringify` 后放进 JSON body 会退化成字符串 `"[...]"` 而非数组 `[...]` |
| AES 加密生成 sign | 沙箱探测：`crypto: undefined`, `Buffer: undefined`, `TextEncoder: undefined`，无任何加密原语 |
| 脚本节点 | 脚本只能作为断言（return boolean），不能产出变量或改写请求 |
| 对比数据库数据 | 数据库节点在 P2 |

**根因链**：
1. 变量袋 `Record<string,string>` ——所有值强制转字符串，数组被 `JSON.stringify` 后再注入 JSON body 时二次转义
2. 沙箱是全新 vm context，不含 Node 全局——这是刻意设计，但意味着零加密能力
3. 没有「在变量展开之后、请求发出之前改写请求」的钩子位置

**修法（三件事合为一次改动）**：
1. **结构化变量**：`resolve.ts` 新增 `SOLE_REFERENCE` 模式区分「整字段替换」与「字符串内插值」。`{{items}}` 作为 JSON body 的整字段值时解析为数组，作为 URL 的一部分时仍是文本。
2. **沙箱 crypto 原语**：`sandbox.ts` 重写，注入一个宿主函数（crypto 桥）。桥两端只传 JSON 字符串，不传宿主对象；宿主侧用 `crypto.getHashes()` / `getCiphers()` 动态校验算法而非白名单；密钥用 `{secret:"NAME"}` 按名引用，宿主侧解析，沙箱侧永远看不到明文。做了三重加固：只传 JSON 字符串、重设原型到沙箱 realm、bootstrap 后删除全局引用。
3. **前置钩子**：`lib/hooks.ts` 作为可插拔接口层（`applyPreRequestHooks`），脚本是第一个 provider。`run.ts` 在 `buildRequest` 之后、`fetch` 之前调用。钩子失败不发请求（放行未签名请求只会从被测服务拿回 401，真正错误在脚本里）。

**关键取舍**：sandbox.ts 弱化了「绝对没有宿主对象进沙箱」的边界——这是本轮唯一降低了安全假设的改动，换取的是不再需要在沙箱里手写 AES。真正的边界仍是 worker 进程隔离。记录在迁移 014 和相关文件中。

**状态**：已修复（后端全通，前端 UI 后续补齐）

---

### #14.1 加密变体如何兜底（架构讨论）

**问题**：AES 有 CBC/GCM/ECB，SM4 是国产算法，还有公司自研的分组密码——平台不可能枚举所有算法。盐、字段排序、双重加密又是无限组合。

**定案**：分两层处理，不同层用不同机制。
- **算法层（有限）**：平台提供字节级可组合原语 `ctx.crypto.encrypt/hash/hmac/sign/xor`，输入字节输出字节，不提供成品签名函数。算法查 OpenSSL 目录而非白名单。
- **约定层（无限）**：脚本负责。盐就是字符串拼接，字段排序就是 JS sort，平台不用管。
- **脚本库引用（代码共享）**：`script_deps` 表 + 脚本拼接——一份 SM4 实现不用贴进 30 个脚本。
- **外部签名器（最后手段）**：前置钩子定义成接口而非实现（`HookProvider`），将来接 webhook provider 是纯增量，不重改执行链路。

**状态**：已定案并实现

---

### #14.2 加密变体不可完整性（架构确认）

**问题**：即使有了随时可加的 webhook provider，有些算法仍不可做（HSM、必须调 jar、闭源 SDK、硬件证书）。

**定案**：完备性不可达，且不该当目标。目标是「没有做不到，只有多麻烦」。四层兜底（原语→脚本组合→纯 JS 手写→外部签名器），失败报具体原因而非静默不签名。`ctx.debug()` 记录待签原串是比覆盖更多算法更紧迫的事——签名不对的时候，第一件事是看签的到底是哪串字节。

**状态**：已确认

---

## 五、第二轮验收反馈（3 项 UI 问题）

### #15 脚本编辑器按钮割裂

**现象**：用例校验页的脚本编辑器里，折叠箭头、来源下拉、「私有脚本/脱离/存为公共」、「试运行」几个按钮散布在多行，权重不一致，读起来像三个不相关的控件。

**修法**：一行两段——左边是「这个脚本是什么」（折叠 + 来源 + 跟随提示），右边用 `margin-left: auto` 成组放「脱离/存为公共 + 试运行」。

**状态**：已修复

---

### #16 流程节点请求 Tab 按钮太多

**现象**：请求 Tab 有 URL 旁的 VariablePicker + body editor 旁的 VariablePicker + headers/params 表格……每个值输入框都配一个「插入变量」按钮，越看越重。

**修法**：
- 新建 `VariableField` 组件：包装 `input`/`textarea`，输入 `{{` 时弹出变量补全列表，实时过滤，上下键选择，Enter/Tab 确认，Esc 关闭。在光标处插入而非追加到末尾。
- 移除 FlowNodeDrawer 中所有 `VariablePicker` 按钮，URL 和 body 换为 `VariableField`
- 已有 `{{var}}` 后面的光标不会误弹出（检测括号闭合）

**状态**：已修复

---

### #17 重复的「从响应提取」

**现象**：提取页签有两个入口做同一件事——每行右侧的准星图标，和列表底部的「从响应提取」批量按钮。

**修法**：删除底部批量按钮。只有一条路径：加一行 → 用那行的准星挑字段。

**状态**：已修复

---

### #18 变量补全未覆盖接口管理页

**现象**：`VariableField` 只加了流程页的节点抽屉和画布，接口管理编辑页的 URL 和 body 仍用普通 `input`/`textarea`。

**修法**：EndpointWorkspace 的 URL 和 body 也换为 `VariableField`。`variableOptions()` 的 `nodes`/`edges`/`variables` 改为可选——接口页没有流程上下文，可选变量就是「当前绑定环境的变量 + 内置动态变量」。

**状态**：已修复

---

## 六、前置钩子前端缺口（4 项，本轮实现）

前置钩子的后端在 #14 已全部打通，但前端没有入口——用户在界面上配不了签名。

### #19 前端 PreRequestHook 类型与后端不一致

**现象**：前端类型有 `id: string`、`type: "script"|"hmac"|"aesBody"|"timestampNonce"`、`config: Record<string,string>`，但后端只认 `{ type:"script", name?, enabled?, script? }`。保存后 `id` 丢失，React 行 key 失效；builtin types 后端从未实现。

**根因**：前端类型先于后端实现，假设了泛化的钩子形态。

**修法**：
- 前端 `PreRequestHook` 对齐后端 `HookConfig`：`id?:string`, `type:"script"`, `enabled?:boolean`, `script?:ScriptRef`
- 抽屉行 key 改用数组 index（服务端位置性存储，无 id 可持久化）
- 移除 `config` 字段和 `hmac`/`aesBody`/`timestampNonce` 类型

**状态**：已修复

---

### #20 节点抽屉没有「前置」页签

**现象**：Tab 只有 `request | extracts | assertions`，配不了钩子。

**修法**：
- 新增「前置」页签，插在请求和提取之间
- 新建 `PreRequestHookEditor`：支持添加/删除/启用禁用/命名/折叠/试运行/存为公共
- 只列出 `kind="hook"` 的公共脚本，避免把断言脚本挂到前置槽位（不会报错，只会静默不签名）
- 跟随/脱离模型与脚本断言编辑器一致

**状态**：已实现，待验证

---

### #21 hookResults 无处展示

**现象**：`executions.hook_results` 已落库、`api.ts` 已定义类型，但没有任何组件渲染它。待签原串白记了。

**修法**：
- `ExecutionSnapshot` 中渲染 `hookResults`（放在请求快照之前，因为签名出问题先看这一块）
- 新建 `HookOutcome` 组件：展示成败、改写了请求的哪些部分、报错文本、`ctx.debug()` 记下的中间值（待签原串用 `<pre>` 完整展示，不折叠不截断）
- 节点抽屉的结果面板同样展示

**状态**：已实现，待验证

---

### #22 PublicScripts 不支持 kind

**现象**：公共脚本页只能建 `kind="assertion"` 的脚本，不能建前置脚本或脚本库。

**修法**：
- 新建/编辑抽屉增加「用途」下拉：断言/前置/脚本库，新建后不可改
- `kind` 变更时预填对应的模板（前置模板示范签名，库模板示范公共函数）
- 库脚本不可声明依赖（一级深、无环）
- 非库脚本可多选依赖的库脚本
- 列表行增加用途 chip

**状态**：已实现，待验证

---

## 七、基础设施类问题（4 项）

### #23 Docker 未启动导致迁移无法执行

**现象**：`docker compose up -d` 报 `ECONNREFUSED`，无法连接 OrbStack daemon。

**修法**：`open -a OrbStack` 启动 OrbStack，等待 socket 就绪后重新执行 compose 和 migrate。

**状态**：已规避（OrbStack 重启后正常）

---

### #24 API 进程中断导致执行行滞留

**现象**：API 进程 (`tsx watch`) 在会话中退出，已入队的 execution 停在 `queued`，worker 仍在运行但无法消费。

**根因**：`tsx watch` 在长时间编辑后可能因文件系统事件或 OOM 退出。

**修法**：重启 API 进程 + worker，卡死回收机制会扫走滞留行。非代码问题，`tsx watch` 是开发工具的限制。

**状态**：已规避（重启恢复）

---

### #25 端口冲突

**现象**：前端重启时报 `Port 5173 is in use`，自动跳到 5174。旧 vite 进程（PID 32429）来自之前的后台进程，未被 `background_process` 清理。

**修法**：`kill` 旧进程后重启，恢复 5173。

**状态**：已规避

---

### #26 Windows 路径误用

**现象**：多次在 macOS 环境下使用 `C:\Users\...` 风格的路径调用 grep/read 工具，返回空或无结果。

**根因**：工具调用时 path 参数未被正确设置为 macOS 绝对路径。

**修法**：每次调用前显式拼接 `/Users/atan/Desktop/work/vscode_js/openApiTest/` 前缀。

**状态**：反复出现，非代码问题

---

## 八、待讨论（2 项）

### #27 后续节点类型排期

| 节点类型 | 建议归属 | 理由 |
|---|---|---|
| 脚本节点 | 可立即做 | 沙箱、`scripts` 表、`owner_flow_id`、`ctx` 全部就绪，只差把变量袋读写接进 ctx |
| 条件节点 | P2 随场景 | 需要「节点被跳过」状态与边条件语义，场景编排同样需要分支 |
| 数据库节点 | P2 | 强依赖 P2 数据源与命名 SQL |
| 循环节点 | P3 或按需 | 需要定义迭代变量、最大轮次、失败中断，且与并行执行纠缠 |

**状态**：待决策

---

### #28 前置钩子 UI 尚未端到端验证

**现象**：#20–#22 的修法已实现（typecheck + build 通过），但没有实际建一个 AES 签名 hook、配到节点上、跑整条流程验证待签原串出现在结果中。

**状态**：待用户手动验证

---

## 九、前置钩子运行与保存链路（4 项，已修复）

触发场景：用户在流程「测试」里配了签名钩子，发现环境变量取不到、保存后编辑器显示旧脚本。查代码与数据库（`flows.variables` 已含 `SIGN_KEY`，所选环境 `debug` 只有 `{"test":"1"}`）后定位出四条独立问题。

### #29 钩子试运行拿不到环境/流程变量

**现象**：钩子编辑器「试运行」里 `ctx.variables["SIGN_KEY"]` 取流程变量报 `key must be a string, { secret: "NAME" } or { value, encoding }`；改用 `{ secret: "SIGN_KEY" }` 报 `no secret named "SIGN_KEY" in this environment`。即使变量确实存在于流程变量或环境中。

**根因**：
- `POST /scripts/try` 对 hook 只传 `request.body?.variables ?? {}`（`scripts.ts:331`），而前端 `PreRequestHookEditor.tryRun` 的 payload **没有 variables 字段**（`PreRequestHookEditor.tsx:191-196`），所以 `ctx.variables` 恒为 `{}`。
- `runScriptHook` 的 `resolveSecret` 用默认 `() => undefined`（`sandbox.ts:591`），试运行里 `{ secret }` 永远解析不到。
- 试运行不加载所选环境、也不加载流程变量，只是一个与真实执行完全隔离的沙箱。

**影响**：试运行只能验证语法与 `ctx.crypto`/`ctx.encoding` 用法；任何依赖环境变量/密钥的签名脚本在试运行里必然失败，容易误导用户以为变量没写对。

**修法**：
- 后端 `/scripts/try` 的 hook 分支支持 `environmentId`：`loadEnvironment` 注入变量袋（环境变量 + 显式传入叠加），并为 `{ secret }` 提供真实 `resolveSecret`（`routes/scripts.ts`）。
- 前端 `PreRequestHookEditor` 新增 `environmentId`/`variables` props 并透传 try payload；`FlowNodeDrawer` 传入流程所选环境与种子变量。

**状态**：已修复

---

### #30 流程单步调试不执行前置钩子

**现象**：`POST /flows/:id/nodes/execute` 单步调试已入队并发送请求（`hook_results = []`），但节点上配置的钩子一次都没跑。

**根因**：`enqueueRun` 的 `EnqueueInput` / `RunSpec` **没有 hooks 字段**，单步调试路由（`flows.ts:282-300`）也没传 hooks，钩子在单步调试链路被整体丢弃。

**影响**：签名节点单步调试发出的是未签名请求，得到 401 却无从在界面上诊断签名脚本。

**修法**：`EnqueueInput`/`RunSpec` 增加 `hooks`，`enqueueRun` 用 `inlineHookContent` 内联后写入 run_spec；单步调试路由把 `node.preRequestHooks` 传入（`routes/flows.ts`）。

**状态**：已修复

---

### #31 整流程执行时钩子脚本内容未内联

**现象**：存库的节点钩子只有 `{ script: { scriptId } }`（`persistFlowScripts` 有意剥离 content），而 `enqueueFlowRun` 只内联节点断言、**不内联钩子**（`enqueue.ts:186-188`）。整流程真跑时 `hooks.ts` 的 `scriptProvider` 取 `config.script?.content` 为空，报 `hook script content is missing`。

**影响**：已保存流程上的钩子在整流程运行时必然失败（除非画布以未保存节点 + 内联 content 的方式运行）。

**修法**：`enqueueFlowRun` 对 `node.preRequestHooks` 走 `inlineHookContent`，与断言同批内联（入队即固化）（`lib/enqueue.ts`）。

**状态**：已修复

---

### #32 前置钩子保存后编辑器显示旧脚本

**现象**：编辑钩子内容后 Cmd+S 保存，编辑器仍显示旧内容，刷新页面才正常。

**根因**：
- 保存后服务端把钩子 content 剥离、只回 `{ scriptId }`（`scripts.ts:119`），前端 `setSteps(saved.nodes)` 更新后 `hook.script.content` 为 `undefined`。
- `PreRequestHookEditor.contentOf` 回退到 `referencedScript(hook)?.content`，来自组件内 `resolved` 缓存——缓存是打开流程时拉的**旧内容**。
- `requested` 集合保证「每个 id 只拉一次」（`PreRequestHookEditor.tsx:76,116-132`），保存不改变 `referencedIds`，effect 不重拉，于是旧内容一直显示到页面刷新（刷新重置缓存后重新 `api.script(id)` 拉到新内容）。

**修法**：`PreRequestHookEditor` 检测「某 scriptId 之前带 content、保存后被剥离为无 content」的过渡，将该 id 从 `requested` 与 `resolved` 中清除并 bump `scriptRev`，让现有 effect 重拉一次（`components/PreRequestHookEditor.tsx`）。`ScriptAssertionEditor` 无「每 id 只拉一次」的集合，不受此影响。

**状态**：已修复
