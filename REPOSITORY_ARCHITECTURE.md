# 接口自动化平台 — 代码仓库划分与跨仓协议

> 版本: v1.1
> 状态: Draft
> 基于: API_AUTOMATION_SPEC.md v1.9 / FRONTEND_INTERACTION_DESIGN.md v2.0
>
> **v1.1（P4 落地）**：2.3 的 SDK 仓改名 `apitrack-sdk-python`（分发名 `apitrack-sdk`，导入名 `apitrack`，环境变量前缀 `APITRACK_`）并重写为零改动接入的形状（pytest 插件 + 传输层打桩 + 零依赖）；3.4 上报协议冻结为 v1.0，相对初版草图增补 `run.scope`、`run.sdk`、`records[].phase`、`inventory[].result` 四个字段，并补齐平台侧的双闸门对账、关系表归属与响应码表。

---

## 1. 总览

### 1.1 仓库清单

| # | 仓库 | 语言/形态 | 交付物 | 引入阶段 |
|---|------|----------|--------|---------|
| 1 | **apitest-server** | Node.js + TypeScript (monorepo) | 容器镜像 | **P0** |
| 2 | **apitest-web** | React 18 + TypeScript | 静态资源 (CDN) | **P0** |
| 3 | **apitrack-sdk-python** | Python | PyPI 包 (分发名 `apitrack-sdk`) | P4 ✅ 已建仓，**已发布 PyPI `v0.1.0`**（2026-08-31） |
| 4 | **apitest-runner** | Node.js + 容器 | 容器镜像 (可自托管) | P4.5 |

> **P0 只需建 1、2 两个仓**。3、4 分别在「仓库用例(上报式)」与「自研 Runner」阶段才需要。

### 1.2 划分依据

拆仓不是按"模块"拆，而是按以下四条硬边界拆 —— 满足任一条才独立成仓：

| 边界 | 说明 | 对应仓库 |
|------|------|---------|
| **语言/生态不同** | 无法共享构建与依赖体系 | `apitrack-sdk-python` |
| **发布渠道不同** | PyPI / CDN / 镜像仓库，各自版本节奏 | 3、2、4 |
| **使用者不同** | 外部开发者依赖 or 客户自托管部署 | 3、4 |
| **团队/权限不同** | 前后端分离协作，代码可见性隔离 | 1、2 |

反过来 —— **不满足以上边界的一律不拆**。典型如 API Service 与 Worker Service：共享 DB schema、执行引擎、报告归一化逻辑，耦合度极高，拆开只会让"改一个字段跨仓提 PR"成为日常，因此同处 `apitest-server` monorepo。

### 1.3 依赖关系

```
                    ┌─────────────────┐
                    │  apitest-web    │  React SPA
                    └────────┬────────┘
                             │ HTTP (OpenAPI 契约)
                             ▼
                    ┌─────────────────┐
                    │ apitest-server  │  平台核心
                    └────┬───────┬────┘
              上报协议 ▲  │       │  ▲ Worker 协议
                       │  │       │  │
        ┌──────────────┴┐ │       │ ┌┴──────────────┐
        │apitrack-sdk-  │ │       │ │apitest-runner │
        │python         │ │       │ │               │
        │(用户测试仓库内)│ │       │ │(可部署客户内网)│
        └───────────────┘ │       │ └───────────────┘
                          ▼       ▼
                    PostgreSQL / Redis / Object Store
```

- **箭头方向 = 谁主动发起连接**。`apitest-runner` 与 `apitrack-sdk-python` 均**主动外连平台**，平台永不反向连接它们。
- 因此 Runner 与 SDK 都可运行在 NAT/内网之后，**无需开放任何入站端口**。

---

## 2. 各仓库职责

### 2.1 `apitest-server` — 平台核心

**定位**: 平台全部后端能力。采用 pnpm workspace monorepo，内部按 app 拆分独立部署单元。

```
apitest-server/
├── apps/
│   ├── api/              # API Service (Fastify)
│   │   ├── auth/         # 认证 / RBAC / 成员
│   │   ├── project/      # 项目 / 环境 / 设置 / 审计
│   │   ├── endpoint/     # 接口管理 / 导入 (OpenAPI·Swagger·Postman)
│   │   ├── testcase/     # 用例 / 场景 / 套件 CRUD
│   │   ├── flow/         # 流程编排元数据
│   │   ├── datasource/   # 数据源代理
│   │   ├── mcp/          # MCP Server 注册与调用
│   │   ├── scheduler/    # Cron 调度 (分布式锁 / 单主选举)
│   │   ├── ingestion/    # 上报接口 + 合并·去重·删除对账 + 覆盖计算
│   │   ├── orchestrator/ # Runner 任务派发 / 心跳 / 日志流 / 报告归一化
│   │   │                 # P4.5-13: allure-results 包的读取/解析/缓存 + 附件下载
│   │   ├── mock/         # Mock 服务
│   │   └── report/       # ExecutionIndex 查询 / 趋势 / 告警
│   ├── worker/           # 接口模式执行引擎 (BullMQ Worker)
│   │                     # DAG 调度 / HTTP 调用 / 脚本沙箱 / 断言 / 数据库节点
│   └── mcp-gateway/      # (可选, P5) MCP Client 运行时
├── packages/
│   ├── shared/           # 领域类型 / DTO / 错误码 / 枚举
│   │   └── contracts/    # ★ 跨仓协议契约 (见第 3 章)
│   ├── db/               # schema + migrations
│   ├── report-parser/    # JUnit / Allure 解析归一化 (api 与 worker 共用; P4.5-13 后报告视图解析在 orchestrator 侧)
│   └── cli/              # api-auto CLI
└── deploy/               # Dockerfile / K8s manifests / compose
```

**核心职责**

| 职责 | 说明 |
|------|------|
| 业务 CRUD | 项目/成员/接口/环境/用例/场景/套件/流程/数据源/MCP |
| 认证鉴权 | JWT + RBAC (系统管理员/项目管理员/开发者/只读) |
| 执行调度 | Cron 调度、Webhook 接收、任务入队 (BullMQ) |
| 接口模式执行 | DAG 引擎、HTTP/脚本/数据库/MCP 节点、断言 |
| **上报接收** | 唯一上报接口、Token 鉴权、仓库绑定校验、快照对账 |
| **Runner 编排** | Worker 注册/心跳/存活判定、任务派发、日志流中转、报告归一化 |
| **报告视图自渲染** | allure-results 包的读取 (零依赖 zip 解析) / 归一化 / 5 分钟缓存 / 按归属鉴权的附件下载——不跑 allure-cli、不托管其静态站 (P4.5-13 边界 19) |
| 统一报表 | 维护 `ExecutionIndex`，供报告监控与统计下钻查询 |
| 覆盖计算 | path 归一匹配、覆盖率与未覆盖清单 |

**不负责**: 不执行仓库模式的用户代码（交给 `apitest-runner`）、不渲染页面（交给 `apitest-web`）。

---

### 2.2 `apitest-web` — 前端 SPA

**定位**: React 单页应用，纯静态资源交付，通过 REST API 与后端通信。

```
apitest-web/
├── src/
│   ├── api/              # ★ OpenAPI codegen 产物 + axios 封装
│   ├── pages/
│   │   ├── auth/         # 登录
│   │   ├── dashboard/    # 全局数据看板（登录默认入口；跨项目指标）
│   │   ├── project/      # 项目管理 CRUD / 项目概览 / 项目设置(含成员)
│   │   ├── system/       # 系统管理：个人偏好、主题、语言、系统管理员配置
│   │   ├── endpoint/     # 接口管理
│   │   ├── testcase/     # 用例 / 套件
│   │   ├── scenario/     # 场景编排
│   │   ├── flow/         # DAG 编辑器 (React Flow)
│   │   ├── repo/         # 仓库模式一个入口五个标签：任务 / 用例树 / 上报记录 / 未匹配诊断 / 凭据
│   │   ├── ci-task/      # 仓库任务执行详情(SSE 日志) / Runner 池（任务列表本身在 repo/ 下）
│   │   ├── datasource/ mock/ mcp/
│   │   ├── report/       # 报告监控 / 趋势
│   │   └── schedule/
│   ├── components/       # 通用组件 (KV 编辑器 / Monaco / 空状态)
│   ├── hooks/            # usePermission / useSearchParams 封装 / useSSE
│   ├── stores/           # zustand 全局状态
│   └── locales/          # i18n (zh-CN / en)
└── vite.config.ts
```

**核心职责**: 全局层（数据看板、项目管理、系统管理）与项目层的交互实现、URL 状态管理 (deep-link)、权限可见性控制、SSE 实时日志消费、i18n。

**信息架构约束**
- 登录后的默认路由是全局数据看板，不得因最近项目而直接进入项目工作台；仅用户显式开启“恢复上次页面”时恢复可访问的最后 URL。
- 项目管理显式负责项目 CRUD 和进入项目；项目内 Dashboard、接口、环境和执行记录均不承担全局目录职责。
- 单接口执行历史与完整 HTTP 快照属于 `endpoint/` 页面；`report/` 只承担跨资源、跨执行类型的统一审查与统计。
- `system/` 是主题、语言和其他个人偏好的完整设置入口；Header 快捷操作不替代该页面。

**关键约束**
- **只通过 HTTP 访问后端**，绝不 import 后端内部模块。
- API 层**全部由 OpenAPI codegen 生成**，不手写请求类型。
- 所有可深链状态（列表筛选/分页/抽屉/Tab/画布定位）进 URL query，见前端设计 6.2。

---

### 2.3 `apitrack-sdk-python` — 采集 SDK

**定位**: 发布到 PyPI，由**外部开发者**安装在**他们自己的测试仓库**中，用于上报仓库用例。

**命名 (P4 落地时定稿)**：仓库 `apitrack-sdk-python`，分发名 **`apitrack-sdk`**，导入名 `apitrack`，pytest 插件注册名 `apitrack` (于是关掉它就是 `-p no:apitrack`)。环境变量前缀 `APITRACK_`。**只发这一个分发包**：曾计划另注册占位包 `pytest-apitrack` 以防同名不同物的包被误装进接入方 CI，但它的代价是每次发版多一处版本号要同步，权衡后撤销 (2026-08-30)，该名字不再占用。

```
apitrack-sdk-python/
├── apitrack/
│   ├── plugin.py         # pytest 插件: hook + contextvar 当前用例 + phase 标记
│   ├── patch/
│   │   ├── requests_patch.py  # HTTPAdapter.send
│   │   └── httpx_patch.py     # HTTPTransport.handle_request / async 版
│   ├── collector.py      # 内存缓冲 + inventory 收集 + 上限降级
│   ├── case.py           # @case 装饰器 (可选的显式覆盖)
│   ├── reporter.py       # sessionfinish 一次性 POST (标准库 urllib)
│   ├── masker.py         # 头部脱敏
│   ├── config.py         # 环境变量 + CI 元数据探测
│   └── cli.py            # 非 pytest 备用入口 (python -m apitrack) + doctor
├── tests/
└── pyproject.toml        # [project.entry-points.pytest11] apitrack = "apitrack.plugin"
```

**核心职责**

| 职责 | 说明 |
|------|------|
| 零改动接入 | 装包 + 两个环境变量 + 原样跑 `pytest`。插件靠 `pytest11` entry point 自动加载 |
| 请求采集 | **传输层打桩** (`requests`/`httpx`)，采 method、raw path、状态码、耗时、脱敏后的头键名、`phase` |
| 用例身份 | `case_key` = nodeid 去掉 `[...]`；`name` = docstring 首行；两者分开 |
| 清单收集 | collect 之后即定 inventory，并按 pytest 参数推出 `scope` 与「范围内是否有过滤」 |
| CI 元数据探测 | commit / branch / ci_run_id (GitHub Actions、GitLab CI、Jenkins) |
| 批量上报 | `pytest_sessionfinish` 一次性 POST 到平台唯一上报接口 |

**关键约束**
- **必须向后兼容**：用户安装的 SDK 版本平台无法控制，老版本 SDK 不得因平台升级而失效。协议版本与包版本**分开**：包可以随便发，协议只增不改。
- **不影响用例执行**：桩体只往内存 list 追加一条 dict，全程零网络；**绝不读响应 body** (`stream=True` 与 httpx 的未读流被读一次就被吃掉了)；延迟用桩自己的 `perf_counter` 差。
- 上报失败**不得中断用户测试流程**：5 秒超时 + 一次重试，失败只 warning，**不动退出码**。桩自身连续失败 3 次自我卸载。
- **零依赖**：`requests` / `httpx` / `pytest` 都不进 `dependencies` (声明依赖会在用户环境里触发一次不必要的版本解析，甚至升级掉他们钉住的版本)；两个 HTTP 库靠 `importlib.util.find_spec` 探测，上报本身用标准库 `urllib`。
- `APITRACK_TOKEN` 缺失时**完全 no-op**，连桩都不打——否则第一个在自己机器上跑全量的人就会误报一次「全量快照」并触发删除对账。
- 未来多语言扩展预留：`apitrack-sdk-js` / `apitrack-sdk-java`。

---

### 2.4 `apitest-runner` — 自研 CI 执行器

**定位**: 独立执行 Worker，可部署在平台侧或**客户内网自托管**。交付物为容器镜像。

```
apitest-runner/
├── src/
│   ├── registry.ts       # 注册 / 心跳 / draining 优雅下线
│   ├── claimer.ts        # 长轮询领取任务
│   ├── executor/
│   │   ├── workspace.ts  # 独立 workspace 准备与清理
│   │   ├── git.ts        # SSH deploy key 浅克隆
│   │   ├── cache.ts      # 依赖缓存命中判定 / 回写
│   │   ├── runner.ts     # 写脚本文件 → spawn → 退出码落盘
│   │   └── sandbox.ts    # 容器隔离 / 资源限额 / kill 进程树
│   ├── streamer.ts       # stdout/stderr 增量日志上报 (offset)
│   ├── uploader.ts       # 产物上传 (pre-signed URL)
│   ├── reportBundle.ts   # allure-results 整目录打 zip → kind='report' 产物 (P4.5-13)
│   ├── report/           # junit XML / allure JSON 解析 → complete 的 cases[]
│   │   └── zip.ts        # 零依赖 zip 写入器 (STORE/DEFLATE, CRC32 查表)
│   ├── masker.ts         # secret 日志脱敏
│   └── proxy/            # 零侵入覆盖率捕获代理 (HTTP_PROXY + CA)
├── images/               # 基础运行镜像 (python/node/git)
└── Dockerfile
```

**核心职责**: ① 沙箱运行脚本 ② SSH 拉取代码 ③ 状态回调 ④ 报告/产物上传，外加实时日志流与依赖缓存。

**关键约束**
- **主动外连**，不监听任何入站端口。
- 执行**不可信用户代码**：rootless 容器、资源限额、出站白名单（禁访平台内网/DB/云元数据 `169.254.169.254`）。
- **退出码落盘**，保证崩溃重启后可判定任务真实状态。
- 独立 semver，需维护与平台的**协议兼容矩阵**。
- **报告渲染在平台侧**（P4.5-13 边界 19）：Runner 只负责解析 allure-results 的结构化
  JSON（timeline 数据随 `complete` 上报）与整目录打 zip 走产物线，**不装 allure-cli、
  不跑 `allure generate`**——镜像里没有 Java，报告视图由平台用自己的 UI 渲染。

---

## 3. 跨仓协议

三条跨仓协议是拆仓后最大的失控风险点，必须**显式定义 + 版本化 + CI 校验**。

契约源文件统一放在 `apitest-server/packages/shared/contracts/`：

```
contracts/
├── openapi.json           # 平台 REST API (自动生成)
├── worker-protocol.yaml   # Worker 协议
└── ingest-protocol.yaml   # 上报协议
```

### 3.1 协议总表

| 协议 | 跨越 | 方向 | 鉴权 | 兼容要求 |
|------|------|------|------|---------|
| **REST API** | server ↔ web | web 主动 | JWT | 前后端同步发布，可较快演进 |
| **Worker 协议** | server ↔ runner | **runner 主动** | worker_token | 需兼容矩阵 (自托管滞后升级) |
| **上报协议** | server ↔ sdk | **sdk 主动** | 项目 API Token | **最严格，必须向后兼容** |

> 兼容要求的严格程度取决于**升级控制权**：web 与 server 同步发布最宽松；runner 客户自托管次之；SDK 装在用户仓库里、完全不可控，因此最严。

---

### 3.2 REST API 协议 (server ↔ web)

**契约先行流程**

```
后端 Fastify schema (TypeBox / Zod)
   → @fastify/swagger 自动生成 openapi.json
   → CI 发布为 artifact (或推私服 npm)
        ↓
前端 openapi-typescript / orval 代码生成
   → 完全类型化的 API client
   → 后端改字段 → 前端 codegen 后编译报错
```

这样类型安全性**不弱于 monorepo**，且强制了 API 契约纪律。

**统一响应格式** (见 Spec 4.1)

```json
{
  "code": 0,
  "message": "success",
  "data": {},
  "meta": { "page": 1, "page_size": 20, "total": 100 }
}
```

**约定**
- 错误码: `0` 成功 / `1001` 参数错误 / `1002` 未认证 / `1003` 无权限 / `2001` 资源不存在 / `5001` 内部错误
- 列表统一 query: `page` / `page_size` / `keyword` / `sort` / `tags` + 资源特有过滤
- 触发类接口支持 `Idempotency-Key`
- 实时执行状态首选 **SSE**，轮询降级

---

### 3.3 Worker 协议 (server ↔ runner)

**全部由 Worker 主动发起**，平台永不反向连接。

| 步骤 | 接口 | 载荷 |
|------|------|------|
| 注册 | `POST /worker/register` | `{worker_token, labels, capacity, mode}` → `worker_id` |
| 领取 | `GET /worker/jobs/claim` | 长轮询 → `JobSpec` |
| 心跳 | `POST /worker/jobs/:id/heartbeat` | 续约；**响应可下发 `cancel` 指令** |
| 日志 | `POST /worker/jobs/:id/logs` | `{offset, chunk}` 增量 |
| 产物 | `POST /worker/jobs/:id/artifacts` | 申请 pre-signed URL 后直传对象存储 |
| 完成 | `POST /worker/jobs/:id/complete` | `{status, exit_code, summary}` |

**JobSpec 结构**

```yaml
run_id:        string
repo:          { ssh_url, deploy_key }      # 凭据继承项目唯一仓库
ref:           string
image:         string                        # 运行镜像
isolation_mode: shared | isolated
steps:         [string]                      # 用户自定义脚本
env:           { KEY: VALUE }
secrets:       [{ key, value }]              # 注入后日志需脱敏
cache_config:  { paths[], key }              # 依赖缓存
report_paths:  [string]                      # JUnit / Allure
proxy_config:  { enabled, endpoint, ca }     # 零侵入覆盖率捕获
timeout_sec:   int
```

**关键约定**
- **日志 offset 单调递增**，断线后按 offset 续传，平台据此去重
- **心跳超时 90s** 判定 `aborted`，任务可重新入队
- **退出码以 Worker 上报为准**，Worker 崩溃重启后读落盘退出码补报
- 兼容策略: 平台需同时支持 **N 与 N-1** 两个协议版本，给自托管 Runner 留升级窗口

---

### 3.4 上报协议 (server ↔ sdk)

**平台只暴露一个入口**: `POST /ingest`，项目级 API Token 鉴权 (`Authorization: Bearer apitrack_<token>`)。

**请求结构 (协议 v1.0，P4 落地时冻结)**

```yaml
protocol_version: "1.0"          # 显式版本, 平台据此路由解析逻辑
run:
  repo:              { git_url, provider }
  commit_sha:        string
  branch:            string       # 空串 = 无法探测；平台侧于是永不对账
  ci_run_id:         string       # 幂等键组成部分；本地跑用空串 (不是 null)
  ci_run_url:        string
  scope:             [string]     # ★ 本次跑的范围, 相对仓库根；空数组 = 全仓
  is_full_inventory: bool         # ★ 含义是「这个范围内没有过滤」
  sdk:               { name, version }   # ★ 平台回 warnings 提示升级时要知道对方是谁
  started_at:        string       # ISO-8601, 可选
  finished_at:       string
inventory:                        # 该 commit 下存在的全部用例 (范围内)
  - case_key:    string           # pytest nodeid 去掉 [...]；@case(key=…) 可覆盖
    name:        string           # 显示名: @case("…") > docstring 首行 > 函数名
    description: string           # docstring 首行之后全部
    file:        string           # 仓库根的相对路径, 对账按 scope 裁剪时用它
    tags:        [string]
    result:      passed|failed|skipped|unknown   # ★ 用例级结果
records:                          # 本次实际执行的请求记录
  - case_key:    string           # 空串 = 没有归属用例 (session 级 fixture)
    param_id:    string           # 参数化子项
    phase:       setup|call|teardown   # ★ 只有 call 阶段建立用例关系
    seq:         int              # 批次内幂等键: UNIQUE(run_id, seq)
    method:      string
    path_raw:    string           # 实际路径, 平台侧归一为模板
    status_code: int
    latency_ms:  int
    passed:      bool             # **这一个请求**的结果, 不是用例的结果
    error:       string
    request_summary: object       # 脱敏后的头键名 / 响应大小 / 可选的截断 body
```

**★ 标记的四个字段是相对本节初版草图的增补，全部必须进 v1.0**：

- `run.scope` 与 `records[].phase`：协议只增不改 (3.1 最严格一档)，首版漏掉之后再加，就要面对「老 SDK 报上来的没有 scope，那它算全仓全量吗」——这个问题的两个答案一个会误删用例、一个会让对账永久失效，没有安全解。
- `inventory[].result`：草图只有 `records[].passed`，那是**每个请求**的结果，而用例结果不能由它推出来 —— 一条被 `skip` 的用例、或一条只断言了本地计算的用例，records 里是空的，按「没有失败的请求就算通过」会把它算成绿的；一条断言「404 是预期行为」的用例反过来会被算成红的。
- `run.sdk`：平台要把升级提示回给具体的谁。

**平台侧处理约定**

| 环节 | 规则 |
|------|------|
| **鉴权** | 项目级 Token，**scrypt 哈希**比对 (只需比对就不该加密，与 Webhook 密钥的 AES-GCM 刻意不同)；首次上报绑定唯一仓库，此后校验 `git_url`，不一致直接拒绝 (409，消息说清绑的是哪个) |
| **幂等** | `(repository_id, commit_sha, ci_run_id)`；重投是合并不是新增。批次内再叠 `(run_id, seq)` |
| **合并** | 按 `(project_id, case_key)` upsert，更新 `last_seen_commit` / `last_result`。`last_result` 只在这一轮真跑了它 (passed/failed) 时才更新——被 skip 的用例不该把昨天的 passed 冲成 unknown |
| **归属** | 一个用例挂它实际打过的**每一个**接口 (关系表，非单列外键)；关系**累积**、不每轮重建；只有 `phase='call'` 的记录建立关系 |
| **删除对账** | 双闸门：`is_full_inventory=true` **且** `branch = repositories.tracking_branch`。只删 `file` 在 `scope` 之内、且本次 inventory 里缺失的用例。**只看 inventory，绝不看 records** |
| **path 归一** | `/users/123` → `/users/{id}`，规则留在平台侧 (SDK 只报 raw path)；匹配不到进「未匹配诊断」区，**绝不自动登记 endpoint** |
| **归一进统一记录** | 写一行 `execution_index(kind='ingest', trigger_source='ci')`，但趋势与通过率默认排除它 (客户端耗时与平台墙钟耗时不是一个口径) |
| **上限** | `INGEST_MAX_RECORDS` (413) + Fastify `bodyLimit` (解析前拒掉)；不做项目级配额 |

**响应**

```
200 { runId, indexId, matched, unmatched, unplaced, reconciled, warnings[] }
401 token 无效或已吊销
409 git_url 与已绑定仓库不一致
413 超过记录数或请求体上限
422 protocol_version 未知 / inventory 与 records 的 case_key 不自洽
```

**兼容要求 (最严格)**
- `protocol_version` 必填，平台需**长期支持历史版本**
- **只增不改**：新增字段必须可选，禁止修改既有字段语义
- 平台返回 `warnings[]` 提示 SDK 升级，但**不得因版本旧而拒绝上报** (拒的只有平台不认识的**未来**版本，那时字段语义可能已经不同，猜着解析会把错误数据写成事实)

---

### 3.5 协议变更管理

**统一规则**

| 变更类型 | 版本 | 要求 |
|---------|------|------|
| 新增可选字段 | minor | 向后兼容，无需协调 |
| 新增必填字段 / 改语义 / 删字段 | **major** | 需兼容窗口 + 迁移方案 |

**CI 强制校验** (在 `apitest-server` 流水线中)

```
1. 契约 diff 检测       → 对比上一版 contracts/，识别破坏性变更
2. 破坏性变更拦截       → 未升 major 直接 fail
3. 契约产物发布         → openapi.json / *.yaml 作为 artifact
4. 下游联动             → web 触发 codegen；runner/sdk 更新兼容矩阵
```

**兼容矩阵示例** (维护在各下游仓 README)

| Runner 版本 | 支持的平台版本 |
|------------|--------------|
| 1.0.x | 1.0 – 1.1 |
| 1.1.x | 1.0 – 1.2 |

---

## 4. 实施建议

### 4.1 分阶段建仓

| 阶段 | 新建仓库 | 说明 |
|------|---------|------|
| **P0** | `apitest-server` + `apitest-web` | 同时搭建 OpenAPI codegen 流水线 |
| P1–P3 | — | 仅在既有两仓迭代 |
| **P4** | `apitrack-sdk-python` | 需先冻结上报协议 v1.0 |
| **P4.5** | `apitest-runner` | 需先冻结 Worker 协议 v1.0 |

### 4.2 前后端拆仓的取舍

**建议拆分**: 前后端由不同人/团队负责、发布节奏不同、需独立灰度、权限需隔离。

**建议暂缓**: 小团队全栈开发、P0–P1 接口频繁变动、不愿维护 codegen 流水线。

**折中路径** (推荐拿不准时采用)

```
P0–P1: 先 monorepo，但强制 apps/web 只通过 packages/api-client 访问后端
P2+:   接口稳定后拆出 apitest-web，api-client 换成 OpenAPI codegen
```

关键在于**从第一天守住边界**：前端绝不 import 后端内部代码，只走 HTTP。守住这条，物理上放哪个仓库随时可调整；反向（多仓合并）成本则高得多。

### 4.3 风险提示

| 风险 | 影响 | 缓解 |
|------|------|------|
| 契约漂移 | 前后端字段不一致，运行时报错 | OpenAPI codegen + CI 契约检测 |
| SDK 版本碎片 | 老版本 SDK 上报失败 | 协议只增不改 + 长期支持历史版本 |
| Runner 版本滞后 | 自托管 Runner 无法领取任务 | 平台支持 N / N-1 双版本 + 兼容矩阵 |
| 跨仓改动成本 | 加字段需多仓提 PR | 契约先行；高频变动期先不拆 |

---

## 5. 附录: 仓库职责速查

| 能力 | server | web | sdk | runner |
|------|:------:|:---:|:---:|:------:|
| 业务 CRUD / 鉴权 | ● | | | |
| 接口模式 DAG 执行 | ● | | | |
| Cron 调度 / Webhook | ● | | | |
| 上报接收 / 对账 / 覆盖计算 | ● | | | |
| Runner 编排 / 日志中转 / 报告归一化 | ● | | | |
| 页面交互 / deep-link / i18n | | ● | | |
| 用例标记 / 请求采集 / 批量上报 | | | ● | |
| 沙箱执行 / git 拉取 / 日志流 / 产物上传 | | | | ● |
| 零侵入覆盖率捕获代理 | | | | ● |
