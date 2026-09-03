/*
 * 修复 045 折行键的第三列缺陷（2026-09-03，勾选执行同 commit 折行问题引出）。
 *
 * 现象：同一 commit 的上报每 3 次起重新建行（dev 库 c1f4d1ba 两行、各 count=2），
 * 045 的「同 commit 折一行」只兑现了一半。
 * 根因：045 保留三列键 (repository_id, commit_sha, ci_run_id)，靠「INSERT 值里写 ''
 * 参与冲突判定」折形；但 ON CONFLICT 的 UPDATE 分支把真实 run id 写回键列
 * （ci_run_id = COALESCE(NULLIF($15,''), …)）。于是：第 1 次上报建行（键列 ''）、
 * 第 2 次命中合并且键列被写成真值、第 3 次起 INSERT 的 '' 在索引里再也找不到
 * 匹配 → 又走插入分支。仲裁按索引中的实际值匹配，不按语句的折形意图。
 *
 * 修法：键真正删掉第三列 → UNIQUE (repository_id, commit_sha)。ci_run_id 列保留，
 * 降级为纯展示语义「最近一次上报来自哪次 CI 执行」，不参与任何唯一性；lib/ingest.ts
 * 的 INSERT 值随之改写真值（不再是 ''）。
 *
 * 计数列 ci_execution_count 的判据「$15 <> 列上值」在列语义改为「最近来源」后仍成立
 * （连续不同 run 各推 1；交错重试的 +1 近似见 lib/ingest.ts 注释）。
 *
 * 旧行合并复用 045 的合并形状：留最早那行（diff 定局），ci_run_id/finished_at 取
 * 最新一次的，execution_index 与各引用 FK 折回保留行，ingest_records 随删除
 * CASCADE 收回翻倍数据。045 合并过的库这里多半是 0 个组（幂等无害）；045 上线
 * 之后又被第 3 次上报撑出多行的组在这里收一次。
 */

DO $$
DECLARE
  keep_id UUID;
  latest_ci TEXT;
  latest_finished TIMESTAMPTZ;
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT repository_id, commit_sha,
           (array_agg(id ORDER BY created_at ASC))[1] AS keep,
           (array_agg(id ORDER BY created_at DESC))[1] AS newest,
           MAX(ci_execution_count) AS max_count
      FROM ingest_runs
     GROUP BY repository_id, commit_sha
     HAVING COUNT(*) > 1
  LOOP
    keep_id := dup.keep;
    SELECT ci_run_id, finished_at INTO latest_ci, latest_finished
      FROM ingest_runs WHERE id = dup.newest;
    /* 同 045：index 行先删多余、保留行的 detail_id 折回 keep（先删后改防撞
       UNIQUE(kind, detail_id)）。 */
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
    UPDATE repo_test_cases
       SET last_ingest_run_id = keep_id
     WHERE last_ingest_run_id IN (
       SELECT id FROM ingest_runs
        WHERE repository_id = dup.repository_id AND commit_sha = dup.commit_sha
          AND id <> keep_id);
    UPDATE repo_case_endpoints
       SET first_seen_run_id = COALESCE(first_seen_run_id, keep_id),
           last_seen_run_id = keep_id
     WHERE last_seen_run_id IN (
       SELECT id FROM ingest_runs
        WHERE repository_id = dup.repository_id AND commit_sha = dup.commit_sha
          AND id <> keep_id);
    UPDATE pipeline_runs
       SET ingest_run_id = keep_id
     WHERE ingest_run_id IN (
       SELECT id FROM ingest_runs
        WHERE repository_id = dup.repository_id AND commit_sha = dup.commit_sha
          AND id <> keep_id);
    DELETE FROM ingest_runs
     WHERE repository_id = dup.repository_id AND commit_sha = dup.commit_sha
       AND id <> keep_id;
    UPDATE ingest_runs
       SET ci_run_id = latest_ci,
           ci_execution_count = dup.max_count,
           finished_at = COALESCE(latest_finished, finished_at)
     WHERE id = keep_id;
  END LOOP;
END $$;

/* 键换窄：删 048 重建的三列约束，建两列的。048 的名字固定（自起），直接 DROP。 */
ALTER TABLE ingest_runs DROP CONSTRAINT IF EXISTS ingest_runs_commit_dedup_key;

ALTER TABLE ingest_runs ADD CONSTRAINT ingest_runs_commit_dedup_key
  UNIQUE (repository_id, commit_sha);
