# 问题记录 — worker 回收事务泄漏导致流程保存卡死 / worker 掉线

## 现象

三个看起来无关、实际同源的症状：

1. **流程保存永久挂住**：`PUT /api/v1/projects/:id/flows/:flowId` 不返回、不超时。前端连续重试后
   整个后端一起卡死，连无关请求也不响应。
2. **worker 启动后约 1 分钟就显示掉线**：进程活着、日志正常，但系统管理页上执行器是离线/过期状态。
3. **同一批执行记录被反复回收**：`worker.log` 每 60 秒重复打印 `reaped 13 stale execution(s)` /
   `reaped 1 stale flow execution(s)`，数字一成不变。

## 根因

`src/worker.ts` 的 `reapStale()` **开了事务却没有提交**：`BEGIN` 之后，成功路径直接落到
`finally` 里的 `client.release()`，全函数只有「没抢到 advisory 锁」和「异常」两条 `ROLLBACK` 分支。

`pg` 的 `client.release()` 不会替你回滚，于是一条**事务仍开着**的连接被还回连接池，并造成连锁反应：

- 之后所有复用这条连接的 `pool.query`（心跳、认领、回收）全都跑在那个未提交事务里。
  → 心跳写入对外不可见，`workers.last_seen_at` 冻结，而在线判定就是心跳新鲜度
    （`routes/system.ts` `OFFLINE_AFTER_SECONDS = 30`，心跳间隔 10s）
    ⇒ **worker 在第一次回收（启动后 60s）之后必然掉线**，即症状 2。
- 回收自己的 UPDATE 同样不可见 ⇒ 同一批记录每轮重复回收，即症状 3；也意味着
  「卡死回收」这层兜底在修复前实际是瘫的。
- 事务持有的锁永不释放。它握着 `flows` 那一行的 **KEY SHARE 共享锁**（外键检查那种锁，
  `HEAP_XMAX_KEYSHR_LOCK | HEAP_XMAX_LOCK_ONLY`，行内容并未被修改），而流程保存的第一条语句
  `SELECT id FROM flows ... FOR UPDATE`（`routes/flows.ts:310`）与之冲突
  ⇒ 保存永久阻塞，即症状 1。后续保存再排在第一个保存的 tuple 锁后面，10 个请求占满
  API 的连接池（pg 默认 max=10）⇒ 整站冻结。

**为什么不会自愈**：对已在事务中的连接再发 `BEGIN`，Postgres 只给一条
`WARNING: there is already a transaction in progress`，**不报错**。所以下一轮回收会静默并入
同一个泄漏事务，越积越久；只有别的代码路径恰好在这条连接上发出 `COMMIT`
（如 `flowRun.ts` 的 `finish()`），或进程/连接死亡，才会散掉。

## 证据（stg 之外，本地 dev 库现场取证）

- `pg_stat_activity`：一条 `idle in transaction` 连接持续 29 分钟，最后一条语句是心跳的
  `INSERT INTO workers`；`pg_locks` 显示它持有 `reapStale` 的 advisory 锁 `8013301`。
- `pageinspect` 扫 `workers` 堆页：**同一行 worker 记录有 43 个死版本，全部
  `xmin = xmax = 泄漏事务 id`** —— 约 7 分钟的 10 秒心跳全被困在一个未提交事务里。
- `flows` 目标行 `xmax` = 泄漏事务 id，标志位为 `KEYSHR_LOCK | LOCK_ONLY`；`updated_at`
  仍是两天前，证明**行没被改过，只是被共享锁住**。
- 10 个 `SELECT ... FOR UPDATE` 全部 `wait_event = transactionid / tuple`，
  `pg_blocking_pids()` 链首指向该泄漏连接。
- 可复现性：观察期间连续出现三例（不同连接、不同事务 id、worker 重启后照旧复发）。
- 实验排除：reap 的 `flow_executions` UPDATE 与 `executions` INSERT 均**不会**锁父行
  （回滚探针验证），说明该共享锁来自泄漏事务吞进去的其他语句，与定性无关。

## 修法

1. `src/worker.ts` — `reapStale()` 成功路径补 `await client.query("COMMIT")`，并注释说明
   「缺它会怎样」以及「下一轮 BEGIN 只给 WARNING、不会自愈」这两点。
2. `src/db.ts` — 连接池加 `options: "-c idle_in_transaction_session_timeout=30s"` 作为兜底闸门。
   该设置只收掉**空闲在事务中**的会话，正在执行或正在等锁的语句不受影响，因此不会误杀慢查询、
   也不会打断合法等锁。

## 状态

已修复（上述两处）。修复后预期：worker 不再掉线，回收只在真有陈旧记录时打印一次，
流程保存不再被 worker 的回收事务阻塞。

## 排队任务的重启兜底（同批修复）

排查本缺陷时顺带发现：**排队中的记录并非总能跨重启继续推进**。

正常路径本来就是通的——job 存在外部 Redis 里，与 API / worker 进程无关，worker 回来即领走。
但有两种情况会让队列与数据库脱节，脱节后没有任何人会认领，那行记录只能等回收扫描标成失败：

1. API 在「事务提交」与「入队」之间挂掉。`enqueue.ts` 的补偿只覆盖 `queue.add` 抛错，
   覆盖不了进程在这两步之间消失。
2. Redis 丢数据。`redis:7-alpine` 默认只有 RDB 快照，硬重启会丢掉最后几秒入队的 job。

修法（两处）：

3. `src/worker.ts` — 新增 `requeueOrphans()`，启动时（心跳之后）把库里仍为 `queued`
   的记录重新投一次。可以无脑重投是因为入队时 `jobId` 就是记录自己的 id，BullMQ 按 jobId
   去重，已存在的 job 再 add 是空操作；只有终态（被保留的失败 job）需要先删再投，否则
   去重会把重投一起吃掉。即使真重复投，认领语句的 `status = 'queued'` 也保证只有一个能跑起来，
   因此无需加锁。
4. `compose.yaml` — redis 开 AOF（`redis-server --appendonly yes`），从源头减少 job 丢失。

## 仍未修复（另记）

**被硬杀的在途任务不会续跑，只会被兜到失败。** 认领语句带 `WHERE status = 'queued'`
（`run.ts:381`、`flowRun.ts:104`），而 BullMQ 的 stalled 重投会把已经翻成 `running` 的记录
再投一次 —— 此时认领不到，`performRun` / `performFlowRun` 直接静默返回，job 算成功，
数据库那行却停在 `running`，最终只能靠 `reapStale` 在 5 分钟（单次）/ 20 分钟（流程）后标 failed。

真要做「断点续跑」需要独立排期，且有两个前置决定：容器节点（loop / subflow）是否按原子重跑，
以及 `execution_steps` 已有行如何处置（`execution_steps_toplevel_unique_idx` /
`execution_steps_nested_unique_idx` 两个唯一索引会拦住无脑重跑）。好消息是数据已足够：
`run_spec` 在终态前不会被清空，且每步的 `output_snapshot.produced` 已经存了该步产出的变量，
中断点的变量袋可以重建，无需加字段。

