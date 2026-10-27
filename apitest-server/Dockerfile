# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# apitest-server 镜像
#
# 一个镜像承载三个进程角色（API / worker / scheduler），它们共用同一份代码与 env，
# 只是启动命令不同。运行时用不同的 command 起三个容器即可（见 DOCKER_DEPLOY.md）：
#   API        : node dist/index.js         （默认 CMD，监听 0.0.0.0:3000）
#   worker     : node dist/worker.js        （不监听端口）
#   scheduler  : node dist/scheduler.js      （不监听端口）
#   migrate    : node dist/migrate.js        （一次性，容器 run 完即退出）
#
# 迁移文件随镜像带入 /app/migrations：migrate.js 用 `new URL("../migrations/")`
# 相对自身解析，dist/migrate.js → /app/migrations，必须存在。
# 同理 data/assistant-providers 随镜像带入 /app/data：seed.js 相对 dist/lib/assistant/
# 往上三级解析。
#
# 基础镜像用 Debian(bookworm-slim) 而非 alpine：依赖里的原生模块
# （oracledb / mssql / mysql2 / mongodb）依赖 glibc 预编译二进制，musl 会拉胯。
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ── 全量依赖（含 devDeps：编译需要 tsc/tsx） ───────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── 编译 TypeScript → dist ────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ── 仅生产依赖（丢掉 devDeps，缩小运行镜像） ──────────────────────────────────
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ── 运行镜像 ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# 非 root 运行（node 基础镜像自带 uid 1000 的 node 用户）
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist          ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
# 助手上游默认清单：启动时按名字「只插不改」预置（src/lib/assistant/seed.ts 相对 dist 解析）。
COPY --chown=node:node data/assistant-providers ./data/assistant-providers

USER node
EXPOSE 3000

# 健康检查命中 GET /health（index.ts 里的 success({status:"ok"})）。
# worker/scheduler 容器不监听端口，用 docker run 覆盖 CMD 时可加 --no-healthcheck。
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 默认角色 = API。worker/scheduler/migrate 在 docker run 时覆盖 command。
CMD ["node", "dist/index.js"]
