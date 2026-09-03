import { join, resolve } from "node:path";
import { pool } from "../db.js";
import { parseAllureReportBundle, type ReportView } from "./allureReport.js";
import { mapExecutionStep, mapPipelineRun, mapPipelineRunCase, type PipelineRun, type PipelineRunCase } from "../models/types.js";
import { readZip } from "./zip.js";

/**
 * 报告装载的单一实现：套件报告与仓库执行报告的拼装都住这里。
 *
 * 两个调用方（项目内详情路由、公开分享路由）要回**同一份**拼装结果——两处各写一遍
 * SQL 的那一天，就是「分享出去的报告与站内看到的数字对不上」的那一天。派生值
 * （耗时/排队/通过率）由这一份实现算（边界 13：减法只有一份）。
 */

/** 派生指标都由这里算（边界 13）：墙钟耗时、排队等待、通过率。 */
function derivedColumns(): string {
  return `
    CASE WHEN se.finished_at IS NOT NULL AND se.started_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (se.finished_at - se.started_at)) * 1000 END AS duration_ms,
    CASE WHEN se.started_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (se.started_at - se.created_at)) * 1000 END AS queue_ms,
    CASE WHEN se.total > 0
      THEN ROUND(se.success_count::numeric * 100 / se.total, 1) END AS pass_rate`;
}

export async function loadSuiteReport(projectId: string, executionId: string) {
  const result = await pool.query(
    `SELECT se.*, ${derivedColumns()}, ei.trigger_source, ei.trigger_ref_id, ei.trigger_ref_name
       FROM suite_executions se JOIN execution_index ei ON ei.id = se.execution_index_id
      WHERE se.id = $1 AND se.project_id = $2`,
    [executionId, projectId],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  /* 顶层步骤 = 成员明细（与套件运行抽屉同一口径）；循环/子流程的内层证据按需走
     execution-steps 的 children 路由。 */
  const steps = await pool.query(
    "SELECT * FROM execution_steps WHERE index_id = $1 AND parent_step_id IS NULL ORDER BY position, created_at",
    [row.execution_index_id],
  );
  return {
    id: String(row.id),
    executionIndexId: String(row.execution_index_id),
    reportName: row.report_name ? String(row.report_name) : null,
    suiteName: String(row.suite_name),
    environmentName: row.environment_name ? String(row.environment_name) : null,
    runnerLabel: String(row.runner_label ?? "default"),
    triggerSource: String(row.trigger_source ?? "manual"),
    triggerRefId: row.trigger_ref_id ? String(row.trigger_ref_id) : null,
    triggerRefName: row.trigger_ref_name ? String(row.trigger_ref_name) : null,
    variableOverrides: (row.variable_overrides ?? {}) as Record<string, string>,
    status: String(row.status),
    error: row.error ? String(row.error) : null,
    total: Number(row.total), successCount: Number(row.success_count), failedCount: Number(row.failed_count), skippedCount: Number(row.skipped_count),
    passRate: row.pass_rate === null || row.pass_rate === undefined ? null : Number(row.pass_rate),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    queueMs: row.queue_ms === null || row.queue_ms === undefined ? null : Number(row.queue_ms),
    createdAt: new Date(String(row.created_at)).toISOString(),
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
    members: steps.rows.map(mapExecutionStep),
  };
}

/* ── 仓库执行报告（pipeline run）───────────────────────────────────────────── */

/** 报告视图缓存：zip 在对象存储里，逐请求读 + 解析一个几百 MB 的包是自找的慢。 */
const reportViewCache = new Map<string, { view: ReportView; loadedAt: number }>();
const REPORT_VIEW_CACHE_MS = 5 * 60 * 1000;

/** run 的 `kind='report'` 产物行（附件下载与视图解析共用同一个包）。 */
export async function findReportArtifactRow(runId: string) {
  const artifact = await pool.query(
    `SELECT id, storage_driver, storage_key FROM artifacts
      WHERE owner_type = 'pipeline_run' AND owner_id = $1 AND kind = 'report' AND uploaded_at IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [runId],
  );
  return artifact.rowCount ? artifact.rows[0] : null;
}

/**
 * 读产物字节并解析成报告视图（缓存 5 分钟——产物不可变：zip 是终态后传的，内容
 * 不会再变）。包读不出来 / 解不开时抛错，由调用方决定回 500 还是别的。
 */
export async function loadReportView(artifactId: string, driver: string, storageKey: string): Promise<ReportView> {
  const cached = reportViewCache.get(artifactId);
  if (cached && Date.now() - cached.loadedAt < REPORT_VIEW_CACHE_MS) return cached.view;
  const bytes = await readArtifactBytes(driver, storageKey);
  if (!bytes) throw new Error("report artifact could not be read from storage");
  const view = parseAllureReportBundle(bytes);
  reportViewCache.set(artifactId, { view, loadedAt: Date.now() });
  return view;
}

/**
 * 读产物的字节。fs 驱动直接读文件（API 进程与存储同机）；s3 驱动拉对象——报告包是
 * 平台自己要消费的**元数据级**产物（几 MB 的 JSON 清单），与「平台永不代理大文件流」
 * （边界 14）不冲突：那条约束说的是用户下载的文件流，这里是一次缓存 5 分钟的读。
 */
export async function readArtifactBytes(driver: string, storageKey: string): Promise<Buffer | null> {
  if (driver === "s3") {
    /* getObject 没暴露在 ObjectStore 接口上——这里按需直接用 S3Client（与
       objectStore.ts 的 loadS3 同一条按需加载纪律）。 */
    const s3 = await import("@aws-sdk/client-s3");
    const endpoint = process.env.ARTIFACT_S3_ENDPOINT?.trim();
    const bucket = process.env.ARTIFACT_S3_BUCKET?.trim();
    if (!bucket) return null;
    const client = new s3.S3Client({
      region: process.env.ARTIFACT_S3_REGION?.trim() || "us-east-1",
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
    const result = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: storageKey }));
    const body = result.Body;
    if (!body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  const { readFile } = await import("node:fs/promises");
  const { fsStorageRoot } = await import("./objectStore.js");
  const file = resolve(join(fsStorageRoot(), storageKey));
  if (!file.startsWith(resolve(fsStorageRoot()) + "/")) return null;
  return readFile(file).catch(() => null);
}

/** 按附件名（zip 内路径的 basename）从报告包里取字节；找不到回 null。 */
export async function readReportAttachment(runId: string, name: string): Promise<{ content: Buffer; contentType: string } | null> {
  const artifact = await findReportArtifactRow(runId);
  if (!artifact) return null;
  const bytes = await readArtifactBytes(String(artifact.storage_driver), String(artifact.storage_key));
  if (!bytes) return null;
  try {
    const entry = readZip(bytes).find((each) => (each.name.split("/").pop() ?? "") === name);
    if (!entry) return null;
    return { content: entry.read(), contentType: guessAttachmentType(name) };
  } catch {
    return null;
  }
}

function guessAttachmentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

/**
 * 仓库执行报告的完整装载：run 摘要 + cases（timeline 的事实源）+ allure 视图（可能
 * 为 null——junit 任务没有报告包是正常态不是错误态）。`taskName` 单独带：分享页与
 * 报告列表的标题都读「任务名 #序号」，而 mapPipelineRun 刻意不含它（run 行上没有）。
 */
export async function loadRunnerReport(projectId: string, runId: string): Promise<{ run: PipelineRun; taskName: string; cases: PipelineRunCase[]; report: ReportView | null } | null> {
  const runRow = await pool.query(
    `SELECT pr.*, t.name AS task_name FROM pipeline_runs pr
       LEFT JOIN ci_tasks t ON t.id = pr.ci_task_id
      WHERE pr.id = $1 AND pr.project_id = $2`,
    [runId, projectId],
  );
  if (!runRow.rowCount) return null;
  const cases = await pool.query(
    `SELECT * FROM pipeline_run_cases
      WHERE pipeline_run_id = $1
      ORDER BY started_at_ms NULLS LAST, suite_name, case_name`,
    [runId],
  );
  const artifact = await findReportArtifactRow(runId);
  let report: ReportView | null = null;
  if (artifact) {
    try {
      report = await loadReportView(String(artifact.id), String(artifact.storage_driver), String(artifact.storage_key));
    } catch {
      /* 读不出来的包不该废掉整份分享：run 摘要与 cases 仍可读，报告视图降级为空。 */
      report = null;
    }
  }
  return {
    run: mapPipelineRun(runRow.rows[0]),
    taskName: String(runRow.rows[0].task_name ?? "ci task"),
    cases: cases.rows.map(mapPipelineRunCase),
    report,
  };
}
