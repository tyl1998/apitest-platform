import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify, { type FastifyInstance } from "fastify";
import { seedAdmin } from "./lib/auth.js";
import { success } from "./lib/response.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { environmentRoutes } from "./routes/environments.js";
import { endpointRoutes } from "./routes/endpoints.js";
import { caseRoutes } from "./routes/cases.js";
import { scriptRoutes } from "./routes/scripts.js";
import { flowRoutes } from "./routes/flows.js";
import { suiteRoutes } from "./routes/suites.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { streamRoutes } from "./routes/stream.js";
import { systemRoutes } from "./routes/system.js";
import { dataSourceRoutes } from "./routes/dataSources.js";
import { executionIndexRoutes } from "./routes/executionIndex.js";
import { mockRoutes } from "./routes/mocks.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { webhookTriggerRoutes } from "./routes/webhookTriggers.js";
import { notificationChannelRoutes } from "./routes/notificationChannels.js";
import { alertRuleRoutes } from "./routes/alertRules.js";
import { notificationDeliveryRoutes } from "./routes/notificationDeliveries.js";
import { reportRoutes } from "./routes/reports.js";
import { repositoryRoutes } from "./routes/repositories.js";
import { ingestRoutes } from "./routes/ingest.js";
import { runnerRoutes } from "./routes/runners.js";
import { ciTaskRoutes } from "./routes/ciTasks.js";
import { gitCredentialRoutes } from "./routes/gitCredentials.js";
import { pipelineRunRoutes } from "./routes/pipelineRuns.js";
import { reportShareRoutes } from "./routes/reportShares.js";
import { mcpTokenRoutes } from "./routes/mcpTokens.js";
import { mcpRoutes } from "./routes/mcp.js";
import { systemUserRoutes } from "./routes/systemUsers.js";
import { invitationRoutes } from "./routes/invitations.js";
import { memberRoutes } from "./routes/members.js";
import { specModuleRoutes } from "./routes/specModules.js";
import { specCaseRoutes } from "./routes/specCases.js";
import { specImportRoutes } from "./routes/specImport.js";
import { testPlanRoutes } from "./routes/testPlans.js";
import { attributionRoutes } from "./routes/attributions.js";
import { failureCategoryRoutes } from "./routes/failureCategories.js";
import { statsRoutes } from "./routes/stats.js";

declare module "@fastify/jwt" {
  /* pwdEpoch 可选（P6-5）：P6-5 之前签发的存量 token 没有 claim，按 0 对齐库里的缺省值。 */
  interface FastifyJWT { payload: { userId: string; email: string; pwdEpoch?: number }; user: { userId: string; email: string; pwdEpoch?: number }; }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  /**
   * methods must be listed explicitly: @fastify/cors defaults to
   * GET,HEAD,POST, so a browser preflight rejects every PUT/PATCH/DELETE
   * while curl (which sends no preflight) still succeeds.
   */
  await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] });
  /* 空串与未设置同义：本地 .env 只放非默认配置，占位值会让密钥漂移（dev 库里
     AES 加密的 Git 凭据按 JWT_SECRET 派生回退密钥解密，见 lib/crypto.ts）。 */
  await app.register(jwt, {
    secret: process.env.JWT_SECRET?.trim() || "change-this-in-production",
    /* P6-5：会话 token 的全局过期（JWT_EXPIRES_IN，默认 7d）。此前不设 expiresIn——
       token 永不过期，泄露后只能靠禁用账号才能作废。只影响 auth 路由的 jwtSign；
       产物直传的一性 token 是 objectStore 自己的 HMAC，不走这里。 */
    sign: { expiresIn: process.env.JWT_EXPIRES_IN?.trim() || "7d" },
  });
  app.get("/health", async () => success({ status: "ok" }));
  await app.register(authRoutes); await app.register(projectRoutes); await app.register(environmentRoutes); await app.register(dataSourceRoutes); await app.register(endpointRoutes); await app.register(caseRoutes); await app.register(scriptRoutes); await app.register(flowRoutes); await app.register(suiteRoutes); await app.register(mockRoutes); await app.register(executionIndexRoutes); await app.register(dashboardRoutes); await app.register(streamRoutes); await app.register(systemRoutes);
  /* P3：调度 / Webhook 触发（含公开 HMAC 路由）/ 告警 / 报告。 */
  await app.register(scheduleRoutes); await app.register(webhookTriggerRoutes); await app.register(notificationChannelRoutes); await app.register(alertRuleRoutes); await app.register(notificationDeliveryRoutes); await app.register(reportRoutes);
  /* P4：仓库模式。`ingestRoutes` 带公开上报入口 `POST /ingest`（Token 鉴权，不走 JWT）。 */
  await app.register(repositoryRoutes); await app.register(ingestRoutes);
  /* P4.5：自研 Runner。`runnerRoutes` 带 `/runner/*`（`apirunner_` Token 鉴权，不走 JWT）
     与 `/api/v1/system/runner*`（系统管理员）两组接口。`ciTaskRoutes` 是 CI 任务 CRUD
     与触发（P4.5-2）；Git 拉取凭据是项目级命名池（`gitCredentialRoutes`，P4.5-14——
     它取代了原先写在仓库行上的 `PUT …/repository/credential`）。`pipelineRunRoutes`
     目前只有 cancel（P4.5-3，取消只经心跳下发的源头），读路由在 P4.5-11。 */
  await app.register(runnerRoutes);
  await app.register(gitCredentialRoutes);
  await app.register(ciTaskRoutes);
  await app.register(pipelineRunRoutes);
  /* 报告分享（2026-09-02）：项目内 CRUD + `/public/report-shares/:token` 免登录只读
     （与 Webhook 公开路由同款：不走 JWT，token 即凭据）。 */
  await app.register(reportShareRoutes);
  /* P5-1：MCP Token 的签发 / 列表 / 吊销（项目级）。`/mcp` 端点本身与工具面在
     P5-3/P5-4 落地——这里先回答「钥匙怎么发、怎么收」。 */
  await app.register(mcpTokenRoutes);
  /* P5-3：`/mcp` 端点（无状态，`apimcp_` Token + 四道闸门，不走 JWT）。SDK 挂载与
     兼容腿见 routes/mcp.ts 文件头；工具面 P5-3 只立机制、清单为空，P5-4/P5-5 逐批
     登记进 lib/mcpServer.ts 的注册表。 */
  await app.register(mcpRoutes);
  /* P6-2：用户管理（建号 / 禁用 / 重置密码，管理员建号通道）+ 审计日志读接口。
     全部 requireSystemAdmin；邀请码通道与强制改密页在 P6-3。 */
  await app.register(systemUserRoutes);
  /* P6-3：邀请码签发 / 列表 / 吊销（系统管理员）。消费端是 `routes/auth.ts` 的公开
     注册路由 `POST /auth/register`（不走 JWT，邀请码即凭据）。 */
  await app.register(invitationRoutes);
  /* P6-4：项目成员 CRUD（读 = viewer 可见，写 = requireProjectAdmin）+ 添加成员的
     候选搜索。审计动作 member.upsert / member.remove 在 lib/audit.ts。 */
  await app.register(memberRoutes);
  /* P7-1：文本用例的模块树 CRUD（迁移 052）。用例 CRUD / 绑定 / 导入 / 计划在
     P7-2…P7-7 逐批落地；树接口先行，前端树视图在 P7-6。 */
  await app.register(specModuleRoutes);
  /* P7-2：文本用例 CRUD（列表分页筛选 / 手工建 / 详情 / 改 / 删）。绑定（links）
     与读时关联的最近自动化结果在 P7-3 挂到详情接口上。 */
  await app.register(specCaseRoutes);
  /* P7-4：文本用例导入（XMind 两代格式解析 + preview/commit 两阶段）。octet-stream
     的 content-type parser 在该插件作用域内注册，与 runners 那份互不越界。 */
  await app.register(specImportRoutes);
  /* P7-7：测试计划（一批文本用例的一次手工执行记录）：建/列表/详情/改/删 + 项
     加/标/删 + CSV 导出（UTF-8 BOM）。五张表迁移 052 已建齐，零新迁移。 */
  await app.register(testPlanRoutes);
  /* P8-2：失败归因（迁移 054）。REST 四条（字典读 / 单条 / 批量 / 清除）；`/stats/*`
     全局统计、MCP 归因工具、归因前端入口分别在 P8-4 / P8-7 / P8-3。归因分类字典的
     管理面（系统设置「归因类型」tab）在 `failureCategoryRoutes`（系统管理员）。 */
  await app.register(attributionRoutes);
  await app.register(failureCategoryRoutes);
  /* P8-4：全局统计（无项目前缀的新路由组）。可见项目集过滤、30s TTL 内存缓存与
     5s statement_timeout 全部收在 stats.ts 内（边界 16/23），注册顺序无讲究——
     它不依赖其他路由的任何状态。前端页面（数据统计三段式 + 看板扩展）在 P8-6。 */
  await app.register(statsRoutes);
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = await buildApp();
  await seedAdmin();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
}
