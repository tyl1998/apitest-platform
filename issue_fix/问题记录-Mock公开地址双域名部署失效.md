# 问题记录 — Mock 公开地址在双域名部署下生成错误域名

## 背景（部署拓扑）

公司内网双域名：办公网浏览器经**域名 A** 访问前端页面，后端 API 只在**域名 B** 上可达
（办公网浏览器可直达 B，跨域由 `@fastify/cors` `origin: true` 放行，SSE 的 CORS 头已在
P1-3 修法里手动搬进 `writeHead`）。前端构建期烧死 `VITE_API_BASE_URL=https://<B>/api/v1`。

## 现象

Mock 列表「复制公开地址」在双域名部署下复制出 `https://<A>:3000/mock/...`——域名是页面
所在的 A，端口是硬编码猜出来的 3000。外部联调方拿到地址无法访问（A 上没有 mock 服务，
端口也不对）；该地址只在本地开发（页面 5173、API 3000、同主机）成立。

## 根因

`MockList.tsx` 的 `copy()` 用 `window.location.origin.replace(/:\d+$/, ":3000")` 推导
mock 服务的源。这个猜法假设「页面与 API 同主机、只差端口」，部署到双域名环境即失效——
mock 路由（`/mock/:publicId/*`，本仓库唯一外部可直接调用的先例）挂在 API 进程上，源应该
跟 API 走，而不是跟页面走。同文件其余三处 API 地址（`RepoCredentials` / `RunnerPoolPanel`
/ `McpPage`）都已是 `VITE_API_BASE_URL` 优先，唯独这里漏了。

## 修法

`MockList.tsx` 新增 `mockPublicOrigin()`：优先从 `VITE_API_BASE_URL` 剥掉尾部 `/api/v1`
得到后端源（`https://<B>/api/v1` → `https://<B>`），未配置或剥完为空时回退原来的
「同域名换 3000 端口」开发猜法。`copy()` 改用该函数。`.env.example` 补注释说明生产
双域名部署的取值。

## 状态

已修（2026-09-11），待用户在双域名环境实测复制出的地址可访问。

## 伴生部署结论（备查，其中一项当日升级为缺陷）

同轮梳理确认的部署口径：`PUBLIC_BASE_URL` 填 B 时，产物直链 / JobSpec `APITRACK_URL` /
`/mcp` Host 白名单三类消费者全部正确。通知模板 `{{reportUrl}}` 拼
`PUBLIC_BASE_URL + 前端站内路径`——若 B 上只跑 API 不伺服 SPA（后端无 `@fastify/static`），
点开是 API 的 404。用户当日即撞上此问题，已升级为独立缺陷修复：新增 `WEB_BASE_URL`
（页面根地址），见 `问题记录-通知reportUrl双域名部署失效.md`。「B 主机 nginx 同时伺服
SPA + 反代 `/api/v1`（SSE 需 `proxy_buffering off`）」仍是可选替代方案——那套形态下
API 与页面同源，无需 `WEB_BASE_URL`。
