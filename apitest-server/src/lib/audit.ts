import { pool } from "../db.js";

/**
 * 审计日志通用设施（P4.5-8，计划 8.1 的 `audit_logs`）。
 *
 * 纪律（8.1 的列注释，验收门槛 9 也点名它）：**`detail` 绝不放 secret 值**。审计日志
 * 天然会被广泛读取，是最容易发生「顺手把 payload 整个塞进去」的地方——Runner Token
 * 的明文、仓库凭据、secrets 的 value 一个都不能进 detail。放的是**决策证据**：
 * 勾了几个 key、触发来源、token 的名字（名字不是凭据）。
 *
 * 写入是 fire-and-forget（`.catch(() => {})`）：审计失败不该让业务请求 500——它记的是
 * 「谁在什么时候做了什么」，一次写失败损失的是一条历史，拦下请求损失的是用户当下的
 * 操作。这与 `authenticateRunner` 里 `last_used_at` 的更新同一条取舍。
 *
 * `project_id` 可空：Runner Token 签发是系统级动作，不属于任何项目。
 */

export const AUDIT_ACTIONS = {
  /** CI 任务触发。target = ci_task，detail 带勾选的 key 数量而不是全量 key 列表（§8.3）。 */
  ciTaskTrigger: "ci_task.trigger",
  /** Runner 注册 Token 签发。target = runner_token，系统级（project_id 为空）。 */
  runnerTokenCreate: "runner_token.create",
  /** Runner 注册 Token 吊销。target = runner_token，系统级。 */
  runnerTokenRevoke: "runner_token.revoke",
  /**
   * MCP Token 签发（P5-1，计划 9.3；P12 改为**用户级**）。target = mcp_token，
   * `project_id` 为空（token 归人，不归项目）；detail 只带 name——scope 已不在 token
   * 上（P12 边界 2），签发不再产生任何项目级权限，权限在绑定时才出现。
   */
  mcpTokenCreate: "mcp_token.create",
  /** MCP Token 吊销（P5-1，计划 9.3；P12 用户级）。target = mcp_token，无项目归属。 */
  mcpTokenRevoke: "mcp_token.revoke",
  /**
   * MCP Token 绑定项目 / 改该绑定的 scope（P12 边界 8）。target = mcp_token；
   * detail 带 projectId 与 scope——「外部 agent 的读写执行通道给哪个项目开了哪几道门」
   * 正是审计要回答的问题（明文与哈希仍不进）。
   */
  mcpTokenBind: "mcp_token.bind",
  /**
   * 解绑（P12 边界 8）。target = mcp_token，detail 带 projectId 与被解绑时的 scope。
   * 解绑权两侧都有：owner 自助解绑、项目管理员踢绑定（边界 4）。
   */
  mcpTokenUnbind: "mcp_token.unbind",
  /**
   * MCP 调用被拒（P5-3，计划 9.0 边界 13「只审计写入、执行与拒绝」）。target = mcp_tool
   * （targetId 是工具名），detail 带 gate（scope 可见集 / rbac 活体判据）。只有第 3、4 道
   * 闸门的拒绝落这里——第 1 道没有可归属的身份（探针噪音），第 2 道是通道关着而不是
   * 「谁被拒了」。
   */
  mcpCallRejected: "mcp.call_rejected",
  /**
   * MCP 写工具成功执行（P5-5，边界 13「只审计写入、执行与拒绝」）。target = mcp_tool
   * （targetId 是工具名），detail 带目标资源 id 与 outcome（created/updated/deleted）——
   * **不带 payload**：payload 里是业务数据，审计只回答「谁改了什么」。
   */
  mcpToolWrite: "mcp_tool.write",
  /**
   * MCP 执行工具成功触发（P5-5b）。target = mcp_tool；detail 带 run/execution id。
   * `trigger_ci_task_run` 另有一行 `ci_task.trigger`（triggerCiTaskRun 自己写的，
   * triggeredBy = Token 签发人）——两行回答两个问题：谁触发的（ci_task.trigger）、
   * 经哪把钥匙触发的（mcp_tool.execute）。
   */
  mcpToolExecute: "mcp_tool.execute",
  /* ── P6 用户与成员（计划 10.0 边界 10：3 → 12 动作）。detail 只放 email 与角色，
     绝不含密码或邀请码明文（本文件头的纪律在 P6 的具体化）。 ── */
  /** 管理员建号。target = user；detail 带 email（是否系统管理员也算「前后角色」的证据）。 */
  userCreate: "user.create",
  /** 禁用用户（只禁不删，边界 9）。target = user；即时生效靠 currentUser 的每请求查库。 */
  userDisable: "user.disable",
  /** 重新启用用户。target = user；与 disable 各一行，读侧不用解析 detail 才能分开两个动作。 */
  userEnable: "user.enable",
  /** 管理员重置密码。target = user；detail 带 email，新密码明文绝不进（只在响应出现一次）。 */
  userResetPassword: "user.reset_password",
  /** 系统管理员旗变更（PATCH 的 isSystemAdmin 分支）。target = user；detail 带前后角色。 */
  userUpdateRole: "user.update_role",
  /* ── P6-3 邀请码（计划 10.0 边界 1 的①）。detail 只放 note 与预分配的 project/role
      证据——**明文码绝不进**（与密码同一条纪律：明文只在签发响应出现一次）。 ── */
  /** 签发邀请码。target = invitation；detail 带 note 与预分配角色（可空）。 */
  inviteCreate: "invite.create",
  /** 吊销邀请码。target = invitation；吊销即时生效（候选查询排除 revoked 行）。 */
  inviteRevoke: "invite.revoke",
  /** 邀请码被消费（注册成功）。target = invitation；user 落的是**新建的用户**，
      detail 带新账号 email——「这张码变成了谁」是审计要回答的问题。 */
  inviteConsume: "invite.consume",
  /* ── P6-4 成员变更（计划 10.0 边界 10 的 member.upsert / member.remove）。target =
      user（被改的那个人），detail 只放 email 与前后角色（与 user.* 同一形状）。 ── */
  /**
   * 添加成员 / 改角色（POST upsert 与 PATCH 同一动作）。detail 带 email 与
   * from/to 角色；from 缺席 = 新加入。
   */
  memberUpsert: "member.upsert",
  /** 移除成员。target = user；detail 带 email 与被移除时的角色。 */
  memberRemove: "member.remove",
  /* ── P14-2 权限申请审批（计划 20）。批准 = 既有成员 upsert（member.upsert，detail.via
     = 'access_request'），不另设动作；拒绝只记状态，落这一条。target = user（申请人），
     detail 只带可选 note（自由文本，不含业务数据）。 ── */
  /** 拒绝权限申请。target = user（申请人）；detail 带可选 note。批准不在这里（走 member.upsert）。 */
  accessRequestReject: "access_request.reject",
  /* ── P8-2：失败归因（计划 12.2）。target = failure_attribution（targetId 是被归因
      的叶子失败行 id，不是归因行 id——归因行随打标生灭，「哪条失败被谁归成了什么」
      才是审计要回答的问题）。detail 只带分类码与目标类型，note 自由文本不进
      （它可能含业务细节，审计只回答「谁改了什么」）。 ── */
  /** 打标/重打标（单条与批量同一动作，detail.batch 区分；批量带 count）。 */
  failureAttributionSet: "failure_attribution.set",
  /** 清除归因。target 同上；detail 带 target 类型。 */
  failureAttributionClear: "failure_attribution.clear",
  /* ── P9-3：助手 provider 管理（系统级，仅系统管理员）。target = assistant_provider。
     detail 只带 name/type 与变更摘要（enabled / 默认切换 / Key set|cleared）——Key 明文
     绝不进（本文件头的纪律在「谁换了上游钥匙」这个问题上最要命）。 ── */
  /** 建 provider（含 JSON 导入，detail.imported 区分）。 */
  assistantProviderCreate: "assistant_provider.create",
  /** 改 provider（名称/参数/能力面/Key/启停）。 */
  assistantProviderUpdate: "assistant_provider.update",
  /** 删 provider（映射会话级联，detail 带 conversationCount）。 */
  assistantProviderDelete: "assistant_provider.delete",
  /** 切换默认 provider（detail 带 from/to 名字）。 */
  assistantProviderSetDefault: "assistant_provider.set_default",
  /* ── P8-2：归因分类字典管理（系统设置「归因类型」tab）。target =
      failure_category（targetId 是 code 而非 uuid——字典的主键就是 code）。
      detail 带 name 与前后状态，seed 的七类同受管理（见路由注释）。 ── */
  failureCategoryCreate: "failure_category.create",
  failureCategoryUpdate: "failure_category.update",
  failureCategoryDelete: "failure_category.delete",
  /* ── P11-9：核心资源 CRUD（方案 B，计划 16.2 / 16.5）。14 类资源 × create/update/delete
     = 42 个动作（`target_type` 与动作前缀同名，读侧 `targetType` 过滤直接可用）。
     detail 一律走 `auditFields()`：**只记字段名列表**，不记任何值——接口 URL、脚本内容、
     环境 variables 的值、渠道 url 全部挡在外面（边界 5）。挂载在主写路径成功之后、
     fire-and-forget（边界 6）。 ── */
  endpointCreate: "endpoint.create",
  endpointUpdate: "endpoint.update",
  endpointDelete: "endpoint.delete",
  testCaseCreate: "test_case.create",
  testCaseUpdate: "test_case.update",
  testCaseDelete: "test_case.delete",
  environmentCreate: "environment.create",
  environmentUpdate: "environment.update",
  environmentDelete: "environment.delete",
  flowCreate: "flow.create",
  flowUpdate: "flow.update",
  flowDelete: "flow.delete",
  testSuiteCreate: "test_suite.create",
  testSuiteUpdate: "test_suite.update",
  testSuiteDelete: "test_suite.delete",
  scriptCreate: "script.create",
  scriptUpdate: "script.update",
  scriptDelete: "script.delete",
  dataSourceCreate: "data_source.create",
  dataSourceUpdate: "data_source.update",
  dataSourceDelete: "data_source.delete",
  sqlDefinitionCreate: "sql_definition.create",
  sqlDefinitionUpdate: "sql_definition.update",
  sqlDefinitionDelete: "sql_definition.delete",
  mockCreate: "mock.create",
  mockUpdate: "mock.update",
  mockDelete: "mock.delete",
  scheduleCreate: "schedule.create",
  scheduleUpdate: "schedule.update",
  scheduleDelete: "schedule.delete",
  webhookTriggerCreate: "webhook_trigger.create",
  webhookTriggerUpdate: "webhook_trigger.update",
  webhookTriggerDelete: "webhook_trigger.delete",
  notificationChannelCreate: "notification_channel.create",
  notificationChannelUpdate: "notification_channel.update",
  notificationChannelDelete: "notification_channel.delete",
  alertRuleCreate: "alert_rule.create",
  alertRuleUpdate: "alert_rule.update",
  alertRuleDelete: "alert_rule.delete",
  specModuleCreate: "spec_module.create",
  specModuleUpdate: "spec_module.update",
  specModuleDelete: "spec_module.delete",
  /**
   * P10-2：清理一张已脱离的执行历史分区（计划 14.1）。target = execution_partition，
   * **targetId 为空**——分区的标识是表名而 `audit_logs.target_id` 是 UUID 列，名字进
   * detail。detail 带表名、清掉的行数与删掉的对象数：这是平台里少数几个真正不可逆的动作，
   * 「谁在什么时候清掉了哪一季、多少条」必须留痕。
   *
   * 自动归档（DETACH）不在这里：它没有人类触发者、也不删任何东西，事实记在
   * `execution_partition_archives` 台账上。
   */
  executionPartitionDrop: "execution_partition.drop",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type AuditInput = {
  action: AuditAction;
  targetType: string;
  /** 可空：批量动作（如接口批量删除）没有单一目标行，数量进 detail（边界 6）。 */
  targetId: string | null;
  /** 可空：系统级动作（如 Runner Token 签发）没有项目归属。 */
  projectId?: string | null;
  /** 可空：调度器 / Webhook 之类的非人触发源没有 user。 */
  userId?: string | null;
  /** 决策证据，不是 payload 转储；secret 值一律不进。 */
  detail?: Record<string, unknown>;
  /** 缺省空串（列 NOT NULL DEFAULT ''，显式传空保持同一形状）。 */
  ip?: string;
};

/**
 * P11-9 方案 B 的 detail 形状（计划 16.5 边界 5）：审计只回答「改了哪些键」，
 * 不回答「改成什么」。`fields` 是**字段名**列表，与 `AuditInput.detail` 的自由记录
 * 并存——P6/P8/P9 的老动作维持各自形状，新的资源 CRUD 动作统一用它。
 */
export type AuditFieldDetail = { fields: string[] };

/**
 * `AuditFieldDetail.fields` 的唯一来源：取自有键的**键名**，不读任何值。
 * 非对象 / null / 数组得到空列表，调用方不必先判类型；同一个请求体多处复用不重算。
 */
export function auditFields(body: unknown): AuditFieldDetail["fields"] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>).sort();
}

/** 批量删除的动作证据（计划 16.5 边界 6）：不逐行落审计，只记删了几条。 */
export type AuditBatchDetail = { ids: number };

/** detail 的护栏：JSON 序列化后超过 4KB 视为调用方在转储 payload，截断而不是照单全收。 */
const DETAIL_MAX_BYTES = 4096;

export async function writeAuditLog(input: AuditInput): Promise<void> {
  let detail = JSON.stringify(input.detail ?? {});
  if (Buffer.byteLength(detail, "utf8") > DETAIL_MAX_BYTES) {
    detail = JSON.stringify({ truncated: true, note: "detail exceeded 4KB; likely a payload dump — not recorded" });
  }
  await pool.query(
    `INSERT INTO audit_logs (project_id, user_id, action, target_type, target_id, detail, ip)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      input.projectId ?? null,
      input.userId ?? null,
      input.action,
      input.targetType,
      input.targetId,
      detail,
      input.ip ?? "",
    ],
  );
}

/** fire-and-forget 包装：业务路径调用这一个，错误吞掉（见文件头注释的取舍）。 */
export function writeAuditLogAsync(input: AuditInput): void {
  void writeAuditLog(input).catch(() => {});
}
