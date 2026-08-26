# P2-4 测试套件 + 统一执行记录 — 问题记录

> **验收状态**：P2-4.1（套件定义 + 成员选择）2026-08-24 验收，P2-4.2（执行后端）、P2-4.3
> （前端闭环）与 P2-4.4（统一父执行列表）2026-08-25 验收，**P2-4.5（引用保护）2026-08-26
> 验收并随验收落地 3 项增补**（见 DEVELOPMENT_PLAN.md 5.0.11「P2-4.5 验收增补」）。
> 本文件 #1–#12 全部已修（#7–#9 是 P2-4.4 实现期间走查发现的，#10 是 P2-4.5 走查发现的，
> #11–#12 是 P2-4.5 验收提出的）。
>
> 记录 P2-4 各批次实现与验收期间发现的实际缺陷。仅收录 bug 本身：现象、根因、修法、状态。
> 范围、边界与分批决策在 `DEVELOPMENT_PLAN.md` 5.0.11，不写进本文件。

---

## #1 新建套件与预览成员都报「selection.members is required for a manual selection」

**发现阶段**：P2-4.1 首轮用户验收。

**现象**：两处都走不通——

1. 在套件列表点「创建套件」（手动选择），提交即报 `selection.members is required for a manual selection`；
2. 一个还没有成员的手动套件，点「预览成员」报同一句。

**根因**：`validateSelection` 把手动选择的成员数校验写成了「必须非空」。但**新建套件必然从零成员
开始**——创建流程本身就是「先建套件 → 进配置页 → 添加成员」，第一步不可能带成员。校验把一个
必经的中间状态当成了非法输入。

「套件里没有成员不能运行」是**执行**时的约束，属于入队路径（P2-4.2），不该提前到保存与预览。

**修法**：保存与预览只校验形状（是数组、成员类型合法、id 是 UUID、不重复、不超 200），允许空
数组；空成员在预览里就是「解析不出任何成员」，如实显示。tag 选择的标签数组同理放开。
非空要求留给 P2-4.2 的 `enqueueSuiteRun`。

**状态**：已修复（`apitest-server/src/routes/suites.ts` `validateSelection`）

---

## #2 空标签的「按标签」套件会解析成整个项目（同批走查发现）

**发现阶段**：修 #1 时顺带走查 `resolveMembers` 的空值路径。

**现象**：一个刚创建、还没填标签的「按标签」套件，若匹配方式是「满足全部标签」，预览会列出
项目里**所有**用例与流程；匹配方式为「满足任一标签」时正常返回零个。

**根因**：SQL 直接把空数组交给了标签运算符。Postgres 的 `tags @> '{}'` 对**每一行都为真**
（任何数组都包含空数组），而 `tags && '{}'`（重叠）对每一行为假。于是同一个「什么都没填」的
配置，在两种匹配方式下一个是「全选」、一个是「全不选」。

一个还没填条件的套件绝不该是「跑全部」的意思——尤其它下一步就要真的去执行。

**修法**：`resolveMembers` 在拼 SQL 之前短路：标签为空（trim 后）直接返回零个成员，不区分
匹配方式。标签同时做 trim + 去空，与保存路径 `toSelectionConfig` 的处理一致。

**状态**：已修复（`apitest-server/src/routes/suites.ts` `resolveMembers`）

---

## #3 保存成功后页面仍显示「未保存」

**发现阶段**：P2-4.1 首轮用户验收。

**现象**：套件配置页点保存，提示「套件已保存」，但右上角的「未保存」标记不消失。

**根因**：脏标记用 `JSON.stringify(A) !== JSON.stringify(B)` 判断，而 `JSON.stringify` **对键的
书写顺序敏感**：草稿里的对象是前端按自己的顺序拼的，保存后拿到的是服务端 mapper 按它的顺序拼的，
内容相同也会得到不同字符串。名字两端空格同理——保存时 `trim()` 过，比较时没 trim，于是永远对不上。

**修法**：两层。

1. 保存成功后**用服务端返回的那份回填草稿**——它才是「库里现在是什么」，任何规范化（trim、
   标签去空、`environmentId` 被清掉）都不会再留下差异；
2. 比较前做稳定序列化（递归排序键、丢掉 `undefined`、字符串 trim），让普通编辑也不会产生假脏。

**状态**：已修复（`apitest-web/src/components/SuiteWorkspace.tsx`）

---

## #4 手动套件里已被删除的成员会在下次添加成员时被静默删掉

**发现阶段**：修 #3 时走查 `draft.members` 与 `selection.members` 的对应关系。

**现象**：手动套件引用的用例被删除后，配置页的成员列表少一行（解析不到就不显示），但保存的
`selection.members` 里仍有那条引用。此时只要再添加任意一个成员，列表就会被整份重建成
`selection.members` —— 那条引用**随之消失**，用户从未同意删除它。

**根因**：成员列表由 `preview` 的解析结果填充，而 `selection.members` 是重建的**依据**。
两者长度一旦不等，重建就等于按短的那份截断。

**修法**：打开页面时按 `selection.members` 的声明顺序逐条对齐解析结果，解析不到的保留成
`missing` 行并在界面上标注「已不存在」。列表与 `selection.members` 因此始终等长同序，
删除只能由用户点删除按钮发生。

**状态**：已修复（`apitest-web/src/components/SuiteWorkspace.tsx`）

---

## #5 「按标签」选择永远选不到流程：流程没有标签编辑入口

**发现阶段**：P2-4.1 第二轮用户验收。

**现象**：套件用「按标签」选择、成员范围勾上「流程」，无论填什么标签都解析不出任何流程。

**根因**：`flows.tags` 列从 P1-2 就存在，流程列表也一直在**显示**标签 chip，`PUT /flows/:flowId`
也一直接受 `tags`——但流程编辑器从来没有编辑标签的控件。于是所有流程的 `tags` 恒为空数组，
匹配任何标签的条件当然命中不了任何流程。

只在用例侧验证标签选择就会看不到这个洞：用例的标签在用例编辑器里本来就能填。

**修法**：`FlowWorkspace` 头部（环境选择旁）加标签编辑，`mode="tags"` 允许新建、`options`
来自 `GET /projects/:id/tags?scope=members` 的已用标签建议；标签并入 `snapshot()` 的脏检查
与保存载荷，保存后从响应回填。

**状态**：已修复（`apitest-web/src/components/FlowWorkspace.tsx`、`src/i18n.ts`）

---

## #6 解析成员只看到「共 3 个成员」，看不到成员清单

**发现阶段**：P2-4.1 第二轮用户验收。

**现象**：「按标签」选择下点「解析当前成员」，条件旁边只出现一个「共 3 个成员」的计数，
成员具体是谁看不到。

**根因**：修 #2 时把**按钮**移进了「选择方式」面板，却把**结果列表**留在页面最下方的独立
面板里，中间还隔着「执行设置」。于是点完按钮，答案在两屏之外——按钮附近只剩一个数字。
上一轮的说明写成了「结果就地展开」，与实际渲染位置不符。

**修法**：把成员表连同超上限/悬空引用两条提示一起搬进选择方式面板，紧跟在按钮下面；
删掉页面末尾那个独立面板与随之不再使用的 `suites.previewTitle` 文案。

**状态**：已修复（`apitest-web/src/components/SuiteWorkspace.tsx`、`src/i18n.ts`）

---

## #7 单步调试写的一次性父索引混进父执行列表，点开必然 404

**发现阶段**：P2-4.4 走查（缺陷从 5.0.9 起就在，统一列表把它放到了主路径上）。

**现象**：执行记录页的父执行清单里夹着一些名字形如「订单流程: 查库存」的行，点开报加载失败。
它们既不是一次流程运行，也不是一次套件运行。

**根因**：非 HTTP 节点的单步调试（`routes/flows.ts` 的 `executeGenericStep`）需要给那一行
`execution_steps` 一个归属，于是它写一条 `kind='flow'` 的**一次性父索引**，`detail_id` 自指
（`VALUES ($1, …, $1, …)`）。而列表路由只按 `project_id` / `kind` / `status` / `target_name`
过滤，所以这些行与真实父执行并列返回；前端拿 `detailId` 去 `GET /flow-executions/:id`，
而这个 id 根本不是 `flow_executions` 的主键，必然 404。

这类行不能删——流程节点的历史证据（`GET /flows/:flowId/nodes/executions`）正是靠
`execution_index.target_id` 反查它们。

**修法**：列表 SQL 加一条 `detail_id <> id`。自指是这类行唯一稳定的标记：两张表的 id 都是
`randomUUID()`，真实父执行不可能撞上。不加列、不加迁移。

**状态**：已修复（`apitest-server/src/routes/executionIndex.ts`）

---

## #8 P2-4.3 交付后 `pnpm check` 是失败的（10 处类型错误）

**发现阶段**：P2-4.4 实现期间跑类型检查。

**现象**：`apitest-web` 的 `pnpm check` / `pnpm build` 报 10 处错误，全部落在 P2-4.1/4.3 新增的
两个文件里。`pnpm dev` 照常跑——`tsx` / Vite 不做类型检查，所以功能验收发现不了。

**根因**：两类：

1. `SuiteMemberPicker` 的 `<Empty title={…} />` 少传必填的 `hint`（`ui.tsx` 的 `Empty` 两个
   文案都是必填的：空态要说「下一步做什么」，只有标题就成了纯报告）。
2. `SuiteWorkspace` 在 `if (!draft) return …` 守卫之后，于**函数体内**读 `draft.xxx`。TS 不把
   守卫的窄化带进函数体（函数可能在任何时刻被调用），所以 `draft` 在 `save` / `runPreview` /
   `start` 里仍是 `Draft | undefined`。同文件的 JSX 里用的是 `draft!`，函数体漏了。

**修法**：补 `suites.pickerEmptyHint` 文案并传给 `Empty`；三个函数体内的 9 处改成 `draft!`，
与同文件既有写法一致。

**状态**：已修复（`apitest-web/src/components/SuiteMemberPicker.tsx`、`SuiteWorkspace.tsx`、
`src/i18n.ts`）

---

## #9 执行记录页每页 200 条会跳记录

**发现阶段**：P2-4.4 走查（缺陷从 5.0.9 起就在）。

**现象**：执行记录页把每页条数选成 200，父执行与批量调试两个大类只显示 100 行，翻到第 2 页
会漏掉 100 条记录。

**根因**：前端 `PAGE_SIZES` 提供 200，但服务端按分页约定把 `pageSize` 收在 100
（`Math.min(100, …)`，`/execution-index` 与 `/batch-executions` 都是）。于是分页器显示的是
服务端返回的 100，而下一页的偏移仍按前端状态里的 200 算——中间那一百条谁都不会显示。

**修法**：`PAGE_SIZES` 去掉 200，改为 `[20, 50, 100]`，与服务端上限对齐。不去放宽服务端上限：
100 是三条列表路由共同遵守的约定，为一个页面破例会让「记录页能选 200」变成又一处要各自记住的
特例。

**状态**：已修复（`apitest-web/src/components/ExecutionRecords.tsx`）

---

## #10 数据源/命名定义的引用扫描漏掉循环体内的数据库节点

**发现阶段**：P2-4.5 走查（缺陷从 P2-7 起就在，P2-4.5 让「引用扫描」成为删除前的必经路径）。

**现象**：删除一个数据源（或命名定义）时，usage 扫描显示「没人引用」，于是放行删除；但真有一条
流程在**循环体内**的数据库节点引用了它，删完这条流程要到下次入队时才报「数据源/定义不存在」。

**根因**：`dataSourceUsage` / `sqlUsage` 的扫描是 `flows.nodes @> '[{"dataSourceId": …}]'`。
`@>` 的右侧是一个**单元素数组**，它只匹配 `nodes` 数组**顶层**的元素。而循环体是内联子图
（`LoopFlowNode.body.nodes`），躺在循环里的数据库节点不在顶层数组里，`@>` 看不见它。P2-6 起
循环就是画布容器，这个盲区从那时就存在，只是此前「扫描」只服务于列表展示，没人把「没引用」当成
删除依据。

**修法**：新增 `lib/flowRefs.ts` 的 `flowsReferencing(projectId, key, value, excludeFlowId?)`，
用 `jsonb_path_exists(nodes, '$.** ? (@.<key> == $value)', jsonb_build_object('value', $value))`
递归匹配任意嵌套深度（值走 `vars` 绑定，不进路径文本）；`dataSourceUsage` / `sqlUsage` 两处
都改走它。P2-4.5 新增的 flow 反向扫描（子流程节点）复用同一个助手，所以循环体内的子流程引用
从一开始就不会漏。

**状态**：已修复（`apitest-server/src/lib/flowRefs.ts`、`src/routes/dataSources.ts`）

---

## #11 删掉被套件绑定的用例/流程后，套件成员列表仍显示「已不存在」的一行

**发现阶段**：P2-4.5 用户验收（用户提出的 3 项增补之一）。

**现象**：手动套件引用的用例（或流程）被 `?force=true` 删掉后，套件配置页的成员列表里仍挂着
一行——名字只剩 UUID、标注「已不存在」。用户要求：**已删除的用例/流程不应出现在套件成员列表里**。

**根因**：P2-4.5 原定「force 之后引用允许悬空」，套件预览把悬空成员挑进 `missing` 保留成行。
但悬空行不能运行、不能打开、没有可修的内容，唯一合理操作就是删掉它。`preview` 的
`resolveMembers` 为悬空引用返回的只有 `{type,id}`（名字已无处可查），界面上只剩 UUID 加一句
「已不存在」，等于一个无法操作的占位。

**修法**：把「删掉它」这件事在删除路径上做完。

1. 新增 `lib/suiteMembers.ts` `detachSuiteMember`：单条 SQL 用 `jsonb_set` 把
   `selection_config.members` 里的该引用就地摘除（`jsonb_agg ... ORDER BY ord` 保序，
   摘空写 `[]`）。
2. `DELETE /cases/:caseId` 与 `DELETE /flows/:flowId` 的 force 路径改为事务内先删资源、
   再摘成员，返回 `detachedSuites` 供界面说清「已从 N 个套件中移除该成员」。子流程节点引用
   不级联——那是画布上被连线引用的节点，静默删掉会破坏流程结构。
3. `SuiteWorkspace` 打开页面时解析不到的引用就地清除并进入未保存态（保存确认），不再渲染
   `missing` 行；调用方（FlowList / EndpointWorkspace）删除成功后按 `detachedSuites` 表态。

**状态**：已修复（`apitest-server/src/lib/suiteMembers.ts`、`src/routes/cases.ts`、
`src/routes/flows.ts`、`apitest-web/src/components/SuiteWorkspace.tsx`、`FlowList.tsx`、
`EndpointWorkspace.tsx`）

---

## #12 标签模式选/取消标签后，成员列表不自动加载

**发现阶段**：P2-4.5 用户验收（用户提出的 3 项增补之一）。

**现象**：套件用「按标签/全部」选择时，改完标签或成员范围后成员列表停在「尚未解析」，
必须再点一次「解析当前成员」才看得到它会跑到谁；进入配置页时同样不会先加载一次。
用户要求：**选/取消标签后默认加载成员进列表，进入页面也默认加载一次**。

**根因**：预览是手动触发的——`onChange` 里 `setPreview(undefined)`，只留下一个按钮。
标签与全部的成员本来就是算出来的，刚改完标签正是最想知道「现在会跑到谁」的那一刻，
让它等一次点击等于没给答案。

**修法**：`SuiteWorkspace` 对 tag/all 选择加防抖（400ms）自动 preview：

- 依赖用 `canonical` 序列化的选择键（含 concurrency），而不是对象引用——改名/改并发不会
  白白重解析，打字停顿后才发请求。
- 进页面在 tag/all 模式下自动解析一次；标签、匹配方式、成员范围任一变化后自动重新解析。
- `previewing` 时显示「搜索中」而不是闪回「尚未解析」；手动按钮文案改为「重新解析」，
  自动解析失败（静默）靠它兜底报错。

**状态**：已修复（`apitest-web/src/components/SuiteWorkspace.tsx`、`src/i18n.ts`）
