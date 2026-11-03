# 问题记录 — CORS 预检未缓存，请求数近乎翻倍

## 现象

用户先是排查 `GET /api/v1/projects/:id/executions/stream` 在浏览器 Network 面板里「耗时很大」，
顺带发现同场景下 API 请求量异常：`.dev-logs/api.log` 里 **2769 个实际请求配了 2385 个 OPTIONS
预检**，几乎一比一，每个业务请求都要多一轮往返。

本项与用户最初的「同机访问卡顿」不同源，不构成卡顿的主因：同机卡顿实测为**本机资源争抢**
（8 核 load 2.7–4.5、Chrome 46 进程 3.5GB、swap 5120MB 已用 4107MB，另加 VS Code / OrbStack /
四个服务进程），服务端 `/health` 120 次采样 p50 0.4ms、p95 1.0ms，另一台机器访问同样流畅。
预检这一项是排查途中确认的真实浪费，单独归档。

## 根因

`apitest-server/src/index.ts` 注册 `@fastify/cors` 时只声明了 `origin` 与 `methods`，**没有
`maxAge`** ⇒ 不下发 `Access-Control-Max-Age`，浏览器只能用 Chrome 的 5 秒默认预检缓存。

而本平台鉴权走 `Authorization` 头（`apitest-web/src/api.ts:2346` 的请求拦截器），**没有任何
业务请求是 simple request**，浏览器对每个 URL 都必须先发 OPTIONS。前端又在 5173、API 在
3000（`.env.local` 的 `VITE_API_BASE_URL`），整站跨源，于是每个 URL 每超过 5 秒就被重新预检：
通知类轮询（30s 一次）每次都要「OPTIONS + 真实请求」，DevTools 打开时这些预检同样被记录，
进一步加重客户端负担。

## 修法

`index.ts` 的 cors 注册补 `maxAge: 600`（10 分钟）——覆盖一次页面会话里对同一 URL 的重复
轮询，又不至于把改过的 CORS 配置在浏览器里滞留太久（Chrome 上限 7200 秒）。注释写进
cors 注册块，与 `methods` 同格说明「为什么是必配项」。

未做同源化改造（vite 代理 `/api`）：该路线要求 `VITE_API_BASE_URL` 改成相对路径，而
`MockList.tsx:36` / `RunnerPoolPanel.tsx:51` / `McpPage.tsx:36` / `RepoCredentials.tsx:32` 四处
都靠它剥出后端源来拼公开地址与产物直链，会连带破坏，不在本次范围内。

## 状态

已修（2026-09-22）。改动只影响响应头，不涉及路由/信封/SQL，未改任何数据形状；API 由
`pnpm dev`（tsx watch）拉起，保存后自重启生效，未由本记录代跑重启与验收。
