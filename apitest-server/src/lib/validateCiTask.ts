import { pool } from "../db.js";
import { DEFAULT_RUNNER_LABEL, RUNNER_LABEL_PATTERN } from "./queue.js";
import { VARIABLE_NAME_PATTERN } from "./resolve.js";
import { isUuid } from "./uuid.js";
import { normalizeSuiteNotify, SANDBOX_MODES, type CiTask, type SandboxMode, type SuiteNotifyConfig } from "../models/types.js";

/**
 * CI 任务草稿的合并与校验（P5-5b 自 `routes/ciTasks.ts` 原样提取，边界 8 的同一笔账）。
 * 函数体逐字搬移：签名、错误文案、`existing` 兜底语义零改动。
 */

/** 24 小时：再长的任务该拆该上调度，而不是占一个 Runner 槽位一天。 */
export const MAX_TIMEOUT_SECONDS = 86400;
/** 平台注入的 `APITRACK_*` 三件套（8.2 约定 8）在 JobSpec 组装时由平台压栈：用户侧
    同名变量会被静默盖掉，与其事后解释不如写入时就拒绝。 */
export const RESERVED_ENV_PREFIX = "APITRACK_";
/** 缓存路径数组的防手误上限。 */
export const MAX_PATH_ENTRIES = 64;

export type CiTaskBody = {
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

export type TaskDraft = {
  name: string; description: string; gitUrl: string; gitCredentialId: string | null; gitRef: string;
  runnerLabel: string; sandboxMode: SandboxMode; image: string; steps: string;
  env: Record<string, string>; cachePaths: string[]; cacheKeyFiles: string[];
  sdkIngestEnabled: boolean; timeoutSeconds: number; enabled: boolean;
  notify: SuiteNotifyConfig;
  singleConcurrency: boolean;
};

function optionalString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? fallback : trimmed;
}

/** 相对路径数组（缓存）：Runner 会把它拼进 workspace，先挡掉绝对路径与 `..`。 */
export function validatePathList(field: string, input: unknown): { list?: string[]; error?: string } {
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
export function validateGitUrl(url: string): string | undefined {
  if (!url) return "gitUrl is required; a CI task needs somewhere to clone from";
  if (url.length > 1024) return "gitUrl must be at most 1024 characters";
  if (/^(https?|ssh):\/\/\S+$/i.test(url)) return undefined;
  if (/^[\w.-]+@[\w.-]+:\S+$/.test(url)) return undefined;
  return 'gitUrl must be an https://, http://, ssh:// URL or scp-style "git@host:group/repo.git"';
}

/** 把请求体合并成一份完整草稿（create 用缺省值兜底，update 用已存行兜底）并校验。 */
export function mergeDraft(body: CiTaskBody, existing?: CiTask): { draft?: TaskDraft; error?: string } {
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
export async function assertCredentialOwned(projectId: string, credentialId: string | null): Promise<boolean> {
  if (credentialId === null) return true;
  const found = await pool.query("SELECT 1 FROM git_credentials WHERE id = $1 AND project_id = $2", [credentialId, projectId]);
  return Boolean(found.rowCount);
}

/**
 * 通知配置校验（P4.5-12）：形状 + 渠道属于本项目 + 模版字段是短字符串。
 *
 * 与 `lib/validateSuite.ts` 的 `validateSuiteNotify` 是同一份判据的第二个调用点。**刻意
 * 保持两份而不抽公共函数**：它读的是同一张 `notification_channels` 表、用同一个归一函数，
 * 但错误文案的字段前缀属于各自的请求体契约；抽出去要么把 `notify.` 这个前缀写死（对
 * 两边都对，但从此那个函数不再属于任何一方），要么多一个参数只为拼字符串。真正不能有
 * 两份的是**归一**（`normalizeSuiteNotify`）与**投递**（`lib/alerts.ts`），那两处已经是一份。
 *
 * 渠道存在性必须查库：悬空 id 会让「开关开了」的任务在终态静默少发一封通知，那比保存
 * 被拒绝难发现得多。
 */
export async function validateCiTaskNotify(projectId: string, notify: unknown): Promise<string | undefined> {
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
