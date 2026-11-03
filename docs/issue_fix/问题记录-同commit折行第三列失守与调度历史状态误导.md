# 问题记录-同commit折行第三列失守与调度历史状态误导

- 日期：2026-09-03
- 阶段：P4.5-9 勾选执行上报链路 / P3 调度触发历史
- 状态：**已修**（`lib/ingest.ts` + 迁移 049 + `routes/schedules.ts` + `models/types.ts` + 前端 ResourceSchedules）

## 一、同 commit 折行只兑现了一半（第三列失守）

### 现象

同 commit 的上报**每 3 次起重新建行**：dev 库 `c1f4d1ba` 一个 commit 两行
`ingest_runs`（各 `ci_execution_count=2`），045 承诺的「同 commit 折一行」被打破，
数据重新按对膨胀。

### 根因

045 保留三列键 `(repository_id, commit_sha, ci_run_id)`，靠「INSERT 值写 `''`」折形；
但 `ON CONFLICT` 的 UPDATE 分支把真实 run id 写回键列
（`ci_run_id = COALESCE(NULLIF($15,''), …)`）。PG 的冲突仲裁按**索引中的实际值**匹配：

- 第 1 次上报：建行（键列 `''`）；
- 第 2 次：`''` 命中合并，**键列被写成真值**；
- 第 3 次起：INSERT 的 `''` 在索引里找不到匹配 → 又走插入分支，溢出一行。

### 修法

- `lib/ingest.ts`：键删第三列——`ON CONFLICT (repository_id, commit_sha)`；
  INSERT 值里 `ci_run_id` 改写真值（不再是 `''`），UPDATE 分支用 `EXCLUDED.*` 引用
  （顺带修掉 `$15` 越位占位符）。`ci_run_id` 列降级为纯展示语义
  「最近一次上报来自哪次 CI 执行」，不参与任何唯一性；前端与反查
  （`completePipelineRun` 按 `(project, commit)`）都不消费它。
- 迁移 `049`：DROP 三列约束 → 建两列约束；同 commit 多余行就地合并
  （045 同款形状：留最早行、引用 FK 折回、records 随 CASCADE 收回、
  `ci_execution_count` 取组内最大值）。
- `ci_execution_count` 判据「与列上上一来源不同」保留：交错重试的 +1 近似写进注释
  （列上不存 run id 全史，一条 SQL 算不了集合差；只影响展示列）。

### 勾选执行口径（用户问题的回答）

勾选用例执行**照常上报**（commit/branch/inventory/results 一样不少）：
`deselected` 进 `filters` → `is_full_inventory=false` → 删除对账双闸门不开；
同 commit 折进同一行 `ingest_runs`，`ci_execution_count` +1；
`last_result/last_run_at` 只动真跑了的勾选条目，勾了没报到的由
`markCaseFilterNotRun` 差集标 `not_run`。

## 二、调度触发历史的「已触发」画成绿色通过

### 现象

定时任务的触发历史里 `triggered` 行显示**绿色 pass 标签**，实际执行是 failed
（dev 库实锤：三行 triggered 对应套件执行全 failed；CI 那行 run 也是
failed 0/50）。仓库 / 套件两种目标都中招。

### 根因（两层）

- 设计层没错：`schedule_runs.status='triggered'` 本来就只表示「拉起成功」
  （计划边界 15：它只回答调度自己有没有按时触发），执行结果在
  `execution_index` / `pipeline_runs` 里。
- 表达层错：前端把这个**中间事实**画成了语义绿色的 `pass`——用户自然读成
  「执行成功」。

### 修法

- `GET /schedules/:scheduleId/runs`（`routes/schedules.ts`）：LEFT JOIN 顺两列引用
  带出执行终态——CI 目标 `pipeline_runs.status`（run 行触发时即存在，在途态可见），
  套件目标 `execution_index.status`。JOIN 加了 `project_id` 守卫。
- `ScheduleRun` 类型 + `mapScheduleRun`（服务端 / 前端两份）加 `executionStatus`
  （读时派生，不落表；别处调用 mapper 无 JOIN 时保持 undefined）。
- 前端 ResourceSchedules 触发历史抽屉：`triggered` 行状态列显示**执行的真实状态**
  （归一：success→pass、queued→queued、claimed/running/cancelling→running、
  canceled→canceled、failed/aborted/timed_out→fail）；`executionStatus` 缺席
  （目标被删，042 的 ON DELETE SET NULL 语义）回退中性「已触发」文案，
  结果列副注「已拉起（目标已删除，执行结果不可查）」。skipped/failed 行不变。

## 状态

已修；`apitest-server`/`apitest-web` 各自 `tsc --noEmit` 通过。原「迁移 049 待
`pnpm migrate`（或 `./start.sh`）应用后生效」——**已随 2026-09-03 P4.5 验收通过
关闭**。
