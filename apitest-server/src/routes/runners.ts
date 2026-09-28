import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat as statFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, writeAuditLogAsync } from "../lib/audit.js";
import { decryptSecret } from "../lib/crypto.js";
import { currentUser } from "../lib/auth.js";
import { publishEvent } from "../lib/events.js";
import { buildJobSpec } from "../lib/jobSpec.js";
import {
  fsStorageRoot, fsTokenKey, getSharedObjectStore, requestBaseUrl, verifyFsUploadToken,
} from "../lib/objectStore.js";
import {
  appendPipelineRunLogs, completePipelineRun, publishPipelineTransition,
  RUNNER_COMPLETE_MAX_BODY_BYTES,
} from "../lib/pipelineRun.js";
import { waitForPipelineQueued } from "../lib/pipelineNotify.js";
import { DEFAULT_RUNNER_LABEL, RUNNER_LABEL_PATTERN } from "../lib/queue.js";
import { requireSystemAdmin } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import {
  authenticateRunner, isSupportedProtocolVersion, issueRunnerToken, protocolVersionRejection,
  type RunnerIdentity,
} from "../lib/runnerAuth.js";
import { isUuid } from "../lib/uuid.js";
import {
  RUNNER_HEARTBEAT_INTERVAL_SECONDS, RUNNER_OFFLINE_AFTER_SECONDS, RUNNER_POLL_TIMEOUT_SECONDS,
  SANDBOX_MODES, mapRunner, mapRunnerToken, type SandboxMode,
} from "../models/types.js";

/**
 * 自研 Runner 的注册协议与 Runner 池管理（P4.5-1，计划 8.2）。
 *
 * 两组接口，受众完全不同，别混：
 * - `/runner/*`：**Runner → 平台**，凭据是 `Bearer apirunner_…`，不走 JWT，不在
 *   `/api/v1/projects/:id` 之下——Runner 是系统级的，项目从 job 来。register / claim /
 *   heartbeat（P4.5-1/3）与 logs / complete（P4.5-4）都在这里。
 * - `/api/v1/system/runner-tokens`、`/api/v1/system/runners`：**浏览器 → 平台**，系统管理员。
 *
 * 路径前缀是 `/runner` 而**不是** Spec 2.10.2(c) 写的 `/worker`（8.2 的冲突记录①）：平台
 * 内部已经有「worker」这个词且指的是 BullMQ worker（`src/worker.ts`、`workers` 表、执行器
 * 面板），两个 worker 会让代码里每一处都要先问「哪个 worker」。
 */

/** 分区标签校验，与 `environments.ts` 的 `normalizeRunnerLabel` 同一个 pattern 与同一句错误信息。 */
function normalizeLabels(input: unknown, field: string): { labels?: string[]; error?: string } {
  if (input === undefined || input === null) return { labels: [DEFAULT_RUNNER_LABEL] };
  if (!Array.isArray(input)) return { error: `${field} must be an array of labels` };
  const labels = [...new Set(input.map((each) => String(each ?? "").trim()).filter(Boolean))];
  if (!labels.length) return { labels: [DEFAULT_RUNNER_LABEL] };
  for (const label of labels) {
    if (!RUNNER_LABEL_PATTERN.test(label)) {
      return { error: `${field} entry "${label}" must be 1–32 characters of lowercase letters, digits or hyphens, starting with a letter or digit` };
    }
  }
  return { labels };
}

/** 阶段枚举照抄迁移 038 的 CHECK（固定四段 + pending/done），心跳按它校验 stage。 */
const PIPELINE_STAGES = ["pending", "clone", "cache", "script", "report", "done"] as const;

/**
 * 租约时长 = 心跳判离线的同一个数（90 秒 = 三个心跳间隔，Spec 2.10.2）。
 *
 * `RUNNER_OFFLINE_AFTER_SECONDS` 的注释已经讲了为什么两者必须同源：面板的「在线」与
 * 租约的「活着」若是两个数，就会出现「面板在线但 job 被判 aborted」的窗口。
 */
const RUNNER_LEASE_SECONDS = RUNNER_OFFLINE_AFTER_SECONDS;

/**
 * 取一台**属于当前 token** 的 Runner 行；任何不满足都在这里回完响应并返回 undefined
 * （守卫先回话的纪律，调用方只判空）。
 *
 * 心跳与 claim 都要过这一层：runner_id 是客户端自报的，没有归属校验的话，一张泄漏的
 * token 就能替别的 Runner 领活、续租别人的租约。
 */
async function ownRunner(
  reply: FastifyReply,
  identity: RunnerIdentity,
  runnerId: string,
): Promise<Record<string, unknown> | undefined> {
  if (!isUuid(runnerId)) {
    fail(reply, 400, 1001, "runner_id must be the uuid returned by register");
    return undefined;
  }
  const result = await pool.query("SELECT * FROM runners WHERE id = $1", [runnerId]);
  if (!result.rowCount) {
    fail(reply, 404, 2001, "runner not found");
    return undefined;
  }
  if (String(result.rows[0].runner_token_id) !== identity.tokenId) {
    fail(reply, 403, 1003, "this token does not own this runner");
    return undefined;
  }
  return result.rows[0];
}

/**
 * fs 直传的计数 + 上限 + sha256 三合一 Transform：pipeline 的中间一站，超限即抛
 * （pipeline 会销毁上下游，路由删半截文件）。声明大小是 Runner 申请时给的，平台
 * 收到的字节数必须等于它——不校验的话 `size_bytes` 就是一个可以随便撒的字段。
 */
class TransformStreamCounter extends Transform {
  private written = 0;

  constructor(private readonly limit: number, private readonly hasher: import("node:crypto").Hash) {
    super();
  }

  _transform(chunk: Buffer, _encoding: string, callback: import("node:stream").TransformCallback): void {
    this.written += chunk.length;
    if (this.written > this.limit) {
      callback(new Error(`payload exceeds the declared size (${this.limit} bytes)`));
      return;
    }
    this.hasher.update(chunk);
    callback(null, chunk);
  }

  get bytesWritten(): number {
    return this.written;
  }
}

export async function runnerRoutes(app: FastifyInstance) {
  /* 长轮询会占住一条 HTTP 连接最长 25 秒（8.2 约定 2）：keepAliveTimeout 必须大于它，
     否则平台会在响应前先关掉连接，Runner 读到 socket hang up。Fastify 默认 72 秒已经
     够，这里只做防御性下限——部署侧如果显式改小过，这一行把它顶回安全值。 */
  app.server.keepAliveTimeout = Math.max(app.server.keepAliveTimeout, RUNNER_POLL_TIMEOUT_SECONDS * 1000 + 10_000);

  /* fs 直传（PUT /runner/artifacts/:id/upload）带的是原始字节流：Fastify 对没有
     parser 的 content-type 回 415，这里注册成「不解析、直接放行到 handler」——
     handler 里 request.raw 才是事实源。只放行这一个类型，不给 JSON 路由开口子。
     **不能给 parseAs**：buffer/string 都会把流读完，handler 的 pipeline(request.raw)
     只剩 EOF——上传「成功」、文件 0 字节；不指定 parseAs 时 body 就是原始流本身，
     done(null, body) 原样放行，流仍归 handler 消费。 */
  app.addContentTypeParser("application/octet-stream", (_request, body, done) => {
    done(null, body);
  });

  /**
   * Runner 注册（8.2 接口 1）。
   *
   * **幂等于 `(runner_token_id, name)`**（8.2 约定 3）：Runner 重启后用同一个 `runner_id`
   * 回来，否则每次重启都在面板上留一行僵尸。靠迁移 036 的唯一索引 + `ON CONFLICT`，不靠
   * 「先 SELECT 再 INSERT」——崩溃重启后的并发重注册会让那种两步式双双通过。
   *
   * 不走 `requireProjectAccess` / `currentUser`：调用者是一台自托管机器而不是登录用户。
   */
  app.post<{
    Body: {
      name?: string; labels?: unknown; capacity?: number; sandboxModes?: unknown;
      sandbox_modes?: unknown; version?: string; protocolVersion?: string; protocol_version?: string;
      dockerTransport?: string; docker_transport?: string;
    };
  }>("/runner/register", async (request, reply) => {
    const identity = await authenticateRunner(request.headers.authorization);
    if (!identity) return fail(reply, 401, 1002, "runner token is invalid or revoked");

    const body = request.body ?? {};
    /* Runner 是别人写的客户端（首版是我们自己的 `apitest-runner`，但协议是公开的），
       所以 snake_case 与 camelCase 两种拼法都收。这不是给平台自己的前端开的后门——
       JobSpec 用的是 snake_case（8.2），一个只读过协议文档的实现自然会用它。 */
    const protocolVersion = String(body.protocolVersion ?? body.protocol_version ?? "").trim();
    /* 版本受理放在注册这一步（验收门槛 16）：不支持的 Runner 若能注册成功，它会一直长
       轮询、领到 JobSpec、再在某个新字段上炸掉——用户看到的是一条 failed 的 run。 */
    if (!isSupportedProtocolVersion(protocolVersion)) {
      return fail(reply, 400, 1001, protocolVersionRejection(protocolVersion));
    }

    const name = body.name?.trim();
    if (!name) return fail(reply, 400, 1001, "name is required");

    const declared = normalizeLabels(body.labels, "labels");
    if (declared.error) return fail(reply, 400, 1001, declared.error);
    const labels = declared.labels ?? [DEFAULT_RUNNER_LABEL];
    /**
     * **分区防御**（迁移 036 的注释，验收门槛 3）：`labels ⊆ runner_tokens.labels`。
     *
     * 没有这一条，任何一台拿到 token 的机器都能声明 `labels=['prod-dmz']` 并开始领生产
     * 网段的任务。它是 P2-8 边界 6 「认领语句加分区防御」的同构物，只是那里的攻击面是
     * 「job 被投错队列」，这里是「机器自称在别的网段」，后者更严重。
     *
     * 403 而不是 400：请求本身是合法的，被拒的是权限。
     */
    const extra = labels.filter((label) => !identity.allowedLabels.includes(label));
    if (extra.length) {
      return fail(reply, 403, 1003, `this token may only declare labels ${identity.allowedLabels.join(", ")}; rejected ${extra.join(", ")}`);
    }

    const rawModes = body.sandboxModes ?? body.sandbox_modes;
    let sandboxModes: SandboxMode[] = ["process"];
    if (rawModes !== undefined && rawModes !== null) {
      if (!Array.isArray(rawModes)) return fail(reply, 400, 1001, "sandboxModes must be an array");
      const modes = [...new Set(rawModes.map((each) => String(each ?? "").trim()).filter(Boolean))];
      const unsupported = modes.filter((mode) => !(SANDBOX_MODES as readonly string[]).includes(mode));
      if (unsupported.length) return fail(reply, 400, 1001, `sandboxModes must be a subset of ${SANDBOX_MODES.join(", ")}; got ${unsupported.join(", ")}`);
      /* 空数组读成「只有进程档」而不是「什么都不支持」：后者会让这台 Runner 永远领不到
         任何任务，且面板上看不出原因。 */
      if (modes.length) sandboxModes = modes as SandboxMode[];
    }

    /* 容量是「同时能跑几个 job」。0 或负数没有意义（那是 draining，有专门的状态列表达），
        上限 64 是一个防手误的护栏而不是能力声明。 */
    const capacity = Math.min(64, Math.max(1, Math.floor(Number(body.capacity ?? 1)) || 1));

    /* 容器档通道自报（迁移 046）：cli（docker run 命令）/ api（Engine API over socket）。
       只认这两个值，别的原样存着但读侧显示「未知」——协议是公开的，不该为它拒注册。 */
    const dockerTransportRaw = String(body.dockerTransport ?? body.docker_transport ?? "").trim().toLowerCase();
    const dockerTransport = dockerTransportRaw === "cli" || dockerTransportRaw === "api" ? dockerTransportRaw : "";

    const result = await pool.query(
      `INSERT INTO runners (id, runner_token_id, name, labels, capacity, sandbox_modes, docker_transport, version, protocol_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (runner_token_id, name) DO UPDATE SET
         labels = EXCLUDED.labels, capacity = EXCLUDED.capacity,
         sandbox_modes = EXCLUDED.sandbox_modes, docker_transport = EXCLUDED.docker_transport,
         version = EXCLUDED.version,
         protocol_version = EXCLUDED.protocol_version,
         /* 重注册**回到 online**：draining 是「这台机器要下线了」这个人为决定，而重启
            后重新注册说的是「我回来了」。保留 draining 会让一台被 drain 过的机器在重装
            升级后永远领不到任务，且面板上看不出为什么。
            registered_at 一并刷新：面板上这一列要回答「这个 Runner 进程是什么时候起来
            的」，而「这台机器第一次出现在平台上是哪天」没有人问。
            （注意：这段注释在模板字符串里，字面反引号会提前终止字面量——别加回来。） */
         status = 'online', last_seen_at = now(), registered_at = now()
       RETURNING *`,
      [randomUUID(), identity.tokenId, name, labels, capacity, sandboxModes, dockerTransport, String(body.version ?? "").trim(), protocolVersion],
    );

    /* 心跳间隔与长轮询窗口由**平台**下发，Runner 不自己定（8.2 接口 1 的响应）：
       租约时长（90 秒）是平台侧租约回收器的判据，让客户端自选间隔等于让它自己决定多久
       算掉线。

       响应字段是 camelCase 而不是 8.2 表格里写的 `runner_id`：整个平台的 API 边界是
       camelCase（server-contract 规则 6），为一组接口开一个 snake_case 例外，代价是
       `models/types.ts` 那条「DB 说 snake_case、API 说 camelCase」的单一边界从此有两种
       答案。**请求侧两种拼法都收**（见上），所以第三方实现不会因此被卡住。 */
    return success({
      runnerId: String(result.rows[0].id),
      heartbeatIntervalSeconds: RUNNER_HEARTBEAT_INTERVAL_SECONDS,
      pollTimeoutSeconds: RUNNER_POLL_TIMEOUT_SECONDS,
      protocolVersion,
    });
  });

  /**
   * 领取一个 job（8.2 接口 2，P4.5-3）。**长轮询**：立刻试一次认领，没领到就在
   * `pipeline_queued` 上按标签等通知，窗口 25 秒（与 SSE 心跳同款，避开常见 30 秒代理
   * 超时），到期仍无 job 回 `204`——Runner 的循环节奏由它自己定，平台只保证「有活干时
   * 秒级醒」。
   *
   * **认领是一条服务端 UPDATE，不是队列 pop**（边界 4）：`FOR UPDATE SKIP LOCKED` 让
   * 10 台 Runner 同时轮询同一批 queued 行时只有一台拿到、其余立刻重试而不是阻塞在锁上
   * （验收门槛 2）。`sandbox_mode = ANY($sandbox_modes)` 是 P2-8 边界 6 的同构物：不支持
   * 容器档的 Runner 在 clone 之前就领不到容器任务，而不是跑到一半失败。
   */
  app.post<{
    Body: { runner_id?: string; runnerId?: string; capacity_available?: number; capacityAvailable?: number };
  }>("/runner/claim", async (request, reply) => {
    const identity = await authenticateRunner(request.headers.authorization);
    if (!identity) return fail(reply, 401, 1002, "runner token is invalid or revoked");
    const runnerId = String(request.body?.runner_id ?? request.body?.runnerId ?? "").trim();
    const runnerRow = await ownRunner(reply, identity, runnerId);
    if (!runnerRow) return;
    /* draining 的机器不再参与 claim（迁移 036）：在跑的任务跑完，心跳仍可用。403 让
       Runner 的轮询循环明确退场，204 会让它空转到下一个 25 秒才死心。 */
    if (String(runnerRow.status) === "draining") {
      return fail(reply, 403, 1003, "this runner is draining and no longer claims jobs; finish in-flight work and shut down");
    }
    const labels = Array.isArray(runnerRow.labels) && runnerRow.labels.length ? (runnerRow.labels as unknown[]).map(String) : [DEFAULT_RUNNER_LABEL];
    const sandboxModes = (Array.isArray(runnerRow.sandbox_modes) && runnerRow.sandbox_modes.length
      ? (runnerRow.sandbox_modes as unknown[]).map(String)
      : ["process"]) as SandboxMode[];

    /* 认领请求本身就是活性证据：刷新 runner 行的心跳，让面板在两次心跳之间也说得清
       「这台机器在轮询」。 */
    void pool.query("UPDATE runners SET last_seen_at = now() WHERE id = $1", [runnerId]).catch(() => {});

    /* 没有空槽就别等：容量为 0 时占住连接 25 秒，只会让代理超时统计变难看。 */
    const capacity = Math.max(0, Math.floor(Number(request.body?.capacity_available ?? request.body?.capacityAvailable ?? 1)) || 0);
    if (capacity <= 0) return reply.code(204).send();

    const claimOne = () => pool.query(
      `WITH picked AS (
         SELECT pr.id FROM pipeline_runs pr
           JOIN ci_tasks t ON t.id = pr.ci_task_id
          WHERE pr.status = 'queued' AND pr.runner_label = ANY($2) AND pr.sandbox_mode = ANY($3)
            /* 任务级串行（P4.5-12，迁移 042）：开着 single_concurrency 的任务，同一时刻只有
               序号最小的在途 run 可被认领。守卫写在**认领侧**而不是触发侧，是因为「排队而
               不是拒绝」是用户要的语义：触发照常 202、行照常入 queued，只是暂时领不走，
               前置 run 一落终态它自动就可领了——没有任何重试逻辑参与。
               子查询按 (ci_task_id, run_number) 走迁移 038 的 pipeline_runs_task_number_idx。 */
            AND (NOT t.single_concurrency OR NOT EXISTS (
              SELECT 1 FROM pipeline_runs earlier
               WHERE earlier.ci_task_id = pr.ci_task_id
                 AND earlier.run_number < pr.run_number
                 AND earlier.status IN ('queued', 'claimed', 'running', 'cancelling')
            ))
          ORDER BY pr.created_at
          FOR UPDATE OF pr SKIP LOCKED LIMIT 1
       )
       UPDATE pipeline_runs pr SET status = 'claimed', runner_id = $1, claimed_at = now(),
              lease_expires_at = now() + ($4 || ' seconds')::interval
        WHERE pr.id IN (SELECT id FROM picked)
        RETURNING pr.*`,
      [runnerId, labels, sandboxModes, RUNNER_LEASE_SECONDS],
    );

    const deadline = Date.now() + RUNNER_POLL_TIMEOUT_SECONDS * 1000;
    for (;;) {
      const picked = await claimOne();
      if (picked.rowCount) {
        const run = picked.rows[0];
        try {
          /* 认领成功即发 `claimed`（SSE 事件，P4.5-4）：执行详情页的「排队 → 已认领」
             推进靠它，不等第一段日志。 */
          await publishPipelineTransition(String(run.project_id), String(run.id), "claimed");
          /* 平台对外根地址：优先部署侧显式配置（反代后面 Host 头常常是内网名），缺省用
             Runner 实际拨号的来源地址（Host 头，带端口——`request.hostname` 剥端口，
             见 requestBaseUrl 的注释）——它对这台机器必然可达。SDK 对根地址与完整
             /ingest 两种写法都归一（apitrack-sdk config.py）。 */
          const baseUrl = requestBaseUrl(request);
          return success(await buildJobSpec(baseUrl, run));
        } catch (error) {
          /* 组装失败（任务行竞态消失、密文损坏）把行放回 queued 让别的 Runner 还有机会，
             而不是留一条已认领却永远等不到心跳的 run 等回收器判死。 */
          await pool.query(
            "UPDATE pipeline_runs SET status = 'queued', runner_id = NULL, claimed_at = NULL, lease_expires_at = NULL WHERE id = $1 AND status = 'claimed' AND runner_id = $2",
            [String(run.id), runnerId],
          ).catch(() => {});
          return fail(reply, 500, 5001, error instanceof Error ? error.message : "job spec could not be assembled");
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reply.code(204).send();
      await waitForPipelineQueued(labels, remaining);
    }
  });

  /**
   * 心跳（8.2 接口 3）：续租 + 汇报阶段与日志水位 + **取消只经这里下发**（约定 6）。
   *
   * 租约判据是 `lease_expires_at`（边界 5）：每次心跳续到 `now() + 90s`，scheduler 的
   * 回收器按过期判 `aborted`。`log_bytes` 单调推进（GREATEST）：Runner 重启后从落盘
   * 水位重报一个旧值，不该把总长倒回去。
   */
  app.post<{
    Params: { jobId: string };
    Body: { runner_id?: string; runnerId?: string; stage?: string; log_bytes?: number; logBytes?: number };
  }>("/runner/jobs/:jobId/heartbeat", async (request, reply) => {
    const identity = await authenticateRunner(request.headers.authorization);
    if (!identity) return fail(reply, 401, 1002, "runner token is invalid or revoked");
    if (!isUuid(request.params.jobId)) return fail(reply, 404, 2001, "pipeline run not found");
    const runnerId = String(request.body?.runner_id ?? request.body?.runnerId ?? "").trim();
    const runnerRow = await ownRunner(reply, identity, runnerId);
    if (!runnerRow) return;

    const stage = request.body?.stage === undefined || request.body?.stage === null ? undefined : String(request.body.stage);
    if (stage && !(PIPELINE_STAGES as readonly string[]).includes(stage)) return fail(reply, 400, 1001, `stage must be one of ${PIPELINE_STAGES.join(", ")}`);
    const rawLogBytes = request.body?.log_bytes ?? request.body?.logBytes;
    let logBytes: number | undefined;
    if (rawLogBytes !== undefined && rawLogBytes !== null) {
      logBytes = Math.floor(Number(rawLogBytes));
      if (!Number.isFinite(logBytes) || logBytes < 0) return fail(reply, 400, 1001, "log_bytes must be a non-negative integer");
    }

    void pool.query("UPDATE runners SET last_seen_at = now() WHERE id = $1", [runnerId]).catch(() => {});

    const result = await pool.query(
      `UPDATE pipeline_runs SET
           stage = COALESCE($3::text, stage),
           log_bytes = GREATEST(log_bytes, COALESCE($4::bigint, log_bytes)),
           lease_expires_at = now() + ($5 || ' seconds')::interval
         WHERE id = $1 AND runner_id = $2 AND status IN ('claimed', 'running', 'cancelling')
         RETURNING status, lease_expires_at`,
      [request.params.jobId, runnerId, stage ?? null, logBytes ?? null, RUNNER_LEASE_SECONDS],
    );
    /* 终态（complete 已落 / 租约被回收判 aborted / 被别的 Runner 认领）一律 409：Runner
       把它读作「这个 job 不再是我的」，停心跳、走退出码补报那条路（P4.5-5）。 */
    if (!result.rowCount) {
      return fail(reply, 409, 2004, "pipeline run is not active for this runner; it may have completed, been aborted after lease expiry, or been re-claimed");
    }
    const row = result.rows[0];
    return success({
      /* snake_case：8.2 协议表冻结的响应形状（register 的 camelCase 是 P4.5-1 的已记录
         偏差，新的协议接口跟协议文档走，不跟着偏差走）。 */
      lease_expires_at: row.lease_expires_at ? new Date(String(row.lease_expires_at)).toISOString() : null,
      cancel: String(row.status) === "cancelling",
    });
  });

  /**
   * 日志上报（8.2 接口 4，P4.5-4）。
   *
   * 去重靠 `UNIQUE (pipeline_run_id, byte_offset)`（边界 7）：断线重传撞唯一键幂等收，
   * 丢的窗口由 offset 续传补上。`next_offset` 回的是**当前总长**（`log_bytes`）——Runner
   * 断线重连后「我上次报到哪了」的答案就是它。SSE 只发水位（`pipelineLog` 事件不带日志
   * 内容，8.6），前端按 offset 拉增量。
   *
   * 终态后仍收（回 ok）：Runner 杀进程树后残余输出还会流一小会儿，拒了只会丢尾部日志。
   */
  app.post<{
    Params: { jobId: string };
    Body: { runner_id?: string; runnerId?: string; byte_offset?: number; byteOffset?: number; chunk?: string };
  }>("/runner/jobs/:jobId/logs", async (request, reply) => {
    const identity = await authenticateRunner(request.headers.authorization);
    if (!identity) return fail(reply, 401, 1002, "runner token is invalid or revoked");
    if (!isUuid(request.params.jobId)) return fail(reply, 404, 2001, "pipeline run not found");
    const runnerId = String(request.body?.runner_id ?? request.body?.runnerId ?? "").trim();
    const runnerRow = await ownRunner(reply, identity, runnerId);
    if (!runnerRow) return;

    const rawOffset = request.body?.byte_offset ?? request.body?.byteOffset;
    const byteOffset = Math.floor(Number(rawOffset));
    if (rawOffset === undefined || rawOffset === null || !Number.isFinite(byteOffset) || byteOffset < 0) {
      return fail(reply, 400, 1001, "byte_offset must be a non-negative integer");
    }
    const chunk = typeof request.body?.chunk === "string" ? request.body.chunk : "";
    if (!chunk.length) return fail(reply, 400, 1001, "chunk is required and cannot be empty");

    void pool.query("UPDATE runners SET last_seen_at = now() WHERE id = $1", [runnerId]).catch(() => {});

    const result = await appendPipelineRunLogs({ runId: request.params.jobId, runnerId, byteOffset, chunk });
    if (!result.ok) {
      if (result.reason === "not_found") return fail(reply, 404, 2001, "pipeline run not found");
      if (result.reason === "not_owner") return fail(reply, 403, 1003, "this runner does not own this pipeline run");
      return fail(reply, 409, 2004, "byte_offset conflicts with already-received logs; retry from the returned next_offset");
    }

    /* 第一次收到输出即视为「真的在跑了」：claimed → running 的推进不靠心跳的 stage，
       而靠日志这一刻的硬证据（stage 可以停在 clone，日志从 clone 就开始流）。 */
    if (byteOffset === 0) {
      const started = await pool.query(
        `UPDATE pipeline_runs SET status = 'running', started_at = COALESCE(started_at, now())
           WHERE id = $1 AND runner_id = $2 AND status = 'claimed'
         RETURNING project_id`,
        [request.params.jobId, runnerId],
      );
      if (started.rowCount) await publishPipelineTransition(String(started.rows[0].project_id), request.params.jobId, "running");
    }

    /* 日志水位事件：载荷只有 `{pipelineRunId, logBytes}`（8.6），内容由前端按 offset 拉取。 */
    void publishEvent({ kind: "pipelineLog", projectId: result.projectId, pipelineRunId: request.params.jobId, logBytes: result.totalLogBytes }).catch(() => {});

    return success({ next_offset: result.nextOffset });
  });

  /**
   * 完成上报（8.2 接口 6，P4.5-4）。
   *
   * **必须幂等**（约定 5）：Runner 在收到响应前断线会重发，第二次撞终态守卫返回
   * `{ok:true}` 而不是报错——报错会让 Runner 无限重试。守卫、归一写入（kind='runner'）、
   * `cases[]` 落库、ingest token 吊销全在 `completePipelineRun` 的一个事务里。
   *
   * 路由级 `bodyLimit`（P4.5-6）：`cases[]` 带整份报告解析结果，默认 1MB 盛不下
   * MAX_REPORT_CASES 行的真实报告——与 `/ingest` 同款，在解析之前拒掉（413）而不是
   * 读完再数。Runner 侧有自己的载荷预算（6MB），正常路径到不了这道闸。
   */
  app.post<{
    Params: { jobId: string };
    Body: {
      runner_id?: string; runnerId?: string; status?: string; exit_code?: number; exitCode?: number;
      commit_sha?: string; commitSha?: string; error?: string; cases?: unknown[];
    };
  }>("/runner/jobs/:jobId/complete", { bodyLimit: RUNNER_COMPLETE_MAX_BODY_BYTES }, async (request, reply) => {
    const identity = await authenticateRunner(request.headers.authorization);
    if (!identity) return fail(reply, 401, 1002, "runner token is invalid or revoked");
    if (!isUuid(request.params.jobId)) return fail(reply, 404, 2001, "pipeline run not found");
    const runnerId = String(request.body?.runner_id ?? request.body?.runnerId ?? "").trim();
    const runnerRow = await ownRunner(reply, identity, runnerId);
    if (!runnerRow) return;

    const body = request.body ?? {};
    const exitCodeRaw = body.exit_code ?? body.exitCode;
    const exitCode = exitCodeRaw === undefined || exitCodeRaw === null ? undefined : Math.trunc(Number(exitCodeRaw));
    if (exitCode !== undefined && !Number.isFinite(exitCode)) return fail(reply, 400, 1001, "exit_code must be an integer");

    void pool.query("UPDATE runners SET last_seen_at = now() WHERE id = $1", [runnerId]).catch(() => {});

    const result = await completePipelineRun({
      runId: request.params.jobId,
      runnerId,
      status: String(body.status ?? ""),
      exitCode,
      commitSha: body.commit_sha ?? body.commitSha,
      cases: Array.isArray(body.cases) ? (body.cases as Record<string, unknown>[]) : [],
      error: body.error,
    });
    if (!result.ok) {
      if (result.reason === "not_found") return fail(reply, 404, 2001, "pipeline run not found");
      if (result.reason === "not_owner") return fail(reply, 403, 1003, "this runner does not own this pipeline run");
      return fail(reply, 409, 2004, result.message ?? "pipeline run is not active for this runner; it may have completed or been aborted after lease expiry");
    }
    /* 协议响应形状（8.2）：`{ok: true}`。 */
    return success({ ok: true });
  });

  /**
   * 申请产物直传（8.2 接口 5，P4.5-7）。
   *
   * **平台永不代理大文件流**（边界 14）：这里只写 `artifacts` 元数据行（`uploaded_at`
   * NULL = 申请了但没传成）并返回上传目标——s3 是 pre-signed PUT URL，fs 是带一次性
   * HMAC token 的平台上传地址。字节不进这个进程。
   *
   * 认领关系按 **JobSpec 的持久事实**（`pipeline_runs.runner_id`）判，不信任 body 里的
   * `runner_id` 是否与 run 匹配之外的东西：终态后**仍允许申请**——Runner 收尾顺序是
   * 「complete → 传产物」，卡死在终态会让每个任务的最后一批产物（往往是最有价值的
   * 失败报告）全部丢失。这与 logs 终态后仍收是同一条纪律。
   */
  app.post<{
    Params: { jobId: string };
    Body: {
      runner_id?: string; runnerId?: string; kind?: string; name?: string;
      size_bytes?: number; sizeBytes?: number; content_type?: string; contentType?: string; checksum?: string;
    };
  }>("/runner/jobs/:jobId/artifacts", async (request, reply) => {
    const identity = await authenticateRunner(request.headers.authorization);
    if (!identity) return fail(reply, 401, 1002, "runner token is invalid or revoked");
    if (!isUuid(request.params.jobId)) return fail(reply, 404, 2001, "pipeline run not found");
    const runnerId = String(request.body?.runner_id ?? request.body?.runnerId ?? "").trim();
    const runnerRow = await ownRunner(reply, identity, runnerId);
    if (!runnerRow) return;

    const kind = String(request.body?.kind ?? "file");
    if (!["log", "report", "file"].includes(kind)) return fail(reply, 400, 1001, "kind must be one of log, report, file");
    /* 名字进 artifacts.name（UI 显示 + 下载文件名），不是存储键：防止 `../../x` 之类
       的路径语义混进来，长度上限对齐 ci_tasks 的路径护栏。 */
    const name = String(request.body?.name ?? "").trim().slice(0, 255);
    if (!name) return fail(reply, 400, 1001, "name is required");
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      return fail(reply, 400, 1001, "name must be a file name, not a path");
    }
    const rawSize = request.body?.size_bytes ?? request.body?.sizeBytes;
    const sizeBytes = Math.floor(Number(rawSize));
    if (rawSize === undefined || rawSize === null || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
      return fail(reply, 400, 1001, "size_bytes must be a non-negative integer");
    }
    /* 单文件上限（fs 驱动的下载直链走平台带宽，s3 侧由桶策略兜底）：1GB 对齐 allure
       报告 + 截图的量级，再大的该走自己的存储。 */
    if (sizeBytes > 1024 * 1024 * 1024) return fail(reply, 400, 1001, "size_bytes exceeds the 1GB per-artifact cap");
    const contentType = String(request.body?.content_type ?? request.body?.contentType ?? "application/octet-stream").slice(0, 255);
    const checksum = String(request.body?.checksum ?? "").slice(0, 128);

    /* 归属与在途：行还在、归这台 Runner 才发上传目标（终态不挡，见上注）。 */
    const run = await pool.query(
      "SELECT project_id, runner_id FROM pipeline_runs WHERE id = $1",
      [request.params.jobId],
    );
    if (!run.rowCount) return fail(reply, 404, 2001, "pipeline run not found");
    if (String(run.rows[0].runner_id ?? "") !== runnerId) {
      return fail(reply, 403, 1003, "this runner does not own this pipeline run");
    }

    void pool.query("UPDATE runners SET last_seen_at = now() WHERE id = $1", [runnerId]).catch(() => {});

    const artifactId = randomUUID();
    const store = await getSharedObjectStore(requestBaseUrl(request));
    const target = await store.presignPut(artifactId, { contentType, sizeBytes });

    /* 存储键：驱动内寻址产物的方式。s3 用 artifact_id 当对象键（UUID 无碰撞、不泄
       露用户命名）；fs 的键在 upload 端点拼路径——两个驱动对「键怎么变成位置」各
       自回答，这层不掺和。 */
    await pool.query(
      `INSERT INTO artifacts (
         id, project_id, owner_type, owner_id, kind, name, storage_driver, storage_key,
         size_bytes, content_type, checksum
       ) VALUES ($1, $2, 'pipeline_run', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [artifactId, String(run.rows[0].project_id), request.params.jobId, kind, name,
        store.driver, store.driver === "s3" ? artifactId : `${request.params.jobId}/${artifactId}`,
        sizeBytes, contentType, checksum],
    );

    /* 协议响应（8.2 接口 5）：snake_case，headers 原样转发（fs 的上传 token 在里面）。 */
    return success({
      artifact_id: artifactId,
      upload_url: target.uploadUrl,
      method: target.method,
      headers: target.headers,
      expires_at: target.expiresAt,
    });
  });

  /**
   * fs 驱动的直传落盘端点（P4.5-7）。字节流**不经过 JSON 信封**：路由只认
   * `application/octet-stream`（Fastify 默认不解析它，`request.raw` 就是事实源），
   * 流式写进 `<ARTIFACT_FS_ROOT>/<storage_key>` 后回写 `uploaded_at`。
   *
   * 鉴权不是 `apirunner_` token：上传 URL 是申请接口发给 Runner 的**一次性凭据**
   * （HMAC 绑 artifact_id + 过期），s3 驱动的对应物是 URL 里的签名——两边都不再带
   * 注册 token，与「presigned URL 是独立凭据」的语义一致。
   */
  app.put<{ Params: { artifactId: string } }>(
    "/runner/artifacts/:artifactId/upload",
    async (request, reply) => {
      if (!isUuid(request.params.artifactId)) return fail(reply, 404, 2001, "artifact not found");
      const token = String(request.headers["x-apitrack-upload-token"] ?? "");
      if (!token || !verifyFsUploadToken(request.params.artifactId, token)) {
        return fail(reply, 403, 1003, "upload token is invalid or expired");
      }

      const artifact = await pool.query(
        "SELECT id, storage_key, size_bytes, uploaded_at FROM artifacts WHERE id = $1 AND storage_driver = 'fs'",
        [request.params.artifactId],
      );
      if (!artifact.rowCount) return fail(reply, 404, 2001, "artifact not found");
      const row = artifact.rows[0];
      /* 幂等：同 token 窗口内重传同一产物，直接回 ok（文件内容相同；token 校验已过）。 */
      if (row.uploaded_at) return success({ uploaded: true });

      const target = resolve(join(fsStorageRoot(), String(row.storage_key)));
      /* 防御性逃逸检查：storage_key 是自己拼的，但这条路径的来源是「run id + UUID」，
         resolve 之后必须仍落在存储根内。 */
      if (!target.startsWith(resolve(fsStorageRoot()) + "/")) {
        return fail(reply, 500, 5001, "artifact storage key escapes the storage root");
      }
      await mkdir(dirname(target), { recursive: true });

      /* 声明大小即上限：超了立刻断流删半截文件——不按声明收下的字节数会让 artifacts
         表的 size_bytes 变成一个可以随便撒的字段。落库读 TransformStreamCounter 的
         实测值而不是这里另算（2026-09-02 验收反馈第三批 ④：原版有个从未被赋值的
         `written` 局部量，文件落盘是对的、库里永远记 0，产物列表全是 0 B）。 */
      const declared = Number(row.size_bytes);
      const hasher = createHash("sha256");
      const guard = new TransformStreamCounter(declared, hasher);
      try {
        await pipeline(request.raw, guard, createWriteStream(target));
      } catch (error) {
        await unlink(target).catch(() => {});
        return fail(reply, 400, 1001, error instanceof Error ? error.message : "upload failed");
      }

      await pool.query(
        "UPDATE artifacts SET uploaded_at = now(), size_bytes = $2, checksum = CASE WHEN $3 = '' THEN checksum ELSE $3 END WHERE id = $1",
        [request.params.artifactId, guard.bytesWritten, hasher.digest("hex")],
      );
      return success({ uploaded: true, size_bytes: guard.bytesWritten });
    },
  );

  /**
   * 上传完成确认（s3 驱动的 `uploaded_at` 落位点）。fs 的 PUT 端点自己回写上传时刻
   * （见上）；s3 的 pre-signed PUT 直连对象存储，平台侧唯一的事实源是存储本身——
   * Runner 直传成功后调这里，服务端 HeadObject 核对象在、再回写 `uploaded_at`。
   * 不核就写等于把「报告列表过滤 uploaded_at IS NOT NULL」的判据交给客户端的嘴。
   * fs 驱动也收（幂等 true）：协议不用按驱动分叉，Runner 无条件确认即可。
   */
  app.post<{ Params: { artifactId: string }; Body: { runner_id?: string; runnerId?: string } }>(
    "/runner/artifacts/:artifactId/uploaded",
    async (request, reply) => {
      const identity = await authenticateRunner(request.headers.authorization);
      if (!identity) return fail(reply, 401, 1002, "runner token is invalid or revoked");
      if (!isUuid(request.params.artifactId)) return fail(reply, 404, 2001, "artifact not found");
      const runnerId = String(request.body?.runner_id ?? request.body?.runnerId ?? "").trim();
      const runnerRow = await ownRunner(reply, identity, runnerId);
      if (!runnerRow) return;

      const artifact = await pool.query(
        "SELECT id, storage_driver, storage_key, uploaded_at FROM artifacts WHERE id = $1",
        [request.params.artifactId],
      );
      if (!artifact.rowCount) return fail(reply, 404, 2001, "artifact not found");
      const row = artifact.rows[0];
      /* 幂等：重复确认（重试窗口内的重发）直接回 ok。 */
      if (row.uploaded_at) return success({ uploaded: true });

      const store = await getSharedObjectStore(requestBaseUrl(request));
      const exists = await store.objectExists(String(row.storage_key)).catch(() => false);
      if (!exists) return fail(reply, 409, 2004, "artifact object was not found in storage; the upload may have failed");
      await pool.query("UPDATE artifacts SET uploaded_at = now() WHERE id = $1 AND uploaded_at IS NULL", [
        request.params.artifactId,
      ]);
      return success({ uploaded: true });
    },
  );

  /**
   * fs 驱动的下载直链（P4.5-7）。鉴权同上传：一次性 HMAC token（绑 storage_key +
   * 过期），浏览器从产物列表拿到 URL 直接跳——列表接口（P4.5-11）经
   * `presignGet` 生成这里带的 token。
   *
   * 路径是通配：storage_key 形如 `<run_id>/<artifact_id>`，带斜杠，`:key` 参数
   * 匹配不了多段，结尾通配是 find-my-way 下唯一能收下它的形状。签名绑的是
   * **完整 key**，通配不放宽鉴权。
   */
  app.get<{ Params: { "*": string }; Querystring: { expires?: string; token?: string; name?: string } }>(
    "/runner/artifacts/*",
    async (request, reply) => {
      /* 通配段必须是路由的最后一段（find-my-way 的硬约束：通配符后再跟字面量段——
         比如这里的 download 后缀——会在注册时直接抛错，启动即崩，P4.5-7 落地时踩过）。
         所以注册成 `/runner/artifacts/` + 结尾通配，把 download 当通配段的尾巴剥掉，
         URL 对外形状不变。find-my-way 对通配参数整体解码（%2F 斜杠 → /），代理
         解码后的字面斜杠同样命中结尾通配——presignGet 生成的编码形态与被代理改写
         的形态在这里归一成同一个 key。别改回按 request.raw.url 切：它带着整个
         query string，锚定结尾的正则永远匹配不上，key 恒空恒 403。 */
      const star = String(request.params["*"] ?? "");
      const key = star.endsWith("/download") ? star.slice(0, -"/download".length) : "";
      const token = String(request.query?.token ?? "");
      const expires = Number(request.query?.expires ?? 0);
      if (!key || !token || !Number.isFinite(expires) || expires <= Math.floor(Date.now() / 1000)) {
        return fail(reply, 403, 1003, "download link is invalid or expired");
      }
      const expected = `${expires}.${createHmac("sha256", fsTokenKey()).update(`${key}.${expires}`).digest("base64url")}`;
      const a = Buffer.from(token);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return fail(reply, 403, 1003, "download link is invalid or expired");
      }
      const file = resolve(join(fsStorageRoot(), key));
      if (!file.startsWith(resolve(fsStorageRoot()) + "/")) return fail(reply, 404, 2001, "artifact not found");
      const stats = await statFile(file).catch(() => undefined);
      if (!stats || !stats.isFile()) return fail(reply, 404, 2001, "artifact not found");
      const name = String(request.query?.name ?? "").replace(/[^\w.\-]+/g, "_") || "artifact";
      reply.header("content-disposition", `attachment; filename="${name}"`);
      reply.header("content-length", String(stats.size));
      return reply.send(createReadStream(file));
    },
  );

  /**
   * Runner 注册 Token 列表（系统管理员）。
   *
   * `runner_tokens` 是**系统级**的（8.1）：一台自托管机器服务的是一个网段，而网段上可能
   * 有多个项目的被测服务。所以这几条路由在 `/api/v1/system` 下，而不是项目下。
   */
  app.get("/api/v1/system/runner-tokens", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    /* 列名写全而**不是** `SELECT *`：`secret_encrypted` 被 `SELECT *` 带进来后，映射漏一个字段
       就是一次凭据泄露（与 `repositories.ts` 的 ingest-token 列表同款纪律）。 */
    const result = await pool.query(
      `SELECT t.id, t.name, t.token_prefix, t.labels, t.created_by, t.last_used_at, t.revoked_at, t.created_at,
              (SELECT COUNT(*)::int FROM runners r WHERE r.runner_token_id = t.id) AS runner_count
         FROM runner_tokens t ORDER BY t.created_at DESC`,
    );
    return success(result.rows.map(mapRunnerToken), { total: result.rowCount });
  });

  /** 创建：明文在本次响应里出现；此后也能重新复制（下面的 `/secret`），丢了不必吊销重发。 */
  app.post<{ Body: { name?: string; labels?: unknown } }>("/api/v1/system/runner-tokens", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    const name = request.body?.name?.trim();
    if (!name) return fail(reply, 400, 1001, "token name is required");
    const declared = normalizeLabels(request.body?.labels, "labels");
    if (declared.error) return fail(reply, 400, 1001, declared.error);
    const issued = issueRunnerToken();
    const result = await pool.query(
      `INSERT INTO runner_tokens (id, name, secret_encrypted, token_prefix, labels, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, token_prefix, labels, created_by, last_used_at, revoked_at, created_at`,
      [randomUUID(), name, issued.secretEncrypted, issued.prefix, declared.labels ?? [DEFAULT_RUNNER_LABEL], user.id],
    );
    /* 审计（P4.5-8）：detail 只有名字与标签——明文 token 连日志都不进（明文只在响应里
       出现一次的纪律），加密密文也不是审计要回答的问题。系统级动作，project_id 为空。 */
    writeAuditLogAsync({
      action: "runner_token.create",
      targetType: "runner_token",
      targetId: String(result.rows[0].id),
      userId: user.id,
      detail: { name, labels: declared.labels ?? [DEFAULT_RUNNER_LABEL] },
      ip: request.ip,
    });
    return reply.code(201).send(success({ ...mapRunnerToken(result.rows[0]), token: issued.plaintext }));
  });

  /**
   * 吊销是软删（留 `revoked_at`）。
   *
   * 硬删会级联掉 `runners`（迁移 036 的 `ON DELETE CASCADE`），于是「那台机器是拿哪张
   * token 注册的」就答不出来了。吊销**即时生效**：鉴权的候选行走部分索引，被吊销的行
   * 不在索引里，已在跑的 Runner 下一次心跳就会被拒。
   */
  app.delete<{ Params: { tokenId: string } }>("/api/v1/system/runner-tokens/:tokenId", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    if (!isUuid(request.params.tokenId)) return fail(reply, 404, 2001, "runner token not found");
    const result = await pool.query(
      `UPDATE runner_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1
        RETURNING id, name, token_prefix, labels, created_by, last_used_at, revoked_at, created_at`,
      [request.params.tokenId],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "runner token not found");
    /* 审计（P4.5-8）：吊销是安全敏感动作，谁在什么时候吊了哪张必须可追溯。detail 带
       该 token 名下注册过的 Runner 台数——吊销影响面（多少台机器下次心跳会被拒）。 */
    writeAuditLogAsync({
      action: "runner_token.revoke",
      targetType: "runner_token",
      targetId: request.params.tokenId,
      userId: user.id,
      detail: { tokenName: String(result.rows[0].name), labels: (result.rows[0].labels as unknown[]).map(String) },
      ip: request.ip,
    });
    return success(mapRunnerToken(result.rows[0]));
  });

  /** 重新取回明文（2026-09-28 可重复复制）：Token 现改为可逆加密存储，丢了不必吊销重发。
      签发/吊销本就是系统管理员权限，读一次明文不扩大爆炸半径；已吊销的不给，审计记一次。 */
  app.get<{ Params: { tokenId: string } }>("/api/v1/system/runner-tokens/:tokenId/secret", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    if (!isUuid(request.params.tokenId)) return fail(reply, 404, 2001, "runner token not found");
    const result = await pool.query(
      "SELECT secret_encrypted FROM runner_tokens WHERE id = $1 AND revoked_at IS NULL",
      [request.params.tokenId],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "runner token not found");
    let token: string;
    try { token = decryptSecret(result.rows[0].secret_encrypted as Buffer); }
    catch { return fail(reply, 500, 5001, "runner token could not be decrypted"); }
    writeAuditLogAsync({
      action: AUDIT_ACTIONS.runnerTokenReadSecret, targetType: "runner_token", targetId: request.params.tokenId,
      userId: user.id, ip: request.ip,
    });
    return success({ id: request.params.tokenId, token });
  });

  /**
   * Runner 池的**聚合**只读视图（P4.5-11，8.6 的「任务列表顶部 Runner 池实时状态」）。
   *
   * 与下面 `GET /system/runners` 的差别只在受众，与 `/system/runner-labels` 对
   * `/system/workers` 的关系完全同构：CI 任务列表页上任何能看这个项目的人都要读到
   * 「在线 / 槽位 / 空闲 / 排队 N 个」，而 Runner 清单带 hostname、token 名、版本，
   * 那是系统管理员的东西。所以这里另开一条路由而不是放宽那一条的权限——只回标签与
   * 数字，够画顶部那一行，不泄露机器信息。
   *
   * 三个数字各有出处，别混：
   * - `online` / `total` / `capacity` 来自 `runners`（机器层，按心跳新鲜度算在线）；
   * - `inflight` / `queued` 来自 `pipeline_runs`（任务层）——一台 Runner 在跑几个 job
   *   平台侧只能从 run 行数它，`runners` 表没有这一列。
   *
   * **`queued` 是跨项目的全局数**：认领扫描按 `runner_label` 取全平台最早的那条
   * （claim 的 SQL 里没有 project 条件），所以「我前面排着几个」的真实答案就是全局的。
   * 只回一个数字，不回别的项目的任何身份信息。
   *
   * 标签全集 = 已注册 Runner 的标签 ∪ CI 任务配置的标签 ∪ `default`，与
   * `/system/workers` 的分区全集同款理由：一个「配了任务却没有 Runner 服务」的标签必须
   * 显式出现且 online=0，否则「为什么触发直接被拒（2004）」只能靠猜。
   */
  app.get("/api/v1/system/runner-pool", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;

    const runners = await pool.query(
      `SELECT labels, capacity, status,
              (last_seen_at > now() - ($1 || ' seconds')::interval) AS online
         FROM runners`,
      [RUNNER_OFFLINE_AFTER_SECONDS],
    );
    /* 在途与排队按标签分组数 run 行。`cancelling` 算在途——那台机器上的进程还在，槽位
       还没释放；把它算成空闲会让「空闲 N」比实际大一个。 */
    const runs = await pool.query(
      `SELECT runner_label,
              COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
              COUNT(*) FILTER (WHERE status IN ('claimed', 'running', 'cancelling'))::int AS inflight
         FROM pipeline_runs
        WHERE status IN ('queued', 'claimed', 'running', 'cancelling')
        GROUP BY runner_label`,
    );
    const configured = await pool.query("SELECT DISTINCT runner_label FROM ci_tasks");

    type LabelStat = { label: string; online: number; total: number; capacity: number; inflight: number; queued: number };
    const stats = new Map<string, LabelStat>();
    const entry = (label: string): LabelStat => {
      const existing = stats.get(label);
      if (existing) return existing;
      const created: LabelStat = { label, online: 0, total: 0, capacity: 0, inflight: 0, queued: 0 };
      stats.set(label, created);
      return created;
    };
    entry(DEFAULT_RUNNER_LABEL);
    for (const row of configured.rows) entry(String(row.runner_label));
    for (const row of runners.rows) {
      const labels = (Array.isArray(row.labels) && row.labels.length ? (row.labels as unknown[]).map(String) : [DEFAULT_RUNNER_LABEL]);
      /* 一台 Runner 可以声明多个标签，在每个标签下各算一次（与 `/system/workers` 的
         分区表同款）。容量**不按标签数均摊**：BullMQ worker 的并发是按标签拆分过的，
         Runner 的 `capacity` 是「这台机器同时能跑几个 job」，跑哪个标签的 job 由
         claim 决定——均摊会报出一个比真实可用槽位更小的数。 */
      for (const label of labels) {
        const stat = entry(label);
        stat.total += 1;
        if (row.online && String(row.status) !== "draining") {
          stat.online += 1;
          stat.capacity += Number(row.capacity);
        }
      }
    }
    for (const row of runs.rows) {
      const stat = entry(String(row.runner_label));
      stat.inflight = Number(row.inflight);
      stat.queued = Number(row.queued);
    }

    const labels = [...stats.values()].sort((a, b) => a.label.localeCompare(b.label));
    /* 合计从 runner 行算，**不是**把 labels[] 求和：一台声明两个标签的机器在两行里各算
       一次，求和会把「在线 3 台」报成 6 台。`online` 的判据是**可认领**（在线且不
       draining），与触发前的可用性检查同一口径——两个数不同会让「面板说在线、触发说
       没有 Runner」成立。 */
    const claimable = runners.rows.filter((row) => row.online && String(row.status) !== "draining");
    return success({
      offlineAfterSeconds: RUNNER_OFFLINE_AFTER_SECONDS,
      labels,
      online: claimable.length,
      total: runners.rowCount ?? 0,
      capacity: claimable.reduce((sum, row) => sum + Number(row.capacity), 0),
      /* 在途与排队按 run 行求和是对的：一条 run 只有一个 runner_label。 */
      inflight: labels.reduce((sum, each) => sum + each.inflight, 0),
      queued: labels.reduce((sum, each) => sum + each.queued, 0),
    });
  });

  /**
   * Runner 池（系统管理员）。
   *
   * 与 `GET /system/workers` 是**两张表两个概念**，页面上要挨着放并写明区别（8.6）：
   * 「执行器（平台内部 BullMQ worker）」vs「Runner（自托管，跑仓库代码）」。不写明会被
   * 当成重复功能报上来。
   *
   * `online` 由查询按心跳新鲜度算出、从不存储（与 `/system/workers` 同款）。阈值是
   * `RUNNER_OFFLINE_AFTER_SECONDS`（90 秒），**不是** worker 的 30 秒：Runner 的心跳要跨
   * 公网走 HTTP，且掉线要判 `aborted` 并回收租约——把一次网络抖动读成「机器没了」的代价
   * 高得多。
   */
  app.get("/api/v1/system/runners", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    const result = await pool.query(
      `SELECT r.*, t.name AS runner_token_name,
              (r.last_seen_at > now() - ($1 || ' seconds')::interval) AS online
         FROM runners r JOIN runner_tokens t ON t.id = r.runner_token_id
        ORDER BY r.last_seen_at DESC`,
      [RUNNER_OFFLINE_AFTER_SECONDS],
    );
    const runners = result.rows.map(mapRunner);
    /* 判据是「在线 **且** 不在 draining」：一台 draining 的机器仍在发心跳（它要跑完手上
       的活），但它不再参与 claim。把它算进可用容量会让「配了 CI 任务却触发被拒」成立。 */
    const claimable = runners.filter((each) => each.online && each.status !== "draining");
    return success({
      runners,
      /* 阈值回给前端，让「离线」这个词在界面上有据可依（不是前端自己写一个 90）。 */
      offlineAfterSeconds: RUNNER_OFFLINE_AFTER_SECONDS,
      capacity: claimable.reduce((sum, each) => sum + each.capacity, 0),
      online: claimable.length,
      total: runners.length,
    });
  });

  /**
   * 只允许改 `status`，且只在 `online` ↔ `draining` 之间（8.2 平台侧 REST）。
   *
   * `offline` 不可人为设置：它是心跳新鲜度算出来的事实，手写一个 `offline` 会让那台还在
   * 发心跳的机器在下一次心跳后又变回 online，界面上看起来像操作没生效。
   * 其余列全部由 Runner 自报——人在这里改 `labels` 就绕过了注册时的子集校验。
   */
  app.patch<{ Params: { runnerId: string }; Body: { status?: string } }>("/api/v1/system/runners/:runnerId", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    if (!isUuid(request.params.runnerId)) return fail(reply, 404, 2001, "runner not found");
    const status = request.body?.status?.trim();
    if (status !== "online" && status !== "draining") return fail(reply, 400, 1001, "status must be online or draining");
    const result = await pool.query(
      `UPDATE runners SET status = $2 WHERE id = $1
        RETURNING *, (last_seen_at > now() - ($3 || ' seconds')::interval) AS online`,
      [request.params.runnerId, status, RUNNER_OFFLINE_AFTER_SECONDS],
    );
    if (!result.rowCount) return fail(reply, 404, 2001, "runner not found");
    return success(mapRunner(result.rows[0]));
  });
}
