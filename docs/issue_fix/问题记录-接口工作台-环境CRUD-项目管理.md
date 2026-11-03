# 接口工作台 / 环境管理 / 项目管理 — 问题记录

日期：2026-08-12

## 需求

1. 编辑接口页保存后，「未保存」标记仍显示在页面上
2. 接口列表新增复制功能
3. 环境变量支持增删改查（删除需兼容是否有 case/接口在使用）
4. 根据文档审计 P0 实现程度并补齐遗漏
5. 编辑页快速切换接口时，左右箭头不在同一水平线
6. 项目管理删除「归档」概念
7. 主页退出按钮与项目内退出按钮样式不一致，以项目内为准
8. 编辑页「发送」按钮与「复制 cURL」按钮显示英文

## 涉及文件

| 文件 | 改动内容 |
|---|---|
| `apitest-web/src/components/EndpointWorkspace.tsx` | 未保存标记修复、历史抽屉、复制功能、回填请求 |
| `apitest-web/src/components/EndpointList.tsx` | 复制按钮、用例数占位列 |
| `apitest-web/src/components/Environments.tsx` | 重写为完整环境 CRUD（变量/密钥行编辑） |
| `apitest-web/src/components/GlobalApp.tsx` | 移除归档、统一退出按钮、补缺失 i18n key |
| `apitest-web/src/components/ProjectShell.tsx` | 项目切换器移除 status 过滤 |
| `apitest-web/src/components/ExecutionSnapshot.tsx` | 环境名展示、「回填到请求区」按钮 |
| `apitest-web/src/api.ts` | 类型与 API 方法（duplicate / usage / force 删除） |
| `apitest-web/src/i18n.ts` | 15 个缺失 key、环境管理全套文案、调试记录改名 |
| `apitest-web/src/design-system.css` | `.switcher` 对齐、操作列宽度、窄屏隐藏列 |
| `apitest-server/src/routes/environments.ts` | 完整 CRUD + secret 掩码 + 依赖扫描 + force 删除 |
| `apitest-server/src/routes/endpoints.ts` | 复制路由、执行记录写 environment_name |
| `apitest-server/src/routes/projects.ts` | 移除 status 可写 |
| `apitest-server/src/routes/dashboard.ts` | 移除 status 过滤与 activeProjectCount |
| `apitest-server/src/models/types.ts` | Environment.secretKeys、Project 去掉 status |
| `apitest-server/src/lib/resolve.ts` | 内置变量 + collectReferences |
| `apitest-server/migrations/004_environment_lifecycle.sql` | 执行记录 environment_name 快照列 |

---

## 1. 保存接口后「未保存」标记仍显示

**现象**：在编辑页点击保存，接口已成功保存（提示「接口已更新」），但页面上的「未保存」黄色标记仍然显示，直到下一次敲键才消失。

**原因**：`dirty` 由 `useMemo(() => JSON.stringify(draft) !== baseline.current, [draft])` 计算。`baseline` 是 `useRef`，保存成功后执行 `baseline.current = ...`，但 **ref 变更不会触发重渲染**，`draft` 又没变，`useMemo` 不重算，`dirty` 一直是 `true`。

**次要原因**：即使修好重渲染，`buildPayload()` 会对 name/url 做 `trim()`、对 tags 做拆分重组，而 `draft` 保留原始输入。若保存前输入带首尾空格，draft 与 baseline 仍不一致，标记照样残留。

**修复**：
- `baseline` 改为 `useState`，保存/加载时 `setBaseline(...)`，`dirty` 的依赖加上 `baseline`
- 保存成功后用发送的 payload 归一化 draft（trim 后的 name/description/url、重组后的 tags），并采用函数式 `setDraft` 防止覆盖保存期间的并发输入

## 2. 点击历史记录替换了当前页面的请求响应

**现象**：在工作台右侧历史列表点一条记录，内联响应面板被该记录覆盖，当前请求对应的响应丢失。

**原因**：历史点击直接 `setResult(run)`，与「发送」共用一个内联状态。历史记录是「过往证据」，与「当前请求的响应」是两个不同的东西，被设计成同一个 state 导致互相覆盖。

**修复**：拆成两个状态：
- `result`：只由「发送」写入，属于当前请求的内联响应
- `inspecting`：抽屉正在查看的记录，历史点击写入
- `?run=<id>` 现在只跟踪抽屉（深链语义 = "这条记录正打开着"），关闭抽屉时清除
- 新增「回填到请求区」按钮（见第 4.1 节）

## 3. 接口列表缺复制功能

**现象**：接口列表只有运行/编辑/删除，无法快速复制一个接口（常见于"同路径不同参数"的变体）。

**修复**：
- 后端新增 `POST /api/v1/projects/:id/endpoints/:endpointId/duplicate`：服务端整行 INSERT…SELECT 复制，名称按 `副本`、`副本 2`、`副本 3` 去重（名称不唯一，但列表全同名不可用）
- 选服务端复制而非"前端读→再创建"：原子完成，不会因第二步失败产生半成品接口，也不会因前端类型滞后丢失字段
- 列表行加 `CopyPlus` 图标按钮（列表停留原地），工作台加页头按钮（复制后跳转到副本编辑）

## 4. 环境变量不支持增删改查

**现象**：环境管理页只有「创建」和「列表」，无法编辑、重命名、删除环境，也无法对单个变量增删改。

### 4.1 前端 UI

重写 `Environments.tsx`：表格列出环境（名称/变量数/密钥数/编辑/删除），抽屉内逐行编辑变量：

- 每行：变量名、值、类型（Text / Secret）、删除
- 密钥值默认 `password` 输入框 + 掩码提示「已配置」，有 `Eye/EyeOff` 短时揭示
- 内置变量以只读徽章展示（见 4.4）

### 4.2 删除依赖扫描（对齐交互文档 4.4）

环境与接口的耦合是**按变量名**的（没有外键）。删除前新增 `GET /environments/:id/usage` 依赖扫描：

- 找出引用了「仅此环境提供」的变量的接口（同名变量在其他环境也提供则不算独占依赖）
- `DELETE` 被引用时默认返回 409，展示引用接口清单后带 `?force=true` 才放行
- 执行历史不阻塞删除，但删除前先把 `environment_name` 快照写回历史（见第 4.3 节）

### 4.3 删除环境后历史记录丢失环境信息（连带发现）

**现象**：`executions.environment_id` 外键是 `ON DELETE SET NULL`，删除环境后所有历史执行记录的"用了哪个环境"信息永久丢失。

**修复**：migration `004` 给 `executions` 增加 `environment_name` 列并回填，`executeEndpoint` 写入时快照环境名。删除环境后历史仍显示环境名（id 为 null 但名称保留），符合交互文档「历史保留环境快照」规则。

### 4.4 内置变量缺失（连带发现）

**现象**：Spec 2.1.2 要求 `$timestamp` / `$uuid` / `$randomInt` / `$randomStr` 内置变量，`resolve.ts` 从未实现。

**修复**：`resolveVariables` 支持 `$` 前缀，内置变量执行时即时生成、优先于环境变量（名字保留，防止环境遮蔽导致行为依赖所选环境）；未知变量保持 `{{name}}` 原文输出，让缺失在快照里可见而非静默变空。

## 5. P0 审计发现并补齐的遗漏

对照 `DEVELOPMENT_PLAN.md` 第三章，实际遗漏 3 项（主题切换、恢复上次页面经核实已实现，非遗漏）：

| 遗漏项 | 修复 |
|---|---|
| 「回填到请求区」（把某次执行的请求快照回填到编辑区快速改参重发） | 抽屉新增「回填到请求区」按钮；认证信息**不回填**——快照 Authorization 已脱敏为 `***`，照抄会把可用凭据替换成失效字面量，保留接口自身 auth 配置并过滤 `***` 值 header |
| 接口列表「用例数」列 | 后端列表返回 `caseCount: null`（非 0，`0` 会被读成"无用例"而事实是"功能没做"），前端显示 `—` |
| 「执行历史」→「调试记录」 | i18n 文案统一改名 |

## 6. 编辑页快速切换接口箭头不在同一水平线

**现象**：页头「上一个 / 下拉框 / 下一个」三个控件，左右箭头明显比下拉框低。

**原因**：`.switcher` 这个 class 在 `design-system.css` 里**从未定义**。三个子元素走普通 inline 流，落在文字基线上；30px 的 `IconButton` 与 antd Select（默认 32px）基线不一致导致错位。

**修复**：

```css
.switcher { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
```

## 7. 项目管理删除归档概念

**需求**：去掉项目「归档 / 恢复」。

**改动**：
- 前端：项目卡片去掉归档/恢复按钮与状态徽章，项目页、看板去掉状态筛选器，删掉 `ProjectStatusSelect` 组件
- 后端：`PATCH /projects/:id` 不再接受 `status`；`queryProjectMetrics` 去掉 `p.status` 过滤；看板响应去掉 `activeProjectCount`
- 类型：`Project` 去掉 `status`，`ProjectStatus` 类型删除
- 连带修复：`ProjectShell.tsx` 项目切换器原按 `status === "active"` 过滤，归档移除后该过滤会莫名隐藏项目，已去掉
- 数据库 `status` 列保留（默认 `active`，无代码读取；删列需迁移且无收益）

## 8. 主页退出按钮与项目内不一致

**现象**：主页侧栏底部退出是 `<button class="btn btn-icon">退出</button>`（文字按钮），项目内是 `IconButton` 图标按钮，两处外观完全不同。

**修复**：主页改用同一个 `IconButton + LogOut` 图标，与项目壳一致。

## 9. 「发送」/「复制 cURL」按钮显示英文

**现象**：发送按钮显示 `editor.send`、复制按钮显示 `editor.copyCurl` 一类的"英文"。

**原因**：不是漏翻译，而是**这些 key 从未在 `i18n.ts` 中定义**。i18next 找不到 key 时直接回显 key 本身。共 15 个：`editor.send` / `editor.sending` / `editor.noResponse` / `editor.copyCurl` / `editor.curlCopied` / `editor.copyFailed` / `editor.raw` / `editor.pretty` / `editor.expandResponse` / `editor.switchEndpoint` / `editor.previousEndpoint` / `editor.nextEndpoint` / `editor.current` / `editor.queryParamsHint` / `endpoints.description`。

**修复**：zh-CN + en 双语言补齐，并补充 `nav.breadcrumb`、`projects.loadFailed`、`dashboard.loadFailed`（原本硬编码中文，英文环境不切换）。

## 10. 安全/数据缺陷（连带发现）

| 缺陷 | 修复 |
|---|---|
| `GET /environments` 把 secret **明文**下发给所有项目成员（违反 Spec 4.6 默认掩码） | 响应只返回 `secretKeys` 键名，值永不出服务端；更新走 patch 语义（`null` 删键、字符串设值、缺省保留），前端无需回传明文 |
| 同名字符串 | 无（创建/重命名环境时 `lower(name)` 唯一冲突返回 409） |
| 接口列表第 5 列「用例数」+ 4 个行内操作后，操作列宽 156px 不够（4×30px 按钮 + 3×6px 间距 + 28px padding = 166px），窄屏会横向滚动 | 操作列宽改 166px；700px 以下隐藏「用例数」列（只显示 `—` 的列最不值得占宽度） |

## 验证

- 后端 `pnpm check`、前端 `pnpm check` 均通过
- 手工 curl 验证：环境创建/secret 掩码/更新合并/409 重名/依赖扫描/409 阻塞删除/force 删除、复制接口全字段携带与名称去重、内置变量解析、`caseCount: null`、删除环境后历史保留环境名
- 浏览器人工验收项（未由代理自动化）：未保存标记消失、历史抽屉、复制按钮、环境编辑抽屉、退出按钮一致性、箭头对齐、发送/复制文案

## 遗留

- `ExecutionIndex` 统一执行索引入口仍是项目级列表，未做跨执行类型统一——按计划属于 P1
- KeyValueEditor 的 `enabled=false` 行（停用的 header/query）不持久化：保存时被 `fromPairs` 过滤，刷新丢失。数据模型是 `Record<string,string>` 存不下停用态，需改为数组结构
- 环境密钥的「短时揭示需二次认证」「审计日志」属 Spec 4.6 后续要求，P0 未实现（当前为前端 `password` 输入框 + 眼睛切换）
