# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# apitest-web 镜像：多阶段（node 构建 → nginx 托管静态 + 同源反代）
#
# ⚠️ 前端 API 地址是「编译时」决定的：src/api.ts 里 BASE_URL = VITE_API_BASE_URL
#    ?? "/api/v1"，且 VITE_API_BASE_URL 会在 `vite build` 时内联进 bundle，构建完
#    无法再改。所以它是 build ARG，不是运行时 env。
#
#    推荐（同源反代）：不传 VITE_API_BASE_URL → 前端发相对 /api/v1，由本镜像内置的
#    nginx 反代到后端（后端地址运行时用 BACKEND_UPSTREAM 注入）。这样运行期可换后端，
#    不必重建前端。
#
#    仅「双域名且不反代」才需要：--build-arg VITE_API_BASE_URL=https://api.example.com/api/v1
#    此时 api.ts:3055 等处「复制给外部的地址」也会用这个绝对地址，端口才正确。
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# 编译时前端 API 根地址：默认留空 → 走同源相对路径 /api/v1（配合下方 nginx 反代）。
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

COPY . .
RUN pnpm build

# ── 托管镜像：nginx + 静态产物 + 同源反代模板 ────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# vite build 产物（默认输出到 dist/）
COPY --from=build /app/dist /usr/share/nginx/html

# 反代模板：nginx 官方镜像入口会用 envsubst 把 ${BACKEND_UPSTREAM} 注入后
# 输出到 /etc/nginx/conf.d/default.conf（$host/$uri 等非环境变量不被替换）。
RUN rm -f /etc/nginx/conf.d/default.conf
COPY deploy/nginx.container.conf.template /etc/nginx/templates/default.conf.template

# 后端地址默认指向宿主机；跨机部署时 docker run -e 覆盖。
ENV BACKEND_UPSTREAM=host.docker.internal:3000

EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

# 用 nginx 官方入口（负责 envsubst 模板后再启动 nginx）
CMD ["nginx", "-g", "daemon off;"]
