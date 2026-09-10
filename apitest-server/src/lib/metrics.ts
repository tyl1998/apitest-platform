/**
 * 统计口径的单一事实源（P8-1，边界 2）。
 *
 * 平台曾有三种「通过率」在跑：报告列表/详情用 passed/(passed+failed)（2026-09-03
 * 用户改口径），报告详情拼装 `reportPayload.ts` 却还在用 success/total，套件通知
 * 模版用 (s+f+skipped)。口径修复与新增代码混在一批，数字变了分不清是「修对了」
 * 还是「新 bug」——所以 P8-1 是纯收口步，先把三件事收敛到这里：
 *
 * 1. **通过率公式**：passed / (passed + failed)。skipped 不进分母（一条被跳过的
 *    用例没有给出结论，算进「没通过」会拉低读数）；canceled 是用户动作不是质量
 *    信号，同样不进分母。**全 skip 的报告读 null**——「没有结论」而不是 0%。
 * 2. **失败样本集**：status 过滤（已定局）+ 自指排除（`detail_id <> id`，见
 *    `NOT_SELF_DEBUG`）+ `includeRepo` 语义（见 `sampleKinds`）。
 * 3. **资产新增口径**：各表 `created_at` 计数（P8-2 起新归因统计直接做对，旧
 *    summary 的失败分布两段随新页替换退役，不在本批改）。
 *
 * 形态是 **SQL 片段常量**（边界 2 的原话）：`PASS_RATE_SQL` 这类字符串常量比参数化
 * 抽象好读，这是 SQL 拼接纪律（只有代码作者写死的片段可拼接，请求值永远走 $n
 * 占位符）允许的形态。片段工厂只接收**代码写死的表别名/列名**（`"se"`、
 * `"passed_count"`），不接收任何请求值——那与拼接纪律冲突。
 */

/**
 * 通过率的分母：有结论的执行数（裸 SQL 表达式，表别名由嵌入方传）。
 * 列名不同心的表（pipeline_runs 叫 passed_count）用 `SETTLED_SUM` 的列参版本。
 */
export const SETTLED_SUM = (prefix: string, passedCol = "success_count", failedCol = "failed_count") =>
  `(${prefix}.${passedCol} + ${prefix}.${failedCol})`;

/**
 * 完整的通过率 CASE 表达式（ROUND 到 0.1）。分母 = passed + failed，skipped 与
 * canceled 都不进——理由见文件头。全 skip / 全 cancel 时为 NULL（「没有结论」）。
 *
 * 用法：`PASS_RATE_SQL("se")` 嵌进 SELECT 列表；pipeline_runs 侧列名不同，
 * `PASS_RATE_SQL("pr", "passed_count")` 显式传列名（同一公式，两处不再各手写
 * 一份 CASE）。
 */
export const PASS_RATE_SQL = (prefix: string, passedCol = "success_count", failedCol = "failed_count") =>
  `CASE WHEN ${SETTLED_SUM(prefix, passedCol, failedCol)} > 0 ` +
  `THEN ROUND(${prefix}.${passedCol}::numeric * 100 / ${SETTLED_SUM(prefix, passedCol, failedCol)}, 1) END`;

/**
 * 单步调试自指索引行的排除片段（`executionIndex.ts` 列表侧同一纪律）。
 *
 * 非 HTTP 单步调试写的是一次性父索引（`routes/flows.ts` 的 `executeGenericStep`，
 * `detail_id = id` 自指），它存在的唯一理由是给那一行 `execution_steps` 一个归属，
 * 不是一次「父执行」。统计样本必须排除它：一次节点调试不该进趋势与汇总的通过率
 * ——列表侧早已排除（executionIndex.ts 的 `detail_id <> id`），P8-1 把趋势
 * （reports/trend）与汇总（reports/summary）补齐到同一口径。
 *
 * 两张表的 id 都是 randomUUID，真实父执行不可能 `detail_id = id`——自指是这类行
 * 唯一稳定的标记。片段恒真恒假与请求值无关，可安全拼进 ON/WHERE；单表查询不传
 * 前缀，多表 JOIN（趋势的 ON 条件）传别名显式限定，防未来加表后 `id` 歧义。
 */
export const NOT_SELF_DEBUG = (prefix?: string) =>
  prefix ? `${prefix}.detail_id <> ${prefix}.id` : "detail_id <> id";

/**
 * 趋势与汇总的样本口径（P4 边界 1 + P4.5 边界 2；2026-09-10 用户验收反馈起三态化）。
 *
 * 三态：`platform`（默认，只算 `flow`/`suite`——平台自己跑的）、`repo`（只算
 * `ingest`/`runner`——仓库侧的）、`all`（混合）。原单开关只有「平台 / 混合」两态，
 * 「只看仓库」没有入口；扩成三态时 **ingest 与 runner 仍是一体**（P4.5 边界 2
 * 的理由继续成立：对用户是同一件事），拆的是「平台 / 仓库」这一层。
 *
 * 默认 platform 的理由不变：外部 CI 的 `latency_ms` 是用户进程里的客户端耗时，
 * 与平台的墙钟耗时不是一个口径，混进同一条分位数曲线得到的是一个谁都不认的数；
 * 而一次 `-m smoke` 的局部跑会把通过率拉出一个没人认的台阶。
 *
 * 这是一段代码作者写死的 SQL 片段，不是请求值拼接。
 */
export type SampleScope = "platform" | "repo" | "all";

export function sampleKinds(scope: SampleScope) {
  if (scope === "repo") return "('ingest', 'runner')";
  if (scope === "all") return "('flow', 'suite', 'ingest', 'runner')";
  return "('flow', 'suite')";
}

/**
 * 通过率的 TypeScript 侧同款公式（通知模版等 Node 内计算用）。
 *
 * SQL 与 TS 各持一份是刻意的：SQL 片段进 SELECT 列表（聚合行一次算好），TS 版本
 * 供已有事件计数的场景（告警/通知拿的是事件上的数字，不再查一次库）。两处的分母
 * 语义必须一致——分母不含 skipped/canceled，null 表示「没有结论」。
 */
export function passRateOf(passed: number, failed: number): number | null {
  const settled = passed + failed;
  return settled > 0 ? Math.round((passed / settled) * 1000) / 10 : null;
}

/**
 * Flaky 判定阈值（P8-4，计划 12.3）：窗口内同一 case_id（或仓库 case_key）的定局
 * 序列**同时满足**四条才算不稳定用例——≥6 次执行、相邻状态翻转 ≥3 次、passed 与
 * failed 各 ≥2 次。
 *
 * 写死在口径库（与通过率同处，计划原话）：`/stats/flaky` 三条腿（executions 的
 * case_id 序列 + ingest_records 推导的仓库用例 SDK 序列 + pipeline_run_cases 的
 * 仓库任务序列）的 SQL HAVING 从这份常量拼数字，不各自手写——三处各写一份迟早
 * 漂移。这是代码写死的常量（非请求值），拼进 SQL 与拼接纪律不冲突。
 */
export const FLAKY = { MIN_RUNS: 6, MIN_FLIPS: 3, MIN_PASSED: 2, MIN_FAILED: 2 } as const;
