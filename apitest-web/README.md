# apitest-web

ApiTrack 接口自动化平台的**前端 SPA**。覆盖接口管理、用例 / 套件、DAG 流程编排、Mock、
数据源、报告与看板、系统管理等全部界面，简体中文 / English 双语。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React 18 + TypeScript 5 |
| 构建 | Vite 5 |
| UI 组件 | Ant Design 5（`theme.ts` 做 palette + antd bridge） |
| 流程画布 | React Flow（`@xyflow/react`） |
| 代码 / 脚本编辑 | Monaco（`@monaco-editor/react`） |
| 状态管理 | Zustand（`src/stores`） |
| 路由 | React Router 6 |
| HTTP | axios（`src/api.ts` 统一 API 层 + JWT 拦截器） |
| i18n | i18next / react-i18next |
| 图标 / 字体 | lucide-react；Inter + JetBrains Mono（自托管 `@fontsource`） |
| 校验 | Ajv（断言 JSON Schema）、YAML |

**视觉契约（Quiet Console）**：设计系统锁定，令牌唯一来源为 `src/design-system.css`
（token）、`src/ui.tsx`（基础组件）、`src/theme.ts`（配色 + antd 桥接）；不要在页面里
现造样式或引入第二套视觉方向，规则见 `quiet-console` 技能。

## 功能概览

- **接口模式**：接口 / 接口用例 / 文本用例、测试套件、断言配置器（JSON Schema + 自定义脚本）、
  环境与变量、请求工作台与批量调试。
- **流程编排**：DAG 画布（循环容器、并发请求、子流程、条件、脚本、等待、数据库节点），
  节点级变量注入与单步调试，执行流 SSE 实时日志。
- **仓库模式**：仓库接入、Git 凭证、CI 任务定义与编辑、Runner 池面板、执行详情与报告包。
- **报告与统计**：统一执行索引、趋势与看板、告警规则与渠道、接口覆盖率、产物下载。
- **平台能力**：项目管理与成员 / 权限、可见性与申请审批、资产版本历史、个人中心、
  用户级 API 凭证 / MCP Token、`/docs` 功能说明。
- **站内助手**：对话视图、provider 管理、proposal 确认工作流。
- **系统管理**：用户、助手 provider、接口来源、执行分区与归档等（系统管理员）。

## 目录结构

```
src/
  api.ts              统一 API 层（axios 实例、各域接口、类型）
  ui.tsx              设计系统基础组件（表格、空态、Tip 等）
  design-system.css   设计令牌（唯一来源）
  theme.ts            配色 + antd 桥接
  components/         各功能域页面与组件
  stores/             Zustand 状态
  hooks/              复用 hooks
  lib/                工具（含 API 基址等）
  i18n.ts             国际化资源
public/docs/          /docs 功能说明截图
deploy/               容器反代模板（nginx.container.conf.template）
```

## API 地址与同源转发

前端默认走**同源相对路径 `/api/v1`**：开发由 Vite dev server 代理、生产由 nginx 反代到后端，
避免跨源、不依赖后端 CORS。`VITE_API_BASE_URL` 只在「双域名且不反代」时才需要设成绝对地址
（构建时内联进 bundle，见 `src/api.ts` 的 `configuredApiBaseUrl()`）。

## 环境变量

见 `apitest-web/.env.example`：

| 变量 | 作用 |
|---|---|
| `VITE_API_BASE_URL` | 可选。设了才直连该绝对地址（双域名不反代）；**留空 / 未设即同源 `/api/v1`** |
| `VITE_DEV_API_PROXY_TARGET` | 仅 dev server：`/api` 代理目标（默认 `http://localhost:3000`），不进 bundle |

## 本地开发

```bash
pnpm install
pnpm dev        # Vite dev server，默认 :5173，/api 代理到 :3000
pnpm check      # tsc -b --pretty false
pnpm build      # 产出 dist/
```

仓库根的 `./start.sh` 会连同后端一起把前端 dev server 拉起（`http://localhost:5173`）。

## Docker 部署

多阶段构建：node 构建 `dist/` → nginx 镜像托管静态产物并**同源反代** `/api`、`/mock|/mcp|/ingest`
到后端。反代模板 `deploy/nginx.container.conf.template` 的 `upstream` 地址来自环境变量
`BACKEND_UPSTREAM`，由 nginx 官方镜像入口用 `envsubst` 在启动时注入，因此**运行期换后端不必重建镜像**。
容器内只 `listen 80`，TLS 交给外层（宿主 nginx / LB / ingress）终结。

### 构建

```bash
# 推荐：同源反代（API 地址运行期由 nginx 注入，无需 build-arg）
docker build -t apitest-web:latest apitest-web

# 仅「双域名且不反代」才把绝对地址编译进 bundle：
docker build -t apitest-web:latest \
  --build-arg VITE_API_BASE_URL=https://api.example.com/api/v1 apitest-web
```

> `VITE_API_BASE_URL` 是**构建期**参数（vite build 内联），不是运行时 env。

### 运行

```bash
docker run -d --name web --network apitest-net \
  -e BACKEND_UPSTREAM=api:3000 \
  -p 8080:80 apitest-web:latest
```

- `BACKEND_UPSTREAM` 默认 `host.docker.internal:3000`（后端在宿主机）；后端在同网络其它容器时
  用容器名，如 `api:3000`。容器名需与实际一致，或给后端加该网络别名。
- 浏览器访问 `http://<宿主IP>:8080`。生产建议前面再套一层网关终结 TLS。
- 完整单机部署（后端 + runner + 中间件编排）见根仓库 `DOCKER_DEPLOY.md`。