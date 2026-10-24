# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# apitest-runner 镜像
#
# runner 主动外连平台（长轮询领任务），clone 仓库、跑用户脚本、推日志、报终态。
# 运行时硬前置：
#   - git         每个 job 都要 clone（index.ts:34 启动即探测 git --version，缺则退出）
#   - POSIX shell  任务 steps 是 shell 脚本（镜像用 /bin/sh，bash 也在）
#   - ssh(可选)    仅 ssh_key 仓库需要；缺了不致命
#   - ca-certs     连平台 HTTPS
#
# 容器档（把测试跑进独立容器）注意事项，详见 DOCKER_DEPLOY.md：
#   - **默认即支持容器档**：镜像默认带 docker CLI，DIND 默认豁免，挂上宿主 socket 即可
#     跑容器任务。
#   - runner 在容器里时，挂宿主 /var/run/docker.sock → 测试容器是宿主上的「兄弟容器」，
#     隔离是共享宿主级别（假隔离）。追求真隔离时把 runner 部署在宿主机上，
#     或设 APITRACK_RUNNER_ALLOW_DIND=no 只跑进程档。
#   - cli 通道需要镜像内有 docker 可执行文件（默认已装）；api 通道
#     （APITRACK_RUNNER_DOCKER_TRANSPORT=api）只连 socket，也无需 CLI，两者都可用。
#   - 挂载路径要两边对齐：APITRACK_RUNNER_DATA_DIR 必须是宿主真实路径，且以相同绝对
#     路径挂进本容器，否则宿主 daemon 解析 bind 源找不到 workspace，job 失败。
# ─────────────────────────────────────────────────────────────────────────────

# docker CLI 的来源镜像（只取其中的静态二进制，带默认值，内网仓库可用
# --build-arg DOCKER_CLI_IMAGE=... 覆盖）。必须声明在第一个 FROM 之前才能被所有阶段看到。
ARG DOCKER_CLI_IMAGE=docker:27-cli
FROM ${DOCKER_CLI_IMAGE} AS docker-cli-src

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ── 全量依赖（含 devDeps：tsc 编译需要） ─────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── 编译 TypeScript → dist ────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ── 仅生产依赖（runner 无运行时依赖，这步基本为空，但保持一致的多阶段结构） ──
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ── 运行镜像 ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production

# 运行时硬前置 + 干净的信号处理(tini)。ssh 供 ssh_key 仓库用；不用可自行精简。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# 容器档默认可用：cli 通道需要镜像内有 docker 可执行文件，所以**默认装上**（约定「默认
# 即支持容器档」）。只跑进程档、想缩小镜像时用 --build-arg INSTALL_DOCKER_CLI=false 关掉，
# 或部署时 APITRACK_RUNNER_DOCKER=off。
#
# CLI 来源：从官方 `docker:27-cli` 镜像 COPY 它的静态 `/usr/local/bin/docker`（约 40MB，
# 无 glibc 依赖，已验证可在 bookworm-slim 运行）。**不用** `apt install docker.io`：那个包
# 会拖进 containerd/runc/daemon，镜像凭空胖几百 MB，而 Runner 只需要一个客户端。
# 也不走 `download.docker.com` apt 源：那台在受限网络里常被挡（本环境实测
# `curl: (35) SSL_ERROR_SYSCALL`），构建会直接失败。内网仓库可用 DOCKER_CLI_IMAGE 覆盖。
ARG INSTALL_DOCKER_CLI=true
COPY --from=docker-cli-src /usr/local/bin/docker /tmp/docker-cli-bin
RUN if [ "$INSTALL_DOCKER_CLI" = "true" ]; then \
      install -m 0755 /tmp/docker-cli-bin /usr/local/bin/docker; \
    fi \
 && rm -f /tmp/docker-cli-bin

WORKDIR /app

# dataDir：默认落到独立卷路径（而非 $HOME/.apitrack-runner），便于挂载对齐。
ENV APITRACK_RUNNER_DATA_DIR=/var/lib/apitrack-runner
RUN mkdir -p /var/lib/apitrack-runner && chown -R node:node /var/lib/apitrack-runner

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist          ./dist
COPY --chown=node:node package.json ./

USER node
VOLUME ["/var/lib/apitrack-runner"]

# tini 作 PID 1：把 SIGTERM 正确转给 node，触发 runner 的优雅停机（丢租约/等在跑的 job）。
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
