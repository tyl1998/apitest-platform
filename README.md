# ApiTrack — 接口自动化平台

> 接口自动化平台（ApiTrack）的**开发记录仓库**：承载平台的设计规格、开发计划、跨仓协议、缺陷记录与一键启动脚本。平台代码按仓库边界拆分、各自独立提交与发布，见[仓库结构](#仓库结构)。

## 项目简介

ApiTrack 是一个面向 API 测试与编排的一体化自动化平台，覆盖接口管理、流程编排、断言验证、报告监控、定时调度、Mock 服务、MCP 工具集成、数据源连接、用例与测试套件等核心能力，同时服务开发者与测试 / 业务人员。

平台提供**两条平行、互不替代**的测试执行范式，可在同一项目中按需选用甚至混用：

| 模式 | 说明 | 适用人群 |
|---|---|---|
| **接口模式（平台托管）** | 接口、用例、流程、断言、参数全部定义并存储在平台内，由平台内部 Worker 引擎可视化 / 低代码执行 | 测试 / 业务人员 |
| **仓库模式（代码仓库 / CI）** | 测试逻辑留在开发者自己的 Git 仓库，平台不持有测试代码 | 开发者 |

仓库模式进一步拆为两个独立能力：

- **仓库用例（上报式）**：`pip install apitrack-sdk` + 两个环境变量，测试代码一行不改、`pytest` 命令不变；跑完经唯一上报接口把用例归位到「系统 → 接口 → 用例」树，并做 commit 快照合并 / 去重 / 删除对账。
- **CI 任务（自研 Runner 执行）**：平台自研轻量 Runner 主动外连领取任务——clone 仓库 → 沙箱运行用户脚本 → 按 offset 推日志 → 上报终态，不依赖 Jenkins，可自托管到客户内网（只需出站 443）。

两种模式仅在**报告与监控层归一**：通过 `ExecutionIndex` 统一执行索引聚合通过率、趋势、告警与覆盖率。

## 核心特性

- **接口模式**：接口管理 / 用例与套件 / DAG 流程编排（循环容器、并发请求、子流程）/ 断言与变量注入 / Mock 服务 / 数据库节点（参数化绑定防注入）/ 定时调度（Cron）/ Webhook 触发 / 单步调试
- **仓库模式**：上报式用例对账（范围内全量 + 跟踪分支双闸门删除对账、路径归一与未匹配诊断）/ 自研 Runner（进程档与容器档、资源限额、出站白名单、secret 日志脱敏、崩溃恢复、依赖缓存、JUnit / Allure 报告解析、产物直传对象存储）
- **零改动接入 SDK**：`apitrack-sdk`（Python ≥ 3.9，零运行时依赖，pytest 插件自动加载，支持 `requests` / `httpx` / `pytest-xdist`，已发布 PyPI）
- **报告与监控**：统一执行索引、趋势与数据统计看板、告警、接口覆盖率、测试级日志与产物下载
- **MCP Server**：平台作为 MCP Server 对外暴露（无状态 `/mcp` 端点 + 项目级 / 用户级 Token），外部 AI / 工具可驱动平台创建与读取接口、用例、流程
- **站内助手**：provider 化的站内助手（多 provider、加密 Key、SSE 流式），「AI 起草、人确认」的 proposal 工作流
- **用户与权限**：RBAC 四角色、项目资源隔离、审计日志（操作 + 触发人）、个人中心与用户级 MCP Token
- **多语言**：简体中文 / English（i18n）

## 仓库结构

| 仓库 | 语言 / 形态 | 职责 |
|---|---|---|
| `apitest-server` | Node.js + TypeScript | 平台核心（API + Worker + Scheduler），Fastify + PostgreSQL / Redis / 对象存储 |
| `apitest-web` | React 18 + TypeScript | 前端 SPA（Vite + antd + React Flow + Monaco） |
| `apitrack-sdk-python` | Python（≥ 3.9） | 上报式采集 SDK，PyPI 分发名 `apitrack-sdk`（已发布 v0.1.x） |
| `apitest-runner` | Node.js（≥ 20） | 自研 CI Runner，可自托管（进程档 / 容器档） |
| `apitest-e2e-python` | Python | 平台接口 e2e 自动化测试（pytest + requests） |
| **本仓库** | Markdown / 脚本 | 开发记录：规格、计划、协议、缺陷记录、启动脚本 |

> 代码仓库均各自独立提交与发布，不提交在本仓库内；本仓库的 `.gitignore` 已忽略它们。

## 技术栈

- **后端**：Fastify 5 + TypeScript，raw 参数化 `pg` SQL（无 ORM），BullMQ + Redis 任务队列，PostgreSQL，S3 兼容对象存储
- **前端**：React 18 + Vite + antd + React Flow + Monaco + i18next，API 层由 OpenAPI codegen 契约驱动
- **Runner**：Node.js ≥ 20，零运行时依赖；进程档 / 容器档双通道，iptables 出站 deny
- **SDK**：Python ≥ 3.9，零运行时依赖，pytest 插件 + 传输层打桩（`requests` / `httpx`）

## 跨仓协议

| 协议 | 跨越 | 方向 | 兼容要求 |
|---|---|---|---|
| REST API | server ↔ web | web 主动（JWT） | 前后端同步发布 |
| Worker 协议 | server ↔ runner | runner 主动（`apirunner_…` Token） | 平台支持 N / N-1 双版本 |
| 上报协议 | server ↔ sdk | sdk 主动（`apitrack_…` Token） | 最严格：只增不改，长期支持历史版本 |

## 开发状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0–P3 | 平台底座 / 接口模式（用例、套件、流程、Mock、调度、报告） | ✅ 已实现并通过验收 |
| P4 | 仓库模式·上报式用例（`apitrack-sdk`，PyPI v0.1.0） | ✅ 已实现并通过验收 |
| P4.5 | 自研 CI Runner（进程 / 容器档） | ✅ 已实现并通过验收 |
| P5 | 平台作为 MCP Server 对外暴露 | ✅ 已实现并通过验收 |
| P6–P8 | 用户与权限 / 测试管理 / 数据统计 | ✅ 已实现（P8 暂记验收通过） |
| P9 | 站内助手（provider 化 + proposal 工作流） | ✅ 已实现（待手工验收） |
| P10 | 性能 / 版本（大响应体转存对象存储、执行历史分区、版本历史、前端列表优化） | 🔄 进行中（P10-1 / P10-8 已实现） |
| P11 | 资产归属（`created_by` / `updated_by` + 审计日志 + 触发人） | ✅ 已实现（待验收） |
| P12 | 个人中心 + 用户级 MCP Token | ✅ 已实现（待验收） |
| P13 | 新手教程 | 📝 已立项，待实现 |
| P14 | 项目可见性两层 + 权限申请审批流 | 📝 已立项，待实现 |

## 文档索引

| 文档 | 说明 |
|---|---|
| `API_AUTOMATION_SPEC.md` | 技术规格说明书（范围、架构、数据模型、技术选型） |
| `FRONTEND_INTERACTION_DESIGN.md` | 前端交互设计（信息架构、页面规格、设计约束） |
| `REPOSITORY_ARCHITECTURE.md` | 仓库划分与跨仓协议（协议契约、兼容矩阵） |
| `DEVELOPMENT_PLAN.md` | 开发计划（P0–P5，含实现状态与验收记录） |
| `DEVELOPMENT_PLAN_P6-P14.md` | P6–P14 阶段规划（范围、边界、迁移、批次、验收门槛） |
| `issue_fix/` | 缺陷记录（现象 / 根因 / 修法 / 状态） |
| `智能体平台-第三方接入接口文档.md` | 第三方 agent 平台接入契约 |

## 快速开始

平台由四个应用进程组成（后端 API / 执行 Worker / 调度器 / 前端 Web），PostgreSQL 与 Redis 为外部依赖（本地 docker 或手动启动的服务）。

```bash
./start.sh                        # 跑迁移并启动全部服务（API 3000 / Web 5173）
./start.sh --restart api worker   # 后端改动后只重启服务端进程
./stop.sh                         # 停止全部进程
```

Windows 使用 `start.ps1` / `stop.ps1`（或双击 `start.cmd` / `stop.cmd`）。

各子仓的接入、部署与开发说明见对应仓库 README：`apitrack-sdk` 的零改动接入与发布流程、`apitest-runner` 的自托管部署与安全边界、`apitest-e2e-python` 的测试运行方式。
