# 接口自动化平台 — 开发计划

> 版本: v0.5
> 基于: API_AUTOMATION_SPEC.md v1.4 / FRONTEND_INTERACTION_DESIGN.md v1.8 / REPOSITORY_ARCHITECTURE.md v1.0
> 当前阶段: P0、P1 全部已实现；P2-0/P2-1/P2-2 已实现并通过用户验收；P2-2.1 请求节点生命周期收尾、
> 认证页签变量补全与项目级「明文执行记录」开关已实现并通过用户验收；P2-6 高级节点已验收
> （见 5.0.8）；**P2-7 数据源适配器增量（MySQL / SQL Server / Oracle / MongoDB / Redis）
> 已全部实现并于 2026-08-22 通过用户验收**（见 5.0.10）；**P2-3 场景已实现后撤回**
> （见 5.0.6），编排统一由流程承担，之后进入 P2-4 测试套件 + 执行记录
> （P1-1 接口用例+断言、P1-2 Flow DAG 编排、P1-3 BullMQ+Worker）
>
> **v0.5 增量切片**: **P2-8 执行分区（跨网段执行）** 已确认范围与边界（见 5.0.12），
> 解决「测试网段的 worker 打不通生产网段」这一环境问题；不占核心 8 周周次、不阻塞
> P2-4 / P2-5，但**有一条硬前置条件**（生产网段能否出站到平台 Redis + Postgres），
> 前置不成立则本切片作废并转 P4.5 的 Runner 协议。
>
> **v0.4 范围变更**: P1-2 的两项遗留（并行执行、流程执行记录独立视图）与全部剩余节点
> 类型（脚本/条件/数据库/循环/等待/子流程）并入 P2，P2 由 6 周上调为 8 周。见 4.0.3 与 5.0。

---

## 一、整体路线图

```
P0 ──→ P1 ──→ P2 ──→ P3 ──→ P4 ──→ P4.5 ──→ P5 ──→ P6
MVP    流程    数据源  调度    仓库     Runner   MCP     性能
       编排    节点补全 告警    用例                     插件
       断言    套件
       用例    Mock
```

---

## 二、P0 — 当前状态

### 2.1 已实现功能

状态说明：`[已实现]` 表示当前代码已具备；`[已确认]` 表示问题已完成代码定位但尚未修复；`[P0待开发]` 表示已纳入本阶段计划。


| 模块     | 后端                                            | 前端                                             | 说明                                                                                          |
| ---------- | ------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 健康检查 | `GET /health`                                   | —                                               |                                                                                               |
| 认证登录 | `POST /auth/login`                              | 登录页(双栏布局)                                 | JWT + scrypt 密码哈希                                                                         |
| 当前用户 | `GET /auth/me`                                  | 用户信息展示                                     |                                                                                               |
| 项目管理 | `GET/POST/PATCH /projects`, `GET /projects/:id` | 基础列表 + 创建 + 下拉切换器                     | 事务性创建 + 自动分配 admin 角色                                                              |
| 环境管理 | `GET/POST /projects/:id/environments`           | Tab 列表 + 变量编辑器                            | `[已实现]` JSONB 变量/密钥存储                                                                |
| 接口管理 | `GET/POST/PATCH/DELETE /projects/:id/endpoints` | 列表(服务端搜索+方法筛选) +**整页编辑器** + 详情 | `[已实现]` 完整要素: method/url/headers/query/path/body(json,form,text)/auth/tags/description |
| 接口执行 | `POST /.../endpoints/:eid/execute`              | 结果抽屉(请求/响应/错误)                         | `[已实现]` 路径参数替换 + query 合并 + auth 注入 + 变量解析 + 30s 超时                        |
| 执行记录 | `GET /projects/:id/executions`                  | 全量分页列表 + 详情抽屉                          | `[已实现]` 服务端分页(20/50/100/200) + 状态/接口筛选，返回真实 total                          |
| RBAC     | `user_project_roles` 表 + `canAccess()` 中间件  | —                                               | 三级: admin/developer/viewer                                                                  |
| 数据迁移 | 自研迁移执行器                                  | —                                               | SQL 文件顺序执行, 事务保护                                                                    |

### 2.2 已实现数据模型 (6 表)

```
users           (id, email, name, password_hash, is_system_admin, status)
projects        (id, name, description, owner_id, status)
user_project_roles (project_id, user_id, role)
environments    (id, project_id, name, variables, secrets)
endpoints       (id, project_id, name, description, method, url, headers, query_params, path_params,
                 body_type, body, body_text, auth, tags, created_at, updated_at)
executions      (id, project_id, endpoint_id, endpoint_name, environment_id, status, status_code, duration_ms,
                 error, request_snapshot, response_headers, response_content_type, response_size_bytes,
                 response_truncated, response_body, created_at)
```

> `body` 存 JSON payload，`body_text` 存 form/text 原文。两者并存是为了切换 Body 类型时不丢用户已输入的内容。

### 2.3 当前架构

```
后端: 路由/权限/模型已模块化 — Fastify + @fastify/jwt + @fastify/cors + pg
前端: 路由、Zustand、i18n 已接入；全局层和项目层待重构
基础设施: compose.yaml — PostgreSQL 16 + Redis 7 (Redis 未使用)
```

### 2.4 P0 环境职责与状态

环境必须按“项目级资源、执行时选择、接口/用例可绑定默认值”分层，避免把环境下拉框的临时状态误当成接口数据或列表筛选条件。


| 能力                        | 当前状态   | 规划                                                                                                                        |
| ----------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 项目环境变量与 secrets 管理 | `[已实现]` | 环境属于项目，继续由`environments` 表维护 `name`、`variables`、`secrets`。                                                  |
| 执行时注入环境变量          | `[已实现]` | `POST /projects/:id/endpoints/:endpointId/execute` 接收 `environmentId`，服务端校验项目归属并解析 `{{variable}}`。          |
| 执行记录环境快照            | `[已实现]` | 执行记录保存`environment_id` 和 `environment_name`，环境删除后历史仍可读。                                                  |
| 编辑页切换环境后持久化      | `[已实现]` | 环境选择已进入接口草稿、保存 payload 和未保存判断，重新进入接口可恢复默认环境。                                             |
| 接口列表环境筛选            | `[已实现]` | 列表仅保留环境筛选并写入 URL；行内运行由服务端按接口默认环境、项目默认环境回退。                                            |
| 项目默认环境                | `[已实现]` | `project_settings.default_environment_id` 作为项目内没有更具体绑定时的默认执行环境。                                        |
| 接口默认环境                | `[已实现]` | `endpoints.default_environment_id` 已接入创建、更新、详情、复制和执行回退。                                                 |
| 列表环境筛选                | `[已实现]` | `GET /projects/:id/endpoints` 支持 `environmentId=<uuid>` 和 `environmentId=unset`。                                        |
| 用例固定环境                | `[已实现]` | `test_cases.environment_id` + `environment_name` 保存用例环境快照；用例执行使用用例绑定环境，不受接口默认环境后续变更影响。 |
| 环境执行分区                | `[待实现]` | `environments.runner_label` 表达「这个环境该从哪个网段发请求」，队列按标签路由到对应分区的 worker。见 5.0.12（P2-8）。 |

环境选择优先级统一为：用例绑定环境 > 接口默认环境 > 项目默认环境 > 当前项目第一个环境 > 不使用环境。列表页环境筛选只筛选接口默认环境，不改变接口本身的临时执行环境语义。

**环境是执行位置的归属者（P2-8，待实现）**：内网存在互不连通的网段（测试 / 生产），而 worker
只能从自己所在网段出站。执行位置挂在环境上而不是新建一层资源，正是因为上面这条选择优先级
已经被用例、接口、流程、套件、批量调试共用——环境定了，分区就定了，不需要第二套选择逻辑。

---

## 三、P0 遗留项 — 优先级最高

> **状态：全部已实现**（1–9 均完成；3.1.1 环境落地清单除验收项外全部落库）。P0 功能面已收口，进入下一阶段迭代。

### 3.1 P0 产品信息架构与可观测性（当前最高优先级）

1. `[已实现]` 全局层：新增数据看板、项目管理、系统管理；登录默认进入数据看板。
2. `[已实现]` 项目管理：卡片默认视图，支持项目 CRUD、关键词筛选与显式进入项目。（归档已从产品概念移除，故无状态筛选；项目暂无标签维度）
3. `[已实现]` 数据看板：按可见项目汇总项目、接口、通过率、完成率；**覆盖率与接口用例数已在 P1-1 接入真实值**（覆盖 = 该接口至少有 1 条用例），CI 任务、定时任务等未交付模块仍显示“未启用/待接入”；项目行可进入项目。看板指标下钻规则见交互文档 3.0.2。
4. `[已实现]` 执行信息：项目执行记录升级为未来 `ExecutionIndex` 的统一明细入口（单接口 / 批量调试两种视图）；接口详情内就地展示该接口历史和完整 HTTP 快照。
5. `[已实现]` 系统管理：新增主题、语言、恢复上次页面等个人偏好页面；快捷切换不能替代设置页。
6. `[已实现]` 导入：OpenAPI/Swagger 扩展为 cURL 解析，并提供冲突预览（新增/已存在/变更 + 全局策略 + 逐项勾选）。
7. `[已实现]` **接口工作台细化（对齐交互文档 v1.6）**：全屏工作台内的「运行记录」（P0 名为「调试记录」，P1-1 起同时收录用例执行故改名）与结果快照 **「替换当前请求」**——把某次执行的请求快照回填到请求区快速改参重发（未保存修改先确认，保留认证配置）；接口列表新增「用例数」列（P0 为预留占位显示 `—`，**已在 P1-1 接入真实 `caseCount` 并可点击进入用例框**；「保存为用例」能力整体在 P1 落地，未提前到 P0）。
8. `[已实现]` **环境默认值与接口筛选（P0）**：接口列表只承担环境筛选，执行环境由接口默认环境、项目默认环境或批量调试弹窗决定。
   - `[已解决]` 接口列表请求方法起始位置已统一左对齐。
   - `[已解决]` 接口编辑页 URL 与复制 cURL 使用未编码的可读文本；实际发送仍由请求构建器执行标准 URL 编码。
   - `[已解决]` 列表页切换项目时不再沿用上一个项目的 `environmentId`；当前选择必须属于当前项目环境集合。
   - `[已解决]` 编辑页环境选择已随接口保存，并参与未保存判断。
   - `[已解决]` 已移除列表页面级“运行环境”控件；列表只负责环境筛选，行内运行不显式传环境。
   - `[已解决]` 已新增项目设置表和默认环境 API；删除环境时外键自动清空默认环境引用。
   - `[已解决]` 接口已新增可空的 `default_environment_id`，创建、更新、详情、复制和列表均返回该字段，并校验同项目归属。
   - `[已解决]` 接口列表 API 已支持 `environmentId=<uuid>` 和 `environmentId=unset`，筛选由 SQL 作用于全量接口数据。
   - `[已解决]` 项目切换时会重置环境筛选，并防止旧项目异步请求覆盖当前项目 store。
9. `[已实现]` **接口列表批量调试（P0，范围已确认）**：只执行选中接口当前已保存的接口定义，不选择或执行接口用例；正式的用例批量执行仍由 P1/P2 的接口用例和测试套件承担。
   - `[已实现]` 列表支持勾选当前筛选结果，并在筛选变化、项目切换或离开页面时清空选择。
   - `[已实现]` 默认按每个接口自己的默认环境执行；用户可明确选择统一覆盖环境或本次不使用环境。
   - `[已实现]` 新增批次父记录，保存总数、成功数、失败数、环境策略、状态和时间范围；每个现有 `Execution` 通过 `batch_id` 关联父批次。
   - `[已实现]` 批量调试结束后在接口列表原地展示汇总与逐接口结果；项目执行记录支持查看批次父记录，单接口记录标识批量来源。
   - `[已实现]` 当前与历史批量调试结果统一使用右侧抽屉，按接口名称列出子项；点击子项打开请求/响应快照，超过 10 条分页，单条不显示分页。
   - `[已实现]` 接口列表支持事务性批量删除：整批校验项目归属后删除，任一校验失败时不删除任何接口。
   - `[已实现]` 批量调试不生成断言结果，不纳入用例通过率或正式回归统计；后端并发固定为 5，单批最多 100 个接口。

### 3.1.1 P0 环境落地清单

**数据库**

1. `[已实现]` 新增 P0 migration，创建 `project_settings(project_id PK/FK, default_environment_id FK NULL)`。
2. `[已实现]` 给 `endpoints` 增加 `default_environment_id UUID NULL REFERENCES environments(id) ON DELETE SET NULL`。
3. `[已实现]` 数据库外键只能保证环境存在，服务端写入时还必须校验环境与项目一致。
4. `[已实现]` 环境删除沿用 `ON DELETE SET NULL`，执行历史继续保留 `environment_name` 快照。

**后端 API**

1. `[已实现]` 新增 `GET /projects/:id/settings` 和 `PUT /projects/:id/settings`，读写项目默认环境。
2. `[已实现]` `POST/PATCH /projects/:id/endpoints` 接收 `defaultEnvironmentId`；`GET` 详情与列表返回该字段。
3. `[已实现]` `GET /projects/:id/endpoints` 增加 `environmentId` 服务端筛选，支持 UUID 和 `unset`，非法值返回 `400`，不静默忽略。
4. `[已实现]` 执行接口未显式传 `environmentId` 时，由服务端依次回退接口默认环境、项目默认环境；显式传空值表示本次不使用环境。

**前端状态**

1. `[已实现]` `EndpointWorkspace` 的环境选择进入 `Draft` 和保存 payload，参与 `dirty` 判断；项目或接口切换时重新加载绑定值。
2. `[已实现]` `EndpointList` 只保留 `environmentFilter` 负责列表查询；行内执行不带环境参数，由服务端按默认优先级解析。
3. `[已实现]` `environmentFilter` 写入 URL query，刷新和分享后结果一致；批量调试的环境策略只存在于该次弹窗，不写入 URL。
4. `[已实现]` 所有环境 ID 在使用前确认属于当前 `projectId` 的环境集合，并阻止旧项目异步加载覆盖当前状态。

**验收标准**

1. 编辑接口选择环境并保存，刷新或重新进入后仍显示已保存环境。
2. 环境筛选后只返回默认环境匹配的接口；“未设置环境”只返回未绑定接口。
3. 切换项目后，不显示或发送上一个项目的环境 ID。
4. 批量调试选择“不使用环境”后执行，不注入任何项目环境变量；未指定时按默认优先级执行。
5. 删除项目默认环境或接口默认环境后，相关引用自动置空，历史执行仍显示原环境名称。

### 3.2 代码重构 (单文件 → 模块化)

**后端重构** — 拆分 `src/index.ts`:

```
src/
├── index.ts          # 入口, 注册插件 + 路由
├── db.ts             # pg 连接池 (已有)
├── migrate.ts        # 迁移执行器 (已有)
├── lib/
│   ├── auth.ts       # JWT 验证 + 密码工具
│   ├── rbac.ts       # 权限中间件
│   └── resolve.ts    # 变量解析
├── routes/
│   ├── auth.ts       # /api/v1/auth/*
│   ├── projects.ts   # /api/v1/projects/*
│   ├── environments.ts
│   ├── endpoints.ts
│   └── executions.ts
├── models/
│   └── types.ts      # 公共类型定义
└── plugins/
    └── response.ts   # 统一响应格式
```

**前端重构** — 拆分 `src/main.tsx`:

```
src/
├── main.tsx          # 入口
├── api.ts            # axios 客户端 (已有)
├── components/
│   ├── Login.tsx
│   ├── Workspace.tsx
│   ├── Dashboard.tsx
│   ├── EndpointList.tsx
│   ├── EnvironmentList.tsx
│   ├── ExecutionList.tsx
│   ├── ExecutionDrawer.tsx
│   └── ProjectSwitcher.tsx
├── hooks/
│   └── useApi.ts     # 数据获取 hook
└── styles.css        # 全局样式 (已有)
```

### 3.3 前端路由 (React Router)

```
/login          → 登录页
/dashboard      → 全局数据看板（默认）
/projects       → 项目管理
/system         → 系统管理
/projects/:projectId → 项目工作台
  /overview     → 项目概览
  /endpoints    → 接口管理
  /environments → 环境管理
  /reports      → 执行记录
```

- 使用 `react-router-dom` v6
- 路由参数 + 查询参数支持深链 (drawer 状态、分页、筛选)
- 路由守卫: 未登录重定向到 `/login`

### 3.4 状态管理 (zustand)

```typescript
// store/authStore
interface AuthStore {
  token: string | null;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

// store/projectStore
interface ProjectStore {
  projects: Project[];
  projectId: string | null;
  switchProject: (id: string) => void;
  refresh: () => Promise<void>;
}
```

### 3.5 多语言 (i18n)

- 引入 `react-i18next`
- 语言文件: `zh-CN.json` / `en.json`
- 框架 UI 文案翻译, 动态数据不翻译
- 语言偏好: 本地存储 + 服务端同步

### 3.6 导入与执行快照

- 解析 OpenAPI 3.0 / Swagger 2.0 JSON/YAML
- 解析单条或多条 cURL（方法、URL、Headers、Body、可识别认证）
- 批量创建 endpoints
- 冲突预览与处理（`method + 标准化 URL`，更新 / 跳过 / 另建 / 逐项处理）
- 落库并展示完整 HTTP 快照：请求 Method/URL/Query/Headers/Body，响应 Status/Headers/Body/Content-Type/截断元数据
- 对环境 secrets、Authorization/Cookie/Set-Cookie 等敏感字段统一脱敏
- `[已实现]` **项目级「明文执行记录」开关**（`project_settings.store_plaintext`，默认关，迁移 019）：开启后该项目执行记录的请求/响应快照不再脱敏（`run.ts`、`flowRun.ts` 按标志跳过掩码），便于内部调试签名与鉴权；环境密钥明文会随记录可见，由项目管理员在「环境管理」页头部开关显式开启。

### 3.7 验证方式

- 按当前约束不创建前后端测试文件。
- 后端执行 `pnpm run check && pnpm run build`；前端执行 `pnpm run check && pnpm run build`。
- 关键业务链路用本地服务和浏览器自动化验证：登录默认页、项目 CRUD、项目进入、接口执行、接口内历史、完整快照、OpenAPI/Swagger/cURL 导入。

---

## 四、P1 — 流程编排与测试用例 (7 周)

> **分批交付 (已确认)**: P1 拆成三批，避免单轮改动面过大、无法验收。
>
>
> | 批次 | 范围                                                                                 | 状态       |
> | ------ | -------------------------------------------------------------------------------------- | ------------ |
> | P1-1 | **接口用例 + 断言**（用例 CRUD/执行、断言引擎、工作台「用例」框、caseCount、覆盖率） | **已实现**（含断言配置器收尾：JSON Schema + 自定义脚本，见 4.0.1） |
> | P1-2 | **Flow DAG 编排**（flows/flow_executions、React Flow 画布、节点配置、单步调试）      | **已实现**（见 4.0.2；剩余节点类型与并行执行已并入 P2，见 4.0.3 / 5.0） |
> | P1-3 | **BullMQ + Worker**（队列异步执行、独立 Worker 进程、SSE 进度、取消）                | **已实现** |
>
> P1-1 先做的原因：它是 P2 套件「跨接口用例选择器」的前置依赖，并且补齐了 P0 遗留的 `caseCount: null` 占位。
>
> **P1 已全部交付。** P1-2 的两项遗留（并行执行、流程执行记录独立视图）与剩余节点类型
> 不属于 P1 范围，已确认并入 P2（见 4.0.3、5.0）。

### 4.0 P1 各批次说明

**P1-1 断言配置器收尾已实现**（见 4.0.1）；**P1-2 Flow DAG 编排已实现**（见 4.0.2）。
**脚本断言契约重做已实现**（`ctx.assert` 取代 `return`，见 4.0.2.5）；**命名与展示整理
已实现**（见 4.0.2.6）。

#### 4.0.1 P1-1 断言配置器收尾：JSON Schema + 自定义脚本 `[已实现]`

**落地内容**（新增 `scripts` 表 + `assert.ts` 扩展 + `lib/sandbox.ts` + `routes/scripts.ts`）:

- `AssertionType` 扩为 `status | header | jsonPath | jsonSchema | script`；
  `AssertionOperator` 加 `matchesSchema`、`isTrue`。断言仍只跑在**截断后**的
  响应体上（`RESPONSE_LIMIT = 10000`）；即时验证 `POST /assertions/validate` 与
  worker 内 `evaluateAssertions` 仍走同一函数。
- **JSON Schema 断言**：新类型 `jsonSchema`，schema 文档存 `expected`（文本，
  与现有结构兼容，**不引入 `params` 通用容器**——schema 与脚本的形态差异用各自的
  字段表达：schema 走 `expected`，脚本走 `script` 引用）。用 **ajv** 校验解析后的
  body（`ajv@8` 已装）；schema 非法或 body 非 JSON → 断言 failed 并附消息。
- **自定义脚本断言**：新类型 `script`，用户写 JS **函数体**，作用域内
  `ctx.response.status / .headers / .body / .text`，`return` 真值即通过。
  > **契约已在 4.0.2.5 重做**：改为脚本内 `ctx.assert` 直接断言，`return` 不再
  > 参与判定。本节其余内容（沙箱选型、脚本存储、follow/copy、执行快照）仍然有效。
  - **沙箱选型定案：`node:vm`**，不引入 `isolated-vm`。零原生依赖；worker
    进程隔离是第一道边界。三道加固：host 对象不进 context（ctx 以 JSON 字符串
    跨边界、沙箱内 `JSON.parse` 重建，防 `constructor` 逃逸）、`codeGeneration`
    禁用（禁 `eval`/`Function`）、`console` 在沙箱内定义收集。
  - **脚本 API 形态定案：`ctx` 包裹**（`ctx.response`），为 P1-2 DAG 脚本节点
    预留 `ctx.variables`/`ctx.steps` 扩展位，不重写用户已写的脚本。
  - 超时 1 秒；抛异常/超时/未返回 → 断言失败并展示异常文本（方便调试）。
  - **脚本存储与共享（本轮新增决策）**：
    - 新增 `scripts` 表（`011_p1_scripts.sql`）：**具名公共脚本**（`name` 非空、
      项目级、可被多处引用）与**匿名私有脚本**（随宿主用例生灭、`ON DELETE
      CASCADE`），CHECK 约束二选一。`language` 列现在建（只允许 `javascript`），
      理由同 `workers.mode`：事后加列无法回填历史行。
    - **follow / copy 模型**：引用方前端二选一——follow（共享更新，改公共脚本
      全部生效）或 copy（复制为私有脚本脱离）。公共脚本编辑只走
      `PATCH /projects/:id/scripts/:scriptId`（带引用清单），**用例保存时不允许
      改公共脚本**（400 拒绝），避免一次 ⌘S 静默改写其他用例行为。公共脚本管理
      页在「环境管理 → 公共脚本」tab，删除前强制扫引用返回 409 + 依赖清单，
      `?force=true` 二次确认（对齐 environments 删除语义）。
    - **保存时序**：客户端不做两阶段写。保存 body 里脚本三态——`{scriptId, content}`
      改过→UPDATE、`{scriptId}` 没动→不碰、`{content}` 新建→INSERT+回填 ID；
      **只发脏脚本的正文**，这就是"20 节点流程每步有脚本时保存 body 不膨胀"的答案。
      脚本 upsert 与用例写入在**同一事务**内（`persistCaseScripts`），失败整体回滚。
    - **执行快照**：入队时 `inlineScriptContent` 把 `scriptId` 解析成正文内联进
      `run_spec`，worker 不读 `scripts` 表——保证入队后、执行前有人改公共脚本，
      跑的还是当时那份，执行记录可复现。`run_spec` 终态置 NULL，内联正文不驻留。
    - 前端脚本编辑器支持**折叠**；环境变量编辑器内新增**内置动态变量参数速查**
      （`{{$randomStr(16)}}`、`{{$date(YYYY-MM-DD)}}` 等用法说明）。
  - **内置动态变量参数化（新增）**：`{{$name(args)}}` 形式，无参时行为不变。
    `{{$randomStr(16)}}` 定长、`{{$randomInt(10,20)}}` 定范围、`{{$date}}` 新增
    （`YYYY/YY/MM/DD/HH/mm/ss/SSS`，本地时间）、`{{$timestamp(s)}}` 秒级时间戳。
    `$randomStr` 长度钳制 1–4096，防一次分配过大的数组。

**本会话关键决策回顾**（供验收对照）:

- 具名公共脚本**本轮就做**（而非只留列）：follow/copy 复制脱离解决"改一处炸一片"。
- `node:vm` 而非 `isolated-vm`；`ctx` 包裹而非裸 `(res) => boolean`。
- 用例保存允许改公共脚本的请求被 400 拒绝；公共脚本编辑必须经独立路由确认影响面。
- 并发编辑无乐观锁（沿用全站"后写覆盖"），不为脚本单独引入 `If-Match`。

#### 4.0.2 P1-2 Flow DAG 编排 `[已实现]`

**现状锚点**（P1-2 建在这些已经验证过的能力之上，不要另起炉灶）:

- 执行链路已全异步：入队(`lib/enqueue.ts`) → BullMQ → worker(`src/worker.ts`) →
  `performRun`(`lib/run.ts`) → SSE 推送(`lib/events.ts` + `routes/stream.ts`)。flow 执行
  复用了这条链路，没有在 API 进程里同步跑。
- job 载荷只放 id，worker 从库里回读快照——flow 同理（`flow_executions.run_spec`）。
- 取消、回收、at-most-once 全是执行基础设施层的能力，flow 执行走同一队列因此自动继承。

**本轮确认的三个决策**（此前 4.0.2 留空的部分）:

1. **执行存储 = 父表 + 复用 executions**。新增 `flow_executions` 父记录（类比
   `batch_executions`），每个节点跑出来的**仍是一条 `executions` 行**，
   `source` 扩为第三个值 `flow_step`，新增 `flow_execution_id` / `flow_node_id` /
   `flow_node_name` 三列。这样取消、卡死回收、at-most-once 认领、SSE、请求/响应快照抽屉、
   接口维度历史与覆盖率统计**全部零改动继承**，而不是为流程再写一套平行设施。
   代价是 `executions` 多三列。
2. **首轮只做 request 节点 + 变量提取**。条件/循环/脚本/等待/子流程节点按需排期。
   没有变量提取的 DAG 只是一串互不相干的请求，所以「提取」与「请求节点」必须同批交付。
3. **节点完全快照隔离，可从接口种入**。节点存 `request` 副本 + 断言 + 提取规则，
   `endpointId` 只表达来源与归属（命名、接口维度统计），执行时不回读接口。
   接口后续被改不会回溯影响已建好的流程——与 P1-1 用例同一条原则。

**已落地内容**:

- 迁移 `012_p12_flows.sql`：`flows`、`flow_executions`、`executions` 三列 + `source` CHECK
  放宽；`scripts` 补 `owner_flow_id` 并把 011 的 CHECK 改为「公共脚本无宿主 / 匿名脚本恰好
  一个宿主」（布尔异或）；`flows.nodes` 加 GIN 索引供公共脚本引用扫描。
- 后端：`lib/flow.ts`（校验 + Kahn 拓扑排序 + 提取求值）、`lib/flowRun.ts`
  （`performFlowRun` 顺序执行、变量袋、失败策略）、`lib/inflight.ts`（中断句柄登记表从
  worker.ts 提取为共享模块）、`routes/flows.ts`（FLOWS 路由组）。
- `lib/run.ts` 抽出 `executeRequest`：接口调试、用例执行、流程节点走**同一个**发请求函数，
  传输、超时、截断、掩码、断言判定不可能分叉。
- 前端：`FlowList`（列表 + 新建 + 复制 + 删除 + 行内运行）、`FlowWorkspace`
  （`@xyflow/react` 画布 + 运行条 + 变量弹窗 + ⌘S + 未保存守卫 + `?run=` 深链）、
  `FlowNodeDrawer`（请求/提取/校验三页签 + 单步调试）。画布配色全部改写为设计令牌。

**关键实现取舍**:

- **变量优先级：节点提取 > 流程初始变量 > 环境变量**。提取值必须能盖掉环境里的同名变量，
  否则「先登录拿 token，后续步骤用它」毫无意义——盖不掉就永远在用环境里那个过期的。
- **提取用未掩码响应体**。掩码是给存储与展示用的；若某 token 恰好等于环境 secret，
  掩码后提取到的是一串星号，下一步会带着星号发出去。
- **提取失败让该步失败**，不写空串。后继步骤带着字面量 `{{token}}` 发出去的话，
  报错离真正原因隔了一整步。
- **流程执行占一个并发槽**，与单次执行共用 `executions` 队列（按载荷形状分派）。
  因此 `WORKER_CONCURRENCY` 是「同时几件事」而非「同时几个请求」，估容量按流程数算。
- **流程回收阈值 20 分钟 > 流程总超时 10 分钟**，否则正常长跑的流程会被回收判死。
  节点步骤仍按 `started_at` 走 5 分钟阈值，不受父记录 `created_at` 影响。
- **运行顺序由服务端给**（`POST /flows/plan`）。前端不自己实现一份拓扑排序：两份实现迟早
  分歧，而画布上显示的那个顺序是用户会相信的那个。
- **同层节点按画布位置排序**（上→下、左→右），最后才退回声明顺序。首轮顺序执行，
  边只表达依赖，并列节点必须有一个用户能预测且能通过拖动改变的先后。
- **环有环即报在画布上**，不等到保存才拒绝——那时用户已经离开编辑器。
- **公共脚本删除确认现在同时扫用例与流程**（`scriptUsage` 返回 `users`，含 `kind`）。
  只数用例会低报影响面，让一次删除静默弄坏流程。

**未做（已确认全部并入 P2，见 5.0）**: 并行执行（边目前只表达依赖）、
条件/循环/脚本/数据库/等待/子流程节点、流程执行记录进「执行记录」页的独立视图
（当前经 `?run=` 深链在画布上复盘，节点步骤本身已出现在项目执行记录里）。

#### 4.0.2.1–4.0.2.4 P1-2 多轮体验修复 `[已实现]`

> P1-2 首轮至四轮的验收反馈与体验修复记录已移出开发计划，统一归档到
> `issue_fix/P1-2-体验修复记录.md`（四轮反馈修复，共 15 项）。

#### 4.0.2.5 脚本断言契约重做：`ctx.assert` 取代 `return` `[已实现]`

原契约要求脚本 `return` 真值才算通过，实际写起来别扭：一个脚本只能表达一条判断，
多条检查得自己 `&&` 起来，失败了也说不出是哪一条。本轮把契约改成**在脚本内直接断言**。

**新契约（三条，按重要性排序）**：

1. **`ctx.assert(...)` 决定结果**。硬模式下失败即 `throw`（后续代码不再执行），沙箱
   `catch` 捕获后作为普通脚本错误上报——不新增第二条上报通道。
2. **无断言且无报错 = 通过**。脚本跑到底就是没发现问题。要求「必须 return 或必须
   assert」只是把刚去掉的仪式换个名字加回来（用户明确否决）。
3. **`return` 只是证据**。返回值记录进 `AssertionResult.actual`（与其他断言类型放
   证据的位置一致）并**明确不参与判定**，所以 `return false` 而没有断言的脚本判通过。

**软断言（可选，脚本内开关）**：脚本里写 `ctx.assert.soft = true` 后失败不中断，
全部收集，最后一起报。判定不能只看「有没有抛错」——软模式下什么都不抛——所以沙箱
额外把 `failedChecks` 计数带出边界，宿主据此判失败。

**API**：`ctx.assert(cond, msg)` / `.ok` / `.isTrue` / `.isFalse` / `.equal` /
`.notEqual` / `.contains` / `.exists` / `.notExists` / `.greaterThan` /
`.lessThan` / `.fail(msg)`。`equal` 的宽松比较**对齐 `lib/assert.ts` 的 `compare`**：
两边都是数字就按数字比，所以 header 里的字符串 `"200"` 与脚本里写的数字 `200` 相等。

**逐条明细**：每次 `ctx.assert` 调用（含通过的）记进 `ScriptCheck[]`，随
`AssertionResult.checks` 落库并在 UI 逐条渲染。通过的也留，因为「绿灯且列出验了什么」
与「绿灯但其实什么都没验」必须能区分开——这正是新契约下最容易踩的坑。

**明细是唯一的信息源（验收后修复）**：断言失败（hard 或 soft）**不再**另生成一条
汇总 message（如「1 of 3 checks failed: expected 400, got 200」）——它会和 ✗ 行重复。
沙箱用 `assertThrew` 标志区分「断言抛的错」和「脚本自己抛的错」（TypeError、超时）：
前者不产 message，明细全在 `checks` 里；后者照常带 message，因为没有哪条 check 能
解释它。编辑行的运行结果也不重复渲染 check 列表（明细在响应面板/快照/试运行各出现
一次即可），否则同一份结果会在页面上出现两遍。

**上下文变量读写（本轮新增）**：断言脚本与前置钩子拿同一个 `ctx.variables`，
`ctx.setVariable(名, 值)` 写回。同一条用例内后面的脚本能看到前面写的值（共享一个可变
bag）；流程里按 `hookVariables → extracted → assertionVariables` 顺序汇入变量袋——
断言在响应之后执行，是这一步最新的一份，同名时盖住钩子那份。

**脱敏**（与响应体同规则）：`ctx.variables` 递给脚本的是**已解析**的环境变量，含
secret 明文，所以脚本吐出的 `message`/`logs`/`debug`/`checks`/`returned` 全部过
`sanitizeValue` 再落库或返回。否则一句 `console.log(ctx.variables)` 就把密钥写进了
执行历史。

**存量脚本全部失效（用户已确认接受）**：老脚本用 `return` 表达结论，新规则下返回值不
再参与判定，于是它们变成「无断言且无报错」→ **无条件通过**。这是本轮最大的风险面：
不会报错，只会静默变绿，必须逐个改写为 `ctx.assert`。

**没动的地方**：`AssertionType` 仍是 `script`，存储的 `operator` 仍是 `isTrue`——
它落在每一行历史数据上，且求值时已无意义，改名要配一次数据迁移却换不到任何东西，
所以留着，UI 不展示它。试运行接口 `POST /scripts/try` 的环境加载从 hook 分支上提到
两种 kind 共用，否则读变量的断言会「试运行失败、真跑通过」。

#### 4.0.2.6 脚本断言命名 + 执行结果展示整理 `[已实现]`

验收后两轮体验问题：一个用例挂多个脚本断言时无法区分（编辑器都叫「私有」、结果都叫
「自定义脚本」）；脚本 `return` 的上下文值最长 4KB，直接内联在结果行里把行撑爆、和
✓/✗ 明细混在一起。

**命名（对齐 hooks 的 `HookConfig.name`）**：`Assertion` 增加可选的本地 `name`，
存在用例/节点的 jsonb 里——**纯增量字段，无 DB migration、无 SQL、无接口变更**。
名字是「引用级」的：同一个公共脚本在不同用例里可以各起各的标签，和钩子的行为一致。
编辑器脚本行加名字输入框，留空回退「脚本 N」（与「hook N」同款），执行结果用它当
标签。

**执行结果展示整理**：

- 脚本断言标签从通用「自定义脚本」换成 `name ?? 脚本 N`。
- `return` 值从内联 span 改为**独立折叠块**：≤120 字符直接显示；更长折叠成单行省略号
  +「展开/收起」，展开后等宽块内可滚动。试运行面板同一套样式。
- 试运行结果在**内容变更**或**新的执行结果落地**时自动清空——「先试运行再跑用例，
  面板还挂着旧内容」会让人以为用例没跑。

改动：后端仅 `types.ts`（1 处类型）；前端 `api.ts` / `AssertionEditor.tsx` /
`ScriptAssertionEditor.tsx` / `design-system.css` / `i18n.ts`。

#### 4.0.3 节点类型与流程遗留 → 全部并入 P2 `[已确认]`

首轮只交付 request 节点。其余节点类型与 P1-2 的两项遗留（并行执行、流程执行记录独立
视图）**已确认全部归入 P2**，落地范围与顺序见 5.0。

此处只保留「为什么不留在 P1」的判断，避免后续重新讨论。**「原建议」一列是本次变更前的
旧归属，仅作留档；实际归属一律为 P2**，批次见 5.0。

| 项 | 原建议（已作废） | 并入 P2 的理由 |
| --- | --- | --- |
| **脚本节点** | P1-3 补充（可立即做） | 技术上确实可立即做（沙箱、`scripts` 表、`owner_flow_id`、`ctx.variables` 均已就绪），但它单独交付只能算能力碎片：真实链路里脚本节点常与条件、数据库步骤同时出现。与 P2 一起做可共用同一套「节点执行结果 + 变量袋」抽象。 |
| **条件节点** | P2 | 需要「节点被跳过」状态与边条件语义，与并行调度同源，分开做必然产出两套语义。 |
| **数据库节点** | P2（依赖数据源） | 强依赖 `data_sources` / `sql_definitions`，P1 内无从执行。 |
| **循环节点** | P3 或按需 | 迭代变量、最大轮次、失败中断都与并行执行纠缠；并行执行本身也已并入 P2，因此循环节点最早只能在 P2 的并行模型确定之后——若 P2 内取舍不做，则顺延而非回到 P3。 |
| 等待 / 子流程 | 按需 | 等待节点成本极低但价值取决于真实场景；子流程需要先有稳定的流程复用语义。两者均在 P2 末尾按需取舍。 |
| **并行执行**（P1-2 遗留） | — | 首轮边只表达依赖、顺序执行。改为并行要同时定义并发上限、局部失败对后继节点的影响、以及与 `WORKER_CONCURRENCY` 的关系；条件与循环节点都建立在这套语义上，因此必须先于它们确定。 |
| **流程执行记录独立视图**（P1-2 遗留） | — | 当前节点步骤已进入项目执行记录，父记录只能经 `?run=` 深链复盘。P2 会出现套件执行这类新的父级执行，届时统一设计「执行索引」比现在单独为 flow 做一个视图更省。 |

### 4.1 数据库迁移

`[已实现]` **接口用例相关**（`007_p1_test_cases.sql`，实际序号接在 P0 的 006 之后，计划原写的 `002_p1_schema.sql` 为过时命名）:

```
test_cases         (id, project_id, endpoint_id, environment_id, environment_name,
                    name, description, request_snapshot JSONB, assertions JSONB, tags,
                    created_at, updated_at)
                   # 用例 = 接口请求快照 + 环境 + 断言，完全快照隔离；接口后续修改不影响已保存用例
executions 扩展     (source CHECK(endpoint_debug|test_case), case_id, case_name,
                    assertion_results JSONB)
                   # 接口调试与用例执行共用一张表但可分离：侧栏「运行记录」默认两类都看，
                   # 可按来源筛选；用例「最近结果」只看自己的 case_id
```

`[已实现]` **异步执行与执行器注册**（P1-3，`008~010`）:

```
008 executions 扩展   (status 扩为 queued|running|success|failed|canceled,
                     started_at, finished_at, run_spec JSONB)
                     # 「入队即落库」：前端拿到 executionId 立刻能查到这一行。
                     # run_spec 存未插值快照({{var}} 还是字面量), 终态后置 NULL——
                     # worker 只从 job 的 executionId 回读, Redis 里没有请求体/凭据
009 workers 表       (id=hostname:pid, hostname, pid, concurrency, inflight,
                     version, started_at, last_seen_at)   # 心跳注册表
    executions 扩展   (worker_id TEXT)                    # 执行归属, 无外键
010 workers 扩展      (mode TEXT CHECK(endpoint|repository), 默认 endpoint)
                     # 仓库模式预留: 现在加列免回填, 回填时无法区分历史行
```

`[已实现]` **脚本存储**（P1-1 断言收尾，`011_p1_scripts.sql`）:

```
011 scripts 表       (id, project_id FK, name TEXT NULL, language CHECK('javascript'),
                     content TEXT, owner_case_id FK ON DELETE CASCADE,
                     created_at, updated_at)
                     # 具名公共脚本: name 非空 + 无 owner, 项目级可复用
                     # 匿名私有脚本: name NULL + owner_case_id 非空, 随用例生灭
                     # CHECK: (name IS NOT NULL AND owner_case_id IS NULL) OR
                     #        (name IS NULL AND owner_case_id IS NOT NULL)
                     # name 唯一索引 (project_id, name) WHERE name IS NOT NULL
    test_cases 扩展   (assertions GIN 索引)  # 供公共脚本引用扫描 (containment 查询)
```

`[已实现]` **Flow DAG 编排**（P1-2，`012_p12_flows.sql`）:

```
012 flows 表          (id, project_id FK, name, description, environment_id/name,
                      nodes JSONB, edges JSONB, variables JSONB, tags, 时间戳)
                      # nodes[] = { id, type:'request', name, position, endpointId,
                      #             request 快照, assertions, extracts, onFailure }
                      # nodes 加 GIN 索引: 公共脚本引用扫描要能命中节点断言
    flow_executions   (id, project_id, flow_id FK ON DELETE SET NULL, flow_name 快照,
                      environment_id/name, status(同 executions 五态), total,
                      success/failed/skipped_count, error, plan JSONB, variables JSONB,
                      run_spec JSONB, worker_id, created/started/finished_at)
                      # plan 终态保留（只有标识与名称），run_spec 终态置 NULL（含 auth 明文）
    executions 扩展    (source CHECK 加 'flow_step', flow_execution_id FK ON DELETE SET NULL,
                      flow_node_id TEXT, flow_node_name TEXT)
                      # 节点 id 是流程文档内的字符串, 不是表主键, 所以无外键可加
    scripts 扩展       (owner_flow_id FK ON DELETE CASCADE, CHECK 改为
                      公共脚本无宿主 / 匿名脚本恰好一个宿主)
```

**边界决策**:

- **不引入 `assertions` 公共库表**：交互文档未提供「断言库」界面，断言直接内联存在用例的 `assertions JSONB` 里；等出现复用需求再抽表。
- **不引入 `execution_index` 统一执行索引**：当前只有接口调试与用例两类执行，`executions.source` 已足够区分；等 P2 套件带来新的父级执行时再建索引表，避免过早抽象。
- **用例删除保留历史**：`executions.case_id` 为 `ON DELETE SET NULL` 且 `case_name` 已快照，删用例不删执行记录（Spec 4.4 历史保留）。
- **run_spec 终态置 NULL**：它携带 auth 明文且没有读取方，落终态即清空，最小化凭据驻留。
- **脚本引用存在 JSONB 里，所有权用真 FK**：断言/节点在 `assertions` JSONB 内以 `{ script: { scriptId } }` 引用，删除用例时匿名脚本靠 `owner_case_id` 的 `ON DELETE CASCADE` 回收，不用多态 `owner_type/owner_id`——多态没有外键，删除必须手写清理，迟早漏。
- **flows 执行取「父表 + 复用 executions」** `[P1-2 已定]`：`source` CHECK 扩出第三个值
  `flow_step`，节点执行仍是 `executions` 行，父记录另立 `flow_executions`（迁移 012）。
  另一个选项——节点结果全塞进父表 JSONB——被否决：那样快照抽屉、取消、卡死回收、接口维度
  历史都要各写一套，且流程步骤不会出现在「执行记录」里。`scripts` 同批加 `owner_flow_id`
  并把 CHECK 改成「公共脚本无宿主 / 匿名脚本恰好一个宿主」。

### 4.2 后端新 API

```
FLOWS  [已实现] (P1-2)
  GET/POST /projects/:id/flows
  GET/PUT/DELETE /projects/:id/flows/:flowId
  GET  /projects/:id/flows/:flowId/usage            # 删除前引用扫描 (P2-4.5): 套件成员 + 子流程节点
  POST /projects/:id/flows/:flowId/execute        (可传 nodes/edges/variables 覆盖, 跑画布当前状态而不落盘)
  POST /projects/:id/flows/:flowId/nodes/execute  (单步调试: 走 enqueueRun, 返回普通 Execution)
  GET  /projects/:id/flows/:flowId/executions
  GET  /projects/:id/flow-executions/:flowExecutionId         (父记录 + 每一步的 executions)
  POST /projects/:id/flow-executions/:flowExecutionId/cancel  (已终态返回 409)
  POST /projects/:id/flows/plan                   (拓扑排序结果或「有环」原因, 供画布显示步骤序号)

TEST CASES  [已实现]
  GET    /projects/:id/endpoints/:endpointId/cases   (接口工作台「用例」框列表, 含最近结果 lastRun)
  POST   /projects/:id/endpoints/:endpointId/cases   (保存为用例: 请求快照+环境+断言)
  GET    /projects/:id/cases                          (跨接口用例检索, 供 P2 选择器复用)
  GET    /projects/:id/cases/:caseId
  PATCH  /projects/:id/cases/:caseId                  (改名称/标签/环境, 亦可整体改写 request 快照与断言)
  DELETE /projects/:id/cases/:caseId                 (被套件引用时 409 + 清单, ?force=true 才删)
  GET    /projects/:id/cases/:caseId/usage           # 删除前引用扫描 (P2-4.5)
  POST   /projects/:id/cases/:caseId/execute          (可传 request / assertions 覆盖, 试跑屏幕上的改动而不落盘)
  GET    /projects/:id/cases/:caseId/executions
  GET    /projects/:id/endpoints                      (增强, 列表返回真实 caseCount)
  # 全部挂在 /projects/:id/** 之下: requireProjectAccess 只认 :id,
  # 计划里裸 /cases/:caseId 的写法拿不到项目守卫, 已改为项目内嵌套路由

ASSERTIONS  [已实现]
  POST /projects/:id/assertions/validate  (即时验证, 可传 environmentId / variables
                                           让脚本断言的 ctx.variables 与 { secret } 与真跑一致,
                                           返回 variables = 脚本 setVariable 写回的值)
  # 不做 assertions 公共库 CRUD: 断言内联存于用例, 无「断言库」界面需求

SCRIPTS  [已实现] (P1-1 断言收尾)
  GET    /projects/:id/scripts             (公共脚本列表, name IS NOT NULL, 支持 keyword)
  POST   /projects/:id/scripts             (新建公共脚本)
  GET    /projects/:id/scripts/:scriptId
  PATCH  /projects/:id/scripts/:scriptId   (编辑公共脚本, 响应带 follower 清单)
  DELETE /projects/:id/scripts/:scriptId   (有引用时 409 + 依赖清单, ?force=true 二次确认)
  GET    /projects/:id/scripts/:scriptId/usage  (引用此脚本的用例列表)
  POST   /projects/:id/scripts/try         (脚本试运行, 返回 console 输出与抛错文本)
  # 匿名私有脚本无独立生命周期, 由用例保存路径写入 (lib/scripts.ts), 不在本路由组暴露

EXECUTIONS  [已实现]
  GET /projects/:id/executions  (增强, 支持 source / caseId 过滤; 列表按「执行对象」显示用例名)
  GET /projects/:id/endpoints/:endpointId/executions  (增强, 默认返回全部来源, 可按 source 收窄)
```

### 4.3 前端新页面

- **Flow 编辑器** `[已实现]`: React Flow DAG 画布 (`@xyflow/react`)
  - 首轮节点类型: **API 请求**（条件/循环/脚本/等待/子流程/MCP 工具按需排期）
  - 拖拽连接, 节点配置抽屉（请求 / 提取 / 校验三页签）
  - 单步调试 + 流程变量注入; 画布配色全部改写为设计令牌, 不用 xyflow 默认调色板
- `[已实现]` **接口工作台「用例」框** (入口在接口管理, 无独立用例导航页):
  - 右侧栏分段切换 `[用例 | 运行记录]`, 同一框内二选一, 不新增常驻空间; **用例为默认视图**
  - 用例列表支持**名称搜索 + 状态(通过/失败/未执行) + 标签**筛选; 行内常驻 运行/编辑/删除 按钮
  - 「保存为用例」: 请求快照+环境+断言, 按最近响应状态码预填 `$.status = 200`; 保存后**自动加载该用例**
  - 点击用例加载快照替换请求区 + 顶部标识与 `[返回调试]`; 用例完全快照隔离
  - 加载后顶部出现主按钮**「保存用例」**, 一次写入请求快照 + 校验规则; `[另存为新用例]` 用于派生变体
  - 未保存时点「执行用例」按**屏幕上的**请求与规则试跑, 不落盘; 深链 `endpoints/:id?case=:caseId`
  - 接口列表「用例数」可点击, 跳转并直接定位到用例框
  - **用例删除暂不做依赖扫描**: 套件在 P2 才出现, 当前无引用方; 删除保留执行历史
- `[已实现]` **工作台「校验」页签**: 仅在加载用例时出现, 与请求页签并列
  - 左侧页签描述「发什么请求」, 校验页签描述「返回必须满足什么」, 以此区分用例与接口定义
  - 表格/文本双模式; 文本格式 `$.status = 200`、`$.headers.content-type ~ json`、`$.body.data.token exists`
  - **快速提取**: JSONPath 从响应 Body 解析成可勾选树, Header 从响应头列表勾选; 勾选多个则生成多条断言
- `[已实现]` **参数 / 请求头文本模式**: `key: value` 或 `key=value` 按行解析, 便于整段复制粘贴
  (按首个分隔符切分, 故 `https://…` 与 `Bearer a=b` 不会被截断; 整行 `#` / `//` 为注释)
- `[已实现]` **保存快捷键**: `⌘S` / `Ctrl+S` 保存当前对象(用例或接口), 未保存徽章直接标注该快捷键
- **跨接口用例选择器** `[P2 交付]`: 后端 `GET /projects/:id/cases` 已就绪, 弹窗随套件一起做
- `[已实现]` **断言配置器**: 支持**状态码 / Header / JSONPath / JSON Schema / 自定义脚本**
  (P1-1 收尾, 见 4.0.1)。JSON Schema 用独立 textarea + 实时 JSON 合法性校验;
  脚本用 Monaco 编辑器 + 试运行(带示例/当前响应上下文) + 折叠。脚本断言在脚本内用
  `ctx.assert` 直接断言, 逐条通过/失败在行内展开 (契约见 4.0.2.5); 支持本地命名、
  `return` 值在结果里以折叠块展示 (见 4.0.2.6)。
- `[已实现]` **公共脚本管理页** (环境管理 → 公共脚本 tab): 公共脚本 CRUD、
  引用数、编辑时显示跟随用例清单、删除两段式确认。接口工作台内公共脚本**只读**
  (跟随态不可编辑, 编辑统一在环境管理页, 避免在接口页顺手改影响其他用例)。
- `[已实现]` **内置动态变量参数化**: `{{$name(args)}}`, 环境变量编辑抽屉内有
  可折叠的参数速查表 (`{{$randomStr(16)}}` / `{{$date(YYYY-MM-DD)}}` / ...)。

### 4.4 基础设施

- `[已实现]` **BullMQ 接入** (P1-3): 队列 `executions`, job 载荷**只有 executionId**,
  请求定义与断言一律由 worker 回读 `executions.run_spec`。这样 Redis 中不存在任何
  请求体与凭据, 队列也不会成为第二真相来源。
- `[已实现]` **Worker 进程** (P1-3): `pnpm worker` / `pnpm start:worker` 独立进程,
  全局并发由 `WORKER_CONCURRENCY` 控制(默认 10), 取代了 P0 批量调试里硬编码的并发 5。
- `[已实现]` **执行事件流**: `GET /projects/:id/executions/stream` (SSE), worker 经
  Redis pub/sub 把状态变更转给 API 进程再扇出给浏览器。

**边界决策 (P1-3)**:

- **三个入口全部真异步**: 接口调试、用例执行、批量调试统一返回 `202` + 一条
  `queued` 的 execution/batch 记录, 结果经 SSE 到达。单发调试**前端交互不变**
  (仍是按钮转圈等结果), 异步只体现在底层与「排队中」状态上。
- **入队失败直接报错, 不降级内联执行**: Redis / worker 不可用时返回 `503`, 前端提示
  「执行队列不可用」。保留内联兜底会让同一份代码有两条执行路径, 行为差异(并发、取消、
  进度)只能靠猜, 排查成本高于收益。因此**日常开发必须同时起 `pnpm dev` 与 `pnpm worker`**。
- **执行记录改为「入队即落库」**: `executions.status` 扩展为
  `queued | running | success | failed | canceled`。代价是所有读取方必须自己区分
  「还没跑完」与「跑完失败」——仪表盘通过率的分母因此只算 `success + failed`,
  否则点一次执行数字就会自己跳动。
- **取消支持中断在途请求**: 服务端置 `canceled` + Redis 广播, worker 侧用
  `AbortController` 打断 `fetch`。终态写入带 `WHERE status = 'running'` 守卫,
  以此解决「取消信号与正常完成同时到达」的竞争——先落库者胜, 不会把已成功的结果
  覆写成 canceled。
- **不做分组限流**: BullMQ 开源版无 Groups, 用多队列或自建令牌模拟的复杂度不值当。
  当前为单队列全局并发, 单项目跑大批量时会占满槽位, 内部工具的并发规模可接受。
- **不自动重试**: 一次执行是一条用户可见记录, 自动重跑会凭空多发一次请求, 对写接口
  尤其危险。`attempts: 1`, 重跑由用户决定。
- **卡死回收**: worker 每 60 秒扫一次, 把超过 5 分钟仍未终态的行判为
  `execution abandoned by worker`(单次执行上限 30 秒, 超出必属事故), 并重算所属批次。
  这同时修掉了 P0 遗留的「批次永久停在 running」问题。
  回收用 `pg_try_advisory_xact_lock` 互斥, 多 worker 时同一时刻只有一个真正执行
  ——UPDATE 本身幂等, 但紧随其后的 `settleBatch` 会被重复触发, 导致同一批次被并发
  重算并各广播一次进度。事务级锁随事务结束自动释放, 进程崩了也不会把锁留下。

### 4.5 执行器可观测 (P1-3)

- `[已实现]` **心跳注册表** (`workers` 表): worker 每 10 秒 upsert 自己的
  hostname/pid/并发度/在途数, 「在线」由 `last_seen_at` 新鲜度在读取时推断
  (阈值 30 秒 = 3 个心跳)。worker 不监听端口, 平台无法主动探它, 只能由它自报;
  在线状态不落库是为了避免 kill -9 之后留下永远「在线」的幽灵行。
- `[已实现]` **执行归属** (`executions.worker_id`): 多 worker 后「某些执行特别慢」
  必须能落到具体进程上。不加外键——worker 下线后注册行会被清掉, 而执行历史必须
  活得比它久。
- `[已实现]` **系统设置 →「执行器」**: 在线数/总容量/在途/排队/失败任务 + 每个
  worker 的负载与运行时长。仅系统管理员可见 (`requireSystemAdmin`), 对其他人整块
  不渲染而非报错。
- `[已实现]` **worker 模式** (`workers.mode`): `endpoint` | `repository`。仓库模式
  尚未实现, 但列现在就加——等真做出来再加需要回填, 而回填时无法判断历史行属于
  哪种模式。worker 通过 `WORKER_MODE` 上报, 默认 `endpoint`。
- `[已实现]` **页面结构**: 顶部 `.tabs` 分「个性设置 / 执行器」(两类互不相关的内容),
  执行器内用 `.segmented` 按模式筛选(同一份内容的不同切片)。不做两层 tab——同页
  两排下划线 tab 无法区分层级。模式切换控件**由实际上报的模式推导**, 只有一种模式
  时不渲染, 将来仓库 worker 一上线自动出现, 无需改代码解除隐藏。
- `[已实现]` **死记录清理**: worker 启动时用 `process.kill(pid, 0)` 检查**本机**
  历史行对应的进程是否还在, 仅 `ESRCH` 时删除(`EPERM` 说明进程活着只是属主不同)。
  优雅停机会自己摘注册, 但 SIGKILL 来不及——`tsx watch` 每次保存换一个 pid, 没有
  这步开发时面板会堆满死 worker。跨主机的陈旧行仍由回收扫描按 1 小时窗口清理。

**边界决策**: **只读, 不做控制**。不提供暂停队列、排空 worker、在线调并发。增减
执行能力靠启停进程, 平台不代管进程生命周期——否则平台需要持有对部署环境的写权限,
而一个「误点暂停」会让所有人的执行静默卡住。

**队列指标按模式隔离**: 「排队/失败」读的是 `executions` 队列, 只对 endpoint 模式
成立。仓库模式必然是另一个队列, 因此响应里队列指标以 mode 为键, 没有队列的模式
不渲染这两项——显示 0 会被读成「没有任务在等」, 而事实是「这个模式还没有队列」。

> **P2-8 修订（待实现，见 5.0.12）**: 执行分区落地后队列指标变成 **mode + label 双键**
> ——`executions` 一条队列会按分区标签分裂成 `executions:<label>` 多条, 面板新增
> `partitions[]` 轴。上面这条「没有队列就不渲染」的原则不变, 只是判断维度多了一层;
> `mode` 仍不参与路由, 与 `labels` 是正交轴。

### 4.6 单机部署 (不使用 compose)

一次构建, 两个入口, 同一份产物:

```bash
pnpm build          # tsc → dist/
pnpm migrate        # 必须先跑: 新 API 会写 status='queued', 旧 CHECK 约束不允许
node dist/index.js       # API
node dist/worker.js      # worker
```

- **IO 密集, 单进程足够**: 执行是等待 HTTP 响应, 不吃 CPU。单机优先调大
  `WORKER_CONCURRENCY`, 而不是起多个 worker 进程。多进程只在响应体巨大、JSON 解析
  成为瓶颈时才有意义。
- **停机宽限期必须 > 30 秒**: worker 收到 SIGTERM 后会等在途请求跑完再退出, 而单次
  请求上限是 30 秒。systemd 默认 `TimeoutStopSec=90` 够用; **pm2 默认
  `kill_timeout` 只有 1600ms, 必须显式改成 45000**, 否则每次重启都会留下一批
  `running` 的行, 要等 5 分钟后的回收扫描才收尾, 用户看到的是「转圈五分钟然后失败」。
- **滚动更新安全**: job 载荷只有 executionId, 新旧版本 worker 可同时消费同一队列,
  不需要停机或排空。
- **worker 无入站端口**: 只出站到 Redis / Postgres / 被测目标, 因此可放在受限网段;
  存活状态从心跳表读, 不需要健康检查端点。

> **P2-8 补充（待实现，见 5.0.12）**: 上面这条「可放在受限网段」正是执行分区的实施基础，
> 但它有一个必须先落实的前提——**那台机器要能出站到平台的 Redis 6379 与 Postgres 5432**。
> 分区 worker 用 `WORKER_LABELS` 声明自己服务哪些分区（默认 `default`）。
> **推荐一个进程只服务一个标签**：BullMQ 的 Worker 绑定单队列, 一个标签一个 Worker 实例,
> 多标签进程必须按 `floor(WORKER_CONCURRENCY / 标签数)` 拆分并发, 否则上报的容量会翻倍失真。
> 生产网段那台 worker 不由 `start.sh` 代管——它不在本地, 与 4.5「平台不代管进程生命周期」
> 同一条边界。

### 4.7 P1-3 收尾修复与关键决策 (本会话)

**断言在 worker 内执行，一次写入定终态**（`lib/run.ts:188-209`）:

- 发完请求、读完响应后，断言求值与 `status` 判定在**同一个 worker 函数里完成**，
  结果、断言明细、终态 status 在同一条 `UPDATE` 落库。平台侧不参与执行。
- **有断言时断言说了算**，没断言才看 HTTP 状态码（`$.status = 404` 的用例收到 404 算通过）。
- 若改成「worker 发请求、平台再校验」，会出现终态已落、断言未判的窗口期，需要二次
  写入翻转 status——而 status 驱动仪表盘通过率、用例最近结果、批次汇总，多一次翻转
  就是多一处不一致。
- 断言跑在**截断后**的响应体上（`RESPONSE_LIMIT = 10000`），保证「断言通过」能从
  UI 看到的文本复现；JSONPath 指向 10KB 之后会取不到，大响应体接口需留意。

**多 worker 下保证 at-most-once**（非 at-least-once）:

- 第一层：BullMQ 原子出队，一个 job 只交给一个 worker。但这层不够——BullMQ 是
  at-least-once，worker 锁续期失败会重投 job。
- 第二层：`performRun` 认领带 `WHERE status = 'queued'`，被重投的 job 匹配不到
  `queued` 行，在 `fetch` 之前就返回 false。
- 三 worker 抢同一队列实测：80 次入队，靶子恰好收到 80 个请求，零重复。
- 这是刻意选择：工具会向真实服务发 POST/DELETE，「执行丢了」可重跑，「静默发了两次」
  无法挽回。代价是极端情况下会出现一条卡在 running、最终被回收判失败的无害记录。

**SSE 跨域坑**: `reply.hijack()` 之后 Fastify 不再走发送流程，@fastify/cors 挂到头上的
`Access-Control-*` 不会写出，浏览器直接拦掉流，前端退回轮询兜底——表现为「每次执行都
慢 3 秒」而不是「流坏了」。修复是手动把 CORS 头搬进 `writeHead`（只搬 access-control-*，
不整包 spread）。curl 测不出此问题，因为 curl 不检查 CORS。

**前端会话恢复 bug**: `authStore.hydrate()` 定义了但从未被调用，刷新后 `user` 恒为
`null`，任何按 `isSystemAdmin` 门控的区块（执行器面板）静默消失。修复在
`main.tsx` 的 `Root` 加一次 `useEffect(() => hydrate())`。教训：门控 UI 用
「整块不渲染」时，权限数据的初始化失败表现为功能消失而非报错，极难定位。

**前端体验修复**:

- **响应面板不再闪屏**: 运行状态只占标题栏（排队中/执行中 + 取消按钮），结果 body
  保持挂载、半透明置灰——之前是整面板替换，快响应（~50ms）下「结果→空白→结果」闪屏。
- **侧边栏分页** (`SidebarPager`): 运行记录与用例列表共用。修正了一个 antd 默认值坑：
  `Pagination` 的 `showSizeChanger` 默认是 `total > 50` 而非 false，不显式传参时列表
  跨过 50 行会凭空出现第二个页大小选择器。用例列表用**前端分页**（筛选是全量客户端
  过滤 + `lastRun` 在应用层拼装，服务端分页会让筛选退化成只筛当前页）。
- **复制按钮** (`CopyButton`): 工作台响应区 + 快照抽屉各代码块。复制的文本与渲染
  共用同一函数（响应体有 pretty/raw 切换，另走格式化路径会复制出和看到不一样的内容）；
  反馈用图标变对勾而非 toast；`navigator.clipboard` 只在安全上下文存在，textarea
  兜底是局域网 http 访问的主路径而非老浏览器兼容。
- **系统设置 tabs**: 顶部 `.tabs` 分「个性设置/执行器」（互不相关的内容），非管理员
  看不到执行器 tab 且整条 tab 栏不渲染。

### 4.5 P1-1 关键取舍 (已验收)

- **调试态「执行」会隐式保存接口定义**: `/endpoints/:id/execute` 由服务端读库发起,
  屏幕上的改动必须先落库才生效。已确认保留此行为, 但**保存 toast 静默**, 避免每次执行都弹提示;
  手动保存(按钮或 `⌘S`)仍有提示。
- **用例态「执行」不落盘**: 请求与断言作为覆盖参数传给后端, 存盘用例不受影响, 与上一条刻意不同。
- **用例编辑弹窗只管名称/标签/环境**: 请求与校验规则统一在工作台内改, 保证一份数据只有一个编辑入口。

---

## 五、P2 — 套件、Mock、数据源 + 流程补全（核心 8 周 + 数据源适配器增量）

> 场景（P2-3）已实现后撤回，编排统一由流程承担。见 5.0.6。

> **范围变更（已确认）**: P1-2 的两项遗留（并行执行、流程执行记录独立视图）与
> 全部剩余节点类型（脚本 / 条件 / 数据库 / 循环 / 等待 / 子流程）**并入 P2**。
> 核心闭环仍按 8 周规划；PostgreSQL 以外的数据源驱动按 P2 增量切片追加，不阻塞核心里程碑。
> 判断依据见 4.0.3。

### 5.0 P2 交付顺序（含 P1-2 并入项）

不按「先做完上层资源再补流程」排，而是按**依赖方向**排：下层语义没定，上层做完必然重做。

#### 5.0.1 已确认的实施边界（2026-08-13）

1. **数据源 PostgreSQL 先行**：先完成连接配置、凭据保护、命名 SQL、参数绑定、测试运行、
   流程数据库节点的完整纵向闭环。MySQL / SQL Server / Oracle / MongoDB /
   Redis 通过同一适配器契约在 P2 后续小批次加入，不要求首批同时落地。
2. **纵向闭环递增交付**：每个小批次必须能独立进入页面、保存配置、执行、取消、查看结果与历史；
   不采用「后端全部完成后再集中补前端」或「所有节点一次做完再验收」的横向大批次。
3. **高级节点留在 P2 后段独立切片**：脚本 / 数据库 / 并行 / 条件先稳定，套件不等待
   循环 / 等待 / 子流程；后三者仍属于 P2，但在核心业务闭环后分别验收。
4. **编排只有流程一种模型**（2026-08-15 修订）：原计划的场景「简化步骤编排」已撤回——它与
   流程解决同一个问题，却把「谁产出变量、谁消费变量」切到多个页面（见 5.0.6）。测试套件
   只负责编排成员，不直接执行 HTTP 或 SQL，成员之间也不传变量。
5. **Mock 与正式执行统计隔离**：Mock 请求日志不写入现有接口/用例通过率；管理 API 继续走
   JWT/RBAC，外部 Mock Runtime 使用独立路径和安全边界（定位确认见 5.0.7：面向外部联调方）。
6. **P2-1 前端边界已实现（2026-08-13）**：项目侧栏仅启用数据源入口，不提前展示 Mock /
   套件；数据源详情与 SQL 编辑目标由 URL 恢复，密码、SQL 参数值不进入 URL 或 localStorage；
   Flow 前端已升级为 `request | database` 判别联合，数据库节点使用独立配置与结果视图。

#### 5.0.2 开工前置：统一执行模型（P2-0，纳入第 1 周）

> **后端已实现（2026-08-13）**：`execution_index` / `execution_steps` 已落库，历史 Flow
> 已回填索引；新 Flow 的请求/数据库步骤、状态计数、取消和回收已接入统一模型。统一记录前端
> 视图仍按 P2-4 交付。

现有 `executions` 是 HTTP 证据表，`endpoint_id NOT NULL`，不能继续硬塞脚本、条件、数据库、
等待等非 HTTP 节点。P2 先建立以下公共模型，再开发新节点：

- 新增 `execution_index`：统一记录 flow / scenario / suite / batch 父执行的类型、目标快照、状态、
  计数和时间；状态统一沿用现有 `queued | running | success | failed | canceled`，不再引入
  `pending` / `aborted` / `cancelled` 等第二套词汇。
- 新增通用 `execution_steps`：每一步保存节点类型、名称快照、状态、耗时、输入/输出摘要和错误；
  HTTP 步骤通过可空 `http_execution_id` 关联现有 `executions`，继续复用请求/响应/断言快照；
  非 HTTP 步骤只写自己的受限结果，不伪造 endpoint。
- 新产生的 flow 执行同时写索引和步骤；历史 `flow_executions` 保持可读，迁移为其补索引，
  不重写既有 HTTP 子记录。统一执行记录 UI 到第 3 批启用，但数据模型在第 1 批先落地。
- 父任务仍占一个 BullMQ worker 槽；流程内并行另设受控上限，默认 4、最大 10。容量按
  `WORKER_CONCURRENCY × 节点并发上限` 评估，禁止无界 `Promise.all`。
- 同一并行阶段向变量袋写同名变量视为冲突并使对应步骤失败，禁止依赖完成先后产生非确定结果。
- 默认依赖边只在前驱成功后激活；失败节点 `stop` 终止整次父执行，`continue` 允许无依赖的其他
  分支继续，其默认成功后继标记 skipped，只有显式失败分支可以继续。

#### 5.0.3 核心 8 周切片

| 周次 | 切片 | 可验收交付 | 状态 |
| --- | --- | --- | --- |
| 1–2 | **P2-1 数据源闭环** | 执行索引/步骤基础；PostgreSQL 数据源 CRUD、凭据加密、连接测试；命名 SQL CRUD/试跑；流程数据库节点 | **已实现并通过用户验收** |
| 3–4 | **P2-2 核心流程补全** | 脚本节点、分层/受控并行、条件节点、非 HTTP 单步调试、节点结果与变量冲突展示 | **已实现并通过用户验收**（见 5.0.4） |
| 4+ | **P2-2.1 请求节点生命周期收尾** | 前置处理 → 请求 → 后置处理（提取+响应脚本）→ 声明式校验 → 成功提交变量；脚本校验迁入响应脚本；变量事务与使用文档分层 | **已实现，待用户验收**（见 5.0.5） |
| 5 | ~~**P2-3 场景**~~ | ~~接口用例 + 数据库步骤、后置 SQL 校验、变量映射、执行/取消/步骤报告~~ | **已撤回**（见 5.0.6，与流程编排重复） |
| 6 | **P2-4 测试套件 + 执行记录** | 手动/标签/全部选择、**用例与流程**成员快照、并发与 fail-fast、统一父执行列表和稳定详情路由 | **进行中**（P2-4.1 / P2-4.2 已验收；范围与边界见 5.0.11） |
| 7 | **P2-5 Mock** | 对外联调桩：自动快照/固定/模板/代理四种规则，独立 Runtime 公开访问、保护性安全上限、规则测试与联调请求日志 | **待实现** |
| 8 | **P2-6 高级节点** | 循环、短等待、子流程，递归/迭代/等待上限；核心链路遗留收口 | **已验收**（见 5.0.8） |
| — | **P2-8 执行分区** | 环境级执行分区标签、队列按标签路由、分区 worker、入队前在线检查、执行器面板分区轴 | **待实现**（范围与边界见 5.0.12，**有硬前置条件**） |

PostgreSQL 以外驱动作为 **P2-7 数据源适配器增量** 逐类交付。关系库先复用 SQL 契约；
MongoDB / Redis 使用独立操作定义，不伪装为 SQL，也不阻塞 P2 核心 8 周验收。
**P2-7.1–P2-7.4 已全部实现并于 2026-08-22 通过用户验收**（范围、分批与验收结论见 5.0.10）。

**P2-8 执行分区**不占核心 8 周的周次，它是一条由环境问题触发的增量切片（内网测试/生产网段
互不连通，worker 只能从自己所在网段出站）。它**不阻塞** P2-4 / P2-5，但**有一条硬前置条件**
（生产网段能否出站到平台 Redis + Postgres），前置不成立则本切片作废并转 P4.5。范围见 5.0.12。

**第 1 批 · 数据源（约 2 周）**

后端状态：`[已实现]`。包含 PostgreSQL 数据源/命名 SQL API、AES-256-GCM 密码补丁语义、
受限参数化 SQL 执行器、usage/force 删除，以及 Flow 数据库节点和通用单步结果。本轮按约束
未运行自动验证或启动服务，联调验收状态保持未完成。

- `data_sources` + `sql_definitions`，首发 PostgreSQL；连接配置、命名 SQL、参数 `{{变量}}`
  绑定防注入、测试运行
- 命名 SQL 定义处只声明参数名、类型、必填和默认值；具体来源和值由查询面板、流程节点、
  流程数据库节点各自在引用处绑定，避免把调用方概念写进公共 SQL 定义
- 首批只允许**单条参数化语句**；区分 query / command，禁止变量替换表名或列名，禁止多语句与
  DDL。查询统一限制超时、最大行数和最大结果字节；command 返回 `rowCount`，不自动重试
- 数据源敏感配置使用应用级 AES-256-GCM 加密，API 只返回非敏感字段和“已配置”状态；密钥由
  环境变量提供，不写入数据库、Redis、执行快照或前端存储
- **先做数据源的理由**：「校验返回 body 是否符合数据库查出的数据」这类需求目前完全无法表达。
- 落地后立刻可交付 **流程数据库节点**（执行与断言实现在 `lib/databaseStep.ts`）

**第 2 批 · 流程节点补全（约 2 周）** — `[已实现，见 5.0.4]`

- ~~**脚本节点**：把变量袋读写接进 `ctx.variables`，`return` 的对象合并进袋；
  沙箱、`scripts` 表、`owner_flow_id`、`ctx.crypto` 均已就绪，是本批最小的一块~~ `[已实现]`
- ~~**断言脚本变量/密钥支持**~~ `[已实现，4.0.2.5]`：断言脚本已接入环境变量袋与
  `{ secret: "NAME" }`，与钩子共用同一套变量优先级；`evaluateAssertions` 的三个调用点
  （`run.ts`、`cases.ts`、`/scripts/try`）均传入 `variables` + `resolveSecret` + 脱敏列表，
  断言写回的值按 `hookVariables → extracted → assertionVariables` 汇入流程变量袋
- ~~**并行执行**：先定义并发上限、局部失败对后继节点的影响、与 `WORKER_CONCURRENCY` 的
  关系；执行器使用 ready-set/分层调度，同层受控并行；**必须先于条件与循环节点**，两者都
  建立在这套语义上~~ `[已实现]`
- ~~**条件节点**：引入「节点被跳过」状态与边条件语义
  （`flow_executions.skipped_count` 已有位置）~~ `[已实现]`
- 循环 / 等待 / 子流程不阻塞第 3 批，改在 P2-6 独立验收：循环只允许节点内部迭代且有硬上限；
  首版等待为有上限的短等待；子流程保存和执行时都做循环引用检测并限制递归深度 `[已实现，见 5.0.8]`

**第 3 批 · 测试套件（约 2 周）**

场景已撤回（见 5.0.6），本批只剩套件与统一执行记录 UI。
**范围、边界、分批与迁移编号以 5.0.11 为准**（迁移号 022 → 026，另有 7 处计划文本更正）。

- `test_suites` / `suite_executions`：成员支持**接口用例与流程**，标签 / 手动 / 全部三种选择；
  动态选择在入队时固化成员快照，保证本次报告可复现
- 每个成员是一次**独立执行**：用例走单次执行，流程走流程执行。成员之间不传变量——需要传值
  的链路本来就应该建成一条流程，而不是靠套件的执行顺序隐式串起来
- ~~**跨接口用例选择器**：后端 `GET /projects/:id/cases` 已就绪，只差弹窗~~
  `[已实现过，随场景一并撤回；套件实现时按套件的选择语义重做]`
- **统一执行索引 UI**：底层索引已在 P2-0 建立；此批启用「执行记录」父级视图和稳定详情路由，
  同时补上 P1-2 遗留的流程执行独立视图。HTTP 子步骤继续使用现有快照抽屉。
  > **流程执行独立视图已提前单独交付**（见 5.0.9，2026-08-16）：流程画布侧栏「运行记录」+
  > 单次运行抽屉 + 项目执行记录标记流程执行。第 3 批剩余工作为套件与统一父执行列表。

**第 4 批 · Mock（约 1 周）**

> 定位确认见 5.0.7：Mock 面向**外部联调方**，不是平台内部测试夹具；本平台流程/用例测试以
> 真实数据为主，Mock 是次要场景。

- `mocks` 表，自动 / 固定 / 模板 / 代理四种模式；固定 / 模板优先（联调最常用）
- 自动模式在创建规则时复制该接口最近一次成功响应作为固定快照，不在每次请求时回读执行历史；
  没有成功响应时要求用户补齐响应
- 模板模式变量来源优先支持从请求 path / query / body 取值（入参不同 → 响应不同）
- 代理模式必须配置目标白名单、连接/响应超时和响应大小上限，剥离平台认证及 hop-by-hop headers，
  防止形成开放代理或 SSRF 入口；连接/响应超时是 **Runtime 自身的转发预算**（保护性上限），
  不是模拟场景，超时回 504 并记日志
- `delay_ms` 保留，模拟「慢 / 超时」面向**外部调用方**——对方按自己的超时预算触发；对平台内
  流程无意义（流程 HTTP 步骤 30s 硬预算先于 mock 延迟开枪，超时场景由流程自身预算兜底）
- `mock_request_logs` 是联调排障核心：matched / 请求快照 / status_code 必须齐全
- 排在最后：它与前三批没有依赖关系，任何时候插入都不影响其他部分

#### 5.0.4 P2-2 已实现并通过用户验收（2026-08-13 实现 / 2026-08-14 验收）

脚本节点、受控并行、条件节点一次落地，执行语义对齐 5.0.2 与 5.5.2：

**数据层（迁移 017）**：`execution_steps.status` 扩出 `skipped`；`scripts.kind`
扩出 `node`（脚本节点脚本与断言/钩子契约不同，仍挂同一张表、随 `owner_flow_id`
生灭、公共脚本可被引用）。受控并发配置存入 `run_spec` JSONB，不加列。

**执行器（`lib/flowRun.ts` 重写为 ready-set 分层调度）**：

- **受控并行**：`FLOW_PARALLELISM` 默认 4、上限 10（计划 5.0.2）。父任务仍占一个
  BullMQ worker 槽；同层 ready 节点按画布位置起跑，用 `Promise.race` 流式补位，
  禁止无界 `Promise.all`。`execution_steps.stage` 记录并行层级。
- **边条件**：`FlowEdge.on` 取值 `success`（默认）/ `failure` / `true` / `false`。
  默认边只在前驱成功后激活；失败节点 `stop` 终止整次父执行（不传播边），
  `continue` 允许失败分支（`on: "failure"`）与无依赖分支继续，其默认成功后继
  标记 `skipped` 并落证据行。条件节点的出边必须声明 `true`/`false`，未命中的
  分支整体跳过——「条件只激活命中分支」。
- **同名冲突稳定失败**：同 `stage` 内两个节点写同一变量名时，后完成者失败并
  把先完成者翻转为失败（步骤行 + `executions` 行），冲突名从变量袋移除——结论
  不依赖完成先后。
- **脚本节点**：`runScriptNode`（`lib/sandbox.ts`）读写 `ctx.variables`，
  `ctx.setVariable` 与 `return` 对象都合并进变量袋；报错或 `ctx.assert` 失败即
  该步失败。入队时 `inlineScriptNode` 内联正文（与断言/钩子同一条复现规则）。
- **取消/回收**：主循环在每次补位前检查 `AbortSignal`，取消后不再启动新步骤，
  在途请求经既有 inflight 登记中断；`execution_steps.skipped` 状态进入回收与
  取消处理路径。

**单步调试（`routes/flows.ts`）**：`/nodes/execute` 按节点类型分派——request 仍走
`enqueueRun`（HTTP 执行），database/script/condition 走 `executeGenericStep`
（通用步骤证据，不伪造 HTTP 快照）。`/nodes/executions` 合并返回两类证据
（`executions` + `execution_steps`）。`/flows/plan` 新增 `stages` 并行分组，
画布步骤序号改为显示并行批次而非平铺序号。

**前端**：新增脚本/条件节点配置抽屉（脚本节点含公共脚本 follow/copy、单步调试
与输出展示；条件节点为变量/比较符/期望值三字段编辑 + 判断结果展示），步骤选择器
增补两类节点，画布渲染对应节点卡。数据库节点单步调试此前因返回形状不匹配实际
不可用，本轮随统一步骤模型一并修复。

**验收对照（5.5.2）**：无依赖节点按上限并行 ✓；同名输出冲突稳定失败 ✓；
条件只激活命中分支 ✓；脚本/数据库/条件步骤均有可复盘结果 ✓；取消后不再启动
新步骤、已启动步骤尽力中断 ✓。

**首轮 / 二轮反馈修复（2026-08-14）**：P2-2 首轮与二轮的反馈修复记录已移出开发计划，
统一归档到 `issue_fix/P2-2_ISSUE_LOG.md`（#1–#5：脚本节点模板、公共脚本按钮、条件节点
双出口、保存后重开、空格键截获）。

**脚本智能提示补全（2026-08-14）**：`lib/scriptContract.ts` 成为 ctx 契约单一来源，按
assertion / hook / node 返回各自可用的 `ctx` 成员与调用 snippet；前端统一 Monaco 编辑器按脚本
类型提供 `ctx.*` 补全。脚本库由后端 Acorn AST 提取顶层函数/类/常量并随列表返回，补全只注入
当前脚本已声明的依赖，另提供可点击的符号速查。脚本节点补齐依赖选择器，断言/前置/脚本节点
三处一致。库内容契约明确为仅允许顶层 function、class、const/let/var（含箭头函数）声明；拒绝
顶层调用、循环、分支和带副作用的变量初始化，JSDoc 作为补全文档展示。

**条件组合与变量链路（2026-08-14）**：条件节点由单条规则扩展为扁平规则组，支持全部满足
（AND）和任一满足（OR），最多 20 条；旧单条件 JSON 在 API 边界自动归一为单条 AND，不需迁移。
执行证据逐条记录变量、操作符、期望值、实际值与结论。脚本节点文案明确变量传播：
`ctx.setVariable("name", value)` 或 `return { name: value }` 写入变量袋，后续请求/SQL/条件通过
`{{name}}` 使用，后续脚本通过 `ctx.variables.name` 使用；同层并行节点不互相读取且同名写冲突失败。

**提示分层与文档沉淀（2026-08-14）**：页面保留一行可扫描的高频规则、字段约束、跟随/依赖
状态、运行结果和错误，不删除操作所需说明；完整生命周期、ctx API、变量传播和脚本库契约后续
建设独立使用文档页面，避免同一页面堆叠长篇说明造成疲劳。已将确认内容写入 `API_AUTOMATION_SPEC.md`：请求节点生命周期
（前置处理 → 请求 → 后置处理 → 声明式校验 → 成功提交变量）、`ctx.setVariable` 临时变量与
DAG stage 传播语义、响应脚本一次遍历完成复杂校验+变量加工、条件 AND/OR、ctx 与脚本库契约；
并明确区分当前执行器行为与后续目标模型，避免文档把未实现重构写成已交付。

#### 5.0.5 P2-2.1 请求节点生命周期收尾（已实现，待用户验收）

本切片承接 P2-2 已验收的节点能力，收口请求节点的固定生命周期，避免同一份请求语义在
不同入口各长一套。

- **固定阶段**：环境/流程变量展开请求模板 → 前置处理 → 发送请求 → 后置处理 → 声明式校验
  → 节点成功后提交临时变量；失败、取消、跳过均丢弃本节点临时变量。
- **后置处理**：由简单字段提取和响应脚本组成。简单路径映射继续使用提取；循环、聚合、格式
  转换、复杂关联校验和变量生成放入一个响应脚本，一次遍历同时使用 `ctx.assert` 与
  `ctx.setVariable`，不要求校验和提取各遍历一次。
- **校验收敛**：校验区只保留状态码、Header、JSONPath、JSON Schema 等声明式规则；删除
  “脚本校验”类型，自定义脚本迁入后置响应脚本。现有数据可忽略，不做旧脚本断言迁移。
- **变量语义**：前置 `ctx.setVariable` 供同节点后续处理和节点成功后的 DAG 后继节点使用，
  但不触发当前请求模板二次展开；影响当前请求必须直接修改 `ctx.request`。后续请求/SQL/条件
  使用 `{{name}}`，后续脚本使用 `ctx.variables.name`；同 stage 不互读且同名写冲突失败。
- **界面与文档**：请求节点 Tab 调整为“请求 / 前置处理 / 后置处理 / 校验”。页面保留高频、
  就地可执行的一行提示，不做无提示化；完整说明集中到后续独立“使用文档”页面，规范来源为
  `API_AUTOMATION_SPEC.md`，页面不复制多份长文。
- **验收**：一个响应脚本可在一次数组遍历中完成聚合、复杂断言和变量写回；任一后置处理或
  声明式校验失败均不提交变量；前置变量可被同节点后置处理读取，节点成功后可被依赖后继读取。

#### 5.0.6 P2-3 场景（已实现后撤回）

场景按「串已有用例 + 传变量」的定位实现过一轮（`scenarios` / `scenario_executions`、
步骤引用用例、入队冻结、后置 SQL 校验、执行/取消/步骤报告），随后**整体撤回**。

**撤回原因**：场景与流程编排解决同一个问题，但场景的「步骤只引用用例」模型让上下文被切开。
一条真实链路——先调生券接口、再把券号传给发券接口——在场景里要求：先去接口工作台把生券
用例的提取变量定义好，再回场景，再去发券用例里把 `{{券号}}` 写进请求体。请求参数不在场景页
可编辑（那是用例的内容），于是「谁产出、谁消费」必须跨多个页面对齐；而一旦为了解决这点把
入参绑定、前置/后置脚本都搬进场景页，它就变成了流程编排的另一套实现。用户实测结论是流程
能更好地表达同一条链路，因此不保留两套语义相近、上下文割裂的编排资源。

**一并撤回的「后置 SQL 校验」**：它真实的需求是「请求之后紧跟一步查库校验」，流程里加一个
数据库节点正是这件事。一个只能挂在末尾、语义特殊的第二种校验位置定位错了。

**保留下来的部分**：`lib/databaseStep.ts` —— 数据库执行与断言的共用实现，现由流程数据库节点
使用（第 1 批约定的「共用同一套执行与断言」因此仍然成立）。

**清理方式**：`021_drop_p2_scenarios.sql` 删表、删 `executions` 上的两个场景列，并把 `source`
的 CHECK 收回三个真实来源。项目尚未上线，`scenario_step` 只存在于开发库（AGENTS.md：不为历史
数据写兼容代码），所以那些执行行一并删除，避免留一个永远不再产生、却要在每个筛选器里解释的
死值。`execution_index.kind` 的 CHECK 不动——收窄它要重建约束，而 P2-4 套件还要再改一次。

**结论写进架构决策**（5.0.1 第 4 条已同步）：编排只有流程一种模型；批量回归由 P2-4 测试套件
承担，套件成员是**相互独立**的用例与流程执行，成员之间不传变量——需要传值的链路就应该建成
一条流程。

#### 5.0.7 P2-5 Mock 定位确认（2026-08-15）

Mock 的首要消费方是**外部联调方**，不是平台内部的测试夹具：

1. **定位：对外联调桩**。被测流程/用例依赖真实数据，Mock 不是本平台回归的主要工具；它的核心
   价值是让外部团队在接口未就绪或半就绪时，通过公开路径先调通、先开发。
2. **两类超时分开**：
   - 代理模式的连接/响应超时是 **Mock Runtime 自身的转发预算**，与目标白名单、响应大小上限
     同属安全边界，不是模拟场景；超时回 504 并记日志，UI 标注「保护性上限」。
   - `delay_ms` 保留，服务对象是**外部调用方**：对方系统按自己的超时预算触发「慢 / 超时」场景，
     验证的是对方对慢依赖的健壮性。对平台内流程无意义——流程 HTTP 步骤有 30s 硬预算
     （`lib/run.ts` REQUEST_TIMEOUT_MS），先于 mock 延迟开枪，「下游超时」由流程自身预算兜底。
3. **四种模式权重按联调排序**：固定 / 模板最常用（对方按不同入参拿不同响应），自动快照次之
   （克隆真实最近一次成功响应，契约贴近真实），代理次之（半就绪时观察 / 转发真实流量）。
4. **模板模式变量来源优先请求驱动**：联调最常见需求是「入参不同 → 响应不同」，模板变量优先从
   请求 path / query / body 取值，再考虑平台环境变量。
5. **请求日志是联调排障核心**：`mock_request_logs` 记录 matched、请求快照、status_code、
   duration_ms，是双方确认「到底调了没有、参数对不对」的客观证据。
6. **公开访问安全性**：外部调用方不登录平台，直接访问 `ANY /mock/:publicId/*`；public_id 必须
   带熵不可枚举、匿名可达，可选访问 token 待拍板。
7. **平台内流程仍可用但非重点**：测试以真实数据为主；流程引用 Mock 时只承担
   「成功 / 失败 / 慢成功」三类可确定响应，超时场景由流程自身预算兜底。

#### 5.0.8 P2-6 高级节点（已验收）

三种节点一次落地：**等待**、**子流程**、**循环**。核心决定是不为它们新建一套执行语义，
而是把 P2-2 的 ready-set 调度器抽成可复用的 `runGraph`，让「节点内部再跑一整张图」复用
同一套分层并行、边条件、跳过传播与同名写冲突裁决——两套语义必然产出「同一条链路在外层
并行、抽成子流程后变串行」这种说不清的差异。

**执行层拆分**：`lib/flowRun.ts` 收缩为薄壳（认领执行、准备 run_spec、收尾），
`lib/flowGraph.ts` 持有 `runGraph` 与两个容器执行器，`lib/flowNodes.ts` 持有不递归的
叶子执行器（数据库/脚本/条件/等待）。依赖单向：flowRun → flowGraph → flowNodes。

**并发模型（本切片最容易做错的一处）**：整次执行共享一个容量固定为 `FLOW_PARALLELISM`
的令牌池，**只有叶子步骤取令牌，loop/subflow 容器不取**。容器持令牌就会死锁——容器占满
额度后，它自己的循环体永远等不到令牌。循环的 `concurrency` 是**局部信号量**而不是抬高
全局容量：后者在两个循环重叠时会互相踩保存/还原，并把池子永久放大。因此嵌套三层的真实
并发仍被单次预算封顶，不会变成 4×4×4。

**「同一个接口的并发请求」的表达方式（用户验收后修订）**：**请求步骤自身的
`RequestFlowNode.concurrency`**——并发只属于请求，不经过循环。并发只属于请求的理由：
它是「同一个接口发 N 个并发请求」的表达，数据库/SQL、脚本、等待并发跑没有价值，
所以不给它们这个字段。请求自己跑 N 次，提取按迭代序收集成数组，证据是 N 个子步骤行。

**迭代语义**：迭代**互相独立**，每次都从同一份外层快照起步——并发下让迭代互读必然产生
调度相关的非确定结果。跨迭代汇总由循环之后的脚本节点读取出参完成。出参按迭代序压实成
JSON 数组（未产出的迭代不占位，不会出现 `null` 空洞）。

**循环是画布容器（用户验收后修订）**：`LoopFlowNode` 从「引用一条流程」改为**内联 body
子图**。循环在画布上是一个**真正的 React Flow 父节点**（虚线大框），被它框住的步骤是真正的
子节点（`parentId` 指向循环）：因此可以**把已有步骤拖进框**、**从框里拖出去**、**双击框内
步骤打开它自己的抽屉**，与顶层步骤没有区别；框右上角的 `+` 直接往框里加一步。体内可以是
任意节点，包括**子流程节点**——「循环内引用子流程」由此成立，不需要循环自己引用。循环自身的
`concurrency` 是「N 次迭代在飞」，与请求并发正交。

坐标与作用域的换算集中在 `apitest-web/src/lib/flowCanvas.ts`（展平/写回/重父/边分派/框尺寸），
不散落在组件里。故意**不用** `extent: "parent"`——那会把子节点锁死在框内、再也拖不出来；
进出由拖拽结束时的中心命中判定完成。**连线不能跨越框**：框内每轮迭代跑一遍、框外只跑一次，
一条跨界边没有可执行语义，`onConnect` 当场拒绝并说明原因。体内无连线时按数组顺序串成链执行。
`materialize()` 是画布→文档的唯一出口，保存、运行、计划、脏检查共用它，避免四条路径对
「文档现在长什么样」给出不同答案。

**引用而非快照**：子流程节点引用另一条流程，与请求节点复制 endpoint 相反。请求节点
快照是为了让流程独立于后续编辑；子流程存在的意义恰恰是一份定义多处复用，所以改子流程
要影响所有调用方。单次运行的可复现性用另一种方式保证：入队时把内层图连同脚本正文整份
冻进 `run_spec`。

**四条硬上限**（对应 5.5.2 第 6 条验收）：迭代 ≤ 100（超限直接失败，不静默截断）；
循环并发 ≤ 10；单次等待 ≤ 30s（等待占着并发额度，长等待需要挂起-恢复模型，不在本版）；
嵌套深度 ≤ 3 且嵌套总步骤数 ≤ 200（仅限深度不能约束体积）。

**循环引用检测**（`lib/flowRefs.ts`）：保存、执行、入队三处都做，且必须给出同一答案——
被引用的流程可能在上次保存后被改坏。报错按名字给出路径（「A → B → A」），而不是 id。

**嵌套证据**（迁移 022）：`execution_steps` 增 `parent_step_id` / `iteration`，容器内部
每一步都有可复盘的证据行，否则一次失败的循环只留下「第 3 次迭代失败」。015 的唯一键按
`position`（节点声明下标，用于同名冲突的确定性裁决）建立，循环会让同一内层节点重复出现，
故改为两条分区唯一索引：顶层保持原语义，嵌套按 (容器行, 节点, 下标, 迭代号) 唯一。
**父级计数只统计顶层步骤**——取消、worker 兜底、回收的聚合都加 `parent_step_id IS NULL`
过滤，否则会出现「12/5 步通过」。

**前端**：三个节点配置抽屉（`FlowAdvancedNodeDrawers.tsx`，共享「引用流程 + 入参 + 出参」
表单）、嵌套步骤证据视图（`NestedStepList.tsx`，循环按迭代分组可折叠，HTTP 子步骤复用既有
快照抽屉）、画布节点卡与节点选择器扩展。出参白名单进入变量补全（脚本节点仍不可知，只有
它自己知道写了什么）。嵌套证据按需拉取（`/execution-steps/:stepId/children`），不随父详情
返回——100 次迭代的嵌套行数可能比顶层步骤多一个量级。

**首轮自审修正**：并发模型返工（容器持令牌导致的死锁、`setCapacity` 的全局踩踏与容量泄漏）；
`onProgress` 改为只在顶层图回调（内层局部计数会把父级进度刷成小数字）；入参解析去掉
`as string`（`resolveDeep` 对整字段引用会还原出数组）；单步调试容器/等待节点补上真实超时
（原先传的是永不 abort 的信号，一个 100 次迭代的循环能把 HTTP 请求挂住近一小时）；循环出参
去空洞；`enqueue.ts` 复用 `inlineFlowNodeScripts`，消掉那份重复的脚本内联实现。

**未验证**：按项目约定未运行测试、未启动服务。两端 `pnpm check` 与前端 `pnpm build` 通过，
但并发模型改动较大，联调验收状态为未完成。
**验收结论**：2026-08-16 用户验收通过（缺陷统计见 `issue_fix/P2-6_ISSUE_LOG.md`）。

#### 5.0.8 P2-6 缺陷统计

> P2-6 的 21 个缺陷统计与七轮用户反馈修正记录已移出开发计划，统一归档到
> `issue_fix/P2-6_ISSUE_LOG.md`（缺陷分组表 A–E、遗留项、教训、多轮修正、执行语义）。

#### 5.0.9 流程执行记录独立视图（P2-4 先行切片，2026-08-16 范围已确认）

> 本切片从 P2-4「统一执行索引 UI」中提前单独交付**流程执行记录独立视图**（P1-2 遗留项），
> 在计划 5.0.3 第 3 批的「统一父执行列表」之前先落地，直接回应「流程历史执行记录 + 统一概览」。
> **已通过用户验收（2026-08-25）**。它交付的「流程执行记录」大类已由 P2-4.4 改造成带 kind
> 筛选的「父执行记录」（`recordType: parent`），见 5.0.11 边界决策 7 与「P2-4.4 落地时确定的
> 6 处细节」。

**已确认范围**：

1. **流程画布编辑器侧栏「运行记录」**：`FlowWorkspace` 增加类似接口编辑器（`EndpointWorkspace`
   的 `workbench-side`）的侧栏，列出该流程的执行历史（复用 `GET /flows/:flowId/executions`），
   支持分页与状态筛选。选中某次运行 → 抽屉打开。折叠后显示 rail（对齐接口编辑器），
   从画布顶部按钮改为侧栏折叠/rail 展开。**侧栏已抽成共享组件 `HistorySidebar`**，流程与
   接口两端共用同一套面板/折叠/rail（顶部间距统一放 flow-body，展开与 rail 与画布严格平齐）。
   `[已实现]`
2. **运行抽屉展示整次运行**：抽屉打开后**一次展示该次运行的全部步骤**（批量调试抽屉的样式——
   每步一行、可展开，行显示「状态码 · 耗时」与批量调试完全同款），不再嵌套一层运行列表。
   步骤渲染：HTTP 步骤复用 `ExecutionDetail`（请求/响应/断言），非 HTTP 步骤复用
   `DatabaseResult` / 脚本 / 条件结果展示，loop/subflow 容器**递归**复用 `NestedStepList`
   ——循环内每一迭代、每一步都点开对应到**那一次具体执行**的快照，支持循环/子流程再套
   循环/子流程。数据来源 `GET /flow-executions/:id`（`steps` + `executionSteps` 已齐备）。
   `[已实现]`
3. **项目级执行记录标记流程执行**：`ExecutionRecords` 页新增「流程执行记录」大类
   （`recordType: flow`，经 `GET /execution-index?kind=flow` 聚合列出流程父执行，点开即
   运行抽屉——与批量调试同类展示），单接口记录默认排除 flow_step；流程步骤行显示
   `流程执行` chip + 流程名；后端项目级 executions 列表 `LEFT JOIN flow_executions`
   带出 `flow_name`，`SOURCE_FILTERS` 放开 `flow_step`。**支持按流程名称搜索**
   （`GET /execution-index?keyword=` 对 `target_name` 做 ILIKE，前端「流程执行记录」
   视图提供搜索框）。`[已实现]`（P2-4.4 起该大类为 `recordType: parent`，`kind` 变成它的
   子筛选；搜索框同时覆盖套件名）

**边界决策**：

- 不做统一父执行列表、不做稳定详情路由、不建 `batch`/`suite` 分支——那些仍留在 5.0.3 第 3 批
  的「统一执行索引 UI」；本切片只做流程侧栏入口 + 单次运行抽屉 + 项目记录标记。
- 后端无新增迁移、无新表；`execution_index` / `execution_steps` 数据模型本轮不改。
- 抽屉内步骤展示「整合一次运行」，与批量调试的交互一致：行点击展开，展开区显示请求/响应快照
  或非 HTTP 步骤结果。
- 项目级「单接口记录」默认排除 flow_step（流程已是大类，避免同一运行步骤重复散落）；接口
  工作台历史仍按 `endpointId` 维度包含流程步骤。

#### 5.0.10 P2-7 数据源适配器增量（2026-08-16 范围已确认；P2-7.1–P2-7.4 已实现并通过用户验收，2026-08-22）

> PostgreSQL 以外的数据源驱动按 P2 增量切片追加（见 5.0.3 末尾），不阻塞 P2 核心里程碑。
> 关系库（MySQL / SQL Server / Oracle）复用 SQL 契约；MongoDB / Redis 使用独立操作定义，
> 不伪装为 SQL。每类按 5.0.1「纵向闭环递增交付」：数据源 CRUD → 连接测试 → 命名定义/试跑
> → 流程数据库节点 → 结果与历史，一类一条闭环，逐类验收。

**已确认的边界决策**：

1. **命名定义仍是 `sql_definitions` 一张表**：CRUD、usage 扫描、流程节点引用、快照、试跑
   五条路径共用，不为 mongo/redis 另开操作定义表（那会把五条路径各复制一份）。迁移 024
   给它加 `kind`（`sql|mongo|redis`）与 `operation` JSONB 列，`statement_type` 语义收窄为
   只对 `kind='sql'` 有效；API 路径 `/sql-definitions` 不变，mongo/redis 定义在 UI 上标注
   「操作定义」。项目未上线，无历史数据要兼容。
   **实现期补充**：迁移 025 放宽 `statement_type` / `sql` 的 `NOT NULL`（024 只加列，没解除
   建表时的约束，导致 mongo/redis 定义写不进库），并把形状收成一条 CHECK——`kind='sql'`
   必须有 statement_type + sql 且无 operation，`kind<>'sql'` 反之。形状由数据库兜住，
   而不是只靠路由分支。
2. **交付顺序（已确认）**：MySQL → SQL Server + Oracle → MongoDB → Redis。MySQL 与 PG 的
   占位符（`?`）、行数包装、只读事务最接近，先验证适配器契约扩展性；SQL Server + Oracle
   收方言差异；Mongo/Redis 另起操作定义模型。
3. **输出契约不因类型改变**：所有类型仍返回 `{ rows, rowCount, truncated, durationMs }`。
   数据库步骤用「200 + JSON content-type」虚拟 HTTP 主体跑断言/提取（`databaseStep.ts`），
   Mongo 文档、Redis 标量/数组全部归一进 `rows`，断言编辑器与 `DatabaseResult` 不出现第二套
   语法。
4. **安全与限制同 PG**：config 只存非敏感字段、密码 AES-256-GCM；参数只经驱动绑定
   （`{{name}}` 在 filter/args 内深解析，不字符串拼接）；超时/行数/结果字节上限逐类型生效；
   连接测试按类型（Oracle 用 `SELECT 1 FROM dual`、Mongo 用 `count`、Redis 用 `PING`）。
5. **连接必填项按类型决定**（实现期确认）：Redis 在 6.0 ACL 之前没有用户名概念且常见于
   无认证部署，它的 `database` 只是库序号（缺省 0）——两者都可选，但填了必须是数字；
   MongoDB 的 `username` 可选（无认证 dev 集群常见），`database` 仍必填（要库名才能定位
   集合）；四个关系库保持 host + database + username 全必填。前后端共用这一份规则。
6. **操作路径的只读边界**（实现期确认，属范围收窄）：SQL 侧的只读保证来自
   `statementType` + `BEGIN READ ONLY` + 首词校验，操作侧没有对等机制，因此**直接拒绝**
   `$where` / `$function` / `$accumulator`（服务端 JS）与 `$out` / `$merge`（会让名义上
   「读」的 aggregate 覆盖整个集合）。深度扫描文档的**键**，且**扫两遍**——定义时一次、
   `{{name}}` 解析后一次，因为 `json` 类型参数能整体替换成对象绕过定义时校验。
   这与 `skeleton.validateStatement` 的分工一致：定义时超集校验，执行时精确校验才是权威边界。
7. **Redis 白名单同时约束参数个数**（实现期确认）：白名单是
   `Record<command, [min, max|null]>`（`null` 表示可变参），唯一入口
   `validateRedisCommand(command, argCount)` 在保存时与驱动开 socket 前各用一次。
   理由：Redis 只回「wrong number of arguments」而不说要几个，而「改命令、忘改 args」
   是这个编辑器里最容易犯的错。
8. **驱动按需加载**（实现期确认）：`lib/adapters/index.ts` 的注册表是动态 `import()`
   加载器 + 结果 memo，不再静态 import 六个驱动。纯 PG 项目的 API 与 worker 不该为
   `mongodb` / `mssql` / `oracledb` 付启动成本，任一驱动加载失败也只应废掉一种数据源类型，
   而不是让整个进程起不来。`isSupportedDataSourceType` 保持同步——回答「这个类型存在吗」
   不该触发驱动加载。

**落地内容**（P2-7 全部已实现并验收）：

- **适配器契约抽取**：`sqlExecutor.ts` 拆为 `lib/adapters/`——`types.ts`（`SqlAdapter` 接口
  + 按 `data_source.type` 的注册表）、`skeleton.ts`（方言感知 SQL 骨架：引号/注释/占位符
  识别）、`common.ts`（参数值转换、行数/字节截断、clamp 共享）、各类型实现。`sqlExecutor.ts`
  收缩为「载入数据源 → 按 type 查 adapter → 分派」的薄壳。
- **关系库方言**（校验规则与防注入原则全部保持，仅骨架/占位符/事务/行数上限不同）：

  | 维度 | MySQL | SQL Server | Oracle |
  |---|---|---|---|
  | 驱动 | `mysql2` | `mssql` | `oracledb`（thin 模式，免 Instant Client） |
  | 占位符 | `?` | `@p1` | `:1` |
  | 行数上限 | `SELECT * FROM (...) AS t LIMIT n+1` | `SET ROWCOUNT n+1`（**不包装语句**） | 驱动 `maxRows: n+1`（**不包装语句**） |
  | 只读事务 | `START TRANSACTION READ ONLY` | 不支持 → 普通事务 + 语句校验兜底 | `SET TRANSACTION READ ONLY` |
  | 超时 | session `max_execution_time` | 驱动 `requestTimeout` | 无驱动选项 → 客户端竞速 + 关连接终止会话 |
  | 连接超时 | 驱动 `connectTimeout`（ms） | 驱动 `connectionTimeout`（ms） | 驱动 `connectTimeout`（**秒**，向上取整） |
  | 骨架补充 | 反引号、`#` 注释 | `[ ]` 方括号标识符 | 同 PG |

  > **行数上限为何两处不再包装语句**（实现期修正）：原计划的
  > `SELECT TOP (n+1) * FROM (<用户 SQL>) AS t` 在 SQL Server 上会让**所有**带
  > `ORDER BY` 的查询报错 1033（派生表不允许裸 ORDER BY），带 CTE 的查询更是直接语法错误
  > ——而 `skeleton.validateStatement` 明确把 `WITH` 当合法 query 放行，两者本身矛盾。
  > 改用 `SET ROWCOUNT`（仅对 query 生效，连接执行完即销毁，无需复位）。Oracle 同理走
  > 驱动 `maxRows`，比 `ROWNUM` 包装更不干扰用户语句。MySQL / PG 的派生表接受
  > `ORDER BY` 与 `WITH`，保持包装不变。

  结果归一化在 adapter 内、进 `rows` 之前：`datetime2` / Oracle `NUMBER`/`DATE` / MySQL
  `BigInt` 显式转字符串或 JSON，保证 `JSON.stringify` 与前端渲染不炸。
- **MongoDB 操作**（kind=`mongo`，`operation` JSONB）：读 `find`（filter/projection/sort/
  limit）、`aggregate`、`count`、`distinct`；写 `insertOne/Many`、`updateOne/Many`、
  `replaceOne`、`deleteOne/Many`。filter/pipeline 内 `{{name}}` 深解析后走驱动绑定；
  `maxTimeMS` 对**全部**操作生效（含 distinct 与写操作）；`limit(maxRows+1)`，且用户传
  `limit: 0` 会被抬到正数——Mongo 的 `limit(0)` 语义是「不限制」，会把整个集合读进内存；
  写结果映射为单行。按边界决策 6 拒绝 `$where`/`$function`/`$accumulator`/`$out`/`$merge`。
  `validateOperation` 逐 op 校验必填载荷（`updateOne` 要 filter+update、`insertMany` 要
  非空对象数组…），不把缺字段留给驱动去抛栈。
- **Redis 操作**（kind=`redis`，`operation` JSONB）：命令白名单 + 参数个数（见边界决策 7），
  覆盖 PING/GET/SET/MSET/MGET/DEL/EXISTS/EXPIRE/TTL/PERSIST/INCR(BY)/DECR(BY)/
  LPUSH/RPUSH/LPOP/RPOP/LRANGE/LLEN/HSET/HMSET/HGET/HGETALL/HDEL/HLEN/HEXISTS/
  SADD/SREM/SMEMBERS/SCARD/SISMEMBER/GETSET/SETNX/INCRBYFLOAT；args 支持 `{{name}}` 绑定；
  标量→单行、数组→逐元素、hash→键值对展开（`{field, value}` 两列）；复用现有 `ioredis`
  （零新依赖）；**不做 pub/sub、阻塞命令与 EVAL**（Lua 等于从数据源配置执行任意代码）。
  下发命令用**小写**——ioredis 的 reply transformer 注册在小写名下，大写会静默跳过，
  `HGETALL` 就会退化成扁平数组而不是 hash。
- **流程数据库节点**：`DatabaseFlowNode` 增可选 `operation`，三种模式（`sqlDefinitionId` /
  内联 `sql` / 内联 `operation`）**恰好命中一个**。引用命名定义时节点只存 `sqlDefinitionId`，
  不拷 operation 副本——入队时 `prepareFlowNodes` 从定义回读，且以定义的 `statementType`
  为准；`statementType` 只在内联 SQL 模式必填（mongo/redis 定义没有这个字段）。
  `databaseStep` / `flowNodes` / `flowGraph` / `flow.ts` 按数据源类型分派 SQL/操作执行与校验。
- **前端**：`DataSourceList`/`DataSourceDrawer` 类型下拉 + 各类型默认端口（5432/3306/1433/
  1521/27017/6379）+ 按类型表单（SQL Server encrypt/trustServerCertificate、Oracle
  serviceName、Mongo authSource、Redis db index）与按类型必填项（见边界决策 5）；
  `DataSourceDetail` 与流程数据库节点在 mongo/redis 时切换为操作编辑器（JSON + 操作模板
  下拉 + 参数声明）；操作模板集中在 `src/operationTemplates.ts` 一份，以**对象**保存并统一
  缩进后进编辑器（两处各存一份字符串模板时内容已经走偏）；模板下拉是**受控**的，值由编辑器
  文本实时反解，重开一条已保存定义能看出它是哪种操作；SQL 定义列表显示 kind 徽标；
  `DatabaseResult` 提供整行展开弹窗（定宽单元格截断后读全长值的出口）。

**分批交付**（纵向闭环，逐类验收）：

| 批次 | 内容 | 预估 | 状态 |
|---|---|---|---|
| P2-7.1 | 适配器契约抽取 + MySQL | ~5 天 | **已验收** |
| P2-7.2 | SQL Server + Oracle（方言收尾） | ~6 天 | **已验收** |
| P2-7.3 | MongoDB（kind/operation 落库、操作编辑器、节点操作模式、文档渲染） | ~5 天 | **已验收** |
| P2-7.4 | Redis（命令白名单、操作编辑器、结果展示） | ~2–3 天 | **已验收**（Redis 侧以本地实例逐条操作核对） |

**验收门槛**（逐类型对齐 5.5.1）：密码保存后不回显且可单独更新；连接测试通过；命名定义
试跑与流程数据库节点使用同一执行器；参数值只经驱动绑定；超时/行数/结果大小限制对该类型
生效；删除引用资源返回 usage 清单。

**验收结论（2026-08-22）**：P2-7.1–P2-7.4 全部通过。Redis 侧以本地实例逐条操作核对
（string / hash / list / set 四种键型 × GET、HGETALL、LRANGE、SMEMBERS、TTL、INCR、SET，
外加非白名单命令与参数个数错误两组负向用例）。走查与实测共发现 22 项问题，全部记录在
`issue_fix/P2-7_ISSUE_LOG.md`（20 项已修，2 项复核后判定不改），本节只保留由此产生的
范围与边界变更。

**风险**：oracledb 包体大、首次下载依赖网络（thin 模式免装 Instant Client，Node ABI 需
匹配）；SQL Server 无只读事务靠语句校验兜底、自签名证书需 `trustServerCertificate`；
方言骨架识别（MySQL 反引号/`#` 注释、SQL Server 方括号）必须进 skeleton，否则只读 CTE
校验会被字符串内容骗过。`mssql` 与 `oracledb` 不自带类型声明，需显式装
`@types/mssql` / `@types/oracledb`，否则 `tsc` 过不去而 `tsx` 照常运行——问题只在构建时暴露。

#### 5.0.11 P2-4 测试套件 + 统一执行记录（2026-08-24 范围与边界已确认）

> 本节是 P2-4 的权威范围。5.0.3 第 3 批的概要、5.1 的迁移清单、5.2 的 API 清单与之冲突时
> 以本节为准。**P2-4.1（2026-08-24）、P2-4.2、P2-4.3 与 P2-4.4（均 2026-08-25）已通过用户
> 验收**（缺陷记录见 `issue_fix/P2-4_ISSUE_LOG.md`），**P2-4.5 已于 2026-08-26 通过用户验收**，
> 验收期间修订一处边界并增补一项功能（见下方「P2-4.5 验收增补」）。
> 5.0.9 也已于 2026-08-25 验收。

**计划文本更正（走查代码后确认的 8 处）**

1. 套件迁移号 `022` → **026**：022 已被 `022_p26_advanced_nodes.sql` 占用（P2-6 提前落地）。
   `023` 是历史空洞（现有文件为 001–022、024、025），**永久弃用**——补一个 023 会让
   「文件名顺序 = 实际应用顺序」这条前提失效；Mock 迁移顺延为 `027_p2_mocks.sql`
   （**再次顺延为 `028_p2_mocks.sql`**：027 已被 P2-8 执行分区占用，见 5.0.12）。
2. `execution_index.kind` 的 CHECK **已经包含 `'suite'`**（015），026 不需要为套件放宽约束。
   5.0.6 里「CHECK 不动，P2-4 还要再改一次」只剩一个动作：顺手去掉死值 `scenario`，
   收窄为 `flow|suite|batch`（`batch` 保留，仍是规划中的父执行类型）。
3. `suite_executions` 与 `flow_executions` 对齐：明细表**不放** `canceled_count`，canceled 只在
   `execution_index` 上派生（`lib/flowRun.ts` 的 `finish` 已是这个做法，两张表两套算法必然分叉）。
4. 5.2 的套件 API 清单缺 `GET /projects/:id/suite-executions/:executionId`——运行抽屉需要成员行
   与子执行指针，补入。
5. 026 需要给 `execution_steps` 加一列 **`child_index_id`**：现有只有 `http_execution_id`，
   表达不了「这个成员本身是一次完整的流程父执行」。
6. 用例/流程的 usage 保护是 P2-4 欠的债——`routes/cases.ts` 与 `routes/flows.ts` 的注释都写着
   「套件是第一个引用方，usage 扫描属于那个切片」，目前两者都是无保护硬删除。本切片补齐；
   **只有 `manual` 成员算引用**，tag/all 是动态选择，不产生引用。
7. `GET /projects/:id/cases` 目前无分页，且每条返回完整 request/断言/钩子/提取/响应脚本。
   本切片改为分页 + 列表瘦身，并把 `FlowNodeDrawer` 的用例下拉改为服务端搜索（它只需要
   id/name/接口名，请求正文另走 `flowNodeSource`，所以瘦身安全）。
8. 统一父执行列表建立在 5.0.9 之上，因此它排在本切片**最后几批**，前三批只新增、不触碰
   5.0.9 已交付的视图。**5.0.9 已于 2026-08-25 验收**，这条前置条件解除。

**已确认的边界决策（13 项）**

1. **成员证据 = 该套件 index 下的一行 `execution_steps`**。用例成员 `step_type='case'`，
   `http_execution_id` 指向 `executions` 行（与流程 request 步骤同构）；流程成员
   `step_type='flow'`，`child_index_id` 指向那次流程执行的 `execution_index` 行。
   不采用批量调试式的「子表加 FK + 派生计数」：那要多加两列、join 两张子表重算计数，
   且**表达不出「因 fail-fast 未启动的成员」**（没有行可写），而 index 那套仍然要维护。
2. **成员在套件自己的 worker 槽内进程内 fan-out**，不给成员单独入队。流程的 HTTP 步骤本来
   就是进程内 `executeRequest`（不走队列），成员入队会让「等子任务的父槽」把
   `WORKER_CONCURRENCY` 吃光——与 5.0.8 容器持令牌的死锁同一类错误。
   `enqueue.ts` 因此拆出 `insertRun` / `insertFlowRun`（现有 `enqueueRun` / `enqueueFlowRun`
   = insert + `queue.add` + publish，既有调用方行为不变）。
3. **并发预算**：见下节「并发预算与原子领取」。
4. **fail-fast = 不再启动新成员，在途成员跑完**。成员是独立执行，它的证据值得留；中途 abort
   会写出一行看起来像用户取消的 `canceled`。未启动的成员写 `skipped`（`execution_steps.status`
   已有这个值），父执行终态 `failed`。
5. **环境支持套件级覆盖**：`member_default | override`，沿用批量调试的两种策略。现在不做的话
   以后补要改 `run_spec` 与 `member_snapshot` 形状。
6. **套件触发的流程执行算该流程的一次正式运行**：出现在流程运行记录侧栏与流程列表 lastRun。
   本切片不加「由套件触发」标记（要标记就得在 `flow_executions` 上再加一列，反查
   `execution_steps.child_index_id` 已经够用）。
7. **统一列表 = 把 5.0.9 的「流程执行记录」改造成带 kind 筛选的「父执行记录」**（全部/流程/
   套件），不平行新增第三个父执行大类——三个语义重叠的大类是坏 UI。批量调试**不并入**
   `execution_index`（它从未写入过），保持独立大类；单接口记录不变。
8. **稳定详情 = `?parent=<indexId>` 按 id 拉取**，不做 `/reports/:indexId` 路径路由。
   现状只在「该行正好在当前页」时才能恢复，且 flow/batch 完全不恢复；改成按 id 拉取
   同时修掉这个限制（单接口 `?run=` 一并改）。
9. `execution_index.kind` 顺手收窄为 `flow|suite|batch`（021 明确把这件事留给 P2-4，
   scenario 行已被 021 删净）。
10. `GET /projects/:id/cases` 改为分页 + 瘦身（见更正项 7）。
11. **manual 成员去重**：同一用例/流程只允许出现一次。成员之间不传变量，重复执行同一成员没有
    语义价值；tag/all 天然去重。
12. **套件不能包含套件**：保存与执行两处都拒绝。
13. **保护性上限**：成员 ≤ 200；`SUITE_TIMEOUT_MS` 30 分钟；`REAP_SUITE_AFTER` 45 分钟
    （沿用「回收阈值必须显著大于自身超时」的既有比例，flow 是 10/20 分钟）。

**并发预算与原子领取（本切片最容易做错的一处）**

现有三层不是一回事：`WORKER_CONCURRENCY`（同时几件**任务**，默认 10）、
`FLOW_PARALLELISM`（一次流程执行内同时几个**叶子**在飞，默认 4）、节点上的 `concurrency`
（**形状声明**，要向令牌池借令牌才真的跑）。套件是流程之上又一层容器，如果每个流程成员各建
一个池子，一个套件任务就能打出 `C × 4`（上限 100）并发——正是 5.0.8 拒绝过的乘法换了一层。

- **一次套件执行共享一个令牌池**，容量 `SUITE_LEAF_BUDGET`（默认 8，上限 20），传给每个流程
  成员（`performFlowRun` 加可选 `tokens` 参数，它现在自己 `new TokenPool`）。
- **成员数由独立信号量 C 控制**（`execution_config.concurrency`，默认 4、上限 10，校验
  `C ≤ 池容量`）。套件容器与流程成员容器**都不拿令牌**——容器拿令牌就会「攥着额度等自己的
  身体要额度」，这是 5.0.8 已经付过一次代价的死锁。
- **请求节点并发改为原子领取**：声明 N 就凑齐 N 枚令牌一起发，凑不齐整批等。现状是逐枚领
  （`lib/flowGraph.ts` 请求并发分支），池子紧张时 `concurrency=3` 会被静默拆成 2+1——而
  「同一接口并发 N」的用例本意就是让服务端真的同时收到 N 个请求，拆开等于结论失真。
  **这项修改动到 P2-6 已验收的代码，属本切片有意的范围扩张。**
- 原子领取的两个风险都必须封死：**真死锁**靠保存时与入队时两处校验 `N ≤ 池容量`，超限
  直接报错（不静默降级，与「循环迭代 >100 硬失败」同一原则）；**饿死**靠等待队列
  FIFO 且**禁止插队**——队头是多枚请求时，即使有空闲令牌也不发给后面的单枚请求。
  代价是攒令牌期间短暂空置几枚，空置窗口上限 = 最长在飞叶子寿命（请求 30s）。
- `TokenPool` 只加 `acquireMany(n)`，把 `acquire()` 实现成 `acquireMany(1)` 的薄壳：
  **一套等待队列**。两套队列必然互相插队，等于没做。
- 循环并发**不用**原子：迭代互相独立，先后跑不改变结论，它只是吞吐。
- 排队不吃单请求 30s 预算（令牌在 `executeRequest` 之前领），但**吃流程 10 分钟预算**
  （`performFlowRun` 认领即起表）。`C ≤ 池容量` 保证每个在跑的成员至少能拿到 1 枚，一定有进展。
- 套件预览时算出峰值需求，超过池容量就明确写出来（「声明并发合计 X，平台上限 Y，实际分批」）
  ——用户看得见，才不会把一份被降级的报告当并发结论。

**分批交付**（纵向闭环，逐批验收）

| 批次 | 内容 | 预估 | 状态 |
|---|---|---|---|
| P2-4.1 | 迁移 026；套件 CRUD + `preview` 成员解析；`GET /cases` 分页瘦身；侧栏/路由/列表页/编辑页/成员选择器。**不含执行**，运行按钮不出现 | ~3–4 天 | **已验收**（2026-08-24） |
| P2-4.2 | 执行后端：`enqueue.ts` 拆分 + `enqueueSuiteRun`/`cancelSuiteRun`；`lib/suiteRun.ts`；`TokenPool.acquireMany` 与请求节点原子领取；queue/worker 五处接入（job 联合、processor、`on("failed")`、`reapStale`、`requeueOrphans`）；`events.ts` 加 `kind:"suite"`；execute/executions/detail/cancel 四条路由 + `executionIndex.ts` 取消分支 | ~4–5 天 | **已验收**（2026-08-25） |
| P2-4.3 | 前端闭环：`api.ts` 套件全套 + 缺失的 `executionIndexDetail`/`cancelExecutionIndex`；列表运行按钮与状态列；编辑页 `HistorySidebar` 运行记录；`SuiteRunDrawer`（成员行复用 `.batch-item`，用例成员展开 `ExecutionDetail`，流程成员展开该次流程步骤——需把 `FlowRunDrawer` 的 `StepEvidence` 导出复用）；SSE 进度与取消 | ~3–4 天 | **已验收**（2026-08-25） |
| P2-4.4 | 统一父执行列表 + 稳定详情路由 + `ExecutionRecords` 接入 stream | ~2–3 天 | **已验收**（2026-08-25） |
| P2-4.5 | 引用保护：用例/流程 `GET .../usage`，删除返回 409 + 清单 + `?force=true`，前端删除前扫描 | ~1–2 天 | **已验收**（2026-08-26，验收增补见下方） |

**明确不做**：套件级变量传递（成员相互独立，需要传值就建流程）· 套件定时调度（P3）·
成员级重试 · 套件嵌套套件 · 把批量调试并入 `execution_index`。

**P2-4.2 落地时确定的 7 处细节**（实现即决策，与上文边界不冲突，只是把它们说到可执行）

1. **两个预算常量搬进 `lib/flow.ts`**（`FLOW_PARALLELISM`、`SUITE_LEAF_BUDGET`）。它们现在
   有三个读者且必须是同一个数：调度器建池、入队校验、保存校验。留在 `flowRun.ts` 会让
   路由层去 import 执行器。
2. **`SUITE_LEAF_BUDGET` 的下界是 `FLOW_PARALLELISM`**。套件池小于流程池会让「单独跑得起
   来、放进套件就超预算」成立，于是「按流程预算校验过就够了」这条前提失效。
3. **请求节点并发的保存上限从 `MAX_LOOP_CONCURRENCY`（10）改为 `FLOW_PARALLELISM`（默认 4）**。
   原子领取之后 N > 池容量就是永远凑不齐，只能在保存时就拒绝。**这会让先前存下的
   `concurrency` 5–10 的请求节点在保存/入队时被拒**——属本切片有意的收紧（循环并发不受
   影响，迭代不需要原子性）。第二道校验在 `insertFlowRun`：预算是可配置的，一份旧流程
   完全可能在预算调小之后才被运行。
4. **并发请求的容器耗时改为墙上时钟**（原先是各次耗时相加）。N 个请求真的同时在飞之后，
   相加会把 3 个 1 秒的并发请求报成 3 秒。
5. **`POST .../execute` 接受可选的 `execution` 部分覆盖**（并发/fail-fast/环境策略），与用例、
   流程的「改了还没保存也能跑一次」同一条规则（交互文档 3.1.3）；成员清单不接受覆盖
   ——随手指定一批成员是「批量执行」而不是「运行这个套件」。
6. **`preview` 返回 `concurrency: { declared, peak, budget }`**，`peak` = 需求最大的 C 个成员
   之和，算法与入队时的硬校验共用 `memberTokenDemand`。单个成员一次要的比整池还多 →
   执行入口 400 拒绝；只是合计超预算 → 只提示「会分批发出」。
7. **被取消的成员计入 `failed`**（它不是一次通过），但成员行本身保留 `canceled`；取消路径下
   父级计数由 `cancelSuiteRun` 写，`finish` 的 `status = 'running'` 守卫让它保持胜出。
   套件整体超时（30 分钟）与用户取消都落 `canceled`，但 `error` 分别写清楚。
8. **新增 `GET /system/limits`**（见 5.2），前端同步接入：`stores/limitsStore.ts` 登录后拉一次，
   四个输入框的 `max` 与提示文案都改成读它——请求并发（`flowParallelism`）、循环迭代
   （`maxLoopIterations`）、循环并发（`maxLoopConcurrency`）、等待秒数（`maxWaitMs`）、套件成员
   并发（`min(suiteMaxConcurrency, suiteLeafBudget)`）。预算是环境变量，界面写死必然与服务端
   不一致（填得进去、保存被拒）；读不到时用与服务端一致的兜底值，不让编辑器打不开。

**P2-4.3 落地时确定的 6 处细节**（前端闭环，实现即决策）

1. **成员行来自 `member_snapshot`，不是 `execution_steps`**。没开跑的成员根本没有步骤行，
   只按步骤行渲染的话，一个 10 成员的套件跑到第 3 个时抽屉里只有 3 行，读起来像「这个套件
   只有 3 个成员」。快照是那次运行的完整计划，它才是清单；步骤行按 `type:id` 挂上去。
2. **运行已结束而某成员没有步骤行 ⇒ 该成员是 `skipped`**。fail-fast 会由 `performSuiteRun`
   补写 skipped 行，但**取消**只把已存在的行改成 canceled（`cancelSuiteRun`），没排到的成员
   一行都没有、只进父级 `skipped_count`。前端不做这个推导就会把一次已结束的运行画成
   「还有成员在排队」。三种「没开跑」分别给不同文案：等名额 / fail-fast 停下 / 没轮到。
3. **流程成员展开走 `childIndexId` 两跳**（`executionIndexDetail` → `flowExecution(detailId)`），
   不走 `output.flowExecutionId`：后者只在成员跑完时才写，而 `child_index_id` 在开跑前就落库，
   所以正在跑的流程成员也能展开。两跳都只在展开时发——套件详情不该为了摘要搬十棵步骤树。
4. **`FlowRunDrawer` 导出 `flowStepRows` 与 `StepEvidence`**。只导出 `StepEvidence` 不够：
   「怎么把一次流程执行摊成行」还包含旧 run 的退路与容器行过滤，抄第二份必然分叉，
   而分叉出来的那份在用户眼里只是「同一次运行在两个地方长得不一样」。
5. **成员行重取只在抽屉打开时或终态才发**。成员级事件不存在（成员发的是自己的
   execution / flow 事件，不带 suiteExecutionId），所以成员行只能靠重取详情；而详情带着每个
   用例成员的完整响应快照，按事件次数取会让 200 成员的套件把同一批证据反复搬上来。
6. **执行入口传 `execution` 但不传成员**，因此**选择方式改了没保存就拒绝运行**（面板与点击
   两处都说明）。只提示不拦，等于让用户以为刚加的成员会跑到。并发峰值提示只说「会分批」：
   「单个成员要的比整池还多」那一档在保存时就被挡住了（请求节点并发 ≤ 流程池 ≤ 套件池），
   走不到预览。

**P2-4.4 落地时确定的 6 处细节**（统一列表 + 稳定详情 + 事件流，实现即决策）

1. **大类 `flow` 改名为 `parent`，`kind` 成为它的子筛选**（全部/流程/套件），地址栏为
   `?type=parent&kind=suite`。旧地址里的 `type=flow` 在读取时映射成 `parent`（`toRecordType`），
   未知值一律回落到 `single`——一个认不出的大类会让页面渲染成空清单，看起来像「没有记录」。
2. **父执行行显示类型 chip + 跳过列**。类型必须在收起状态下就能读到：一份混着流程与套件的
   清单里，点开看到的是步骤树还是成员行，名字本身说不清。跳过列为 0 时写 `—` 而不是 `0`
   ——它只在 fail-fast 与取消时才有值，写成 0 会让人以为这个数字有含义。
3. **稳定详情三个参数一起改成按 id 拉取**：`?parent=<indexId>`（先 `executionIndexDetail`
   解析 kind + detailId，再按 kind 取流程/套件明细）、`?run=<executionId>`、
   `?batch=<batchId>`。原先只有 `?run=` 有恢复逻辑，且是在刚取回的那一页里 `find`——深页与
   换过筛选条件都恢复不了，而流程与批量调试连参数都没写进地址栏。**读失败就摘掉参数并明确
   报「这条记录不在了」**：留着参数会让每次筛选变化都重试一次注定失败的请求，而静默失败会让
   人以为是自己点错了。
4. **事件流的分工是固定的：状态与计数就地打补丁，要完整字段才重取。** 重取只有两个时机——
   终态一次，以及**停在第一页**时收到一条打不到当前页的事件（那是刚产生的新记录）。深页不为
   新记录重取：偏移分页会让整页往后错一行，正在读的人会以为自己看错了。重取本身是
   600ms 尾随合并的一次（`revision` 计数器进取数 effect 的依赖，取数仍然只有一处），否则一次
   200 成员的套件运行会打出 200 次列表请求。
5. **抽屉开着时按事件重取详情，关着时不取**（与套件编辑器同一条规则）。父级每落地一个
   成员/步骤才发一条进度，所以这个频率本来就是对的；而详情带着完整响应快照，没人看的时候
   重取只是白搬数据。这条重取是**静默**的——一次读失败弹一条报错盖在正在看的抽屉上只是噪音，
   下一条事件还会再试。
6. **`GET /execution-index/:indexId` 收窄为只回顶层步骤**（`parent_step_id IS NULL`），与套件
   明细一致。它的两个调用方（套件里的流程成员、记录页的 `?parent=` 深链）都只读父行本身，
   而不过滤的话一次 100 迭代的循环会把上千行带完整快照的步骤塞进这个响应里。嵌套证据仍按需
   走 `GET /execution-steps/:stepId/children`。

**本切片不做**：记录页的取消入口（`cancelExecutionIndex` 因此仍无调用方）。记录页是审计视图，
运行中的父执行在流程/套件编辑器里有自己的运行条与取消按钮；在两个地方各放一个取消按钮，
就要在两个地方各维护一套「取消后计数怎么算」。

**P2-4.5 落地时确定的 5 处细节**（引用保护，实现即决策）

1. **反向扫描统一走 `lib/flowRefs.ts` 的 `flowsReferencing`，用 `jsonb_path_exists` 递归。**
   循环体是内联子图（`LoopFlowNode.body.nodes`），所以子流程节点/数据库节点完全可能躺在循环里。
   原先数据源与命名定义的扫描用 `nodes @> '[{...}]'` 只看顶层数组元素，循环体内的引用会漏成
   「没人用」，删完被引用的资源后外层流程要到入队时才报错。`$.** ? (@.key == $value)` 一层
   查询覆盖任意嵌套深度，值走 `jsonb_path_exists` 的 `vars` 参数绑定、不进路径文本（规范 4.4）。
   这个漏扫顺带在 dataSources 的两处旧扫描上修掉了（见 `issue_fix/P2-4_ISSUE_LOG.md` #10）。
2. **用例的引用只有「套件 manual 成员」一种**。流程请求节点的 `sourceCaseId` 只是来源标记
   （节点自带完整请求/断言快照，改用例不影响已存流程），执行历史靠 `case_name` 快照——两者都不
   拦，只把历史条数报出来供人判断。流程的引用是「套件 manual 成员 + 别的流程的子流程节点」两种，
   都拦。
3. **tag/all 是动态选择，不产生引用**（边界决策 6），扫描用 `selection_type = 'manual'` 排除；
   套件引用匹配用 `selection_config @> '{"members":[{"type":…,"id":…}]}'`，撞上 026 建的 GIN 索引。
4. **`?force=true` 之后有两类引用，各自处置（验收时修订）**：
   - **套件 manual 成员不再悬空**：删除与「把它从每个引用它的手动套件里摘掉」在同一个事务里
     完成（`lib/suiteMembers.ts` 的 `detachSuiteMember`）。原设计「悬空并显示一行已不存在」
     在验收时被用户否决——那行除了解释自己为什么在那儿之外没有用途，唯一合理操作就是删掉它，
     而删除路径可以直接做完（见下方「P2-4.5 验收增补」甲）。
   - **别的流程的子流程节点保持悬空**：那是一个画布节点，静默删掉会改变流程的结构与连线，
     属于「删一个东西连带改一串东西」；它在入队时报「references a flow that does not exist」，
     由人去改那张图。
5. **前端扫描失败就**不删。一个「查不到有没有人引用」的答案不能当成「没人引用」；有引用时对话框
   列出清单（复用 `.usage-list`）并把主按钮从「删除」换成「仍然删除」（`action.deleteAnyway`），
   而不是把 409 当成需要重试一次的错误。

**P2-4.5 验收增补（2026-08-26，用户验收时提出的 3 项）**

> P2-4.5 于 2026-08-26 通过用户验收。验收期间针对悬空引用、标签选择与用例→流程的改动传播
> 提出 3 项增补，随验收一并落地。前两项是套件页行为修订（缺陷记录见 `issue_fix/P2-4_ISSUE_LOG.md`
> #11 / #12），最后一项是新增功能，写在这里。

**甲 · 删用例/流程时级联摘掉套件成员（修订「force 之后悬空」边界）**

原设计是 force 之后让引用悬空、套件预览把悬空成员挑进 `missing` 显示成一行「已不存在」。
用户明确否决：**已经不存在的用例/流程不该出现在套件成员列表里**。悬空行不能运行、不能打开、
没有可修的内容，唯一合理操作就是删掉它——于是删除路径直接做完：

- 新增 `lib/suiteMembers.ts` `detachSuiteMember`：用 `jsonb_set` 把 `selection_config.members`
  里目标引用就地摘除（`jsonb_agg ... ORDER BY ord` 保住剩余成员的声明顺序，摘空写 `[]`）。
- `DELETE /cases/:caseId` 与 `DELETE /flows/:flowId` 的 force 路径改为**先开事务 → DELETE →
  `detachSuiteMember` → 提交**，两步不再可能分离。返回 `detachedSuites` 清单供界面表态
  「已从 N 个套件中移除该成员」。
- 子流程节点引用**不**级联——那是一张图上被连线引用的节点，静默删掉会破坏流程结构。
- 前端 `SuiteWorkspace` 对历史遗留的悬空引用就地清除并进入未保存态，由保存确认（不偷偷写库）。

**乙 · 标签/全部选择自动解析成员**

原设计要手动点「解析当前成员」。标签与全部的成员本来就是算出来的，刚改完标签正是最想知道
「现在会跑到谁」的那一刻，让它停在「尚未解析」上等一次点击等于没给答案：

- `SuiteWorkspace` 对 tag/all 选择增加防抖（400ms）自动 preview：进页面一次、条件（标签/
  匹配方式/成员范围）变化一次。手动按钮保留为「重新解析」，自动失败的报错靠它兜底。
- 预览用序列化键作依赖而不是对象引用，改名、改并发不会白白重解析；`previewing` 态显示
  「搜索中」而不是闪一下「尚未解析」。

**丙 · 用例 → 已绑定流程的同步 tab（新增功能）**

快照隔离保证「改用例不会自动改动已存流程」，代价是用例修好之后，引用它的每条流程都要手工
重新导入。同步 tab 把那件事变成一次显式点击：

- 后端两条路由：
  - `GET /projects/:id/cases/:caseId/flow-bindings`：返回引用该用例的全部流程与节点
    （含循环体内节点，`inLoop` 标记）。复用 `lib/flowRefs.ts` 的递归 jsonpath 扫描，
    并把 `sourceCaseId` 加进 `FlowNodeRefKey`。
  - `POST /projects/:id/cases/:caseId/sync-to-flows`：body 为 `{ flowIds, nodeIds? }`，
    **一次事务同步全部选中的流程**（全部成功或全部不动；flowIds 排序后加锁防死锁）。
    覆盖节点的请求快照、断言、前置钩子、提取、响应脚本与 `endpointId`/来源标记，节点名、
    画布坐标、失败策略、并发次数保留（那是流程自己的编排决策）。脚本引用走 `adoptScriptRefs`
    接手（与 `flows/node-source` 同规则），写库走 `toFlowNode` + `persistFlowScripts`。
  - 实现以 `lib/caseSync.ts` 为中心：扫描、payload 整理、树内替换、写回都在一处。
- 前端 `EndpointWorkspace` 在「校验」后新增「同步」tab（仅在加载用例时存在），支持
  **多选流程**（勾选 + 全选），同步前对话框逐条列出将被覆盖的节点；用例有未保存改动时
  先提示保存——同步读的是库里那份定义。
- 同步是显式操作，自动传播仍然不做。

#### 5.0.12 P2-8 执行分区：跨网段执行（2026-08-24 范围与边界已确认）

> 本节是 P2-8 的权威范围。**待实现**。

**问题**

公司内网存在多个互不连通的网段（测试网段 / 生产网段）。平台与 worker 部署在测试网段，
worker 只能从**自己所在网段**出站，因此指向生产的接口用例根本发不出去。

这不是环境配置问题，而是**执行位置**问题：现有模型里没有任何东西能表达「这次执行该从哪个
网段发出」。被测地址只是 endpoint URL 里的 `{{var}}`，`environments` 只有 `variables` /
`secrets`；`lib/run.ts` 的 `fetch` 没有 proxy、没有自定义 dispatcher；队列名是模块常量
`"executions"`，worker 无条件消费它；`workers.mode` 只是个上报标签，**不参与路由**。

要分清两堵独立的墙，不能混在一起解：

1. **平台 → 被测服务** 不可达。
2. **生产网段机器 → 平台的 Redis / Postgres** 也往往不可达。

只有第一堵墙时是简单问题；两堵都在时，现有的「worker 拉队列」模型从根上不成立。

**开工前置条件（硬门槛）**

生产网段那台机器必须能**出站**到平台 Redis 6379 与 Postgres 5432。这是拉队列模型的下限，
无法绕过，方案的全部有效性押在这一条上。**必须在写代码前拿到运维答复**：

- 能出站 → 按本节 P2-8 实施。
- 不能出站 → P2-8 交付为零，直接转 P4.5 的 HTTP 长轮询 Runner（只需出站 443）。

**方案选型（三条路线的取舍）**

| 方案 | 改动量 | 前提 | 结论 |
|---|---|---|---|
| A. 出口代理（`undici` `ProxyAgent` + 环境级 proxy 配置） | 小 | 有一台两边都能到的正向代理/跳板 | **不采用**：只解决第一堵墙，且生产网段通常不提供这种代理 |
| B. 分区 worker + 队列路由 | 中 | 生产网段能出站到 Redis + Postgres | **采用为 P2-8** |
| C. Runner 反向拉取（HTTP 长轮询） | 大 | 生产网段只需出站 443 | **推迟到 P4.5**：前置条件不成立时才必须做，届时同时覆盖仓库用例 |

选 B 的两个决定性前提均已确认：**凭据继续留在平台库**（不做「只下发变量名 + runner 侧取值」
的改造），**生产准入走后续权限与审批流程**（本切片不做）。这两条一定，B 就不需要先建
HTTP 协议。

采用 B 的已知代价，明确接受：生产网段的 worker 持有平台 Postgres 的写凭据，且直接
`UPDATE executions` / 写 `workers` 表——worker 侧目前没有认证边界。这是选择 B 而非 C
换来的实施成本节约，不是被忽略的问题；安全评审若否决这一点，处置办法是转 C，而不是给 B 打补丁。

**核心模型**

**environment 持有分区标签，队列按标签分裂，worker 声明自己服务哪些标签。**

选 environment 作为归属者，因为它是唯一天然携带「我指向哪套系统」的实体。环境选择链
（用例绑定 → 接口默认 → 项目默认，见 2.4）已经存在且被套件/流程/批量调试共用，分区自动
沿用，不需要第二套选择逻辑。分区（`labels`）与 worker 模式（`mode`）是两个**正交轴**：
本切片只让 `labels` 参与路由，`mode` 仍是上报标签。

**已确认的边界决策（9 项）**

1. **标签写进三张执行表做快照**（`executions` / `flow_executions` / `suite_executions`）。
   理由与 `environment_name`（迁移 004）完全一致：environment 改标签或被删后历史仍要说清
   这次执行从哪跑的；更关键的是**认领与取消都要靠这一列找队列**，不能回查 environment。
2. **`suite_executions` 一起加列**，尽管套件执行后端（P2-4.2）尚未实现。迁移 010 已经吃过
   「等做出来再加列就要回填、而回填时分不清历史行」这个亏，同一个理由。
3. **标签格式必须约束**：`^[a-z0-9][a-z0-9-]{0,31}$`。它**会进 Redis key**
   （`executions:<label>`），不约束就会写出奇怪的键。校验放在路由层而非 CHECK——错误信息
   要能回给用户。
4. **入队前检查该标签有在线 worker，没有就拒绝，绝不写行。** 这是本切片最容易漏、代价最高
   的一处。少了它，用户看到的是一条永远 `queued`、5 分钟后被回收判成
   `execution abandoned by worker` 的记录——排查方向会完全跑偏到 worker 崩溃上，而事实是
   这个分区根本没有执行器。检查放在 `INSERT` **之前**，因此连补偿删除都不需要。
5. **用真错误码而非字符串嗅探**：新增 `NoRunnerError` + 错误码 `2004`，`data` 带 `label`。
   现有 6 处前端错误分支靠 `detail?.includes("queue unavailable")` 判断，分区化之后
   「队列挂了」与「这个分区没人」是两个完全不同的处置动作，必须能分开。
6. **认领语句加分区防御**：`WHERE id = $1 AND status = 'queued' AND runner_label = ANY($2)`。
   at-most-once 的第二层保护（4.7）现在多一个维度——万一有 job 被投进了错的队列，worker 在
   `fetch` **之前**退出，而不是从错误的网段发出一个真实请求。这是本切片唯一的安全性增量，
   不能省。
7. **多标签进程必须拆分并发**：`perLabel = max(1, floor(WORKER_CONCURRENCY / labels.length))`，
   心跳上报 `perLabel × labels.length`。BullMQ 的 Worker 绑定单队列，一个标签一个 Worker
   实例，各给一份 `CONCURRENCY` 会让容量凭空翻倍，执行器面板上的数字就是假的。
   **推荐一个进程只服务一个标签**，多标签只作为单机开发的便利。
8. **`requeueOrphans` 只补投自己服务的分区**（`WHERE runner_label = ANY($1)`），并投进对应
   队列。一个 worker 不该对它看不见的分区采取行动。**`reapStale` 保持全局**——它管的是 DB
   状态而不是队列，advisory lock 已经解决并发。
9. **`CANCEL_CHANNEL` 保持单条全局频道**。取消是广播 + 持有者对号入座，按标签分频道只会让
   每个 worker 多订阅几条，没有收益。

**已知行为，必须写进代码注释**

某分区 worker 在**入队之后**掉线，那批行仍会在 5 分钟后被 `reapStale` 判失败。决策 4 的
入队前检查只挡新的，挡不住这种。这是可接受的，但不写注释下一个人会当成 bug 查。

**一次性代价**

队列名从 `executions` 变为 `executions:<label>`，Redis 里现存的 job 会成为孤儿。按
AGENTS.md 的数据兼容条款不写兼容代码，改完清一次开发 Redis 即可——库里 `queued` 的行由
worker 启动时的 `requeueOrphans` 自己捡回来。

**执行器面板：加分区轴，不加第二排 segmented**

`/api/v1/system/workers` 返回新增 `partitions: [{ label, online, total, capacity, inflight,
waiting, failed }]`，而不是把 `queues` 改成两层嵌套 record。标签全集 = `workers.labels` ∪
`SELECT DISTINCT runner_label FROM environments` ∪ `'default'`——取并集是为了让一个
「配了但没人服务」的分区**显式出现在面板上且 online=0**，这正是用户最需要看到的那一行。

前端**不再加一排 segmented**：现有 mode segmented 已占那个位置，4.5 明确否决过「同页两排
下划线 tab」。分区用 worker 表格上方一个小表呈现，是同一份数据的另一个切片而不是导航层级。
`capacity` / `inflight` 的 mode 键保持不变（`repository` 预留位不动）。

**分批交付**（后端先行，P2-8.1–P2-8.3 完成后即可手工起一个带标签的 worker 验证路由是否正确，
P2-8.4 起才是可视化）

| 批次 | 内容 | 预估 | 状态 |
|---|---|---|---|
| P2-8.1 | 迁移 `027_p2_execution_partition.sql`；`queue.ts` 队列名按标签分裂（`Map<label, Queue>`）；`enqueue.ts` 的 `resolveRunnerLabel` + 入队前在线检查 + `NoRunnerError`；`cancelRun`/`cancelBatch` 按行标签找队列 | ~1–2 天 | 待实现 |
| P2-8.2 | `run.ts` / `flowRun.ts` 认领语句加 `runner_label` 防御 | ~0.5 天 | 待实现 |
| P2-8.3 | `worker.ts`：`WORKER_LABELS`、每标签一个 Worker、并发拆分、心跳写 `labels`、`requeueOrphans` 按分区过滤、启动日志打印实际队列 | ~1–2 天 | 待实现 |
| P2-8.4 | `types.ts`（`Environment.runnerLabel` / `Worker.labels`）+ `environments.ts` 读写与校验 + `system.ts` 分区轴 + 四处 enqueue 调用方错误映射（`endpoints.ts` / `cases.ts` / `flows.ts` ×2） | ~1–2 天 | 待实现 |
| P2-8.5 | 前端：`api.ts` 类型；`i18n.ts`（`environments.runnerLabel*` / `workers.partition*` / `run.noRunner`，zh+en 各一行扁平键）；`Environments.tsx` 抽屉与表格列；`GlobalApp.tsx` 分区表格 + worker 表分区列；6 处错误分支改判 `2004` | ~2 天 | 待实现 |
| P2-8.6 | `.env.example` 加 `WORKER_LABELS`；`start.sh` 注释给出起第二个分区 worker 的命令（**不自动拉起**，那台机器不在本地） | ~0.5 天 | 待实现 |

**明确不做**

- **按环境配代理**（方案 A）。只在生产网段根本放不了 worker 时才需要，是 P2-8 失败后的备选，
  不提前埋。
- **HTTP 长轮询 Runner**（方案 C，P4.5 的 `POST /worker/register|claim|heartbeat|complete`）。
  只在前置条件不成立时才必须做。
- **凭据下沉 / 只下发变量名**：维持现状，凭据继续留在平台库。
- **生产准入的权限与审批**：后置。相关提示：分区打通后工具就能对生产发 `POST` / `DELETE`，
  而 `lib/queue.ts` 的 `attempts: 1`「绝不重试」（理由见 4.7）保护的正是这个场景——审批做
  之前，这一条不能松。
- **仓库模式的队列**：`workers.mode` 仍只是标签。等仓库模式真做时它自己开队列，本切片的标签
  机制可直接复用，不需要返工。
- **worker 侧认证边界**：不在本切片解决，见上文「采用 B 的已知代价」。

### 5.1 数据库迁移（从 015 顺序追加）> 序号说明：计划原写的 `003_p2_schema.sql` 为过时命名，实际接在 `014` 之后。
> 按上述批次拆分为多个迁移，而不是一个大文件。

按纵向切片拆分，文件名在实现时保持一批一个主题：

```
015_p2_execution_index.sql
  execution_index  (id, project_id, kind, target_id, target_name, detail_id, status,
                    total, success_count, failed_count, skipped_count, canceled_count,
                    created_at, started_at, finished_at)
  execution_steps  (id, index_id, step_id, step_type, step_name, status, stage, position,
                    input_snapshot JSONB, output_snapshot JSONB, error, http_execution_id,
                    started_at, finished_at)
                   # kind 首批: flow | scenario | suite | batch
                   # http_execution_id 可空；HTTP 证据仍在 executions，非 HTTP 结果不伪造 endpoint

016_p2_data_sources.sql
  data_sources      (id, project_id, name, type, config JSONB, credentials_encrypted,
                    key_version, created_at, updated_at)
  sql_definitions   (id, project_id, data_source_id, name, statement_type, sql,
                    params JSONB, description, created_at, updated_at)
                   # 首发 type=postgresql；statement_type=query|command

017_p2_flow_nodes.sql
  scripts 扩展      (kind 增加 node)
  execution_steps  (status 增加 skipped)
  # 受控并发配置存 run_spec JSONB，不加列；并行层级写 execution_steps.stage

018_p22_request_lifecycle.sql
  test_cases 扩展   (pre_request_hooks / extracts / response_scripts JSONB，默认 '[]')
  executions 扩展   (response_script_results JSONB，默认 '[]')
  scripts 扩展      (kind 增加 response)

020_p2_scenarios.sql   # 场景已撤回，见 5.0.6
021_drop_p2_scenarios.sql
  # 删 scenarios / scenario_executions 与 kind='scenario' 的父索引；
  # 删 executions 的 scenario_execution_id / scenario_step_id 两列；
  # source 的 CHECK 收回 endpoint_debug | test_case | flow_step。

026_p2_suites.sql      # 计划原写 022，已被 022_p26_advanced_nodes.sql 占用；023 是历史空洞，永久弃用
  test_suites        (id, project_id, name, description, selection_type,
                     selection_config JSONB, execution_config JSONB, tags, 时间戳)
  suite_executions   (id, project_id, suite_id, suite_name, environment_id, environment_name,
                     status, total, success_count, failed_count, skipped_count, error,
                     member_snapshot JSONB, run_spec JSONB, worker_id,
                     execution_index_id, 时间戳)
                     # 与 flow_executions 对齐：明细表不放 canceled_count，canceled 只在
                     # execution_index 上派生；run_spec 在终态置 NULL
  execution_steps 扩展 (child_index_id → execution_index(id) ON DELETE SET NULL)
                     # 成员是一次完整的父执行（流程成员）时指向它的 index 行；
                     # 用例成员仍用 http_execution_id 指向 executions
  execution_index    (kind 的 CHECK 收窄 → flow|suite|batch，去掉 021 留下的死值 scenario)
                     # 'suite' 015 就已在 CHECK 里，套件本身不需要放宽约束

027_p2_execution_partition.sql   # P2-8 执行分区（跨网段执行），规划见 5.0.12
  environments 扩展     (runner_label TEXT NOT NULL DEFAULT 'default')
                        # 「这个环境指向的系统该从哪个网段发请求」。选 environment 承载是因为
                        # 它是唯一天然携带「我指向哪套系统」的实体，且环境选择链（2.4）已被
                        # 用例/接口/流程/套件/批量调试共用，分区自动沿用，不需要第二套选择逻辑
  workers 扩展          (labels TEXT[] NOT NULL DEFAULT ARRAY['default'])
                        # 这个 worker 服务哪些分区。与 mode 是正交轴：本切片只有 labels 参与路由
                        # 不建 GIN 索引：这张表是几十行量级，顺序扫比索引快
  executions 扩展       (runner_label TEXT NOT NULL DEFAULT 'default')
  flow_executions 扩展  (runner_label TEXT NOT NULL DEFAULT 'default')
  suite_executions 扩展 (runner_label TEXT NOT NULL DEFAULT 'default')
                        # 三张执行表都要快照列，理由同 environment_name（004）：环境改标签或被删后
                        # 历史仍要说清从哪跑的；更关键的是认领与取消都靠这一列找队列，不能回查环境
                        # suite_executions 一起加——套件执行后端未实现，但 010 已经吃过
                        # 「等做出来再加列就要回填、而回填分不清历史行」这个亏
                        # 标签格式 ^[a-z0-9][a-z0-9-]{0,31}$ 在路由层校验而非 CHECK：它会进
                        # Redis key（executions:<label>），但错误信息要能回给用户

028_p2_mocks.sql       # 计划原写 023 → 027，随套件与执行分区两次顺延；定位见 5.0.7（对外联调桩）
  mocks               (id, project_id, endpoint_id, name, public_id, mode, enabled, priority,
                      request_match JSONB, response JSONB, proxy_config JSONB, delay_ms, 时间戳)
                      # public_id 带熵不可枚举、匿名可访问；proxy_config 含白名单/连接/响应超时/大小上限
                      # delay_ms 面向外部调用方模拟慢/超时；request_match 支持从请求取模板变量
  mock_request_logs   (id, mock_id, method, path, matched, status_code, duration_ms,
                      request_snapshot JSONB, response_size_bytes, created_at)
                      # 联调排障核心：matched / 请求快照 / status_code 齐全

022_p26_advanced_nodes.sql   # 实际先于套件/Mock 落地（P2-6 提前实现）
  execution_steps 扩展  (parent_step_id 自引用 ON DELETE CASCADE、iteration)
  # 容器节点（loop/subflow）内部每一步都留证据行，parent_step_id 指回容器行；
  # 015 的 UNIQUE(index_id, step_id, position) 改为两条分区唯一索引：顶层保持原语义，
  # 嵌套按 (容器行, 节点, 声明下标, 迭代号) 唯一（position 仍是节点声明下标，
  # 它承担同 stage 同名写冲突的确定性裁决，不能改成按启动顺序自增）。
  # 父级计数只统计 parent_step_id IS NULL 的顶层步骤。

024_p27_data_source_adapters.sql  # 编号顺延；P2-7 规划见 5.0.10
  data_sources  (type CHECK 放宽 → postgresql|mysql|sqlserver|oracle|mongodb|redis)
  sql_definitions 扩展 (kind TEXT NOT NULL DEFAULT 'sql' CHECK(kind IN ('sql','mongo','redis')),
                      operation JSONB)
  # kind='sql' 时 statement_type(query|command) 有效；mongo/redis 的操作类型由
  # operation JSONB 内部表达，不新增第二张定义表（CRUD/usage/引用/快照/试跑五条路径复用）

025_p27_definition_shape.sql      # 024 的收尾：只加列不够，建表时的 NOT NULL 还在
  sql_definitions   statement_type / sql 解除 NOT NULL（mongo/redis 定义这两列为 NULL）
  sql_definitions   + CHECK sql_definitions_kind_shape_check
                    # kind='sql'  → statement_type/sql 非空且 operation 为空
                    # kind<>'sql' → statement_type/sql 为空且 operation 非空
                    # 形状由数据库兜住，避免任何漏判的写路径留下「既无 SQL 也无 operation」
                    # 的定义——那种行只会在执行时才炸
```

所有历史表继续保留名称快照并使用 `ON DELETE SET NULL`；配置资源被流程、套件或 Mock
引用时先返回 usage 清单和 409，只有 `?force=true` 二次确认后才能破坏引用。敏感字段不进入 mapper。

### 5.2 后端新 API

```
SCENARIOS                                      # 已撤回，见 5.0.6

TEST SUITES                                    # 成员为接口用例与流程，各自独立执行
  GET/POST /projects/:id/test-suites
  GET/PUT/DELETE /projects/:id/test-suites/:suiteId
  POST /projects/:id/test-suites/:suiteId/preview
  POST /projects/:id/test-suites/:suiteId/execute
  GET  /projects/:id/test-suites/:suiteId/executions
  GET  /projects/:id/suite-executions/:executionId   # 明细 + 成员行（含子执行指针），运行抽屉必需
  POST /projects/:id/suite-executions/:executionId/cancel

MOCK
  GET/POST /projects/:id/mocks
  GET/PUT/DELETE /projects/:id/mocks/:mockId
  POST /projects/:id/mocks/:mockId/test
  GET  /projects/:id/mocks/:mockId/logs        # 联调排障：matched / 请求快照 / status_code
  ANY  /mock/:publicId/*                       # 独立 Runtime，不使用项目 JWT，面向外部联调方匿名访问

ADVANCED NODES (P2-6)                          # 已实现
  GET  /projects/:id/execution-steps/:stepId/children
  # 一个 loop/subflow 容器步骤内部跑过的步骤 + 它们的 HTTP 快照。按需拉取而不是随
  # /flow-executions/:id 一起返回：100 次迭代 × 多节点循环体的嵌套行数可能比顶层步骤
  # 多一个量级，默认带上会让运行面板变重。
  # 循环/子流程本身没有独立 CRUD——它们是流程节点，随 PUT /flows/:flowId 保存。

DATA SOURCES
  GET/POST /projects/:id/data-sources  GET/PUT/DELETE /projects/:id/data-sources/:dataSourceId
  GET  /projects/:id/data-sources/:dataSourceId/usage
  POST /projects/:id/data-sources/:dataSourceId/test
  POST /projects/:id/data-sources/:dataSourceId/query
  GET/POST /projects/:id/data-sources/:dataSourceId/sql-definitions
  GET/PUT/DELETE /projects/:id/sql-definitions/:sqlId
  POST /projects/:id/sql-definitions/:sqlId/test              # v1.8 测试运行预览结果

EXECUTION INDEX
  GET  /projects/:id/execution-index           # ?kind=flow|suite|all &status &keyword &page &pageSize
                                               # 单步调试的一次性父索引（detail_id 自指）不返回
  GET  /projects/:id/execution-index/:indexId  # 父行 + 顶层步骤行（嵌套证据另走 children）
  POST /projects/:id/execution-index/:indexId/cancel

PLATFORM LIMITS (P2-4.2)                       # 登录即可读，无敏感信息
  GET  /system/limits                          # flowParallelism / suiteLeafBudget /
                                               # maxLoopIterations / maxLoopConcurrency /
                                               # maxWaitMs / suiteMaxMembers
  # 存在的理由：请求节点并发改为原子领取后，「一个请求最多并发几次」= FLOW_PARALLELISM，
  # 而它是环境变量。编辑器写死上限必然与服务端不一致（填得进去、保存被拒），所以由
  # 服务端说出这些数。

EXECUTION PARTITION (P2-8)                     # 无新路由，只扩现有形状；规划见 5.0.12
  POST/PATCH /projects/:id/environments        + runnerLabel（校验 ^[a-z0-9][a-z0-9-]{0,31}$）
  GET        /projects/:id/environments        + runnerLabel
  GET  /system/workers                         + partitions[{label,online,total,capacity,
                                                 inflight,waiting,failed}] + Worker.labels
  # 标签全集 = workers.labels ∪ DISTINCT environments.runner_label ∪ 'default'，
  # 取并集是为了让「配了但没人服务」的分区显式出现且 online=0——那正是最需要看到的一行。
  # capacity/inflight 的 mode 键不变（repository 预留位不动）。
  # 所有 execute 路由新增失败分支：错误码 2004「该分区无在线执行器」，data 带 label。
  # 不用现有的字符串嗅探（前端 6 处 detail.includes("queue unavailable")）——分区化之后
  # 「队列挂了」与「这个分区没人」是两个不同的处置动作。
```

### 5.3 前端新页面

- 项目侧栏调整为「接口资产：接口/环境/数据源/Mock」「编排与回归：流程/套件」
  「通用：执行记录」；入口随切片启用，未实现能力不展示空页面
- 测试套件配置 (标签选择 / 手动选择 / 全部，**用例 + 流程**) + **跨接口用例选择器**
- Mock 管理 (自动 / 固定 / 模板 / 代理模式) —— 面向外部联调方：公开访问地址、请求日志（排障核心）、
  规则测试；代理超时标注为保护性上限，delay_ms 标注为面向外部调用方的慢/超时模拟
- 数据源连接配置 (首发 PostgreSQL；敏感字段不回显，只显示是否已配置)
- **数据源 SQL 定义**: 命名 SQL 列表 + 编辑器 (参数 `{{变量}}` 绑定防注入, 测试运行), 供流程数据库节点复用
- 执行记录拆成父执行与 HTTP 明细两层；父执行使用稳定详情路由，HTTP 子步骤继续复用
  `ExecutionSnapshot`，不把复杂流程/套件报告塞进抽屉
- 跨接口用例 API 在选择器上线前补服务端分页和接口摘要字段；选择器支持搜索、接口/标签筛选、
  单选/多选与按接口分组，供流程来源与套件成员共用
- 所有 P2 详情页和执行详情以 URL 恢复状态；新增 Drawer 在窄屏全宽，继续遵守单主滚动容器和
  Quiet Console 的单一运行中动画预算
- **执行分区（P2-8）**：环境编辑抽屉加「执行分区」输入 + 环境列表加分区列；执行器面板在
  worker 表格**上方**加一个分区小表（label / 在线 / 容量 / 在途 / 排队 / 失败），worker 表格
  加分区列。**不再加第二排 segmented**——现有 mode segmented 已占那个位置，4.5 明确否决过
  「同页两排下划线 tab」，分区是同一份数据的另一个切片而非导航层级。

### 5.4 流程编排补全（P1-2 并入项）

沿用已交付的画布与执行链路，不另起炉灶：

- **新节点类型**: 脚本 / 条件 / 数据库 / 循环 / 等待 / 子流程。节点抽屉已是页签结构
  （请求 / 前置 / 提取 / 校验），新类型按 `FlowNode.type` 分派到各自的配置页签。
- **节点模型**: `FlowNode` 改为带公共字段的判别联合，`FlowEdge` 保留条件/分支元数据；画布
  读取和保存不能再把节点、边压缩成 request 专用字段，避免静默丢数据。
- **并行执行**: 边语义从「只表达依赖」扩展为可并行；当前 `topologicalOrder` 实际返回平铺
  顺序，P2 改为 stages/ready-set 计划，同层受控并行，并按 5.0.2 的失败传播规则结算。
- **执行索引**: P2-0 先建立父执行索引与通用步骤证据；P2-4 再切换执行记录 UI。现有 flow
  `?run=` 深链继续兼容，但复盘指定历史时节点抽屉必须读取同一次 run，不能回退到节点最新结果。
- **变量袋扩展**: `ctx.variables` 已在沙箱预留；脚本节点与数据库节点的输出统一写回
  同一个变量袋，沿用「节点提取 > 流程变量 > 环境变量」优先级，不新增第二套作用域。

### 5.5 分批验收门槛

1. **P2-1**：数据源密码保存后不回显且可单独更新；连接测试、命名 SQL 试跑、流程数据库节点
   使用同一执行器；参数值只经驱动绑定；超时/行数/结果大小限制可见；删除引用资源返回 usage。
2. **P2-2**：无依赖节点按上限并行；同名输出冲突稳定失败；条件只激活命中分支；脚本/数据库/
   条件步骤都有可复盘结果；取消后不再启动新步骤，已启动步骤尽力中断。
3. ~~**P2-3**~~：**已撤回**（见 5.0.6）。编排统一由流程承担，跨接口传值、库校验、前置/后置
   脚本都在一条流程内完成，不再有第二套语义。
4. **P2-4**：标签/全部选择在入队时固化成员快照；套件并发和 fail-fast 生效；每个成员（用例 /
   流程）作为独立执行，互不传变量；flow/suite 均可从执行记录打开稳定详情，删除原资源后
   历史仍可读。
   补充（5.0.11 确认）：一次套件执行只有一个令牌池，成员数与叶子并发是两个旋钮，
   嵌套不放大并发（`C × FLOW_PARALLELISM` 的乘法不成立）；请求节点声明的并发**原子领取**
   ——声明 3 就真的同时 3，凑不齐整批等，`N > 池容量` 在保存与入队两处直接报错；
   fail-fast 后未启动成员留 `skipped` 证据行，在途成员跑完；套件预览把峰值并发需求
   与平台上限一起写出来。
5. **P2-5**：四种 Mock 模式按优先级匹配；禁用规则不响应；代理只访问白名单；敏感头和响应受限；
   Mock 流量不改变接口用例通过率或正式执行统计；外部调用方可匿名访问 `/mock/:publicId/*` 并在
   日志中确认 matched 与请求快照；代理超时作为保护性上限回 504；delay_ms 对平台内流程不构成
   超时语义（流程自身 30s 预算兜底）。
6. **P2-6**：循环达到硬上限必停；等待不超过首版上限；子流程循环引用在保存和运行时均拒绝，
   递归深度受限；高级节点失败仍遵循统一传播和取消语义。
   补充（实现后固化，见 5.0.8）：容器节点不占并发额度，嵌套不放大并发（三层嵌套的真实
   并发仍受单次 `FLOW_PARALLELISM` 封顶）；循环迭代互不可见，同一接口的并发请求由
   「按次数循环 + 单节点循环体 + concurrency」表达；父级计数只统计顶层步骤，容器内部
   每一步都有可复盘证据行。
7. **P2-8**（见 5.0.12）：环境可配执行分区标签，指向该环境的用例/流程/套件/批量调试全部
   路由到对应分区的 worker；一个只服务 `prod-dmz` 的 worker 不会领到 `default` 的任务，
   反之亦然；**目标分区无在线 worker 时执行请求直接失败（错误码 2004，文案指明是哪个分区
   没有执行器），不写出一条会被回收判死的 `queued` 记录**；执行器面板列出全部分区（含
   「配了但没人服务」且 online=0 的那些）；环境改标签或被删后，历史执行仍显示原分区名。

---

## 六、P3 — 调度、告警、趋势 (3 周)

### 6.1 数据库迁移: 004_p3_schema.sql

```
schedules          (id, project_id, target_type, target_id, cron, config JSONB, status)
notifications      (id, project_id, type, config JSONB, channels JSONB)
alert_rules        (id, project_id, metric, condition, threshold)
```

### 6.2 后端新 API

```
SCHEDULES
  GET/POST /projects/:id/schedules
  PUT/DELETE /projects/:id/schedules/:scheduleId

ALERTS
  GET/POST /projects/:id/alerts
  PUT/DELETE /projects/:id/alerts/:alertId

REPORTS
  GET /projects/:id/reports/trend
  GET /projects/:id/reports/summary
```

---

## 七、P4 — 仓库模式: 上报式用例 (4 周)

### 7.1 数据库迁移: 005_p4_schema.sql

```
repositories       (id, project_id, git_url, branch, status)
ingest_runs        (id, repository_id, commit_sha, status)
ingest_records     (id, ingest_run_id, endpoint_id, action)
repo_test_cases    (id, repository_id, endpoint_id, file_path, code_hash)
```

### 7.2 SDK 包 (apitest-sdk-python)

- `apitest.ingest()` — 上报用例结果
- `apitest.TestCase` — 装饰器 + 断言工具
- `apitest.Client` — 鉴权 + 重试

---

## 八、P4.5 — CI 任务: 自研 Runner (4 周)

> **与 P2-8 执行分区的关系（见 5.0.12）**：本阶段的 Runner 协议（8.2，runner 主动出站、
> 无入站端口、只需 443）是「生产网段连不上平台 Redis / Postgres」情况下的**唯一解**。
> P2-8 采用的分区 worker 依赖出站 Redis + Postgres，若该前置条件不成立，P2-8 作废并把
> 本阶段的 Runner 协议提前。反之，P2-8 已落地的分区标签机制可被本阶段直接复用——
> 仓库模式自带队列，标签只需照搬，不需要返工。
> 另：仓库用例的 `git clone` 与用户脚本执行**只能**发生在能访问被测服务的网段里，
> 因此跨网段的仓库用例最终一定要走本阶段的协议，而不是分区 worker。

### 8.1 数据库迁移: 006_p45_schema.sql

```
ci_tasks           (id, repository_id, name, config JSONB)
pipeline_runs      (id, ci_task_id, trigger_type, status)
pipeline_run_cases (id, pipeline_run_id, case_id, status, result JSONB)
pipeline_run_artifacts (id, pipeline_run_id, type, path)
```

### 8.2 Worker 协议 (Runner → Server)

```
POST /worker/register   (注册 Worker)
POST /worker/claim      (领取任务)
POST /worker/heartbeat  (心跳)
POST /worker/logs       (日志流)
POST /worker/artifacts  (构件上传)
POST /worker/complete   (任务完成)
```

### 8.3 勾选用例快速执行 (`[已确认]` 范围，与 7.x 上报式用例配合)

> **定位**: 在「仓库用例」树上勾选若干上报用例 → 触发对应 CI 任务，带 `case_filter` 筛选，
> 由仓库代码按 key 只跑选中用例，结果经上报接口回传归位到树节点。**不是**接口模式批量调试
> (EndpointList bulk-bar) 的等价物——平台不拥有测试代码，只传参 + 接收结果 + 对账。

**链路**: 树行勾选 → 「触发 CI 任务」→ 校验(仓库已绑 + 有任务 + 有在线 Worker) → 选任务
(默认推荐「最近成功跑过并上报过这些 case_key 的任务」，其次默认任务) → 触发 run，
JobSpec 携带 `case_filter: { case_keys: [] }` → Runner 注入 env `APITEST_CASE_KEYS` + CLI 参数
→ 用户脚本只跑选中 → SDK/报告回传 → 树上 `last_result` 刷新，未报的标 `not_run`。

**支持 (平台侧开箱即用)**:
- 勾选→触发链路，Idempotency-Key 防重；`trigger_type=manual_case_selection` 进 ExecutionIndex 可过滤。
- 结果归位: run 结束 SDK 经 `/ingest` 回传，自带 `ci_run_id` 命中幂等键 `(repo, commit, ci_run_id)`，
  按 `(project, case_key)` upsert 树节点；参数化用例按 `case_key` 归并为一条节点。
- 缺失对账: 筛选集合中本次未上报的用例标 `not_run` (区别于失败)；部分运行不触发删除对账 (沿用 2.10.1)。
- 跨任务: 一次勾选可触发多个任务 (各跑全集筛选，脚本自行跳过不认识的 key)。
- 复用 Runner 全套: PipelineRun 状态、心跳、取消、孤儿恢复、实时日志 SSE；触发动作落审计日志。
- 触发时可顺带填任务 `parameters`。

**依赖用户侧 (平台传参，效果取决于脚本)**:
- 「只跑选中」本身需脚本调用 SDK `apitest.select(case_keys)` / `--apitest-case-keys`；无视筛选 = 全量跑，
  平台以 `not_run` 兜底，不误报成功。
- case_key ↔ 可执行单元映射: SDK 装饰器天然带 key；裸 pytest 等需用户适配。
- 前置条件 (依赖/数据/登录态) 用户侧保证；`cache_config` 命中才「快」。
- 结果语义以触发时 HEAD 为准，不追溯旧 commit。
- junit/allure 报告解析路径: case 级结果可落 `PipelineRunCase`，但回写树上 `last_result` 仅 best-effort
  (测试名 ↔ case_key 无稳定映射)；SDK 上报路径才是干净路径。

**明确不支持**:
- 平台直接执行/重放上报用例 (无代码、仅请求摘要)。
- 保证任意脚本「只跑选中」；精细到函数/行的调度 (无行号语义，粒度止步 case_key 集合)。
- 纯外部 CI 上报、无自研 Runner 的仓库: 无法触发，仅提供带筛选参数的触发命令/清单旁路。
- 任意 ref 选择 (默认用任务配置 `ref`)；跨项目勾选。

**落地点 (最小改动)**:
- JobSpec + `POST /ci-tasks/:id/trigger` payload 加 `case_filter`；`PipelineRun.trigger_type` 扩展枚举。
- `RepoTestCase.last_result` 枚举加 `not_run` (现 passed/failed/unknown)。
- SDK 加 `select()`/CLI 参数约定；ExecutionIndex 加 trigger_type 过滤；任务表加 `is_default` 或「最近命中」推荐逻辑。
- 体验预期: 常驻 Worker + 缓存命中时秒级~数十秒级，相对「手动去仓库跑」成立，非接口模式毫秒~秒级。

---

## 九、P5 — MCP: 平台对外暴露 (4 周)

### 9.1 数据库迁移: 007_p5_schema.sql

```
mcp_servers        (id, project_id, name, url, api_key, capabilities JSONB)
mcp_tool_calls     (id, flow_execution_id, tool_name, args JSONB, result JSONB)
```

### 9.2 平台 MCP 对外暴露 (Server 模式) 与 AI 能力

> **方向 (交互文档 v1.7)**: **移除应用内「MCP 对话式创建接口」**（不提供前端对话 UI）。平台将自身能力作为 **MCP Server 对外暴露**，让外部 AI/工具通过 MCP 创建接口、接口用例、DAG 编排。**暂不对外暴露**，待接口用例（P1）、DAG 编排（P1/P2）等能力全部完成后**统一提供**。前端届时仅提供最小管理入口（暴露地址 / Token / 工具清单 / 启停开关）。

- **AI 能力（可选 / 后置）**: AI 生成断言 / AI 根因分析 / AI 趋势洞察（报告分析）

---

## 十、P6 — 性能、插件、版本 (3 周)

### 10.1 性能优化

- 执行历史归档 (分区表)
- 大响应体截断 + 对象存储 (MinIO/S3)
- 查询缓存 (Redis)

### 10.2 插件机制

- 插件生命周期: 注册 → 启用 → 禁用 → 卸载
- 钩子点: 执行前/后, 断言, 报告生成

### 10.3 版本历史

- 接口变更追踪
- 环境配置快照
- 执行结果回放

---

## 十一、依赖安装清单

### 11.1 后端新增依赖


| 阶段 | 依赖                  | 用途             |
| ------ | ----------------------- | ------------------ |
| P0   | —                    | 当前无新增       |
| P1   | `bullmq` **已装**     | 任务队列         |
| P1   | `ioredis` **已装**    | Redis 客户端     |
| P1   | `ajv` **已装**        | JSON Schema 断言（P1-1 收尾） |
| P1   | `zod`                 | 请求校验         |
| P1   | `@fastify/rate-limit` | 频率限制         |
| P2   | `@fastify/websocket`  | 日志流           |
| P2-7 | `mysql2` **已装**     | MySQL 驱动       |
| P2-7 | `mssql` + `@types/mssql` **已装** | SQL Server 驱动（包不自带类型声明） |
| P2-7 | `oracledb` + `@types/oracledb` **已装** | Oracle 驱动，thin 模式（包不自带类型声明） |
| P2-7 | `mongodb` **已装**    | MongoDB 驱动     |
| P3   | `node-cron`           | 定时调度         |
| P5   | `@fastify/swagger`    | OpenAPI 文档生成 |

> 说明: P1-3 的执行进度推送用 **SSE**(`reply.hijack()` + `text/event-stream`)实现,
> 未引入 `@fastify/websocket`——单向推送不需要双工通道。
>
> P2-7 的 Redis 操作驱动复用 P1 已装的 `ioredis`，零新依赖。四个新驱动在
> `lib/adapters/index.ts` 按需 `import()`，不进启动路径（见 5.0.10 边界决策 8）。
> `mssql` / `oracledb` 必须配套装 `@types/*`：`tsx` 不做类型检查，缺声明只会在
> `pnpm check` / `pnpm build` 时才暴露。

### 11.2 前端新增依赖


| 阶段 | 依赖                   | 用途          |
| ------ | ------------------------ | --------------- |
| P0   | `react-router-dom` v6  | 路由          |
| P0   | `zustand`              | 状态管理      |
| P0   | `react-i18next`        | 多语言        |
| P1   | `@xyflow/react`        | DAG 画布      |
| P1   | `@monaco-editor/react` | 代码编辑器    |
| P1   | `ajv` **已装**          | JSON Schema 断言（P1-1 收尾） |
| P3   | `@ant-design/charts`   | 趋势图表      |
| P5   | `@uiw/react-md-editor` | Markdown 编辑 |

> 说明: 脚本断言沙箱**定案用 `node:vm`**（零依赖），不再引入 `isolated-vm`——原生
> 依赖要编译且版本对齐成本高，而 worker 进程隔离已是第一道边界，`node:vm` 只需
> 挡掉明显路径（见 4.0.1）。

---

## 十二、里程碑 & 交付标准

### 12.1 里程碑


| 里程碑 | 阶段    | 交付物                   | 验收标准                                         |
| -------- | --------- | -------------------------- | -------------------------------------------------- |
| M0     | P0 重构 | 模块化代码 + 路由 + 测试 | 现有功能全部通过测试                             |
| M1     | P1      | Flow 编排 + 测试用例     | 可创建 DAG 并执行, 结果可查                      |
| M2     | P2      | 数据源 + 流程节点补全 + 套件 + Mock | 数据源可连可跑命名 SQL；流程支持脚本/条件/数据库节点与并行；可批量执行 + 模拟响应 |
| M3     | P3      | 调度 + 告警 + 趋势       | 定时执行 + 失败通知                              |
| M4     | P4      | SDK 上报                 | Python SDK 可安装使用                            |
| M5     | P4.5    | Runner                   | 可拉取代码执行并查看结果                         |
| M6     | P5      | 平台 MCP 对外暴露        | 外部可通过 MCP 创建接口/用例/DAG (统一上线) |
| M7     | P6      | 性能 + 插件              | 支持 1000+ 并发执行                              |

### 12.2 交付标准

- 后端: 所有 API 有集成测试, 覆盖率 > 80%
- 前端: 核心页面有组件测试, 无控制台错误
- 文档: 每个模块有 API 文档 + 使用说明
- 性能: 单接口执行 < 100ms 开销, 100 并发无崩溃
