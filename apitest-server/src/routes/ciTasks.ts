import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { normalizeIdempotencyKey } from "../lib/idempotency.js";
import { notifySerializedQueue } from "../lib/pipelineRun.js";
import { DEFAULT_RUNNER_LABEL, RUNNER_LABEL_PATTERN } from "../lib/queue.js";
import { VARIABLE_NAME_PATTERN } from "../lib/resolve.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { failTrigger, IdempotentReplayError, triggerCiTaskRun } from "../lib/trigger.js";
import { isUuid } from "../lib/uuid.js";
import { mapCiTask, normalizeSuiteNotify, SANDBOX_MODES, type CiTask, type SandboxMode, type SuiteNotifyConfig } from "../models/types.js";

/**
 * CI 任务 CRUD 与触发（P4.5-2，计划 8.2 平台侧 REST；P4.5-14 收窄，见 8.11）。
 *
 * 任务回答「从哪个仓库的哪个 ref 拉、在哪台机器（runner_label）、用哪档沙箱、跑哪一段
 * shell」。触发走 `lib/trigger.ts` 的 `triggerCiTaskRun`——与流程 / 套件共用 `failTrigger`
 * 的错误映射（P3-3 边界 5）；调度与 Webhook（P4.5-12 接入）也走那一个函数。
 *
 * **P4.5-14 删掉的四组配置**（用户验收反馈，8.11 的 B 类）：任务级 secret、报告格式与
 * 路径、产物路径、默认任务。删的理由都是同一条——配置项比决策多。报告目录改从 `steps`
 * 里解析（`lib/allureDir.ts`），是派生值不是输入。
 *
 * **Git 来源在任务上**（8.11 的 A 类）：`git_url` + 可空的 `git_credential_id`（项目级
 * 命名凭据池）。仓库行不再是建任务的前提——它由第一次上报创建，而用户来这里正是因为还
 * 没有上报。
 */

/** 24 小时：再长的任务该拆该上调度，而不是占一个 Runner 槽位一天。 */
const MAX_TIMEOUT_SECONDS = 86400;
/** 平台注入的 `APITRACK_*` 三件套（8.2 约定 8）在 JobSpec 组装时由平台压栈：用户侧
    同名变量会被静默盖掉，与其事后解释不如写入时就拒绝。 */
const RESERVED_ENV_PREFIX = "APITRACK_";
/** 缓存路径数组的防手误上限。 */
const MAX_PATH_ENTRIES = 64;
/** 推荐查询接受的 key 上限，与触发侧的 `CASE_FILTER_LIMIT` 对齐（超出的忽略而不是报错：
    推荐只是个建议，为它拒绝一次请求会让勾选面板打不开）。 */
const MAX_RECOMMEND_KEYS = 500;

type CiTaskBody = {
  name?: string; description?: string; gitUrl?: string; gitCredentialId?: string | null; gitRef?: string;
  runnerLabel?: string; sandboxMode?: string; image?: string; steps?: string;
  env?: Record<string, string>;
  cachePaths?: unknown; cacheKeyFiles?: unknown;
  sdkIngestEnabled?: boolean; timeoutSeconds?: number; enabled?: boolean;
  /** 终态结果通知（P4.5-12）：形状与套件的 `notify` 逐字相同，校验也复用同一个函数。 */
  notify?: unknown;
  /** 任务级串行（P4.5-12）：缺省不动，新建时默认开。 */
  singleConcurrency?: boolean;
};

type TaskDraft = {
  name: string; description: string; gitUrl: string; gitCredentialId: string | null; gitRef: string;
  runnerLabel: string; sandboxMode: SandboxMode; image: string; steps: string;
  env: Record<string, string>; cachePaths: string[]; cacheKeyFiles: string[];
  sdkIngestEnabled: boolean; timeoutSeconds: number; enabled: boolean;
  notify: SuiteNotifyConfig;
  singleConcurrency: boolean;
};

/** 详情 / 创建 / 更新的读取形状：凭据名与方式来自 join，不在 `ci_tasks` 上。
    列表页不用它——它要多带两段 LATERAL 的列，投影不一样（见列表路由的注释）。 */
const TASK_SELECT = `SELECT t.*, c.name AS git_credential_name, c.method AS git_credential_method
   FROM ci_tasks t LEFT JOIN git_credentials c ON c.id = t.git_credential_id`;

function optionalString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? fallback : trimmed;
}

/** 相对路径数组（缓存）：Runner 会把它拼进 workspace，先挡掉绝对路径与 `..`。 */
function validatePathList(field: string, input: unknown): { list?: string[]; error?: string } {
  if (input === undefined || input === null) return { list: [] };
  if (!Array.isArray(input)) return { error: `${field} must be an array of paths` };
  if (input.length > MAX_PATH_ENTRIES) return { error: `${field} accepts at most ${MAX_PATH_ENTRIES} entries` };
  const list: string[] = [];
  for (const entry of input) {
    const path = String(entry ?? "").trim();
    if (!path) return { error: `${field} entries cannot be empty` };
    if (path.startsWith("/") || path.startsWith("\\")) return { error: `${field} entries must be relative to the repository workspace, not absolute: "${path}"` };
    if (path.split(/[/\\]/)[0] === "..") return { error: `${field} entries cannot escape the workspace: "${path}"` };
    list.push(path);
  }
  return { list };
}

/** env 的键形校验：它们都会变成 Runner 里的真环境变量。 */
function validateEnvKeys(field: string, map: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(map)) {
    if (!VARIABLE_NAME_PATTERN.test(key)) {
      return `${field} name "${key}" must start with a letter or underscore and contain only letters, digits and underscores`;
    }
    if (key.startsWith(RESERVED_ENV_PREFIX)) {
      return `${field} name "${key}" is reserved for platform injection (${RESERVED_ENV_PREFIX}*)`;
    }
  }
  return undefined;
}

/**
 * 拉取地址的形状校验。
 *
 * 只认 `https://` / `http://` / `ssh://` / `git@host:path` 四种写法：这不是安全边界
 * （Runner 那边执行 `git clone` 时地址已经是平台自己存的值），而是让「粘错了一个网页
 * 地址」在保存时就被指出来，而不是在第一次执行的 clone 阶段。
 *
 * 刻意**不**校验它和 `repositories.git_url` 是否一致：仓库行可能还不存在（这正是搬到
 * 任务上的理由），而两者不一致也不需要平台裁决——`/ingest` 的准入判据一个字不改。
 */
function validateGitUrl(url: string): string | undefined {
  if (!url) return "gitUrl is required; a CI task needs somewhere to clone from";
  if (url.length > 1024) return "gitUrl must be at most 1024 characters";
  if (/^(https?|ssh):\/\/\S+$/i.test(url)) return undefined;
  if (/^[\w.-]+@[\w.-]+:\S+$/.test(url)) return undefined;
  return 'gitUrl must be an https://, http://, ssh:// URL or scp-style "git@host:group/repo.git"';
}

/** 把请求体合并成一份完整草稿（create 用缺省值兜底，update 用已存行兜底）并校验。 */
function mergeDraft(body: CiTaskBody, existing?: CiTask): { draft?: TaskDraft; error?: string } {
  /* 路径数组先按「请求体优先、已存行兜底」取原始输入，再统一校验：否则「必填」类检查
     会看到请求体的缺省而不是合并后的真值。 */
  const rawPaths = {
    cachePaths: body.cachePaths !== undefined ? body.cachePaths : existing?.cachePaths,
    cacheKeyFiles: body.cacheKeyFiles !== undefined ? body.cacheKeyFiles : existing?.cacheKeyFiles,
  };
  const draft: TaskDraft = {
    name: optionalString(body.name, existing?.name ?? ""),
    description: optionalString(body.description, existing?.description ?? ""),
    gitUrl: optionalString(body.gitUrl, existing?.gitUrl ?? ""),
    /* `null` 是显式的「不用凭据」（公开仓库），`undefined` 是「不动」——两者必须分开，
       否则清空凭据引用这个动作没有形状可表达。 */
    gitCredentialId: body.gitCredentialId !== undefined
      ? (body.gitCredentialId === null || body.gitCredentialId === "" ? null : String(body.gitCredentialId))
      : existing?.gitCredentialId ?? null,
    gitRef: optionalString(body.gitRef, existing?.gitRef ?? "main"),
    runnerLabel: optionalString(body.runnerLabel, existing?.runnerLabel ?? DEFAULT_RUNNER_LABEL),
    sandboxMode: optionalString(body.sandboxMode, existing?.sandboxMode ?? "container") as SandboxMode,
    image: optionalString(body.image, existing?.image ?? ""),
    steps: optionalString(body.steps, existing?.steps ?? ""),
    env: body.env !== undefined ? body.env : existing?.env ?? {},
    cachePaths: [], cacheKeyFiles: [],
    sdkIngestEnabled: body.sdkIngestEnabled !== undefined ? Boolean(body.sdkIngestEnabled) : existing?.sdkIngestEnabled ?? true,
    /* notify 整块覆盖（与套件同款）：归一后写整个 JSONB，缺省键落默认值（两开关全关）。 */
    notify: normalizeSuiteNotify(body.notify !== undefined ? body.notify : existing?.notify ?? {}),
    singleConcurrency: body.singleConcurrency !== undefined ? Boolean(body.singleConcurrency) : existing?.singleConcurrency ?? true,
    timeoutSeconds: Number(body.timeoutSeconds !== undefined ? body.timeoutSeconds : existing?.timeoutSeconds ?? 1800),
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : existing?.enabled ?? true,
  };
  if (!draft.name) return { error: "name is required" };
  if (!draft.steps) return { error: "steps is required" };
  const invalidUrl = validateGitUrl(draft.gitUrl);
  if (invalidUrl) return { error: invalidUrl };
  if (draft.gitCredentialId !== null && !isUuid(draft.gitCredentialId)) return { error: "gitCredentialId must be a uuid or null" };
  if (!draft.gitRef) return { error: "gitRef cannot be empty" };
  if (draft.gitRef.length > 255) return { error: "gitRef must be at most 255 characters" };
  if (!RUNNER_LABEL_PATTERN.test(draft.runnerLabel)) {
    return { error: `runnerLabel "${draft.runnerLabel}" must be 1–32 characters of lowercase letters, digits or hyphens, starting with a letter or digit` };
  }
  if (!(SANDBOX_MODES as readonly string[]).includes(draft.sandboxMode)) {
    return { error: `sandboxMode must be one of ${SANDBOX_MODES.join(", ")}` };
  }
  /* container 档必填（迁移 037 的注释）：错误信息说清缺什么，process 档忽略 image。 */
  if (draft.sandboxMode === "container" && !draft.image) {
    return { error: "image is required when sandboxMode is container (or switch to process mode — a trust declaration, not a lighter option)" };
  }
  const invalidEnv = validateEnvKeys("env", draft.env);
  if (invalidEnv) return { error: invalidEnv };
  if (Object.values(draft.env).some((value) => typeof value !== "string")) return { error: "env values must all be strings" };
  for (const field of ["cachePaths", "cacheKeyFiles"] as const) {
    const built = validatePathList(field, rawPaths[field]);
    if (built.error) return { error: built.error };
    draft[field] = built.list!;
  }
  /*
   * 报告目录**不校验、不拦保存**（8.11 的 B 类）：`steps` 里没有 `--alluredir` 时用户
   * 可能把它写在仓库的 `pytest.ini` 的 `addopts` 里，那份文件平台看不见。前端会显示
   * 「跑完不会有报告」的提示，服务端不拿一条猜测去否决一次保存。
   */
  if (!Number.isInteger(draft.timeoutSeconds) || draft.timeoutSeconds < 1 || draft.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    return { error: `timeoutSeconds must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}` };
  }
  return { draft };
}

/** 凭据必须属于本项目：借别项目的 key 去 clone 等于跨项目提权。 */
async function assertCredentialOwned(projectId: string, credentialId: string | null): Promise<boolean> {
  if (credentialId === null) return true;
  const found = await pool.query("SELECT 1 FROM git_credentials WHERE id = $1 AND project_id = $2", [credentialId, projectId]);
  return Boolean(found.rowCount);
}

/**
 * 通知配置校验（P4.5-12）：形状 + 渠道属于本项目 + 模版字段是短字符串。
 *
 * 与 `routes/suites.ts` 的 `validateNotify` 是同一份判据的第二个调用点。**刻意保持两份而
 * 不抽公共函数**：它读的是同一张 `notification_channels` 表、用同一个归一函数，但错误文案
 * 的字段前缀属于各自的请求体契约；抽出去要么把 `notify.` 这个前缀写死（对两边都对，但从此
 * 那个函数不再属于任何一方），要么多一个参数只为拼字符串。真正不能有两份的是**归一**
 * （`normalizeSuiteNotify`）与**投递**（`lib/alerts.ts`），那两处已经是一份。
 *
 * 渠道存在性必须查库：悬空 id 会让「开关开了」的任务在终态静默少发一封通知，那比保存被
 * 拒绝难发现得多。
 */
async function validateNotify(projectId: string, notify: unknown): Promise<string | undefined> {
  if (notify === undefined || notify === null) return undefined;
  if (typeof notify !== "object" || Array.isArray(notify)) return "notify must be an object";
  const raw = notify as Record<string, unknown>;
  if (raw.onSuccess !== undefined && typeof raw.onSuccess !== "boolean") return "notify.onSuccess must be a boolean";
  if (raw.onFailure !== undefined && typeof raw.onFailure !== "boolean") return "notify.onFailure must be a boolean";
  if (raw.channelIds !== undefined) {
    if (!Array.isArray(raw.channelIds)) return "notify.channelIds must be an array";
    const ids = raw.channelIds.map(String);
    for (const id of ids) if (!isUuid(id)) return "notify.channelIds must contain UUIDs";
    if (ids.length) {
      const found = await pool.query(
        "SELECT COUNT(*)::int AS total FROM notification_channels WHERE project_id = $1 AND id = ANY($2::uuid[])",
        [projectId, ids],
      );
      if (Number(found.rows[0].total) !== ids.length) return "notify.channelIds must reference channels in this project";
    }
  }
  if (raw.template !== undefined && raw.template !== null) {
    if (typeof raw.template !== "object" || Array.isArray(raw.template)) return "notify.template must be an object";
    for (const key of ["title", "body"] as const) {
      const value = (raw.template as Record<string, unknown>)[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") return `notify.template.${key} must be a string`;
      if (value.length > 2000) return `notify.template.${key} is too long (max 2000 characters)`;
    }
  }
  return undefined;
}

export async function ciTaskRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { page?: string; pageSize?: string; keyword?: string } }>("/api/v1/projects/:id/ci-tasks", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const page = Math.max(1, Number(request.query?.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(request.query?.pageSize ?? 20)));
    /* 关键字在 SQL 里过滤（与接口/流程/套件列表同一条纪律）：就地过滤只能筛出当前页，
       而「我那条任务在第几页」正是要搜索的原因。命中面是名称 + 描述 + Git 地址——
       任务多起来之后「哪些任务拉的是这个仓库」是真实问法。 */
    const keyword = request.query?.keyword?.trim();
    const filters: unknown[] = [context.project.id];
    let where = "t.project_id = $1";
    if (keyword) {
      filters.push(`%${keyword}%`);
      where += ` AND (t.name ILIKE $${filters.length} OR t.description ILIKE $${filters.length} OR t.git_url ILIKE $${filters.length})`;
    }
    const total = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ci_tasks t WHERE ${where}`,
      filters,
    );
    /* 在途 run 用 LATERAL 随行带出（列表页的「执行中/排队中」行内提示）：串行任务恒
       ≤1 条；并行任务最新一条给身份（#N、状态），条数说全。聚合形状（无 GROUP BY 的
       聚合恒返回一行）保证没有在途时 count=0、身份列为 NULL，mapper 读作「没有」而不
       是「未知」。走 (ci_task_id, run_number) 索引，每行一次小额扫描。

       第二段 LATERAL 是**最近一条执行 + 历史总条数**（不限状态）：`activeRun` 只在有
       在途 run 时存在，所以跑完的任务收起来后既没有状态也没有规模。两段分开而不是合成
       一段，是因为条件不同（在途 vs 全部）且各自都要 COUNT——塞进一段就得写两个
       FILTER 聚合，读起来比两段更绕。

       **SELECT 列表逐列写全，不复用 `TASK_SELECT`**：那个常量的列表是
       `t.*, c.name, c.method`，把 LATERAL 接在它后面**不会**让 `ar.*` / `lr.*` 进结果集
       ——join 只决定行，投影只看 SELECT 列表。P4.5 走查五项 ⑤ 就是这么写的，于是
       `activeRun` 从落地那天起一直是 `undefined`，行内状态提示从未出现过（这一轮验收
       反馈的第 7 项）。列表页的读取形状与详情/创建不同，就让它有自己的 SELECT。 */
    const result = await pool.query(
      `SELECT t.*, c.name AS git_credential_name, c.method AS git_credential_method,
              ar.active_run_count, ar.active_run_id, ar.active_run_number, ar.active_run_status,
              lr.run_total, lr.last_run_id, lr.last_run_number, lr.last_run_status
         FROM ci_tasks t
         LEFT JOIN git_credentials c ON c.id = t.git_credential_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS active_run_count,
                  (ARRAY_AGG(id ORDER BY run_number DESC))[1] AS active_run_id,
                  (ARRAY_AGG(run_number ORDER BY run_number DESC))[1] AS active_run_number,
                  (ARRAY_AGG(status ORDER BY run_number DESC))[1] AS active_run_status
             FROM pipeline_runs
            WHERE ci_task_id = t.id AND status IN ('queued', 'claimed', 'running', 'cancelling')
         ) ar ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS run_total,
                  (ARRAY_AGG(id ORDER BY run_number DESC))[1] AS last_run_id,
                  (ARRAY_AGG(run_number ORDER BY run_number DESC))[1] AS last_run_number,
                  (ARRAY_AGG(status ORDER BY run_number DESC))[1] AS last_run_status
             FROM pipeline_runs WHERE ci_task_id = t.id
         ) lr ON true
        WHERE ${where} ORDER BY t.created_at DESC LIMIT $${filters.length + 1} OFFSET $${filters.length + 2}`,
      [...filters, pageSize, (page - 1) * pageSize],
    );
    return success(result.rows.map(mapCiTask), {
      page, pageSize, total: Number(total.rows[0].total),
    });
  });

  /**
   * 创建。**不需要已绑定的仓库**（P4.5-14，8.11 的 A 类）：拉取地址与凭据都在任务自己
   * 身上，原先那句「this project has no bound repository」的前置检查随之删掉——它锁死的
   * 正是「我还没有 CI，让平台帮我跑第一次」这个入口。
   */
  app.post<{ Params: { id: string }; Body: CiTaskBody }>("/api/v1/projects/:id/ci-tasks", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    const { draft, error } = mergeDraft(request.body ?? {});
    if (error || !draft) return fail(reply, 400, 1001, error ?? "invalid CI task");
    if (!(await assertCredentialOwned(context.project.id, draft.gitCredentialId))) {
      return fail(reply, 400, 1001, "gitCredentialId must reference a git credential of this project");
    }
    const invalidNotify = await validateNotify(context.project.id, request.body?.notify);
    if (invalidNotify) return fail(reply, 400, 1001, invalidNotify);

    const result = await pool.query(
      `INSERT INTO ci_tasks (
         id, project_id, name, description, git_url, git_credential_id, git_ref, runner_label,
         sandbox_mode, isolation_mode, image, steps, env,
         cache_paths, cache_key_files, sdk_ingest_enabled, notify_config, single_concurrency,
         timeout_seconds, enabled, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'shared', $10, $11, $12::jsonb, $13, $14, $15, $16::jsonb, $17, $18, $19, $20)
       RETURNING *`,
      [
        randomUUID(), context.project.id, draft.name, draft.description,
        draft.gitUrl, draft.gitCredentialId, draft.gitRef, draft.runnerLabel,
        draft.sandboxMode, draft.image, draft.steps, JSON.stringify(draft.env),
        draft.cachePaths, draft.cacheKeyFiles, draft.sdkIngestEnabled, JSON.stringify(draft.notify),
        draft.singleConcurrency, draft.timeoutSeconds, draft.enabled, context.user.id,
      ],
    );
    /* 凭据名要回给客户端（列表列），但 INSERT 的 RETURNING 拿不到 join 列：单独读一次
       比在 INSERT 外面套一层 CTE 直白，这是一次创建，多一次查询无关紧要。 */
    const loaded = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [String(result.rows[0].id)]);
    return reply.code(201).send(success(mapCiTask(loaded.rows[0])));
  });

  app.get<{ Params: { id: string; taskId: string } }>("/api/v1/projects/:id/ci-tasks/:taskId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    if (!isUuid(request.params.taskId)) return fail(reply, 404, 2001, "CI task not found");
    const result = await pool.query(`${TASK_SELECT} WHERE t.id = $1 AND t.project_id = $2`, [request.params.taskId, context.project.id]);
    if (!result.rowCount) return fail(reply, 404, 2001, "CI task not found");
    return success(mapCiTask(result.rows[0]));
  });

  /**
   * 更新（部分覆盖：缺省字段保持原值）。
   *
   * Git 地址与凭据**可改**（P4.5-14）：原先「代码来源只读、换仓库要新建任务」那条规则
   * 来自「来源挂在仓库行上、改它会打断上报」——来源搬到任务上之后那个理由就不成立了。
   * 改地址只影响下一次执行；历史 run 的证据在 `pipeline_runs` 自己的快照里。
   */
  app.put<{ Params: { id: string; taskId: string }; Body: CiTaskBody }>("/api/v1/projects/:id/ci-tasks/:taskId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.taskId)) return fail(reply, 404, 2001, "CI task not found");
    const existing = await pool.query(`${TASK_SELECT} WHERE t.id = $1 AND t.project_id = $2`, [request.params.taskId, context.project.id]);
    if (!existing.rowCount) return fail(reply, 404, 2001, "CI task not found");
    const { draft, error } = mergeDraft(request.body ?? {}, mapCiTask(existing.rows[0]));
    if (error || !draft) return fail(reply, 400, 1001, error ?? "invalid CI task");
    if (!(await assertCredentialOwned(context.project.id, draft.gitCredentialId))) {
      return fail(reply, 400, 1001, "gitCredentialId must reference a git credential of this project");
    }
    const invalidNotify = await validateNotify(context.project.id, request.body?.notify);
    if (invalidNotify) return fail(reply, 400, 1001, invalidNotify);

    await pool.query(
      `UPDATE ci_tasks SET
         name = $3, description = $4, git_url = $5, git_credential_id = $6, git_ref = $7,
         runner_label = $8, sandbox_mode = $9, image = $10, steps = $11, env = $12::jsonb,
         cache_paths = $13, cache_key_files = $14, sdk_ingest_enabled = $15,
         notify_config = $16::jsonb, single_concurrency = $17,
         timeout_seconds = $18, enabled = $19, updated_at = now()
       WHERE id = $1 AND project_id = $2`,
      [
        request.params.taskId, context.project.id,
        draft.name, draft.description, draft.gitUrl, draft.gitCredentialId, draft.gitRef,
        draft.runnerLabel, draft.sandboxMode, draft.image, draft.steps, JSON.stringify(draft.env),
        draft.cachePaths, draft.cacheKeyFiles, draft.sdkIngestEnabled,
        JSON.stringify(draft.notify), draft.singleConcurrency, draft.timeoutSeconds, draft.enabled,
      ],
    );
    const loaded = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [request.params.taskId]);
    /* 关掉串行之后，之前被守卫挡住的排队 run 立刻就该可领（P4.5-12）：不补这一发唤醒，
       它要等到下一个轮询窗口。开着串行时这个调用查不到东西，是一次空操作。 */
    await notifySerializedQueue(pool, request.params.taskId).catch(() => {});
    return success(mapCiTask(loaded.rows[0]));
  });

  /**
   * 删除。`pipeline_runs.ci_task_id` 是刻意设计的 `ON DELETE CASCADE`（8.1）：任务没了，
   * 它的执行账本没有独立存在的意义；要留历史就停用（`enabled=false`）而不是删。
   *
   * P4.5-12 起任务多了两类引用者：调度与 Webhook 触发（它们的 `target_id` 按 target_type
   * 多态、无外键，迁移 030 的决定）。悬空的调度会每拍到点记一行 failed、悬空的 Webhook 会
   * 对外返回 404 之后的触发失败，所以这里与 `routes/suites.ts` 的套件删除完全同款：先 409
   * 给清单，`?force=true` 才连带删掉引用者。
   */
  app.delete<{ Params: { id: string; taskId: string }; Querystring: { force?: string } }>("/api/v1/projects/:id/ci-tasks/:taskId", async (request, reply) => {
    const context = await requireProjectAccess(request, reply, true); if (!context) return;
    if (!isUuid(request.params.taskId)) return fail(reply, 404, 2001, "CI task not found");
    const referencingSchedules = await pool.query(
      "SELECT id, name FROM schedules WHERE project_id = $1 AND target_type = 'ci_task' AND target_id = $2",
      [context.project.id, request.params.taskId],
    );
    const referencingTriggers = await pool.query(
      "SELECT id, name FROM webhook_triggers WHERE project_id = $1 AND target_type = 'ci_task' AND target_id = $2",
      [context.project.id, request.params.taskId],
    );
    if ((referencingSchedules.rowCount || referencingTriggers.rowCount) && request.query?.force !== "true") {
      return reply.code(409).send({
        code: 2003,
        message: "CI task is referenced by schedules or webhook triggers",
        data: {
          schedules: referencingSchedules.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
          webhookTriggers: referencingTriggers.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
        },
      });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      /* 连带删除是 force 语义的一部分：留着就是每分钟报错的僵尸。执行历史不受影响——
         `execution_index.trigger_ref_*` 无外键且带名字快照（P3 边界 13）。 */
      if (request.query?.force === "true") {
        await client.query("DELETE FROM schedules WHERE project_id = $1 AND target_type = 'ci_task' AND target_id = $2", [context.project.id, request.params.taskId]);
        await client.query("DELETE FROM webhook_triggers WHERE project_id = $1 AND target_type = 'ci_task' AND target_id = $2", [context.project.id, request.params.taskId]);
      }
      const result = await client.query("DELETE FROM ci_tasks WHERE id = $1 AND project_id = $2 RETURNING id", [request.params.taskId, context.project.id]);
      await client.query("COMMIT");
      if (!result.rowCount) return fail(reply, 404, 2001, "CI task not found");
      return success({ id: result.rows[0].id });
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally {
      client.release();
    }
  });

  /**
   * 勾选执行的任务推荐（§8.3，P4.5-9；P4.5-14 去掉「默认任务」那一档）。
   *
   * **POST 而不是 GET**：勾选可以到 500 个 key（`CASE_FILTER_LIMIT`），塞进查询串会撞
   * URL 长度上限，且 key 里含 `::` 与路径分隔符，编码后极难读。它仍是一次只读查询，
   * 所以 `requireProjectAccess` 不要 `write`——viewer 打开勾选面板看得到推荐，只是按不动
   * 触发按钮（那一步才是写）。
   *
   * 「最近命中」的判据是 `repo_test_cases.last_ingest_run_id`：那一列本身就是「这条用例
   * 最近一次是被哪次上报刷新的」，反查 `pipeline_runs.ingest_run_id` 即得任务。不去翻
   * `ingest_records`——那里只有真发过 HTTP 的用例，一条纯断言用例会凭空落选。
   *
   * **没有第二档兜底**（P4.5-14，8.11 的 B 类）：`is_default` 列已删。没有历史命中时回
   * `null`，前端按「项目里只有一个任务就用它、多个就让用户选」处理——「只有一个任务」
   * 前端数一下就知道，不需要一列去声明它。
   */
  app.post<{ Params: { id: string }; Body: { caseKeys?: unknown } }>("/api/v1/projects/:id/ci-tasks/recommend", async (request, reply) => {
    const context = await requireProjectAccess(request, reply); if (!context) return;
    const raw = request.body?.caseKeys;
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) return fail(reply, 400, 1001, "caseKeys must be an array of strings");
    const caseKeys = [...new Set((Array.isArray(raw) ? raw : []).map((each) => String(each ?? "").trim()).filter(Boolean))].slice(0, MAX_RECOMMEND_KEYS);

    let taskId: string | null = null;
    let reason: "recent_hit" | null = null;
    let hitCount = 0;

    if (caseKeys.length) {
      const hit = await pool.query(
        `SELECT pr.ci_task_id, COUNT(*)::int AS hits
           FROM repo_test_cases c
           JOIN pipeline_runs pr ON pr.ingest_run_id = c.last_ingest_run_id
           JOIN ci_tasks t ON t.id = pr.ci_task_id AND t.enabled
          WHERE c.project_id = $1 AND c.case_key = ANY($2::text[]) AND pr.status = 'success'
          GROUP BY pr.ci_task_id
          ORDER BY hits DESC, MAX(pr.finished_at) DESC
          LIMIT 1`,
        [context.project.id, caseKeys],
      );
      if (hit.rowCount) {
        taskId = String(hit.rows[0].ci_task_id);
        reason = "recent_hit";
        hitCount = Number(hit.rows[0].hits);
      }
    }
    return success({ ciTaskId: taskId, reason, hitCount, caseKeyTotal: caseKeys.length });
  });

  /**
   * 触发（支持 `parameters` / `caseFilter`，§8.3）。校验、Runner 可用性与沙箱可满足性
   * 检查、排队行的写入全在 `triggerCiTaskRun`（P3-3 边界 5 的单一触发路径）。
   *
   * 202：与流程 / 套件执行同语义——受理了一次执行，不是结论。`Idempotency-Key` 头
   * （P4.5-8）带上后防重：同一键的重复触发返回首次那条 run（响应带
   * `idempotentReplay: true` 让前端能说清「没有新触发」）；不带头保持既有行为
   * （双击两条 run）。键在**成功触发后**才占用：校验失败（400/404/2004）不占键，
   * 同一键换个参数重试是允许的。
   */
  app.post<{ Params: { id: string; taskId: string }; Body: { parameters?: Record<string, string>; caseFilter?: { caseKeys?: unknown } | null } }>(
    "/api/v1/projects/:id/ci-tasks/:taskId/trigger",
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, true); if (!context) return;
      const normalizedKey = normalizeIdempotencyKey(request.headers["idempotency-key"]);
      if (normalizedKey.error) return fail(reply, 400, 1001, normalizedKey.error);
      try {
        const run = await triggerCiTaskRun({
          projectId: context.project.id,
          ciTaskId: request.params.taskId,
          parameters: request.body?.parameters,
          caseFilter: request.body?.caseFilter,
          triggeredBy: context.user.id,
          idempotencyKey: normalizedKey.key,
          requestIp: request.ip,
        });
        return reply.code(202).send(success(run));
      } catch (error) {
        /* 幂等命中不是失败：回首次的 run（202 语义不变——那次受理确实发生过）。 */
        if (error instanceof IdempotentReplayError) {
          return reply.code(202).send(success({ ...error.run, idempotentReplay: true }));
        }
        return failTrigger(reply, error, "CI task could not be triggered");
      }
    },
  );
}
