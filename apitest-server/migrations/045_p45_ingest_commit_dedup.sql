/*
 * P4 上报幂等键的口径变更（2026-09-03 用户改口径）。
 *
 * 035 的键是 `(repository_id, commit_sha, ci_run_id)`——CI 任务每条 run 注入的
 * APITRACK_CI_RUN_ID 就是 job id，于是**同一 commit 的每次执行都新增一行**（用户实测：
 * 一个 commit 报了 8 次，ingest_records 跟着翻 8 倍）。原口径防的是「同一次 CI run 的
 * 重投」，但把「同一 commit 的再次执行」也当成新数据收进来——用户明确不期望这样：
 * 仓库用例的「快照」语义以 commit 为单位，同 commit 的重复执行不改变快照内容，
 * 只该更新「最近一次什么时候跑的、结果是什么」。
 *
 * 新口径：键 = `(repository_id, commit_sha, ci_run_id = '')`——按 commit 去重，
 * 任意 ci_run_id 的上报都折到同一行（ci_run_id 保留为「最近一次上报的来源」）。
 * SDK 直跑（ci_run_id = ''）行为不变：同 commit 合并。
 *
 * 代价与缝合：
 * - `pipeline_runs.ingest_run_id` 的反查（`completePipelineRun`）原按
 *   `ci_run_id = run.id` 精确命中；键折行后同一 ingest 行被多条 run 共享，反查改按
 *   `(project, commit, ci_run_id ∈ 该 commit 的任一次上报)` → 拿到那行折合后的
 *   ingest run。`markCaseFilterNotRun` 的判据 `last_ingest_run_id = 本次 ingest run`
 *   语义不变：所有上报都推同一行，`last_ingest_run_id` 就是它。
 * - `execution_index`（kind='ingest'）继续一行：`UNIQUE (kind, detail_id = ingest run id)`
 *   折行后天然唯一；新增 `ci_execution_index_id` 列存「同 commit 最近一次 CI 执行」的
 *   run 归一索引行，供前端显示「这个 commit 跑过几次」而不必造第二行。
 * - `request_count` / `unmatched_count` 在旧行口径下随重投累积；折行后同 commit 的
 *   完全重投增量为 0（insertRecords 只数新插的行），只有 payload 内容真变了才会涨，
 *   语义回到「这份快照现在长什么样」。
 *
 * 旧行（同 commit 多行）在迁移里就地合并：留最早那行（diff 定局的那一次），
 * ci_run_id 取最新一次的（「最近一次上报来自哪次执行」），其余行删除——
 * ingest_records 的 FK ON DELETE CASCADE 会带走各自的记录行，正好把翻倍的数据
 * 收回来；execution_index 的行指向被删的 run id 时由 015 的 ON DELETE SET NULL
 * 兜底，迁移最后把它们指回保留行。
 */

DO $$
DECLARE
  keep_id UUID;
  latest_ci TEXT;
  lost_index UUID;
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT repository_id, commit_sha,
           (array_agg(id ORDER BY created_at ASC))[1] AS keep,
           (array_agg(id ORDER BY created_at DESC))[1] AS newest
      FROM ingest_runs
     GROUP BY repository_id, commit_sha
     HAVING COUNT(*) > 1
  LOOP
    keep_id := dup.keep;
    SELECT ci_run_id INTO latest_ci FROM ingest_runs WHERE id = dup.newest;
    /* execution_index(kind='ingest') 的行先改指保留行——015 的 FK 是 SET NULL，先删
       再改会丢关联。先删重复目标行再改：同 commit 有 N 行 run 时会各有自己的 index 行
       （UNIQUE(kind, detail_id)），全部改指保留行会互相撞键——删掉多余行、保留行的
       index 行指回 detail_id=保留行，聚合值取各次执行里最新的一条。 */
    DELETE FROM execution_index e
     WHERE e.kind = 'ingest' AND e.detail_id IN (
       SELECT id FROM ingest_runs
        WHERE repository_id = dup.repository_id AND commit_sha = dup.commit_sha)
       AND e.id <> (
         SELECT i.id FROM execution_index i
          WHERE i.kind = 'ingest' AND i.detail_id = dup.newest
          LIMIT 1);
    UPDATE execution_index
       SET detail_id = keep_id
     WHERE kind = 'ingest' AND detail_id = dup.newest;
    /* repo_test_cases.last_ingest_run_id（SET NULL）指回保留行：markCaseFilterNotRun
       的判据是「= 本次 ingest run」，NULL 会让差集把刚跑过的用例误标 not_run。 */
    UPDATE repo_test_cases
       SET last_ingest_run_id = keep_id
     WHERE last_ingest_run_id IN (
       SELECT id FROM ingest_runs
        WHERE repository_id = dup.repository_id AND commit_sha = dup.commit_sha
          AND id <> keep_id);
    /* 关系表的 first/last_seen_run_id 同理（SET NULL FK，语义上「第一次见到」属于
       最早那行——本来就是保留行；「最后一次见到」折到最新，直接指保留行即对。 */
    UPDATE repo_case_endpoints
       SET first_seen_run_id = COALESCE(first_seen_run_id, keep_id),
           last_seen_run_id = keep_id
     WHERE last_seen_run_id IN (
       SELECT id FROM ingest_runs
        WHERE repository_id = dup.repository_id AND commit_sha = dup.commit_sha
          AND id <> keep_id);
    /* pipeline_runs.ingest_run_id（SET NULL FK）：折行后同 commit 的多条 run 共指
       保留行——这正是新缝合口径（completePipelineRun 的反查同样会拿到它）。 */
    UPDATE pipeline_runs
       SET ingest_run_id = keep_id
     WHERE ingest_run_id IN (
       SELECT id FROM ingest_runs
        WHERE repository_id = dup.repository_id AND commit_sha = dup.commit_sha
          AND id <> keep_id);
    /* 先删非 keep 行再写 keep 的 ci_run_id：删除不需要归一 ci_run_id（旧唯一键在行
       消失后自然让位），任何「先把某行折成 ''」的顺序都会与 keep 或 sibling 撞键——
       keep='' 且 sibling 非 '' 的组（SDK 直跑后接 CI）正是实测的撞法。 */
    DELETE FROM ingest_runs
     WHERE repository_id = dup.repository_id AND commit_sha = dup.commit_sha
       AND id <> keep_id;
    UPDATE ingest_runs
       SET ci_run_id = latest_ci, finished_at = now()
     WHERE id = keep_id AND latest_ci <> '';
    DELETE FROM ingest_runs
     WHERE repository_id = dup.repository_id AND commit_sha = dup.commit_sha
       AND id <> keep_id;
  END LOOP;
END $$;

ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS ci_execution_count INTEGER NOT NULL DEFAULT 1;

/* 键换窄：按定义找 035 的旧唯一约束（auto-named），DROP 后建新的。 */
DO $$
DECLARE
  target TEXT;
BEGIN
  FOR target IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'ingest_runs'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) ILIKE '%repository_id%commit_sha%ci_run_id%'
  LOOP
    EXECUTE format('ALTER TABLE ingest_runs DROP CONSTRAINT %I', target);
  END LOOP;
END $$;

ALTER TABLE ingest_runs ADD CONSTRAINT ingest_runs_commit_dedup_key
  UNIQUE (repository_id, commit_sha, ci_run_id)
  DEFERRABLE INITIALLY DEFERRED;
