import { pool } from "../db.js";
import { decryptSecret } from "./crypto.js";
import type { ExecutionEvent } from "./events.js";
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
};

async function loadEventContext(executionIndexId: string | undefined): Promise<EventContext> {
  if (!executionIndexId) return {};
  const result = await pool.query(
    /* 报告名挂在 suite_executions 上；流程执行 join 不中，读作没有。 */
    `SELECT ei.target_name, ei.trigger_source, ei.trigger_ref_name, se.report_name
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
 */
const DEFAULT_SUITE_TEMPLATE = {
  title: "【接口自动化】套件「{{suiteName}}」{{status}}",
  body: [
    "结果: {{status}} · 通过 {{successCount}}/{{total}} · 失败 {{failedCount}} · 跳过 {{skippedCount}}",
    "通过率: {{passRate}} · 耗时: {{duration}}",
    "触发: {{trigger}}",
    "报告: {{reportName}}",
    "时间: {{finishedAt}}",
  ].join("\n"),
};

/** 秒级可读化：报告与告警同一口径（毫秒整数在群里没法读）。 */
function humanDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
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
            ei.trigger_source, ei.trigger_ref_name,
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
  const settled = event.successCount + event.failedCount + event.skippedCount;
  const values = {
    suiteName: String(row.suite_name),
    status,
    passRate: settled > 0 ? `${((event.successCount / settled) * 100).toFixed(1)}%` : "—",
    successCount: String(event.successCount),
    failedCount: String(event.failedCount),
    skippedCount: String(event.skippedCount),
    total: String(event.total),
    duration: humanDuration(row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms)),
    reportName: row.report_name ? String(row.report_name) : "—",
    trigger: row.trigger_source === "scheduled" || row.trigger_source === "webhook" || row.trigger_source === "ci"
      ? `${TRIGGER_LABEL[String(row.trigger_source)] ?? String(row.trigger_source)}「${row.trigger_ref_name ?? "?"}」`
      : "手动",
    finishedAt: clock(),
  };
  const message: AlertMessage = {
    title: renderTemplate(notify.template?.title || DEFAULT_SUITE_TEMPLATE.title, values),
    lines: renderBody(notify.template?.body || DEFAULT_SUITE_TEMPLATE.body, values),
  };

  await dispatchAlert({
    projectId: event.projectId,
    executionIndexId: event.executionIndexId,
    channels,
    message,
  });
}
