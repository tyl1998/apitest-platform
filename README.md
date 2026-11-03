# ApiTrack — 接口自动化平台

ApiTrack 是一个一体化 API 测试与编排平台：接口管理、用例与套件、DAG 流程编排、断言与变量、Mock、定时调度、Webhook、报告与趋势、告警、MCP Server、站内 AI 助手，以及「测试代码留在自己仓库」的仓库模式（上报式 SDK + 自研 Runner）。

后端、前端、Runner 与 SDK 在同一个 monorepo 里，文档在 `docs/`。

## 目录

```
.
├── apitest-server/        # 后端：API + 执行 Worker + 调度器（Fastify + TypeScript + PostgreSQL/Redis/S3）
├── apitest-web/           # 前端 SPA（Vite + React 18 + antd + React Flow + Monaco）
├── apitest-runner/        # 自研 CI Runner：主动外连领任务，进程档 / 容器档，可自托管
├── apitrack-sdk-python/   # 上报式采集 SDK（pip install apitrack-sdk）
├── docs/                  # 设计规格、开发计划、协议文档、缺陷记录
├── start.sh / stop.sh     # 一键启动 / 停止四个应用进程（POSIX）
└── start.ps1 / stop.ps1   # Windows 同等脚本
```

## 两条执行范式

| 模式 | 说明 | 面向 |
|---|---|---|
| **接口模式** | 接口、用例、流程、断言全部存平台，由平台内部 Worker 执行 | 测试 / 业务人员 |
| **仓库模式** | 测试代码留在自己的 Git 仓库，平台不持有代码 | 开发者 |

仓库模式有两条接入路径，结果统一归一到同一份执行索引：

- **上报式（SDK）**：`pip install apitrack-sdk`，配两个环境变量，`pytest` 命令不变，跑完把用例结果归位到「系统 → 接口 → 用例」树。
- **CI 任务（Runner）**：平台 Runner 主动外连领取任务 → clone → 沙箱执行 → 推日志 → 上报终态，不依赖 Jenkins，可自托管（只需出站 443）。

## 快速开始

环境要求：Node.js ≥ 20、pnpm、Python ≥ 3.9（仅 SDK）、Docker 或本机运行的 PostgreSQL + Redis。

```bash
# 依赖：在各子项目目录里各自安装一次
(cd apitest-server && pnpm install)
(cd apitest-web && pnpm install)
(cd apitest-runner && pnpm install)

./start.sh                        # 跑迁移并启动 API(3000) + Worker + Scheduler + Web(5173)
./start.sh --restart api worker   # 后端改动后只重启服务端进程
./stop.sh                         # 停止全部进程
```

Windows 用 `start.ps1` / `stop.ps1`（或双击 `start.cmd` / `stop.cmd`）。

各服务的环境变量模板：`apitest-server/.env.example`、`apitest-runner/.env.example`、`apitest-web/.env.example`。Postgres / Redis 是外部依赖，`apitest-server/compose.yaml` 提供了本地起容器的样例。

## 核心能力

- **接口与流程**：接口分组、用例与断言、套件、DAG 流程（循环容器 / 并发 / 子流程）、环境与变量、数据库节点、Mock、单步调试
- **调度与通知**：Cron 调度、Webhook 触发、告警与站内通知
- **报告与监控**：统一执行索引、趋势看板、接口覆盖率、报告分享、测试级日志与产物下载
- **MCP Server**：无状态 `/mcp` 端点 + 项目级 / 用户级 Token，外部 AI 工具可读写接口、用例、流程
- **站内助手**：provider 化的上游协议配置（建会话 / SSE / 停止 / 历史 + 事件映射），「AI 起草、人确认」的提案工作流
- **权限与审计**：RBAC 四角色、项目资源隔离、审计日志、操作人与触发人追溯
- **中英双语**：i18n

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/API_AUTOMATION_SPEC.md`](docs/API_AUTOMATION_SPEC.md) | 技术规格：范围、架构、数据模型、技术选型 |
| [`docs/REPOSITORY_ARCHITECTURE.md`](docs/REPOSITORY_ARCHITECTURE.md) | 模块划分与跨模块协议、兼容矩阵 |
| [`docs/FRONTEND_INTERACTION_DESIGN.md`](docs/FRONTEND_INTERACTION_DESIGN.md) | 前端交互设计 |
| [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md) / [`docs/DEVELOPMENT_PLAN_P6-P14.md`](docs/DEVELOPMENT_PLAN_P6-P14.md) | 开发计划与实现状态 |
| [`docs/DOCKER_DEPLOY.md`](docs/DOCKER_DEPLOY.md) | 容器化部署 |
| [`docs/智能体平台-第三方接入接口文档.md`](docs/智能体平台-第三方接入接口文档.md) | 第三方 agent 平台接入契约 |
| [`docs/issue_fix/`](docs/issue_fix/README.md) | 缺陷记录（现象 / 根因 / 修法 / 状态） |

## 部署与开发文档

部署相关的文档分布在两个层级，按需跳转：

| 主题 | 文档 |
|---|---|
| 全局容器化部署（拓扑、镜像、反代、数据卷） | [`docs/DOCKER_DEPLOY.md`](docs/DOCKER_DEPLOY.md) |
| 后端三进程：环境变量、本地开发、镜像构建与运行 | [`apitest-server/README.md`](apitest-server/README.md#docker-部署) |
| 前端 SPA：API 地址与同源反代、镜像构建与运行 | [`apitest-web/README.md`](apitest-web/README.md#docker-部署) |
| Runner：自托管部署、安全边界、容器档两条通道 | [`apitest-runner/README.md`](apitest-runner/README.md#部署) |
| Runner 镜像（Docker 构建 / 运行） | [`apitest-runner/README.md`](apitest-runner/README.md#docker-部署) |
| SDK：接入三步、环境变量、发布流程 | [`apitrack-sdk-python/README.md`](apitrack-sdk-python/README.md#接入三步测试代码一行都不改) |
| 本地一键启动 / 停止 | 本文「快速开始」+ [`docs/AGENTS.md`](docs/AGENTS.md#start--stop-services)「Start / Stop Services」 |
| 第三方 agent 平台接入 | [`docs/智能体平台-第三方接入接口文档.md`](docs/智能体平台-第三方接入接口文档.md) |
| 缺陷记录索引 | [`docs/issue_fix/README.md`](docs/issue_fix/README.md) |

## 许可

[MIT](LICENSE)。可自由使用、修改与分发。
