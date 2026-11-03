# 执行索引 start/finish 跨执行错配（全局看板耗时分位数 7.8 万秒）

> 2026-09-20 用户报告：「全局看板的耗时分位数，7w多S？」。与 P8-5 ③ 同一族（趋势页
> p99 被假耗时拉爆），但根因不同：P8-5 修的是「重投把兜底 now() 写进 finished_at」，
> 这次是 **同 commit 折行后 start/finish 取自两次不同执行**。缺陷记本文件，开发内容见
> `DEVELOPMENT_PLAN_P6-P14.md` 十二章。

## 现象

全局看板「耗时分位数」图 p99 冲到 78022s（≈21.7 小时），y 轴刻度出现 `78022s`。

## 根因

`execution_index` 的幂等键是 `(kind, detail_id)`，而 ingest 行的 `detail_id` 是
`ingest_runs.id`——那张表的键是 `(repository_id, commit_sha)`（P4.5 迁移 049 的
「同 commit 折一行」）。**同一个 commit 的每日重跑复用同一行**：

- UPDATE 分支只刷新 `finished_at`（重投带真值就覆盖），`started_at` 从首投起再也不动。
- 于是「第一次执行的 start + 最近一次执行的 finish」被当成一次耗时。

dev 库实测（2026-09-20 查库）：

| id | started_at | finished_at | 假耗时 |
| --- | --- | --- | --- |
| `479ecada` | 2026-09-04T09:57:36Z | 2026-09-15T08:24:35Z | 944819s ≈ 10.9 天 |
| `131d0871` | 2026-09-16T10:44:00Z | 2026-09-17T08:24:22Z | 78022s ≈ 21.7 小时 |

两个 finished_at 都落在 08:24（定时 CI 任务的重跑时刻），即「这次重跑的完成时刻」被写进了
上一次执行的索引行。P8-5 的两条纪律（首投不兜底真 started_at、重投只在真值时覆盖）挡的是
「兜底 now() 往后推」，挡不住「真 finished_at 配上另一次执行的 start」。

## 修法

- **代码**（`src/lib/ingest.ts` 的 execution_index upsert）：start/finish **成对采用**——
  只有这次上报同时带真 `started_at` 与真 `finished_at`（= 一次完整执行的报告）时，
  两个一起换成本次的；只有续投（或完成时刻是兜底 `now()`）时才只碰 `finished_at`，
  `started_at` 必须留着。注释写明这次的判例。
- **数据**（dev 库，AGENTS 允许自由改）：把上述两行错配的 `finished_at` 置 NULL——无法
  还原真完成时刻时 NULL 是诚实值，趋势 SQL 的 `FILTER (finished_at IS NOT NULL)` 会把它们
  排除出耗时样本。判据用 `finished_at > created_at + 30 分钟`（接收时刻之后才出现的完成
  时刻 = 必然来自后续重投），库内命中且只命中这 2 行。下一次同 commit 上报会按新纪律把
  两列一起换成那次执行的成对值。

## 状态

已修（代码 + dev 库两行）。服务未重启；统计接口缓存 TTL 30s，用户刷新即可看到 p99 回到
正常秒级。未做验收复验。
