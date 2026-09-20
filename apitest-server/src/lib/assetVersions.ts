import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  mapCiTask, mapDataSource, mapEndpoint, mapEnvironment, mapFlow, mapMock, mapScript, mapSpecCase, mapSqlDefinition, mapTestCase, mapTestSuite,
  type AssetVersionType, type CiTask, type DataSource, type Endpoint, type Environment, type Flow, type Mock, type Script, type SpecCase, type SqlDefinition, type TestCase, type TestSuite,
} from "../models/types.js";

/*
 * P10-4（计划 14.3，迁移 067）：统一版本模型的写侧半边。
 *
 * 只做一件事：在**调用方已经开好的事务里**，为某个资产落一版内容快照。快照写入与资产写入
 * 同事务 —— 失败整体回滚（计划 14.3 边界），所以本模块只接 `PoolClient`，不自己 connect、
 * 不自己 BEGIN/COMMIT。四条写路径（endpoints / cases / specCases / environments）各自把
 * 单条写包进事务后调这里。
 *
 * secret 纪律：环境快照的 secrets 只存**键名**（`environmentSnapshot` 取自 mapEnvironment 的
 * secretKeys），绝不含值。版本表落在库里、之后要在 diff（P10-5）里展示，存了明文就等于在
 * 这里给全站脱敏口径（Spec 4.6）开了个洞。
 */

/**
 * 每资产保留的版本上限（2026-09-20 拍板的显式决策点）。默认 50；`0` = 不裁剪。
 *
 * 读一次、缓存在模块级：这是运维旋钮不是热配置，改了要重启进程（与仓库其它
 * `process.env.X ?? 默认` 的读法同口径）。非法值（负数 / 非数字）回落默认，不静默关掉裁剪。
 */
const RETENTION = (() => {
  const raw = Number(process.env.ASSET_VERSION_RETENTION ?? 50);
  return Number.isInteger(raw) && raw >= 0 ? raw : 50;
})();

/**
 * 在既有事务里落一版快照，并按保留策略裁剪旧版。
 *
 * `version_no` 取该资产现有最大值 +1（首版为 1），单调递增、永不复用 —— 裁剪删掉早期版本
 * 后编号不回头，"回滚到第 N 版"的编号永远指向同一份内容。并发下两条写可能取到同号，唯一索引
 * `asset_versions_asset_version_idx` 把后者打回（23505）；调用方的事务本就会因异常回滚，不吞。
 *
 * 裁剪与插入同事务：按 version_no 保留最高的 RETENTION 个、删更早的。RETENTION=0 时跳过。
 */
export async function recordAssetVersion(
  client: PoolClient,
  params: {
    projectId: string;
    assetType: AssetVersionType;
    assetId: string;
    snapshot: Record<string, unknown>;
    changeSummary: string;
    /** 存这一版的人；NULL = 系统/非人工写入。 */
    createdBy: string | null;
  },
): Promise<void> {
  const next = await client.query(
    "SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM asset_versions WHERE asset_type = $1 AND asset_id = $2",
    [params.assetType, params.assetId],
  );
  const versionNo = Number(next.rows[0].version_no);
  await client.query(
    `INSERT INTO asset_versions (id, project_id, asset_type, asset_id, version_no, snapshot, change_summary, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [randomUUID(), params.projectId, params.assetType, params.assetId, versionNo, JSON.stringify(params.snapshot), params.changeSummary, params.createdBy],
  );
  if (RETENTION > 0) {
    /* 保留最高的 RETENTION 个版号：删 version_no ≤ (本次版号 - RETENTION) 的行。本次插入让
       最大版号变成 versionNo，故阈值就是 versionNo - RETENTION（含）以下全删。 */
    await client.query(
      "DELETE FROM asset_versions WHERE asset_type = $1 AND asset_id = $2 AND version_no <= $3",
      [params.assetType, params.assetId, versionNo - RETENTION],
    );
  }
}

/* ── 每类资产的内容快照构造器 ──────────────────────────────────────────────
 *
 * 都从 map*() 的出参（camelCase、已脱敏）取，而不是原始行：diff（P10-5）比较的就是这份
 * API 形状，且能天然避开 created_by_email/updated_at 这类会话性/派生字段 —— 那些不是"内容"，
 * 进了快照只会让相邻两版看起来"改过"其实没改。 */

/** 接口定义快照：可运行部分 + 定义元数据（name/description/tags/默认环境）。 */
export function endpointSnapshot(endpoint: Endpoint): Record<string, unknown> {
  return {
    name: endpoint.name,
    description: endpoint.description,
    method: endpoint.method,
    url: endpoint.url,
    headers: endpoint.headers,
    queryParams: endpoint.queryParams,
    pathParams: endpoint.pathParams,
    bodyType: endpoint.bodyType,
    body: endpoint.body ?? null,
    bodyText: endpoint.bodyText ?? null,
    auth: endpoint.auth,
    tags: endpoint.tags,
    defaultEnvironmentId: endpoint.defaultEnvironmentId ?? null,
  };
}

/** 接口用例快照：请求快照 + 校验/生命周期配置 + 绑定环境。 */
export function testCaseSnapshot(testCase: TestCase): Record<string, unknown> {
  return {
    name: testCase.name,
    description: testCase.description,
    environmentId: testCase.environmentId ?? null,
    environmentName: testCase.environmentName ?? null,
    request: testCase.request,
    assertions: testCase.assertions,
    preRequestHooks: testCase.preRequestHooks,
    extracts: testCase.extracts,
    responseScripts: testCase.responseScripts,
    tags: testCase.tags,
  };
}

/** 文本用例快照：标题/前置/步骤/优先级/状态等文本内容（无请求、无环境）。 */
export function specCaseSnapshot(specCase: SpecCase): Record<string, unknown> {
  return {
    moduleId: specCase.moduleId,
    itemKey: specCase.itemKey ?? null,
    title: specCase.title,
    preconditions: specCase.preconditions,
    steps: specCase.steps,
    priority: specCase.priority,
    tags: specCase.tags,
    status: specCase.status,
    source: specCase.source ?? null,
  };
}

/**
 * 环境快照：变量 / 分区标签 / 默认头 + secret **键名**（取自 mapEnvironment.secretKeys）。
 * 绝不含 secret 值 —— diff 只能显示"某 secret 已变更/新增/删除"，靠比较键集合。
 */
export function environmentSnapshot(environment: Environment): Record<string, unknown> {
  return {
    name: environment.name,
    variables: environment.variables,
    runnerLabel: environment.runnerLabel,
    defaultHeaders: environment.defaultHeaders,
    secretKeys: environment.secretKeys,
  };
}

/* ── P10-6：版本历史扩面的 7 类内容资产快照构造器 ──────────────────────────────
 *
 * 同 P10-4 四类：都从 map*() 出参（camelCase、已脱敏）取内容子集，避开 id/项目/时间戳/归属
 * 这些非内容字段（进快照只会让相邻两版看起来"改过"其实没改）。数据源与 SQL 定义天然不含密文
 * ——mapDataSource 只出 `passwordConfigured` 布尔，密文列 `credentials_encrypted` 从不进快照
 * （与环境 secret 同纪律，Spec 4.6）。 */

/** Mock 快照：匹配规则 + 响应/代理 + 模式/优先级/延迟（不含 publicId 这类建时身份）。 */
export function mockSnapshot(mock: Mock): Record<string, unknown> {
  return {
    name: mock.name,
    endpointId: mock.endpointId ?? null,
    snapshotExecutionId: mock.snapshotExecutionId ?? null,
    mode: mock.mode,
    enabled: mock.enabled,
    priority: mock.priority,
    requestMatch: mock.requestMatch,
    response: mock.response,
    proxyConfig: mock.proxyConfig ?? null,
    delayMs: mock.delayMs,
  };
}

/** 脚本快照：名称/语言/种类/正文 + 依赖库 id 序列（kind 不可改，各版恒同）。 */
export function scriptSnapshot(script: Script): Record<string, unknown> {
  return {
    name: script.name ?? null,
    language: script.language,
    kind: script.kind,
    content: script.content,
    dependencies: script.dependencies,
  };
}

/** 流程快照：整张节点图 + 边/变量/标签 + 绑定环境（快照偏大，靠 retention 封顶）。 */
export function flowSnapshot(flow: Flow): Record<string, unknown> {
  return {
    name: flow.name,
    description: flow.description,
    environmentId: flow.environmentId ?? null,
    environmentName: flow.environmentName ?? null,
    nodes: flow.nodes,
    edges: flow.edges,
    variables: flow.variables,
    tags: flow.tags,
  };
}

/** 套件快照：成员选择 / 执行配置 / 通知配置 / 标签。 */
export function testSuiteSnapshot(suite: TestSuite): Record<string, unknown> {
  return {
    name: suite.name,
    description: suite.description,
    selection: suite.selection,
    execution: suite.execution,
    notify: suite.notify,
    tags: suite.tags,
  };
}

/** 数据源快照：名称 / 类型 / 连接配置 + secret 是否配置（绝不含密文）。 */
export function dataSourceSnapshot(dataSource: DataSource): Record<string, unknown> {
  return {
    name: dataSource.name,
    type: dataSource.type,
    config: dataSource.config,
    passwordConfigured: dataSource.passwordConfigured,
  };
}

/** SQL 定义快照：所属数据源 + 名称/描述 + 种类/语句类型/SQL 或操作 + 参数定义。 */
export function sqlDefinitionSnapshot(sqlDefinition: SqlDefinition): Record<string, unknown> {
  return {
    dataSourceId: sqlDefinition.dataSourceId,
    name: sqlDefinition.name,
    description: sqlDefinition.description,
    kind: sqlDefinition.kind,
    statementType: sqlDefinition.statementType ?? null,
    sql: sqlDefinition.sql ?? null,
    operation: sqlDefinition.operation ?? null,
    params: sqlDefinition.params,
  };
}

/** 仓库任务快照：拉取来源/凭据 + 运行/沙箱/缓存/通知等全部可编辑内容（isolationMode 固定，不入）。 */
export function ciTaskSnapshot(ciTask: CiTask): Record<string, unknown> {
  return {
    name: ciTask.name,
    description: ciTask.description,
    gitUrl: ciTask.gitUrl,
    gitCredentialId: ciTask.gitCredentialId ?? null,
    gitRef: ciTask.gitRef,
    runnerLabel: ciTask.runnerLabel,
    sandboxMode: ciTask.sandboxMode,
    image: ciTask.image,
    steps: ciTask.steps,
    env: ciTask.env,
    cachePaths: ciTask.cachePaths,
    cacheKeyFiles: ciTask.cacheKeyFiles,
    sdkIngestEnabled: ciTask.sdkIngestEnabled,
    notify: ciTask.notify,
    singleConcurrency: ciTask.singleConcurrency,
    timeoutSeconds: ciTask.timeoutSeconds,
    enabled: ciTask.enabled,
  };
}

/* ── P10-5 回滚：把某一版快照写回资产 ──────────────────────────────────────────
 *
 * 回滚 = **把目标版本的 snapshot 写回源表 → 再产一个新版本**（changeSummary 记「回滚」），
 * 不删历史、不就地改写（计划 14.3 边界：回滚不改变「历史不可变」）。所以下面每类资产各有
 * 一个 `restore*` —— 只接 `PoolClient`（进调用方已开好的事务，与写侧同一条纪律），把快照
 * 字段映射回该表的列、UPDATE ... RETURNING，再由调用方 `recordAssetVersion` 落新版本。
 *
 * 三条跨越时间的边界，回滚必须自己扛（快照是「当时的内容」，写回的是「现在的库」）：
 *
 * 1. **引用可能已失效**：接口/用例快照里的 `defaultEnvironmentId` / `environmentId` 指向的
 *    环境可能已被删。接口默认环境有 FK，写回失效 uuid 会撞；用例无 FK 但会产出指向不存在
 *    环境的行。故写回前校验环境仍在本项目，不在则落 NULL（用例保留快照里的 environmentName，
 *    与「环境被删后用例仍读得出打的是哪个」同一取向）。
 * 2. **唯一约束可能已被别人占**：环境名有 UNIQUE(project_id, name)。回滚到旧名时若该名已被
 *    另一个环境占用，写回会撞唯一索引（500）。故先探测，冲突则抛 `AssetRollbackError`
 *    （路由转 409），让用户先改名而不是收到一个说不清的 500。
 * 3. **secret 不可回滚**：环境快照只存 secret 键名、从不存值（Spec 4.6）。因此回滚**不动
 *    secrets 列** —— 无从把旧值写回。调用方在响应里带 `secretsPreserved` 明确这一点。
 */

/** 回滚因当下库状态无法安全落地（如环境重名）。路由捕获后转成 4xx，而不是 500。 */
export class AssetRollbackError extends Error {}

async function environmentExists(client: PoolClient, projectId: string, environmentId: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM environments WHERE id = $1 AND project_id = $2", [environmentId, projectId]);
  return Boolean(result.rowCount);
}

async function restoreEndpoint(client: PoolClient, projectId: string, assetId: string, snapshot: Record<string, unknown>): Promise<Endpoint | undefined> {
  /* 默认环境失效则落 NULL（写回失效 uuid 会撞 endpoints.default_environment_id 的 FK）。 */
  let defaultEnvironmentId = (snapshot.defaultEnvironmentId as string | null | undefined) ?? null;
  if (defaultEnvironmentId && !(await environmentExists(client, projectId, defaultEnvironmentId))) defaultEnvironmentId = null;
  const result = await client.query(
    `UPDATE endpoints SET
       name = $1, description = $2, method = $3, url = $4,
       headers = $5::jsonb, query_params = $6::jsonb, path_params = $7::jsonb,
       body_type = $8, body = $9::jsonb, body_text = $10,
       auth = $11::jsonb, tags = $12, default_environment_id = $13,
       updated_by = $14, updated_at = now()
     WHERE id = $15 AND project_id = $16 RETURNING *`,
    [
      snapshot.name, snapshot.description, snapshot.method, snapshot.url,
      JSON.stringify(snapshot.headers ?? {}), JSON.stringify(snapshot.queryParams ?? {}), JSON.stringify(snapshot.pathParams ?? {}),
      snapshot.bodyType ?? "none", snapshot.body === undefined || snapshot.body === null ? null : JSON.stringify(snapshot.body), (snapshot.bodyText as string | null | undefined) ?? null,
      JSON.stringify(snapshot.auth ?? { type: "none" }), snapshot.tags ?? [], defaultEnvironmentId,
      null, assetId, projectId,
    ],
  );
  return result.rowCount ? mapEndpoint(result.rows[0]) : undefined;
}

async function restoreTestCase(client: PoolClient, projectId: string, assetId: string, snapshot: Record<string, unknown>): Promise<TestCase | undefined> {
  /* 环境失效则落 NULL，但保留快照里的 environmentName（用例仍读得出「当时打的是哪个」）。 */
  let environmentId = (snapshot.environmentId as string | null | undefined) ?? null;
  if (environmentId && !(await environmentExists(client, projectId, environmentId))) environmentId = null;
  const result = await client.query(
    `UPDATE test_cases SET
       name = $1, description = $2,
       environment_id = $3, environment_name = $4,
       request_snapshot = $5::jsonb, assertions = $6::jsonb,
       pre_request_hooks = $7::jsonb, extracts = $8::jsonb, response_scripts = $9::jsonb,
       tags = $10, updated_by = $11, updated_at = now()
     WHERE id = $12 AND project_id = $13 RETURNING *`,
    [
      snapshot.name, snapshot.description,
      environmentId, (snapshot.environmentName as string | null | undefined) ?? null,
      JSON.stringify(snapshot.request ?? {}), JSON.stringify(snapshot.assertions ?? []),
      JSON.stringify(snapshot.preRequestHooks ?? []), JSON.stringify(snapshot.extracts ?? []), JSON.stringify(snapshot.responseScripts ?? []),
      snapshot.tags ?? [], null, assetId, projectId,
    ],
  );
  return result.rowCount ? mapTestCase(result.rows[0]) : undefined;
}

async function restoreSpecCase(client: PoolClient, projectId: string, assetId: string, snapshot: Record<string, unknown>): Promise<SpecCase | undefined> {
  /* 模块可能已删/被移动。快照里的 moduleId 失效则保留用例当前模块（module_id NOT NULL，
     写回失效 uuid 会撞 FK）。item_key / source 是建时身份，回滚不动（PATCH 也不接受它们）。 */
  const moduleId = snapshot.moduleId as string | undefined;
  const moduleOk = moduleId ? (await client.query("SELECT 1 FROM spec_modules WHERE id = $1 AND project_id = $2", [moduleId, projectId])).rowCount : 0;
  const result = await client.query(
    `UPDATE spec_cases SET
       module_id = CASE WHEN $1 THEN $2::uuid ELSE module_id END,
       title = $3, preconditions = $4, steps = $5::jsonb,
       priority = $6, tags = $7, status = $8, updated_at = now()
     WHERE id = $9 AND project_id = $10 RETURNING *`,
    [
      Boolean(moduleOk), moduleOk ? moduleId : null,
      snapshot.title, snapshot.preconditions ?? "", JSON.stringify(snapshot.steps ?? []),
      snapshot.priority ?? "P2", snapshot.tags ?? [], snapshot.status ?? "unreviewed",
      assetId, projectId,
    ],
  );
  return result.rowCount ? mapSpecCase(result.rows[0]) : undefined;
}

async function restoreEnvironment(client: PoolClient, projectId: string, assetId: string, snapshot: Record<string, unknown>): Promise<Environment | undefined> {
  /* 旧名可能已被另一个环境占用（UNIQUE(project_id, name)）：先探测，冲突就抛让路由转 409。 */
  const name = snapshot.name as string;
  const clash = await client.query("SELECT 1 FROM environments WHERE project_id = $1 AND lower(name) = lower($2) AND id <> $3", [projectId, name, assetId]);
  if (clash.rowCount) throw new AssetRollbackError(`an environment named "${name}" already exists; rename it before rolling back`);
  /* secrets 不写回：快照只有键名、无值（Spec 4.6），无从复原旧值。变量/分区标签/默认头照写。
     environments 表没有 updated_at/updated_by 列（001 起就没有，见 environments.ts 注释）。 */
  const result = await client.query(
    `UPDATE environments SET
       name = $1, variables = $2::jsonb, runner_label = $3, default_headers = $4::jsonb
     WHERE id = $5 AND project_id = $6 RETURNING *`,
    [
      name, JSON.stringify(snapshot.variables ?? {}), snapshot.runnerLabel ?? "default", JSON.stringify(snapshot.defaultHeaders ?? {}),
      assetId, projectId,
    ],
  );
  return result.rowCount ? mapEnvironment(result.rows[0]) : undefined;
}

/** 回滚写回的结果：映射后的资产 + 「secret/密文未复原」标记。 */
export type RollbackResult = {
  asset: Endpoint | TestCase | SpecCase | Environment | Mock | Script | Flow | TestSuite | DataSource | SqlDefinition | CiTask;
  /** true = 该资产含无法从快照复原的密文（环境 secret / 数据源密码只存了配置标记），提示前端说明。 */
  secretsPreserved: boolean;
};

/* ── P10-6：7 类扩面资产的回滚写回 ────────────────────────────────────────────
 *
 * 与 P10-4 四类同一条纪律：只接 PoolClient（进调用方事务）、把快照映射回源表列、
 * UPDATE ... RETURNING、由调用方 recordAssetVersion 落新版本。跨时间边界各自扛：失效引用
 * 落 NULL（FK ON DELETE SET NULL 的列，写回失效 uuid 反而会撞 FK），唯一名冲突抛
 * AssetRollbackError（路由转 409），密文列不动（快照本就不含密文，无从复原）。 */

async function endpointExists(client: PoolClient, projectId: string, endpointId: string): Promise<boolean> {
  return Boolean((await client.query("SELECT 1 FROM endpoints WHERE id = $1 AND project_id = $2", [endpointId, projectId])).rowCount);
}

async function restoreMock(client: PoolClient, projectId: string, assetId: string, snapshot: Record<string, unknown>): Promise<Mock | undefined> {
  /* endpoint_id / snapshot_execution_id 都是 ON DELETE SET NULL 的 FK：写回一个已删的 uuid
     会撞 FK，故失效则落 NULL（与「引用外活于其目标」一致）。 */
  let endpointId = (snapshot.endpointId as string | null | undefined) ?? null;
  if (endpointId && !(await endpointExists(client, projectId, endpointId))) endpointId = null;
  let executionId = (snapshot.snapshotExecutionId as string | null | undefined) ?? null;
  if (executionId && !(await client.query("SELECT 1 FROM executions WHERE id = $1 AND project_id = $2", [executionId, projectId])).rowCount) executionId = null;
  const result = await client.query(
    `UPDATE mocks SET
       endpoint_id = $1, snapshot_execution_id = $2::uuid, name = $3, mode = $4,
       enabled = $5, priority = $6, request_match = $7::jsonb, response = $8::jsonb,
       proxy_config = $9::jsonb, delay_ms = $10, updated_by = $11, updated_at = now()
     WHERE id = $12 AND project_id = $13 RETURNING *`,
    [
      endpointId, executionId, snapshot.name, snapshot.mode,
      snapshot.enabled ?? true, snapshot.priority ?? 0, JSON.stringify(snapshot.requestMatch ?? {}), JSON.stringify(snapshot.response ?? {}),
      snapshot.proxyConfig === undefined || snapshot.proxyConfig === null ? null : JSON.stringify(snapshot.proxyConfig), snapshot.delayMs ?? 0, null, assetId, projectId,
    ],
  );
  return result.rowCount ? mapMock(result.rows[0]) : undefined;
}

async function restoreScript(client: PoolClient, projectId: string, assetId: string, snapshot: Record<string, unknown>): Promise<Script | undefined> {
  /* kind 不可改（普通编辑就拦着），故各版 kind 恒同，回滚不写 kind。name IS NOT NULL 把回滚
     限定在具名公共脚本上（匿名脚本无独立生命周期，见 scripts 路由注释）。 */
  const result = await client.query(
    `UPDATE scripts SET name = $1, content = $2, updated_by = $3, updated_at = now()
     WHERE id = $4 AND project_id = $5 AND name IS NOT NULL RETURNING *`,
    [(snapshot.name as string | null | undefined) ?? null, snapshot.content ?? "", null, assetId, projectId],
  );
  if (!result.rowCount) return undefined;
  /* 依赖库回写：快照里的库可能已删。宽松处理——只保留仍存在且确为 library 的 id（失效的
     悄悄丢弃，与其它资源「引用失效落空」同取向），library 自身不接依赖。 */
  const wantIds = [...new Set(((snapshot.dependencies as string[] | undefined) ?? []).filter(Boolean))];
  let liveIds: string[] = [];
  if (wantIds.length && String(result.rows[0].kind) !== "library") {
    const live = await client.query("SELECT id FROM scripts WHERE id = ANY($1::uuid[]) AND project_id = $2 AND kind = 'library'", [wantIds, projectId]);
    const liveSet = new Set(live.rows.map((row) => String(row.id)));
    liveIds = wantIds.filter((id) => liveSet.has(id)); // 保留快照里的原顺序
  }
  await client.query("DELETE FROM script_deps WHERE script_id = $1", [assetId]);
  for (const [position, id] of liveIds.entries()) {
    await client.query("INSERT INTO script_deps (script_id, depends_on_id, position) VALUES ($1, $2, $3)", [assetId, id, position]);
  }
  return mapScript({ ...result.rows[0], dependencies: liveIds });
}

async function restoreFlow(client: PoolClient, projectId: string, assetId: string, snapshot: Record<string, unknown>): Promise<Flow | undefined> {
  /* 绑定环境失效则落 NULL，但保留快照里的 environmentName（流程仍读得出「当时打的是哪个」）。
     节点图整块写回：节点里按 id 引用的脚本若已被回收，运行时才会暴露（与接口默认环境失效
     同类边界）——回滚只复原内容形状，不重建被删的匿名脚本。 */
  let environmentId = (snapshot.environmentId as string | null | undefined) ?? null;
  if (environmentId && !(await environmentExists(client, projectId, environmentId))) environmentId = null;
  const result = await client.query(
    `UPDATE flows SET
       name = $1, description = $2, environment_id = $3, environment_name = $4,
       nodes = $5::jsonb, edges = $6::jsonb, variables = $7::jsonb, tags = $8,
       updated_by = $9, updated_at = now()
     WHERE id = $10 AND project_id = $11 RETURNING *`,
    [
      snapshot.name, snapshot.description ?? "", environmentId, (snapshot.environmentName as string | null | undefined) ?? null,
      JSON.stringify(snapshot.nodes ?? []), JSON.stringify(snapshot.edges ?? []), JSON.stringify(snapshot.variables ?? {}), snapshot.tags ?? [],
      null, assetId, projectId,
    ],
  );
  return result.rowCount ? mapFlow(result.rows[0]) : undefined;
}

async function restoreTestSuite(client: PoolClient, projectId: string, assetId: string, snapshot: Record<string, unknown>): Promise<TestSuite | undefined> {
  /* selection/execution/notify 都是整块替换（与写路径同口径，深合并会留下形状对不上的旧键）。
     execution.environmentId 指向的环境即便已删，成员默认策略在运行时兜底，故这里不校验、原样写。 */
  const selection = (snapshot.selection ?? {}) as Record<string, unknown>;
  const result = await client.query(
    `UPDATE test_suites SET
       name = $1, description = $2, selection_type = $3, selection_config = $4::jsonb,
       execution_config = $5::jsonb, notify_config = $6::jsonb, tags = $7,
       updated_by = $8, updated_at = now()
     WHERE id = $9 AND project_id = $10 RETURNING *`,
    [
      snapshot.name, snapshot.description ?? "", selection.type ?? "all", JSON.stringify(selection),
      JSON.stringify(snapshot.execution ?? {}), JSON.stringify(snapshot.notify ?? {}), snapshot.tags ?? [],
      null, assetId, projectId,
    ],
  );
  return result.rowCount ? mapTestSuite(result.rows[0]) : undefined;
}

async function restoreDataSource(client: PoolClient, projectId: string, assetId: string, snapshot: Record<string, unknown>): Promise<DataSource | undefined> {
  /* 名唯一（UNIQUE(project_id, lower(name))）：旧名被别的数据源占了就抛 409，让用户先改名。
     type 不可改（PUT 从不改它），回滚也不动；密文列 credentials_encrypted 不写回（快照无密文）。 */
  const name = snapshot.name as string;
  const clash = await client.query("SELECT 1 FROM data_sources WHERE project_id = $1 AND lower(name) = lower($2) AND id <> $3", [projectId, name, assetId]);
  if (clash.rowCount) throw new AssetRollbackError(`a data source named "${name}" already exists; rename it before rolling back`);
  const result = await client.query(
    `UPDATE data_sources SET name = $1, config = $2::jsonb, updated_by = $3, updated_at = now()
     WHERE id = $4 AND project_id = $5 RETURNING *`,
    [name, JSON.stringify(snapshot.config ?? {}), null, assetId, projectId],
  );
  return result.rowCount ? mapDataSource(result.rows[0]) : undefined;
}

async function restoreSqlDefinition(client: PoolClient, projectId: string, assetId: string, snapshot: Record<string, unknown>): Promise<SqlDefinition | undefined> {
  /* 名在所属数据源内唯一：旧名被占抛 409。kind 跟随数据源类型、各版恒同，按快照原样写；
     sql/statement_type 只在 kind='sql' 有值，operation 只在非 sql 有值（与写路径 CASE 同口径）。 */
  const existing = await client.query("SELECT data_source_id FROM sql_definitions WHERE id = $1 AND project_id = $2", [assetId, projectId]);
  if (!existing.rowCount) return undefined;
  const dataSourceId = String(existing.rows[0].data_source_id);
  const name = snapshot.name as string;
  const clash = await client.query("SELECT 1 FROM sql_definitions WHERE data_source_id = $1 AND lower(name) = lower($2) AND id <> $3", [dataSourceId, name, assetId]);
  if (clash.rowCount) throw new AssetRollbackError(`an SQL definition named "${name}" already exists; rename it before rolling back`);
  const kind = (snapshot.kind as string | undefined) ?? "sql";
  const result = await client.query(
    `UPDATE sql_definitions SET
       name = $1, description = $2, kind = $3,
       statement_type = CASE WHEN $3 = 'sql' THEN $4 ELSE NULL END,
       sql = CASE WHEN $3 = 'sql' THEN $5 ELSE NULL END,
       operation = CASE WHEN $3 = 'sql' THEN NULL ELSE $6::jsonb END,
       params = $7::jsonb, updated_by = $8, updated_at = now()
     WHERE id = $9 AND project_id = $10 RETURNING *`,
    [
      name, snapshot.description ?? "", kind,
      (snapshot.statementType as string | null | undefined) ?? null, (snapshot.sql as string | null | undefined) ?? null,
      snapshot.operation === undefined || snapshot.operation === null ? null : JSON.stringify(snapshot.operation), JSON.stringify(snapshot.params ?? []),
      null, assetId, projectId,
    ],
  );
  return result.rowCount ? mapSqlDefinition(result.rows[0]) : undefined;
}

async function restoreCiTask(client: PoolClient, projectId: string, assetId: string, snapshot: Record<string, unknown>): Promise<CiTask | undefined> {
  /* git_credential_id 是 ON DELETE RESTRICT 的 FK，但快照里的凭据可能在解除引用后被删：
     失效则落 NULL（任务可无凭据）。isolation_mode 固定为 'shared'，回滚不动。 */
  let gitCredentialId = (snapshot.gitCredentialId as string | null | undefined) ?? null;
  if (gitCredentialId && !(await client.query("SELECT 1 FROM git_credentials WHERE id = $1 AND project_id = $2", [gitCredentialId, projectId])).rowCount) gitCredentialId = null;
  const updated = await client.query(
    `UPDATE ci_tasks SET
       name = $1, description = $2, git_url = $3, git_credential_id = $4, git_ref = $5,
       runner_label = $6, sandbox_mode = $7, image = $8, steps = $9, env = $10::jsonb,
       cache_paths = $11, cache_key_files = $12, sdk_ingest_enabled = $13,
       notify_config = $14::jsonb, single_concurrency = $15, timeout_seconds = $16,
       enabled = $17, updated_at = now()
     WHERE id = $18 AND project_id = $19`,
    [
      snapshot.name, snapshot.description ?? "", snapshot.gitUrl ?? "", gitCredentialId, snapshot.gitRef,
      snapshot.runnerLabel, snapshot.sandboxMode, snapshot.image ?? "", snapshot.steps ?? "", JSON.stringify(snapshot.env ?? {}),
      snapshot.cachePaths ?? [], snapshot.cacheKeyFiles ?? [], snapshot.sdkIngestEnabled ?? false,
      JSON.stringify(snapshot.notify ?? {}), snapshot.singleConcurrency ?? true, snapshot.timeoutSeconds ?? 0,
      snapshot.enabled ?? true, assetId, projectId,
    ],
  );
  if (!updated.rowCount) return undefined;
  /* ci_tasks 的 UPDATE 无 RETURNING join 列（凭据名）；回读一行给出与写路径同形的映射。 */
  const loaded = await client.query("SELECT * FROM ci_tasks WHERE id = $1 AND project_id = $2", [assetId, projectId]);
  return loaded.rowCount ? mapCiTask(loaded.rows[0]) : undefined;
}

/**
 * 把 `snapshot` 写回 `assetType`/`assetId` 的源表（在调用方已开好的事务里）。
 *
 * 返回 `undefined` 表示资产已不存在（源表无此行）——调用方回 404。抛 `AssetRollbackError`
 * 表示当下库状态挡住了回滚（如环境/数据源重名）——调用方回 409。写回后由调用方
 * `recordAssetVersion` 落一个新版本（回滚也是一次「保存」，产新版而非改历史）。
 */
export async function restoreAssetSnapshot(
  client: PoolClient,
  assetType: AssetVersionType,
  projectId: string,
  assetId: string,
  snapshot: Record<string, unknown>,
): Promise<RollbackResult | undefined> {
  switch (assetType) {
    case "endpoint": {
      const asset = await restoreEndpoint(client, projectId, assetId, snapshot);
      return asset ? { asset, secretsPreserved: false } : undefined;
    }
    case "test_case": {
      const asset = await restoreTestCase(client, projectId, assetId, snapshot);
      return asset ? { asset, secretsPreserved: false } : undefined;
    }
    case "spec_case": {
      const asset = await restoreSpecCase(client, projectId, assetId, snapshot);
      return asset ? { asset, secretsPreserved: false } : undefined;
    }
    case "environment": {
      const asset = await restoreEnvironment(client, projectId, assetId, snapshot);
      return asset ? { asset, secretsPreserved: true } : undefined;
    }
    case "mock": {
      const asset = await restoreMock(client, projectId, assetId, snapshot);
      return asset ? { asset, secretsPreserved: false } : undefined;
    }
    case "script": {
      const asset = await restoreScript(client, projectId, assetId, snapshot);
      return asset ? { asset, secretsPreserved: false } : undefined;
    }
    case "flow": {
      const asset = await restoreFlow(client, projectId, assetId, snapshot);
      return asset ? { asset, secretsPreserved: false } : undefined;
    }
    case "test_suite": {
      const asset = await restoreTestSuite(client, projectId, assetId, snapshot);
      return asset ? { asset, secretsPreserved: false } : undefined;
    }
    case "data_source": {
      const asset = await restoreDataSource(client, projectId, assetId, snapshot);
      /* 数据源密码是密文、快照只有 passwordConfigured 标记，回滚不复原密码 → secretsPreserved。 */
      return asset ? { asset, secretsPreserved: true } : undefined;
    }
    case "sql_definition": {
      const asset = await restoreSqlDefinition(client, projectId, assetId, snapshot);
      return asset ? { asset, secretsPreserved: false } : undefined;
    }
    case "ci_task": {
      const asset = await restoreCiTask(client, projectId, assetId, snapshot);
      return asset ? { asset, secretsPreserved: false } : undefined;
    }
  }
}
