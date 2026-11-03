# 问题记录 — 通知 {{reportUrl}} 在双域名部署下链接不可达

## 现象

双域名部署（办公网页面域名 A、API 域名 B，`PUBLIC_BASE_URL=https://<B>`）下，套件 /
仓库终态通知里的「链接: {{reportUrl}}」生成 `https://<B>/projects/.../suite-reports/...`；
B 上只有 API 进程（后端无 `@fastify/static`），收件人点开是 Fastify 的 404 JSON，
报告页打不开。

## 根因

`reportUrl()`（`lib/alerts.ts`）拼 `PUBLIC_BASE_URL + 前端 SPA 路由`，但这两半的消费
者不同：路径是 SPA 路由（打开的是**页面**），而 `PUBLIC_BASE_URL` 的语义是「平台对外
根地址」，其消费者里产物直链、JobSpec 的 `APITRACK_URL`、`/mcp` Host 白名单打开的
都是 **API 自己的路由**（机器走 B 正确）；唯独通知链接的受众是「人 + 浏览器入口」。
单域名部署 API 与页面同源，掩盖了这层错位，双域名一拆即断。通知由调度器进程投递、
没有请求上下文，也不能像 `requestBaseUrl` 那样按拨号 Host 自适应。

站内收件箱的 `link`（`deliverInboxToUser`，相对路径、前端按当前 origin 拼）不受影响，
无需改动。

## 修法

`lib/alerts.ts` 的 `reportUrl()` 改三级回退：`WEB_BASE_URL`（浏览器打开平台页面的
根地址，人消费）→ `PUBLIC_BASE_URL`（未配时的兼容回退，单源部署无需多配）→ 裸相对
路径。`PUBLIC_BASE_URL` 语义不变，继续服务机器消费者。双域名部署取值：
`PUBLIC_BASE_URL=https://<B>` + `WEB_BASE_URL=https://<A>`。

## 状态

已修（2026-09-11），待用户在双域名环境实测通知链接可打开（需重启 scheduler 生效）。

## 关联

同日同主题：`问题记录-Mock公开地址双域名部署失效.md`——同一族「页面源 vs API 源」
错位的前端侧修法；其「伴生部署结论」中 B 伺服 SPA 的 nginx 方案是可选替代（那套
形态下无需 `WEB_BASE_URL`）。

## 同族全量盘点（2026-09-11，用户要求排查其余场景）

按「谁生成 / 打开的是页面还是 API / 受众是人还是机器」过完全部 URL 生成点，结论：
**无第三处同类缺陷**。浏览器 API 调用（`api.ts` `VITE_API_BASE_URL`）、Runner 部署
命令（`RunnerPoolPanel`）、SDK 上报 base（`RepoCredentials`）、`/mcp` 端点展示
（`McpPage`）走 B ✓；站内收件箱 link（`alerts.ts`/`members.ts`，相对路径前端拼
origin）、报告分享（`ShareReportButton`）、邀请链接（`UsersPanel`）走 A ✓；产物
上传/下载直链与 JobSpec `APITRACK_URL`（`objectStore`/`jobSpec`，机器 + 浏览器均可
达 B）✓；MCP 工具返回不含平台链接 ✓。两个**非缺陷的看护点**：

1. **Webhook 触发器 URL（未来的坑）**：`POST /webhooks/:publicId` 是给外部系统调的
   API 路由（受众是机器，应走 B），但触发器管理 UI 尚未落地（`WebhookTrigger` 类型
   已在 `api.ts`，无组件消费）。将来做该 UI 时，完整 URL 必须从 `VITE_API_BASE_URL`
   推导（同 `mockPublicOrigin()` 模式），**不能**用 `window.location.origin`（会拼出
   只在办公网可达的 A）——正是 MockList 犯过的错。
2. **S3 驱动产物直链（现状确认 + 办公网不可直达，2026-09-11）**：presigned URL 指向
   `ARTIFACT_S3_ENDPOINT` 本身、不经 B。**当前 dev 已在用 S3**（`apitest-server/.env`
   `ARTIFACT_STORAGE_DRIVER=s3`，MinIO 由 compose 起），本地不炸只是因为浏览器可达
   本地端点；公司双域名部署里端点是内网地址，**浏览器下载（`presignGet`）这条腿当天
   即断**——四条数据路径只有它断：Runner 上传（`presignPut`）内网仍可直传，
   `reportPayload` 服务端读取与 `objectExists` 都是 API 主机 → MinIO，不受影响。
   已定方向（2026-09-11 用户确认：实现下载侧转发，不着急、放后续计划；边界修订已
   记 `DEVELOPMENT_PLAN_P6-P14.md` 十七「后置：产物下载侧转发」）：下载侧改走平台路由——`presignGet`
   对 s3 驱动也返回 fs 同款 `/runner/artifacts/:key/download` 平台直链（token 签
   key + 过期，`signFsToken` 与驱动无关，机制复用），handler 按驱动分流，s3 档从
   MinIO `GetObject` **流式**转吐（pipe 不缓冲；Content-Length / Content-Disposition
   改由平台头下发）；上传保持 presigned 直传不动。这是对 P4.5 边界 14「平台永不代理
   大文件流」的修订（收窄为：上传不代理，下载侧允许转发），修订条目已落
   `DEVELOPMENT_PLAN_P6-P14.md` 十七，实现时按此执行。替代项：公司环境切回 fs 驱动
   （零代码，产物落 API 主机磁盘）或 MinIO 过办公网入口（纯基建，专属域名走 B 同一
   入口反代、Host/路径原样透传以保 SigV4 签名）。
