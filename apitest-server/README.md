# apitest-server

ApiTrack 接口自动化平台的**后端核心**。一个代码库承载三个进程角色——**API**（HTTP 服务）、
**Worker**（执行引擎）、**Scheduler**（定时调度与告警）——它们共用同一份代码、同一份
环境变量，只是启动命令不同。

## 技术栈

| 层 | 选型 |
|---|---|
| 语言 / 运行时 | TypeScript 5 + Node.js 22（ESM） |
| HTTP 框架 | Fastify 5（`@fastify/jwt` 认证、`@fastify/cors`） |
| 数据库 | PostgreSQL 16，**raw 参数化 `pg` SQL，无 ORM** |
| 队列 | BullMQ 6 + Redis 7（AOF） |
| 加密 | `node:crypto`（scrypt 口令、AES-256-GCM 凭据落库） |
| 校验 / 解析 | Ajv（JSON Schema）、YAML、acorn（脚本沙箱静态检查）、cron-parser |
| 对象存储 | S3 兼容（`@aws-sdk/client-s3`，MinIO / AWS S3；fs 驱动可退化本地目录） |
| 数据源驱动 | `pg` / `mysql2` / `mssql` / `oracledb` / `mongodb` / `ioredis` |
| MCP | `@modelcontextprotocol/server`（平台作为 MCP Server 对外暴露） |
| 报表 | ExcelJS（用例导出）、JUnit / Allure 结果解析 |

**设计取向**：刻意保持薄栈——无 ORM、无校验框架、无 service 层，路由里直接写参数化 SQL 与
响应信封，约束见根仓库 `server-contract` 技能与 `src/lib/response.ts`。

## 功能概览

- **接口模式（平台托管）**：接口管理、接口 / 文本用例、测试套件、DAG 流程编排（循环容器、
  并发、子流程、条件、脚本、等待节点）、断言与变量注入、Mock 服务、数据库节点、定时调度
  （Cron）、Webhook 触发、单步调试。
- **仓库模式**：上报式用例对账（`POST /ingest`，范围内全量 + 跟踪分支双闸门删除对账、
  路径归一）、CI 任务（自研 Runner 协议 `/runner/*`：register / claim / heartbeat / logs /
  complete）、报告包解析与产物对象存储直传 / 下载直链。
- **报告与监控**：统一执行索引（`ExecutionIndex`）、通过率趋势、告警规则与渠道、接口覆盖率、
  执行历史按季分区与归档。
- **平台能力**：RBAC 四角色与项目资源隔离、审计与归属（`created_by` / `updated_by`）、
  资产版本历史、个人中心、用户级 API 凭证 / MCP Token、权限申请审批流。
- **MCP Server**：无状态 `/mcp` 端点 + 项目级 / 用户级 Token，外部 AI / 工具可创建与读取接口、
  用例、流程。
- **站内助手**：provider 化的对话服务（多 provider、加密 Key、SSE 流式）、proposal 工作流。
- **接口来源（Spec Source）**：从外部文档源搜索预填接口，带内网段 / 云元数据地址的出站防护。

## 目录结构

```
src/
  index.ts          API 进程入口（监听 HTTP）
  worker.ts         Worker 进程入口（消费执行队列）
  scheduler.ts      Scheduler 进程入口（cron tick / 漏跑判定 / 告警派发）
  migrate.ts        迁移执行器（一次性）
  db.ts             pg 连接池
  routes/           每个业务域一个路由模块（40+）
  lib/              响应信封、RBAC、jobSpec、crypto、对象存储、MCP、脱敏等
  models/           行 → API 映射类型
migrations/         前向迁移（forward-only），按编号累积的 SQL 文件
```

## 环境变量

以 `apitest-server/.env.example` 为完整清单，关键项：

| 变量 | 说明 |
|---|---|
| `PORT` | API 监听端口（默认 3000） |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `REDIS_URL` | Redis 连接串（API 入队 / worker 消费必须同一实例） |
| `JWT_SECRET` | JWT 签名密钥，生产必改 |
| `DATA_SOURCE_ENCRYPTION_KEY` | 32 字节 AES 密钥（64 hex 或 32 字节 base64），**API / worker / scheduler 三进程必须一致** |
| `WORKER_CONCURRENCY` | 单 worker 在途请求数（默认 10） |
| `WORKER_LABELS` | 该 worker 服务的执行分区（逗号分隔，默认 `default`） |
| `PUBLIC_BASE_URL` | 平台对外根地址，JobSpec 的 `APITRACK_URL` 与通知模板的 `{{reportUrl}}` 用它拼链接 |
| `MCP_ALLOWED_HOSTS` | `/mcp` 的 Host 白名单（DNS rebinding 防护） |
| `ARTIFACT_STORAGE_DRIVER` | `fs`（默认，本地目录）或 `s3` |
| `ARTIFACT_S3_BUCKET` / `ARTIFACT_S3_ENDPOINT` | s3 驱动的桶与端点（MinIO 填 endpoint，AWS 留空） |

> 密钥与业务标识一律走环境变量，仓库内只放占位符；真实值写进 gitignore 的 `.env`，不要提交。

## 本地开发

前置：Node ≥ 22、pnpm、PostgreSQL、Redis（可用仓库根的 `./start.sh` 一并拉起，含迁移）。

```bash
pnpm install
pnpm migrate     # 应用 migrations/*.sql
pnpm dev         # API（tsx watch，热重载，默认 :3000）
pnpm worker      # 另一个终端：执行 Worker
pnpm scheduler   # 另一个终端：调度器
pnpm check       # tsc --noEmit
pnpm build       # 编译到 dist/
```

## Docker 部署

镜像多阶段构建（node 构建 → 只带生产依赖与 `dist/` 的运行层），一个镜像跑三种角色。
运行时**非 root**（node 用户），内置 `GET /health` 健康检查。

### 构建

```bash
docker build -t apitest-server:latest apitest-server
```

### 中间件（外部依赖，可自备）

```bash
docker network create apitest-net

docker run -d --name postgres --network apitest-net \
  -e POSTGRES_USER=apitest -e POSTGRES_PASSWORD=change-me-db -e POSTGRES_DB=apitest \
  -v apitest-pg:/var/lib/postgresql/data -p 5432:5432 postgres:16-alpine

docker run -d --name redis --network apitest-net \
  -v apitest-redis:/data -p 6379:6379 \
  redis:7-alpine redis-server --appendonly yes
```

> 仓库内 `apitest-server/compose.yaml` 也可 `docker compose up -d` 拉起 PostgreSQL / Redis /
> MinIO（含桶初始化），仅作中间件、不跑应用。

### 配置

```bash
cp apitest-server/.env.example apitest-server/.env
# 至少填：DATABASE_URL / REDIS_URL / JWT_SECRET
#        DATA_SOURCE_ENCRYPTION_KEY（三进程一致）
# s3 驱动再填 ARTIFACT_S3_* 与 AWS_* 凭证
```

容器内连接串要指向中间件容器名（如 `postgres:5432` / `redis:6379`），不要写 `localhost`。

### 运行

```bash
# 1) 迁移（一次性，跑完即退出）
docker run --rm --network apitest-net --env-file apitest-server/.env \
  apitest-server:latest node dist/migrate.js

# 2) API（默认 CMD）
docker run -d --name api --network apitest-net \
  --env-file apitest-server/.env -p 3000:3000 apitest-server:latest

# 3) Worker（不监听端口，覆盖 CMD；--no-healthcheck）
docker run -d --name worker --network apitest-net --env-file apitest-server/.env \
  --no-healthcheck apitest-server:latest node dist/worker.js

# 4) Scheduler（不监听端口）
docker run -d --name scheduler --network apitest-net --env-file apitest-server/.env \
  --no-healthcheck apitest-server:latest node dist/scheduler.js
```

若要给同网络里的前端按名字反代，API 容器可加 `--network-alias api`，前端用 `BACKEND_UPSTREAM=api:3000`。

> 执行队列**绝不内联进 API 进程**：没有 worker 在跑时，run 会一直停在 `queued`。
> 完整单机部署（含前端 / runner 与网络编排）见根仓库 `DOCKER_DEPLOY.md`。

## 迁移约定

前向迁移（forward-only）：**永不修改已应用的迁移文件**，改结构就新增一个编号文件。
迁移在 API 启动前由 `migrate` 角色单独执行一次。