# 问题记录 — Windows 启动时 `minio/mc:latest` 拉不到

- 阶段：2026-09-17，Windows 环境首次起基建（`docker compose -f apitest-server/compose.yaml up`）。
- 涉及：`apitest-server/compose.yaml` 的 `minio` / `minio-init` 两个服务。

## 现象

Windows 上起 postgres/redis/minio 时，`minio-init` 拉 `minio/mc:latest` 报
`manifest unknown`（镜像根本找不到），基建起不来。

## 根因

不是本仓库配置写错，是上游把镜像下架了：MinIO 社区版 **2025-10-23 起停止向
Docker Hub / Quay 发布容器镜像**，2026-02 上游仓库归档；`minio/mc` 的标签在多数
环境已不可拉取。`minio-init` 依赖 `minio/mc` 来建桶，所以它是这次启动失败的直接
原因。而 `minio/minio` 服务镜像本身自带 `mc`（`/usr/bin/mc`，实测镜像内
`mc RELEASE.2025-08-13T08-35-41Z`），原本的 healthcheck `mc ready local` 用的就是它
——同一个镜像里已经有 mc，`minio/mc` 这个独立服务是多余的。

## 修法

`minio-init` 改用 `minio/minio`（与 `minio` 服务同一个 `MINIO_IMAGE`），桶初始化命令
`mc alias set` + `mc mb --ignore-existing` 一字不改——只是让 `mc` 从已在用的镜像里来。
两个服务都走 `MINIO_IMAGE` 变量（默认 `minio/minio:latest`），内网镜像仓库 / 自建 tag
或要固定版本时用 `MINIO_IMAGE=... docker compose up -d` 覆盖，不用改文件。

顺带：本次一并补齐 Windows 版启动脚本（见 `AGENTS.md` 的 Start / Stop Services）；
那把 `start.ps1` / `stop.ps1` 也不依赖 `minio/mc`，它继承修好后的 compose。

## 状态

已修（2026-09-17，`apitest-server/compose.yaml`）。`docker compose config` 渲染通过；
真实拉起（需要能拉到 `minio/minio`）由用户在 Windows 上验证。
