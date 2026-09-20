/*
 * P10-4（计划 14.3）：统一版本模型 —— 一张 `asset_versions` 承接四类资产的**内容序列**。
 *
 * **为什么一张表而不是两三套**：P7 边界 18（文本用例版本历史）、P6 边界 16（接口用例版本
 * 历史）、P11 边界 10（diff/回滚）三处欠账都在这张表上还。刻意分处做会长出两套版本模型，
 * 之后 diff/回滚（P10-5）就得写两遍。`asset_type` 单一枚举覆盖 接口 / 接口用例 / 文本用例 /
 * 环境；流程、套件按需后排（届时只加枚举值，不动表结构）。
 *
 * **版本是内容的序列，不是流程状态**（计划 14.3 边界）：这里没有「评审流 / 审批状态机」
 * （P6 边界 16 已排除）。保存即产出一个新版本，由写路径在**同一事务**里落——快照写入与资产
 * 写入一起成功或一起回滚，不靠 audit_logs 事后反推。
 *
 * ── 为什么 asset_id 不是外键 ──────────────────────────────────────────────
 *
 * `asset_id` 指向四张不同的表（endpoints / test_cases / spec_cases / environments），一列
 * 组不成单一外键。故这里只对 `project_id` 建 `ON DELETE CASCADE`：**删项目连版本一起消散**。
 * 删单个资产时版本历史留存（成为孤儿行）——这是刻意的：版本是「曾经存在过的内容」的证据，
 * 与执行历史「谁改的」同一取向（历史外活于其引用，server-contract「History outlives its
 * references」）。孤儿行只随项目删除清理。
 *
 * ── 归属与时间戳带在版本行自己身上 ────────────────────────────────────────
 *
 * 四张源表的归属/时间列并不齐整：`spec_cases` 没有 `updated_by`，`environments` 连
 * created_at/updated_at 都没有。所以「谁在何时存了这一版」不从源行取，由写路径在落版本时
 * 写入本行的 `created_by`（= context.user.id，NULL 表示系统/非人工写入）与 `created_at`。
 *
 * ── secret 纪律 ───────────────────────────────────────────────────────────
 *
 * 环境快照的 `secrets` **只存键名**（沿用 mapEnvironment.secretKeys），**绝不存值**。版本表
 * 落在库里、之后要在 diff 里展示，存了明文就等于把全站脱敏口径（Spec 4.6）在这里开了个洞。
 * diff（P10-5）只显示「某 secret 已变更」，靠比较键集合与写路径记录的变更标记，不回显明文。
 *
 * ── 保留策略（本批显式决策点，2026-09-20 拍板）────────────────────────────
 *
 * **每资产保留最近 N 版**，N 走环境变量 `ASSET_VERSION_RETENTION`（默认 50，0 = 不裁剪）。
 * 裁剪在写路径落新版本的**同一事务**里做（lib/assetVersions.ts 的 recordAssetVersion），
 * 按 version_no 保留最高的 N 个、删更早的。裁剪不影响编号：`version_no` 单调递增、永不复用，
 * 删掉第 1~10 版后第 61 版仍是 61，避免「回滚到某版」的编号在裁剪后指向别的内容。
 * 之所以做上限：接口/环境是高频保存对象，无界增长这张表会比源表还大。
 */

CREATE TABLE IF NOT EXISTS asset_versions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  /* 四类资产共用一列；后排流程/套件时只加枚举值。 */
  asset_type TEXT NOT NULL CHECK (asset_type IN ('endpoint', 'test_case', 'spec_case', 'environment')),
  /* 不是外键：见文件头「为什么 asset_id 不是外键」。 */
  asset_id UUID NOT NULL,
  /* 每资产内单调递增、永不复用；由写路径取 MAX+1，唯一约束兜并发。 */
  version_no INTEGER NOT NULL,
  /* 该版本的完整内容快照（camelCase，与 API 出参同形；环境的 secrets 只含键名）。 */
  snapshot JSONB NOT NULL,
  /* 动作标签（创建/更新/复制/回滚）；改动内容的 diff 由 P10-5 服务端算，不落这里。 */
  change_summary TEXT NOT NULL DEFAULT '',
  /* 存这一版的人；NULL = 系统/非人工写入（源表归属列不齐，故归属带在版本行上）。 */
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* 一个资产的同一版号只能有一行——写路径 MAX+1 在并发下可能取到同号，靠这条打回重试。 */
CREATE UNIQUE INDEX IF NOT EXISTS asset_versions_asset_version_idx
  ON asset_versions (asset_type, asset_id, version_no);

/* 版本列表（P10-5）按资产取、按版号倒序翻；这条索引直接服务它。 */
CREATE INDEX IF NOT EXISTS asset_versions_asset_created_idx
  ON asset_versions (asset_type, asset_id, version_no DESC);
