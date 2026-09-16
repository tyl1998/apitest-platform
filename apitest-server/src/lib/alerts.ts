import { pool } from "../db.js";
import { decryptSecret } from "./crypto.js";
import type { ExecutionEvent } from "./events.js";
import { deliverInboxToUser } from "./inbox.js";
import { passRateOf } from "./metrics.js";
import { dispatchAlert, renderBody, renderTemplate, type AlertChannel, type AlertMessage } from "./notify.js";
import { mapAlertRule, normalizeSuiteNotify } from "../models/types.js";

/**
 * 告警规则评估（P3-5，边界 9）。
 *
 * 告警不侵入执行路径：调度器订阅 `executions:events`，在**终态事件到达时**评估规则
 * （lib/scheduler.ts 的订阅管线先筛好 flow / suite + 终态）。不用定时扫表——终态事件
 * 本来就会来，扫表只会在两次扫描之间留出「告警迟到一整个周期」的窗口。
 *
 * 两类指标（迁移 031 的 CHECK）：
 * - `execution_failed` 事件型：失败事件一到就评估，无窗口；
 * - `consecutive_failures` / `success_rate` / `avg_duration` 窗口型：在同一条事件上
 *   跑一次聚合查询。
 *
 * 窗口统计只看**父执行**（flow / suite）且已定局（success / failed）的行：单接口调试
 * 没有索引行、批量调试是调试动作，把「一次勾选 20 个接口半数失败」算进回归成功率
 * 只会制造噪声；canceled 是用户动作，不是质量信号。
 *
 * 冷却（边界 9）：没有冷却，一次雪崩会把渠道刷爆，而第 2 条到第 200 条通知不携带
 * 任何新信息。多实例竞争靠「冷却写回带 WHERE last_fired_at IS NOT DISTINCT FROM
 * <读到的那个>」的行级认领——与 schedules.next_run_at 同一个惯用法，不引入第二套
 * 并发原语。
 */

type ParentEvent = Extract<ExecutionEvent, { kind: "flow" | "suite" }>;

/** 比较器：阈值方向由规则声明（成功率跌破用 lt，耗时/连败超过用 gt/gte）。 */
function thresholdBreached(comparator: string, value: number, threshold: number): boolean {
  if (comparator === "gt") return value > threshold;
  if (comparator === "gte") return value >= threshold;
  if (comparator === "lt") return value < threshold;
  return value <= threshold;
}

function comparatorLabel(comparator: string): string {
  return comparator === "gt" ? ">" : comparator === "gte" ? "≥" : comparator === "lt" ? "<" : "≤";
}

function clock(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const TRIGGER_LABEL: Record<string, string> = { manual: "手动", scheduled: "定时", webhook: "Webhook", ci: "CI" };

/** 事件指向的父执行上下文（报告名、触发者），事件型规则的模板要用。 */
type EventContext = {
  targetName?: string;
  reportName?: string;
  triggerSource?: string;
  triggerRefName?: string;
  /** 触发人（P9-1 收件口径）：站内通知的定点收件人；非人触发为空。 */
  triggeredBy?: string | null;
};

async function loadEventContext(executionIndexId: string | undefined): Promise<EventContext> {
  if (!executionIndexId) return {};
  const result = await pool.query(
    /* 报告名挂在 suite_executions 上；流程执行 join 不中，读作没有。 */
    `SELECT ei.target_name, ei.trigger_source, ei.trigger_ref_name, ei.triggered_by, se.report_name
       FROM execution_index ei
       LEFT JOIN suite_executions se ON se.execution_index_id = ei.id
      WHERE ei.id = $1`,
    [executionIndexId],
  );
  if (!result.rowCount) return {};
  const row = result.rows[0];
  return {
    targetName: row.target_name ? String(row.target_name) : undefined,
    reportName: row.report_name ? String(row.report_name) : undefined,
    triggerSource: row.trigger_source ? String(row.trigger_source) : undefined,
    triggerRefName: row.trigger_ref_name ? String(row.trigger_ref_name) : undefined,
    triggeredBy: row.triggered_by ? String(row.triggered_by) : null,
  };
}

/** 冷却认领：先本地判窗口，再 compare-and-set 抢「这次派发归我」。 */
async function claimCooldown(rule: { id: string; lastFiredAt?: string; cooldownSeconds: number }): Promise<boolean> {
  if (rule.lastFiredAt && Date.now() - new Date(rule.lastFiredAt).getTime() < rule.cooldownSeconds * 1000) return false;
  const claimed = await pool.query(
    "UPDATE alert_rules SET last_fired_at = now() WHERE id = $1 AND last_fired_at IS NOT DISTINCT FROM $2::timestamptz",
    [rule.id, rule.lastFiredAt ?? null],
  );
  return Boolean(claimed.rowCount);
}

/** 渠道按 rule.channel_ids 读，解好密再交给投递；停用与已删的不参与。 */
async function loadChannels(projectId: string, channelIds: string[]): Promise<AlertChannel[]> {
  if (!channelIds.length) return [];
  const rows = await pool.query(
    "SELECT * FROM notification_channels WHERE id = ANY($1::uuid[]) AND project_id = $2 AND enabled",
    [channelIds, projectId],
  );
  return rows.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    type: String(row.type) as AlertChannel["type"],
    url: String(row.url),
    /* 解密失败不让整次投递陪葬：以未带密钥发出（钉钉会回签名错误，那也是诚实的证据）。 */
    secret: row.secret_encrypted
      ? (() => { try { return decryptSecret(row.secret_encrypted as Buffer); } catch { return undefined; } })()
      : undefined,
    templatePrefix: row.template_prefix ? String(row.template_prefix) : undefined,
  }));
}

/**
 * 窗口聚合一次查回三个窗口型指标要的原料。
 *
 * 样本 = 已定局的父执行（success / failed）且 created_at 落在窗口内——按开始时间归桶，
 * 正在跑的执行不进分母：把在途请求算成「未成功」会在业务高峰制造虚假的成功率告警。
 */
async function windowAggregate(projectId: string, windowMinutes: number) {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
       AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)
         FILTER (WHERE status IN ('success', 'failed') AND started_at IS NOT NULL AND finished_at IS NOT NULL) AS avg_duration_ms
     FROM execution_index
     WHERE project_id = $1 AND kind IN ('flow', 'suite') AND status IN ('success', 'failed')
       AND created_at >= now() - make_interval(mins => $2)`,
    [projectId, windowMinutes],
  );
  const row = result.rows[0];
  return {
    success: Number(row.success_count),
    failed: Number(row.failed_count),
    avgDurationMs: row.avg_duration_ms === null || row.avg_duration_ms === undefined ? undefined : Number(row.avg_duration_ms),
  };
}

/**
 * 连续失败：窗口内按时间倒序取回前若干次定局执行，数出队头的连续失败数。
 * 取 threshold + 1 行就够判 gt/gte 两种方向，不必把整段历史拉回来。
 */
async function consecutiveFailures(projectId: string, windowMinutes: number, threshold: number): Promise<number> {
  const result = await pool.query(
    `SELECT status FROM execution_index
      WHERE project_id = $1 AND kind IN ('flow', 'suite') AND status IN ('success', 'failed')
        AND created_at >= now() - make_interval(mins => $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [projectId, windowMinutes, Math.min(Math.trunc(threshold), 200) + 1],
  );
  let consecutive = 0;
  for (const row of result.rows) {
    if (String(row.status) !== "failed") break;
    consecutive += 1;
  }
  return consecutive;
}

/**
 * 评估一条终态父执行事件：命中且过了冷却的规则逐条投递。
 *
 * 事件本身就是「窗口跨过阈值」或「这次失败」的诱因，评估在它到达时做——包括成功
 * 事件（成功率跌破类规则同样可能被一次成功推过下界，比如样本变多稀释了分母）。
 */
export async function evaluateAlertEvent(event: ParentEvent): Promise<void> {
  /* 绝大多数项目没配任何规则：一条索引查询直接返回，订阅管线保持零成本。 */
  const rules = await pool.query(
    "SELECT * FROM alert_rules WHERE project_id = $1 AND enabled ORDER BY created_at",
    [event.projectId],
  );
  if (!rules.rowCount) return;

  /* 事件上下文懒加载：窗口型规则用不到它，白查一次就是纯开销。 */
  let context: EventContext | undefined;
  const contextOf = async () => context ??= await loadEventContext(event.executionIndexId);

  for (const row of rules.rows) {
    const rule = mapAlertRule(row);
    try {
      let message: AlertMessage | undefined;
      if (rule.metric === "execution_failed") {
        /* 事件型只看失败：canceled 是用户动作，不是故障。 */
        if (event.status !== "failed") continue;
        const info = await contextOf();
        const trigger = info.triggerSource === "scheduled" || info.triggerSource === "webhook" || info.triggerSource === "ci"
          ? `${TRIGGER_LABEL[info.triggerSource]}「${info.triggerRefName ?? "?"}」`
          : "手动";
        message = {
          title: "【接口自动化】执行失败",
          lines: [
            `目标: ${event.kind === "suite" ? "套件" : "流程"}「${info.targetName ?? "?"}」`,
            ...(info.reportName ? [`报告: ${info.reportName}`] : []),
            `结果: 失败 ${event.failedCount} / 通过 ${event.successCount} / 跳过 ${event.skippedCount} / 共 ${event.total}`,
            `触发: ${trigger}`,
            `时间: ${clock()}`,
          ],
        };
      } else if (rule.metric === "success_rate") {
        const window = rule.windowMinutes ?? 0;
        const sample = await windowAggregate(event.projectId, window);
        const settled = sample.success + sample.failed;
        /* 空窗口不评：0/0 的「成功率」没有含义，除零告警只会吓人。 */
        if (!settled) continue;
        const rate = (sample.success / settled) * 100;
        if (!thresholdBreached(rule.comparator, rate, rule.threshold)) continue;
        message = {
          title: "【接口自动化】成功率告警",
          lines: [
            `规则: 「${rule.name}」`,
            `当前: 窗口 ${window} 分钟内成功率 ${rate.toFixed(1)}%（阈值 ${comparatorLabel(rule.comparator)} ${rule.threshold}%）`,
            `样本: 通过 ${sample.success} / 失败 ${sample.failed}`,
            `时间: ${clock()}`,
          ],
        };
      } else if (rule.metric === "avg_duration") {
        const window = rule.windowMinutes ?? 0;
        const sample = await windowAggregate(event.projectId, window);
        if (sample.avgDurationMs === undefined) continue;
        if (!thresholdBreached(rule.comparator, sample.avgDurationMs, rule.threshold)) continue;
        message = {
          title: "【接口自动化】平均耗时告警",
          lines: [
            `规则: 「${rule.name}」`,
            `当前: 窗口 ${window} 分钟内平均耗时 ${(sample.avgDurationMs / 1000).toFixed(1)}s（阈值 ${comparatorLabel(rule.comparator)} ${(rule.threshold / 1000).toFixed(1)}s）`,
            `样本: ${sample.success + sample.failed} 次定局执行`,
            `时间: ${clock()}`,
          ],
        };
      } else {
        /* consecutive_failures：窗口型。 */
        const window = rule.windowMinutes ?? 0;
        const consecutive = await consecutiveFailures(event.projectId, window, rule.threshold);
        if (!thresholdBreached(rule.comparator, consecutive, rule.threshold)) continue;
        const info = await contextOf();
        message = {
          title: "【接口自动化】连续失败告警",
          lines: [
            `规则: 「${rule.name}」`,
            `当前: 窗口 ${window} 分钟内连续失败 ${consecutive} 次（阈值 ${comparatorLabel(rule.comparator)} ${rule.threshold} 次）`,
            ...(info.targetName ? [`最近: 「${info.targetName}」`] : []),
            `时间: ${clock()}`,
          ],
        };
      }

      if (!message) continue;
      /* 冷却认领在投递之前：没抢到说明另一实例正在发同一件事，这里退出即可。 */
      if (!await claimCooldown(rule)) continue;
      const channels = await loadChannels(event.projectId, rule.channelIds);
      /* 站内通知（P9-1 收件口径变更，2026-09-11）：定点发给触发这次执行的人（手动 /
         MCP execute 落在 execution_index.triggered_by）；非人触发（定时 / Webhook）
         不发站内——受众不明确的广播只是噪声，需要关注的人已由上面的外发渠道覆盖。
         与外发渠道解耦：外发是「配置了才知道」，这一发只给亲手触发的人。 */
      const triggerContext = await contextOf();
      deliverInboxToUser({
        projectId: event.projectId,
        userId: triggerContext.triggeredBy,
        kind: "alert",
        title: message.title,
        body: message.lines.join("\n"),
        link: `/projects/${event.projectId}/alerts`,
      });
      /* 渠道全部被删/停用：条件确实命中了（冷却已记），没有可投递的对象也是一种
         要在证据里看得见的状态——投递记录为空本身就是答案（边界 10）。 */
      if (!channels.length) continue;
      await dispatchAlert({
        projectId: event.projectId,
        ruleId: rule.id,
        executionIndexId: event.executionIndexId,
        channels,
        message,
      });
    } catch (error) {
      /* 一条规则坏了不拖垮其它规则：告警是旁路，永远不能反噬执行链路。 */
      console.error(`[alerts] rule "${rule.name}" evaluation failed`, error);
    }
  }
}

/* ── 套件级结果通知（P3-11，6.8）────────────────────────────────── */

/**
 * 默认模版（套件级覆盖前的兜底）。正文按行给出：`AlertMessage.lines` 是行的列表，
 * 渠道各自决定怎么排版；自定义模版的 body 由 `renderBody` 按换行拆成同样的形状。
 *
 * 标题前缀是**通知源的主语**（「套件通知」）而不是平台名——套件自己已经说了名字，
 * 再压一层「接口自动化」在站内读起来像在分类这个任务（2026-09-11 用户反馈）。
 */
const DEFAULT_SUITE_TEMPLATE = {
  title: "【套件通知】{{suiteName}} {{status}}",
  body: [
    "结果: {{status}} · 通过 {{successCount}}/{{total}} · 失败 {{failedCount}} · 跳过 {{skippedCount}}",
    "通过率: {{passRate}} · 耗时: {{duration}}",
    "触发: {{trigger}}",
    "报告: {{reportName}}",
    "链接: {{reportUrl}}",
    "时间: {{finishedAt}}",
  ].join("\n"),
};

/** 秒级可读化：报告与告警同一口径（毫秒整数在群里没法读）。 */
function humanDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * 通知里的报告直链（2026-09-03：模版支持 `{{reportUrl}}`）。
 *
 * 通知由调度器进程投递（订阅终态事件），那里没有 HTTP 请求上下文，根地址只能来自
 * 环境变量。链接打开的是**前端 SPA 路由**，不是 API 路由——双域名部署（办公网页面
 * 在 A、API 在 B）下 `PUBLIC_BASE_URL` 指 B，链接会落到只跑 API 的 B 上变 404。
 * `WEB_BASE_URL` 专指浏览器打开平台页面的根地址（人消费）；`PUBLIC_BASE_URL` 继续
 * 服务机器消费者（产物直链 / JobSpec 的 APITRACK_URL / /mcp Host 白名单），语义
 * 不变。未配 `WEB_BASE_URL` 时回退 `PUBLIC_BASE_URL`——单源部署两者同源，无需多
 * 配一个。两者皆无时回**相对路径**：站内路由是确定的，缺的只是域名那一半——比
 * 悄悄吞掉占位符可排查。
 */
function reportUrl(path: string): string {
  const base = process.env.WEB_BASE_URL?.trim().replace(/\/+$/, "")
    || process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}

/**
 * 套件终态事件 → 按套件自己的通知配置投递（成功/失败开关 + 渠道 + 可覆盖模版）。
 *
 * 与告警规则的区别：规则回答「项目的质量指标怎么了」，这里回答「这个套件跑完了，
 * 告诉我结果」——配置跟着套件走，不进 alert_rules，投递证据行的 rule_id 为空
 * （与渠道「测试」同款）。`canceled` 不通知：用户动作不是执行结果。
 */
export async function notifySuiteResult(event: Extract<ExecutionEvent, { kind: "suite" }>): Promise<void> {
  if (event.status !== "success" && event.status !== "failed") return;
  /* 事实一次取齐：套件配置 + 报告名 + 触发者 + 耗时。suite_id 为空说明套件已被删，
     通知没有收件语境，跳过。 */
  const found = await pool.query(
    `SELECT ts.notify_config, se.suite_id, se.suite_name, se.report_name,
            ei.trigger_source, ei.trigger_ref_name, ei.triggered_by,
            EXTRACT(EPOCH FROM (se.finished_at - se.started_at)) * 1000 AS duration_ms
       FROM suite_executions se
       JOIN execution_index ei ON ei.id = se.execution_index_id
       LEFT JOIN test_suites ts ON ts.id = se.suite_id
      WHERE se.id = $1 AND se.project_id = $2`,
    [event.suiteExecutionId, event.projectId],
  );
  if (!found.rowCount || !found.rows[0].suite_id) return;
  const row = found.rows[0];

  const notify = normalizeSuiteNotify(row.notify_config);
  const wanted = event.status === "success" ? notify.onSuccess : notify.onFailure;
  if (!wanted) return;
  /* 开关开了却没选渠道：与规则「渠道全被删」同一种可见状态——不投递，也不假装投过。 */
  if (!notify.channelIds.length) return;

  const channels = await loadChannels(event.projectId, notify.channelIds);
  if (!channels.length) return;

  const status = event.status === "success" ? "成功" : "失败";
  /* 通过率口径（P8-1 收口）：passed/(passed+failed)，skipped 不进分母——与报告
     列表/详情/分享页同一公式（lib/metrics.ts 的 passRateOf）。此前这里把
     skipped 算进分母，被跳过的用例拉低了通知里的读数，与报告页对不上。 */
  const passRate = passRateOf(event.successCount, event.failedCount);
  const values = {
    suiteName: String(row.suite_name),
    status,
    passRate: passRate === null ? "—" : `${passRate.toFixed(1)}%`,
    successCount: String(event.successCount),
    failedCount: String(event.failedCount),
    skippedCount: String(event.skippedCount),
    total: String(event.total),
    duration: humanDuration(row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms)),
    reportName: row.report_name ? String(row.report_name) : "—",
    reportUrl: reportUrl(`/projects/${event.projectId}/suite-reports/${event.suiteExecutionId}`),
    trigger: row.trigger_source === "scheduled" || row.trigger_source === "webhook" || row.trigger_source === "ci"
      ? `${TRIGGER_LABEL[String(row.trigger_source)] ?? String(row.trigger_source)}「${row.trigger_ref_name ?? "?"}」`
      : "手动",
    finishedAt: clock(),
  };
  const message: AlertMessage = {
    title: renderTemplate(notify.template?.title || DEFAULT_SUITE_TEMPLATE.title, values),
    lines: renderBody(notify.template?.body || DEFAULT_SUITE_TEMPLATE.body, values),
  };

  /* 站内通知（P9-1 收件口径变更，2026-09-11）：定点发给触发人（手动 / MCP execute）；
     定时 / Webhook 触发不发站内（triggered_by 为空）——受众不明确，且配置了站外
     渠道的人已覆盖。 */
  deliverInboxToUser({
    projectId: event.projectId,
    userId: row.triggered_by ? String(row.triggered_by) : null,
    kind: "suite_result",
    title: message.title,
    body: message.lines.join("\n"),
    link: reportUrl(`/projects/${event.projectId}/suite-reports/${event.suiteExecutionId}`),
  });

  await dispatchAlert({
    projectId: event.projectId,
    executionIndexId: event.executionIndexId,
    channels,
    message,
  });
}

/* ── 仓库任务级结果通知（P4.5-12，8.7 的范围扩项）────────────────── */

/**
 * 默认模版。占位符换成 CI 语境（没有「报告名」——CI 的报告是 run 详情页本身；多出
 * `runNumber` / `gitRef` / `commitSha`，那三个是「跑的是哪一版代码」的答案；
 * `reportUrl` 直指 run 详情页——2026-09-03 起与套件模版同款支持报告链接）。
 *
 * 标题前缀「仓库任务」（2026-09-11 用户反馈）：仓库里跑的是用户自己的代码（pytest
 * 等），不是平台的接口用例——前缀说**跑的是什么**，不说平台名。
 */
const DEFAULT_CI_TASK_TEMPLATE = {
  title: "【仓库任务】{{taskName}} #{{runNumber}} {{status}}",
  body: [
    "结果: {{status}} · 通过 {{passedCount}}/{{total}} · 失败 {{failedCount}} · 跳过 {{skippedCount}}",
    "代码: {{gitRef}} @ {{commitSha}}",
    "耗时: {{duration}}",
    "触发: {{trigger}}",
    "详情: {{reportUrl}}",
    "时间: {{finishedAt}}",
  ].join("\n"),
};

/**
 * pipeline run 终态事件 → 按任务自己的通知配置投递。
 *
 * 与 `notifySuiteResult` 是同一件事在第二种目标上的同一个答案，所以除了「事实从哪张表取」
 * 与「文案里说什么」之外一行不同：开关语义、渠道来源、模版覆盖、投递证据（`rule_id` 为空）
 * 全部复用。订阅点也共用（`scheduler.ts` 那一条），因此 `complete` 与租约回收（abort）两条
 * 终态路径**自动都覆盖**，不必各插一次通知调用。
 *
 * 终态口径：
 * - `canceled` **不通知**（与套件同款：用户动作不是执行结果）。
 * - `aborted` / `timed_out` **要通知**，归一成失败文案——「机器没了」与「跑超时了」正是最
 *   需要有人知道的两种结局；run 行上的原状态保留，通知里说的是 `status` 占位符渲染出的
 *   那个词，两者不冲突。
 */
export async function notifyPipelineResult(event: Extract<ExecutionEvent, { kind: "pipeline" }>): Promise<void> {
  const CI_TERMINAL_STATUS: Record<string, string> = {
    success: "成功", failed: "失败", aborted: "中断（Runner 失联）", timed_out: "超时",
  };
  const label = CI_TERMINAL_STATUS[event.status];
  if (!label) return;

  /* 事实一次取齐：任务配置 + 计数 + 代码版本 + 触发者 + 耗时。ci_task_id 是 NOT NULL 且
     级联删除，所以任务行在则 run 在——join 不中只可能是删除竞态，跳过即可。 */
  const found = await pool.query(
    `SELECT t.notify_config, t.name AS task_name,
            pr.run_number, pr.git_ref, pr.commit_sha, pr.case_total, pr.passed_count,
            pr.failed_count, pr.skipped_count, pr.trigger_source, pr.trigger_ref_name, pr.triggered_by,
            EXTRACT(EPOCH FROM (pr.finished_at - COALESCE(pr.started_at, pr.claimed_at))) * 1000 AS duration_ms
       FROM pipeline_runs pr JOIN ci_tasks t ON t.id = pr.ci_task_id
      WHERE pr.id = $1 AND pr.project_id = $2`,
    [event.pipelineRunId, event.projectId],
  );
  if (!found.rowCount) return;
  const row = found.rows[0];

  const notify = normalizeSuiteNotify(row.notify_config);
  const wanted = event.status === "success" ? notify.onSuccess : notify.onFailure;
  if (!wanted) return;
  if (!notify.channelIds.length) return;

  const channels = await loadChannels(event.projectId, notify.channelIds);
  if (!channels.length) return;

  const values = {
    taskName: String(row.task_name),
    runNumber: String(Number(row.run_number)),
    status: label,
    passedCount: String(Number(row.passed_count)),
    failedCount: String(Number(row.failed_count)),
    skippedCount: String(Number(row.skipped_count)),
    total: String(Number(row.case_total)),
    duration: humanDuration(row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms)),
    gitRef: String(row.git_ref ?? "—"),
    /* 短 sha：群里没人读 40 位。clone 之前失败的 run 这一列是空串，读成「—」。 */
    commitSha: row.commit_sha ? String(row.commit_sha).slice(0, 8) : "—",
    reportUrl: reportUrl(`/projects/${event.projectId}/pipeline-runs/${event.pipelineRunId}`),
    trigger: row.trigger_source === "scheduled" || row.trigger_source === "webhook" || row.trigger_source === "ci"
      ? `${TRIGGER_LABEL[String(row.trigger_source)] ?? String(row.trigger_source)}「${row.trigger_ref_name ?? "?"}」`
      : "手动",
    finishedAt: clock(),
  };
  const message: AlertMessage = {
    title: renderTemplate(notify.template?.title || DEFAULT_CI_TASK_TEMPLATE.title, values),
    lines: renderBody(notify.template?.body || DEFAULT_CI_TASK_TEMPLATE.body, values),
  };

  /* 站内通知（P9-1 收件口径变更，2026-09-11）：定点发给触发人（pipeline_runs.
     triggered_by——手动 / MCP execute 都有值）；定时 / Webhook / CI 触发为空不发。 */
  deliverInboxToUser({
    projectId: event.projectId,
    userId: row.triggered_by ? String(row.triggered_by) : null,
    kind: "ci_result",
    title: message.title,
    body: message.lines.join("\n"),
    link: reportUrl(`/projects/${event.projectId}/pipeline-runs/${event.pipelineRunId}`),
  });

  await dispatchAlert({
    projectId: event.projectId,
    executionIndexId: event.executionIndexId,
    channels,
    message,
  });
}
