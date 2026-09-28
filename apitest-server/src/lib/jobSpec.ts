import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { parseAllureDir } from "./allureDir.js";
import { decryptSecret } from "./crypto.js";
import { issueIngestToken } from "./ingestAuth.js";
import { RUNNER_PROTOCOL_VERSION, type SandboxMode } from "../models/types.js";

/**
 * JobSpec 组装（P4.5-3，8.2）。claim 的响应体，也是**全平台唯一**出现 Git 拉取凭据明文
 * 的地方（边界 11 / 迁移 041 的缓解②）：不进 `pipeline_runs` 快照、不进日志、不进任何
 * GET。键名是 snake_case——JobSpec 是冻结协议（8.2）里第三方实现者照抄的那份文档，响应
 * 方向没有「两种拼法都收」可言，跟协议走。
 *
 * 任务配置取**当前值**、沙箱档取 run 行上的**冻结快照**：档位是路由/可满足性判据，
 * 触发那一刻定终身；image 没有快照列，用任务当前值（改 image 不需要新 run 才生效，
 * 与「任务改配置后历史仍说得清」不冲突——run 上记住的是 mode）。
 *
 * **P4.5-14 的两处改动**（见计划 8.11）：clone 来源从 `ci_tasks` 自己那两列取（不再
 * join `repositories`），`report` 从 `steps` 里解析 `--alluredir` 得来——报告目录的单一
 * 出处是命令行本身。任务级 secret 已删，`secrets` 固定为空数组（协议字段保留，见下）。
 */

export type JobSpec = {
  job_id: string;
  project_id: string;
  ci_task_id: string;
  run_number: number;
  repo: {
    clone_url: string;
    clone_method: "none" | "https_token" | "ssh_key";
    /** ★ 只在这里出现；不进快照、不进日志、不进任何 GET。 */
    credential: string | null;
  };
  git_ref: string;
  sandbox: {
    mode: SandboxMode;
    image: string;
    cpu_limit: string;
    memory_limit: string;
    disk_limit: string;
    /** container 档才生效（8.5）；进程档是信任声明，做不到网络隔离。 */
    network: { deny_cidrs: string[] };
  };
  steps: string;
  env: Record<string, string>;
  /**
   * **协议字段保留但平台永远发空数组**（P4.5-14）：任务级 secret 已删，平台不再有敏感
   * 值词表。字段留着是因为协议 v1.0 是冻结的，去掉一个键会让已部署的 Runner 在解析时
   * 见到 `undefined`；Runner 侧的脱敏机制照旧存在（clone 凭据仍走它），只是没有输入。
   */
  secrets: { key: string; value: string }[];
  cache: { paths: string[]; key_files: string[] };
  /** `format` 恒为 `allure` 或 `none`（解析不到目录时）；`paths` 是解析出的那一个目录。 */
  report: { format: "none" | "junit" | "allure"; paths: string[] };
  artifact_paths: string[];
  case_filter: { case_keys: string[] } | null;
  timeout_seconds: number;
  protocol_version: string;
};

/*
 * 沙箱限额是平台级默认值而不是任务列（迁移 037 没建那几列——限额属于「这台机器愿意
 * 给多少」，与任务的「怎么跑」是两个维度）。env 可覆盖，覆盖值进 JobSpec 原样下发。
 */
const CPU_LIMIT = process.env.RUNNER_CPU_LIMIT?.trim() || "2";
const MEMORY_LIMIT = process.env.RUNNER_MEMORY_LIMIT?.trim() || "2g";
const DISK_LIMIT = process.env.RUNNER_DISK_LIMIT?.trim() || "10g";
/** 默认只封云元数据地址；平台内网段部署侧按需追加（逗号分隔）。 */
const DENY_CIDRS = (process.env.RUNNER_DENY_CIDRS ?? "169.254.169.254/32")
  .split(",").map((cidr) => cidr.trim()).filter(Boolean);

export type ClaimedRun = {
  id: string;
  project_id: string;
  ci_task_id: string;
  run_number: number;
  git_ref: string;
  sandbox_mode: string;
  case_filter: { case_keys?: unknown[] } | null;
  parameters: Record<string, unknown>;
};

/** 解不开的凭据密文按「无凭据」处理并抛错更糟：clone 会以一条看不懂的失败收场，所以
    这里让它抛——密钥轮换是运维事件，让 claim 明确失败比发出一个注定失败的 job 好。 */
function decryptCredential(encrypted: unknown): string | null {
  if (!encrypted) return null;
  return decryptSecret(encrypted as Buffer);
}

/**
 * 组装 JobSpec。`baseUrl` 是平台对外根地址（SDK 的 `APITRACK_URL` 接受根地址或完整
 * `/ingest`，`apitrack-sdk/apitrack/config.py` 两种都归一）。
 *
 * 容器档的回环改写（`containerLoopback`）：`baseUrl` 缺省取 Runner 拨号的 Host 头，
 * 本机部署时是 `localhost:3000`——对进程档 Runner 正好，但**容器档的脚本在容器里**，
 * `localhost` 指向容器自身，SDK 上报会 Connection refused（run #23 实测）。改写目标是
 * `host.apitrack.internal`：Runner 起容器时用 `--add-host` 把它指到宿主网关（见
 * executor 容器档），Linux 原生 docker / Docker Desktop / OrbStack 语义一致——
 * `host.docker.internal` 只在 Docker 系桌面产品里内置，Linux 上不存在，不能用。
 * 只对 container 档改写、且只改回环地址；部署侧显式配了 PUBLIC_BASE_URL 时原样使用
 * （那已经是「对所有消费者都可达」的地址，平台不猜）。
 */
function containerLoopback(baseUrl: string, sandboxMode: string): string {
  if (sandboxMode !== "container") return baseUrl;
  try {
    const url = new URL(baseUrl);
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1") return baseUrl;
    url.hostname = "host.apitrack.internal";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

export async function buildJobSpec(baseUrl: string, run: ClaimedRun): Promise<JobSpec> {
  const loaded = await pool.query(
    `SELECT t.name AS task_name, t.steps, t.env, t.image,
            t.cache_paths, t.cache_key_files,
            t.sdk_ingest_enabled, t.timeout_seconds,
            t.git_url, c.method AS credential_method, c.credential_encrypted
       FROM ci_tasks t LEFT JOIN git_credentials c ON c.id = t.git_credential_id
      WHERE t.id = $1`,
    [run.ci_task_id],
  );
  /* FK 级联保证任务在则 run 在（删任务会连带删 run），这里只剩理论竞态——抛错让 claim
     路由把行放回 queued，而不是发出一个空壳 job。 */
  if (!loaded.rowCount) throw new Error("CI task disappeared before claim");
  const task = loaded.rows[0];

  /*
   * `APITRACK_TOKEN` 按 run 现签一张新的 ingest token（8.2 约定 8「复用 ingest_tokens」
   * 的落地形状）：明文进 JobSpec、加密密文进 `ingest_tokens`（名字带任务与序号，列表页
   * 认得出是 CI 签的，可吊销）。按 run 一张意味着隔离与吊销都以 run 为粒度；run 终态后
   * 由 `complete`（P4.5-4）顺手吊销，防行数无界增长。
   */
  let ingestToken: string | undefined;
  if (task.sdk_ingest_enabled) {
    const issued = issueIngestToken();
    await pool.query(
      "INSERT INTO ingest_tokens (id, project_id, name, secret_encrypted, token_prefix) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), run.project_id, `ci ${String(task.task_name)} #${run.run_number}`, issued.secretEncrypted, issued.prefix],
    );
    ingestToken = issued.plaintext;
  }

  /*
   * 合并顺序只有一层要讲清：任务 env ← 触发参数 ← 平台注入（URL/TOKEN/CI_RUN_ID/
   * GIT_URL/BRANCH 五件）。参数的键形在触发时已按 `VARIABLE_NAME_PATTERN` 校验
   * （lib/trigger.ts），但校验不排除 `APITRACK_*`——注入必须最后压栈，让用户侧同名
   * 变量被「拒绝写入任务 env」的规则（routes/ciTasks.ts）之外再有一道运行时兜底。
   */
  const env: Record<string, string> = {
    ...((task.env ?? {}) as Record<string, string>),
    ...(run.parameters as Record<string, string>),
  };
  if (task.sdk_ingest_enabled) {
    env.APITRACK_URL = containerLoopback(baseUrl, String(run.sandbox_mode));
    env.APITRACK_TOKEN = ingestToken!;
    /* SDK 拿它做「本次执行」的标识上报（ci_run_id 列保留「最近一次来自哪次执行」）。
       幂等折行已改为按 commit（迁移 045）：同一 commit 的再次执行不再新增上报行，
       平台反查 pipeline_runs.ingest_run_id 用 (repository, commit_sha)。 */
    env.APITRACK_CI_RUN_ID = run.id;
    /* 仓库身份必须显式注入：Runner 的 clone 是 init+fetch+checkout、刻意不
       `git remote add`（https_token 的地址带凭据，落进 workspace 的 .git/config 就活到
       任务结束），于是 workspace 里没有 remote.origin，SDK 的 detect_git_url() 永远
       拿不到——它的告警原文就叫人设 APITRACK_GIT_URL。任务自己带着 clone 地址，
       在这里下发，SDK 的 env 优先级会直接采用它。 */
    const gitUrl = String(task.git_url ?? "").trim();
    if (gitUrl) env.APITRACK_GIT_URL = gitUrl;
    /* 分支同理：clone 的最后一步是 `checkout --detach FETCH_HEAD`（`clone --branch`
       不收 commit sha，detach 是唯一能同时覆盖分支/tag/sha 的形状），workspace 处于
       detached HEAD——`rev-parse --abbrev-ref` 只会返回字面量 HEAD，SDK 的
       detect_branch() 按设计宁可回空串也不猜（取错与取空同样不对账，都安全）。但空
       分支永远过不了删除对账的第二道闸门（branch = tracking_branch），而平台明明
       知道这次跑的 ref。ref 形如 commit sha 时不注入：sha 不是分支名，报上去只会
       让上报记录的分支列显示一个假分支。 */
    const gitRef = run.git_ref.trim();
    if (gitRef && !/^[0-9a-f]{7,40}$/i.test(gitRef)) env.APITRACK_BRANCH = gitRef;
  }

  /*
   * 报告目录从命令行解析（P4.5-14）。解析不到就发 `format: 'none'`——Runner 侧的收集器
   * 见到 none 直接跳过，不会去猜一个目录。这与保存时「提示而不是拒绝」是同一个取舍的
   * 两端：平台不猜，用户在界面上已经被告知过跑完不会有报告。
   */
  const allureDir = parseAllureDir(String(task.steps ?? ""));

  return {
    job_id: run.id,
    project_id: run.project_id,
    ci_task_id: run.ci_task_id,
    run_number: run.run_number,
    repo: {
      clone_url: String(task.git_url ?? ""),
      /* 拉取方式随凭据走（迁移 041）：没引用凭据就是公开仓库，协议里仍用 `none` 表达
         ——那是 Runner 侧 `cloneRepository` 的三个分支之一，协议不变。 */
      clone_method: (task.credential_method ? String(task.credential_method) : "none") as JobSpec["repo"]["clone_method"],
      credential: decryptCredential(task.credential_encrypted),
    },
    git_ref: run.git_ref,
    sandbox: {
      mode: String(run.sandbox_mode) as SandboxMode,
      image: String(task.image ?? ""),
      cpu_limit: CPU_LIMIT,
      memory_limit: MEMORY_LIMIT,
      disk_limit: DISK_LIMIT,
      network: { deny_cidrs: DENY_CIDRS },
    },
    steps: String(task.steps ?? ""),
    env,
    /* 任务级 secret 已删（P4.5-14）：协议字段留着，值恒为空。 */
    secrets: [],
    cache: {
      paths: Array.isArray(task.cache_paths) ? task.cache_paths.map(String) : [],
      key_files: Array.isArray(task.cache_key_files) ? task.cache_key_files.map(String) : [],
    },
    report: allureDir ? { format: "allure", paths: [allureDir] } : { format: "none", paths: [] },
    /* 产物路径这一列已删（P4.5-14）：allure-results 的打包上传是平台自己的行为
       （边界 19 的报告层，由 `report.format='allure'` 触发），与它从来无关。 */
    artifact_paths: [],
    case_filter: run.case_filter
      ? { case_keys: Array.isArray(run.case_filter.case_keys) ? run.case_filter.case_keys.map(String) : [] }
      : null,
    timeout_seconds: Number(task.timeout_seconds ?? 1800),
    protocol_version: RUNNER_PROTOCOL_VERSION,
  };
}
