# Docker 单机部署（独立容器，不使用 compose）

本文档说明如何用独立的 `docker build` / `docker run` 部署四类应用进程 + runner，**不依赖 docker compose**。中间件（Postgres / Redis / 对象存储）为外部依赖，可自备，也可用文末的独立 `docker run` 拉起。

镜像清单：

| 组件 | Dockerfile | 说明 |
|---|---|---|
| 后端 | `apitest-server/Dockerfile` | 一个镜像，跑三种角色：API(3000) / worker / scheduler；迁移也用它 |
| 前端 | `apitest-web/Dockerfile` | node 构建 → nginx 托管静态 + 同源反代到后端 |
| runner | `apitest-runner/Dockerfile` | 主动外连平台的 CI runner |

> 公共仓库纪律：本文所有域名、密钥均为占位符（`example.com` / `ak-xxx` / `change-me-*`）。真实值只在部署机的 env 里填，不要写进仓库。

---

## 0. 先建一个用户自定义网络（替代 compose 的服务发现）

不用 compose 时，容器之间靠 **同一个用户自定义 bridge 网络 + `--name`** 互相用名字解析（默认 bridge 网络不提供 DNS，必须自建）：

```bash
docker network create apitest-net
```

之后所有容器都加 `--network apitest-net`，就能用容器名互访（如 `postgres:5432`、`api:3000`）。

---

## 1. 中间件（外部依赖）

已有 Postgres / Redis 就跳过这节，直接把连接串填进第 3 步。没有就用独立容器拉起：

```bash
# Postgres
docker run -d --name postgres --network apitest-net \
  -e POSTGRES_USER=apitest \
  -e POSTGRES_PASSWORD=change-me-db \
  -e POSTGRES_DB=apitest \
  -v apitest-pg:/var/lib/postgresql/data \
  -p 5432:5432 \
  postgres:16-alpine

# Redis（开 AOF：队列是「已受理未执行」的唯一凭据，RDB 硬重启会丢最后几秒入队的 job）
docker run -d --name redis --network apitest-net \
  -v apitest-redis:/data \
  -p 6379:6379 \
  redis:7-alpine redis-server --appendonly yes
```

对象存储（仅 `ARTIFACT_STORAGE_DRIVER=s3` 时需要）用 MinIO：

```bash
# MinIO（9000 = S3 API，9001 = 控制台）
docker run -d --name minio --network apitest-net \
  -e MINIO_ROOT_USER=apitest \
  -e MINIO_ROOT_PASSWORD=change-me-minio \
  -v apitest-minio:/data \
  -p 9000:9000 -p 9001:9001 \
  minio/minio:latest server /data --console-address ":9001"
```

> 用 `minio/minio` **一个镜像**就够：它自带 `mc`（`/usr/bin/mc`），下面的建桶用它。
> 不要依赖 `minio/mc` 镜像——社区版 2025-10 起停发、2026-02 上游归档，`minio/mc:latest`
> 多数环境拉取即 `manifest unknown`。要固定版本可指向最后一个公开发布版
> `minio/minio:RELEASE.2025-09-07T16-13-09Z`。内网仓库自建 tag 直接替换镜像名即可。

建桶（一次性，幂等，桶名与后端 `ARTIFACT_S3_BUCKET` 一致）：

```bash
docker run --rm --network apitest-net --entrypoint /bin/sh minio/minio:latest -c "\
  mc alias set local http://minio:9000 apitest change-me-minio && \
  mc mb --ignore-existing local/apitest-artifacts"
```

不需要对象存储时，默认 `fs` 驱动把产物写在后端容器挂载的卷里即可（见第 3、5 步）。

---

## 2. 构建镜像

```bash
# 后端
docker build -t apitest-server:latest apitest-server

# 前端：默认走同源反代（推荐），API 地址运行时由 nginx 注入，无需 build-arg
docker build -t apitest-web:latest apitest-web
#   仅「双域名且不反代」才需要把绝对地址编译进 bundle：
#   docker build -t apitest-web:latest \
#     --build-arg VITE_API_BASE_URL=https://api.example.com/api/v1 apitest-web

# runner：默认不带 docker CLI（容器档用 api 通道即可）；需要 cli 通道时加 build-arg
docker build -t apitest-runner:latest apitest-runner
#   docker build -t apitest-runner:latest --build-arg INSTALL_DOCKER_CLI=true apitest-runner
```

---

## 3. 后端环境变量

后端三个角色（API / worker / scheduler）**共用同一份 env**，用一个 `--env-file` 挂给三者。以下是关键项（完整清单见 `apitest-server/.env.example`）：

```ini
# server.env —— 不要提交进仓库
PORT=3000
DATABASE_URL=postgres://apitest:change-me-db@postgres:5432/apitest
REDIS_URL=redis://redis:6379

# 下面两个密钥必须在 API/worker/scheduler 三个容器间完全一致，且换成随机长串
JWT_SECRET=change-me-jwt-secret
DATA_SOURCE_ENCRYPTION_KEY=change-me-32byte-key

# 反代/外网可达的对外根地址：不设则平台用容器内网 hostname 拼链接，
# 导致 SDK/runner 上报与通知链接指向容器内网打不开
PUBLIC_BASE_URL=https://apitest.example.com

# 产物存储：默认写本地文件系统（挂卷持久化）
ARTIFACT_STORAGE_DRIVER=fs
ARTIFACT_FS_ROOT=/data/artifacts

# —— 或改用 MinIO/S3（见第 1 步）。启用时删掉上面 fs 两行，改用下面这组：——
# ARTIFACT_STORAGE_DRIVER=s3
# ARTIFACT_S3_BUCKET=apitest-artifacts
# ARTIFACT_S3_ENDPOINT=http://minio:9000     # MinIO/自建需填（path-style）；AWS 原生留空
# ARTIFACT_S3_REGION=us-east-1
# 凭证走 AWS SDK 默认链，与 MinIO 的 root 用户/密码一致：
# AWS_ACCESS_KEY_ID=apitest
# AWS_SECRET_ACCESS_KEY=change-me-minio
```

> ⚠️ 用 s3 驱动时,`ARTIFACT_S3_ENDPOINT` 会作为**浏览器下载直链(presignGet)**的主机。
> 若填容器内网名 `http://minio:9000`,浏览器解析不到 → 产物下载失败。跨容器上传用内网名没问题,
> 但要让浏览器能下载,应把 endpoint 设为**浏览器可达**的地址(如 `http://<宿主IP>:9000`,
> 或前面套一层反代/域名)。上传(runner→MinIO)与下载(浏览器→MinIO)对可达性的要求不同,
> 生产建议给 MinIO 一个内外都能解析的地址。

> ⚠️ `JWT_SECRET` / `DATA_SOURCE_ENCRYPTION_KEY` 三进程不一致会导致 JWT 校验失败、数据源解密失败。务必同一份文件。

---

## 4. 跑数据库迁移（一次性）

前向-only 迁移。每次升级、Postgres ready 之后先跑一遍，再起应用：

```bash
docker run --rm --network apitest-net \
  --env-file server.env \
  apitest-server:latest \
  node dist/migrate.js
```

容器跑完即退出；`Applied migration ...` 是正常输出。

---

## 5. 起后端三个进程

三者同镜像、同 env，只有 command 不同。**worker 必须起**——不起的话测试任务会一直停在 `queued`（队列绝不内联进 API 进程）。

```bash
# API（唯一监听端口的进程）
docker run -d --name api --network apitest-net \
  --env-file server.env \
  -v apitest-artifacts:/data/artifacts \
  -p 3000:3000 \
  apitest-server:latest
  # 默认 CMD 即 node dist/index.js

# worker（不监听端口，关掉 healthcheck）
docker run -d --name worker --network apitest-net \
  --env-file server.env \
  -e WORKER_LABELS=default \
  -v apitest-artifacts:/data/artifacts \
  --no-healthcheck \
  apitest-server:latest \
  node dist/worker.js

# scheduler（不监听端口，关掉 healthcheck）
docker run -d --name scheduler --network apitest-net \
  --env-file server.env \
  --no-healthcheck \
  apitest-server:latest \
  node dist/scheduler.js
```

产物用 `fs` 驱动时，API 与 worker 要挂**同一个** `apitest-artifacts` 卷到 `/data/artifacts`，否则一方写、另一方读不到。

---

## 6. 起前端

前端镜像内置 nginx，把 `/api/v1`、`/mock|/mcp|/ingest` 同源反代到后端。后端地址运行时用 `BACKEND_UPSTREAM` 注入：

```bash
docker run -d --name web --network apitest-net \
  -e BACKEND_UPSTREAM=api:3000 \
  -p 8080:80 \
  apitest-web:latest
```

浏览器访问 `http://<宿主IP>:8080`。生产建议在前面再套一层 nginx / LB 终结 TLS（本镜像只 listen 80）。

> 若第 2 步用了 `--build-arg VITE_API_BASE_URL=...` 编译了绝对地址，则前端直连该地址，`BACKEND_UPSTREAM` 反代不再被 SPA 使用（但根路径端点仍可能走它）。二选一，别混着配。

---

## 7. 起 runner

runner 通常部署在被测环境侧，只出站连平台，可与平台不同机。它连的是平台**对外可达**地址（不是容器内网名，除非同网络）。

### 7a. 仅进程档（跑 shell 脚本，不跑测试容器）

最简单，无需 docker socket：

```bash
docker run -d --name runner \
  -e APITRACK_RUNNER_URL=https://apitest.example.com \
  -e APITRACK_RUNNER_TOKEN=apirunner_xxxxxxxx \
  -e APITRACK_RUNNER_LABELS=default \
  -v apitest-runner-data:/var/lib/apitrack-runner \
  apitest-runner:latest
```

### 7b. 容器档（把测试跑进独立容器）

runner 在容器里跑容器 = docker-in-docker。挂宿主 socket 时，**测试容器是宿主上的兄弟容器**（跟 runner 并排，不在 runner 容器内），隔离是共享宿主级别，需显式豁免 DIND 检测。

关键约束（务必满足，否则起得来容器也读不到 workspace）：

- `APITRACK_RUNNER_DATA_DIR` 必须是**宿主真实路径**，并以**相同绝对路径**挂进 runner 容器。因为 bind 挂载源是由宿主 daemon 解析的，runner 写在容器内的 workspace 路径必须在宿主上同名存在。

```bash
# 先在宿主建目录
sudo mkdir -p /srv/apitrack-runner

docker run -d --name runner \
  -e APITRACK_RUNNER_URL=https://apitest.example.com \
  -e APITRACK_RUNNER_TOKEN=apirunner_xxxxxxxx \
  -e APITRACK_RUNNER_LABELS=default \
  -e APITRACK_RUNNER_ALLOW_DIND=yes \
  -e APITRACK_RUNNER_DOCKER_TRANSPORT=api \
  -e APITRACK_RUNNER_DATA_DIR=/srv/apitrack-runner \
  -v /srv/apitrack-runner:/srv/apitrack-runner \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(getent group docker | cut -d: -f3)" \
  apitest-runner:latest
```

说明：
- `APITRACK_RUNNER_DOCKER_TRANSPORT=api` 走 Engine API over socket，镜像无需 docker CLI。要用 `cli` 通道请改这里为 `cli`，并用 `--build-arg INSTALL_DOCKER_CLI=true` 重建镜像。
- `--group-add <docker gid>` 让容器内的非 root `node` 用户能读写宿主 `docker.sock`（socket 通常是 `root:docker`）。
- `APITRACK_RUNNER_ALLOW_DIND=yes` 是承认「共享宿主、隔离是假的」后的显式放行。若追求真隔离，把 runner 直接部署在宿主机上而非容器里。

---

## 8. 验证与运维

```bash
# 后端健康
curl -fsS http://<宿主IP>:3000/health        # {"status":"ok"} 形态

# 容器状态与日志
docker ps
docker logs -f api
docker logs -f worker

# 升级：重建镜像 → 跑迁移 → 重启容器
docker build -t apitest-server:latest apitest-server
docker run --rm --network apitest-net --env-file server.env apitest-server:latest node dist/migrate.js
docker restart api worker scheduler
```

## 常见坑速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 任务一直 `queued` | 没起 worker | 起 worker 容器（第 5 步） |
| 登录后接口 401 / 数据源解密失败 | 三进程 `JWT_SECRET` / `DATA_SOURCE_ENCRYPTION_KEY` 不一致 | 用同一份 `server.env` |
| 前端能开但接口 502 | `BACKEND_UPSTREAM` 指错 / 后端未在同网络 | 确认 `--network apitest-net` 且值为 `api:3000` |
| runner 只跑进程档、不接容器任务 | DIND 检测拦下 / socket 不可达 / 无 docker CLI | 见第 7b（`ALLOW_DIND`、socket、transport/CLI） |
| 容器任务起得来但读不到代码 | dataDir 宿主/容器路径不一致 | 两边用相同绝对路径挂载（第 7b） |
| SDK/runner 回来的链接指向内网打不开 | 未设 `PUBLIC_BASE_URL` | 设成对外可达地址 |
| 产物上传成功但浏览器下载失败(s3) | `ARTIFACT_S3_ENDPOINT` 是容器内网名,浏览器解析不到 | endpoint 设为浏览器可达地址(见第 3 步 s3 注释) |
