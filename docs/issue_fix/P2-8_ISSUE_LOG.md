# P2-8 执行分区 — 缺陷记录

> 对应开发内容见 `DEVELOPMENT_PLAN.md` 5.0.12（P2-8 执行分区）。本文件只记录实际缺陷。

## 1. worker 启动即崩：`Queue name cannot contain :`

**现象**

`./start.sh` 之后 API 与前端正常，worker 进程起不来，`.dev-logs/worker.log`：

```
Error: Queue name cannot contain :
    at new QueueBase (.../bullmq/dist/cjs/classes/queue-base.js:35:19)
    at new Worker (.../bullmq/dist/cjs/classes/worker.js:31:9)
    at <anonymous> (.../src/worker.ts:94:45)
```

**根因**

P2-8 把队列名从常量 `executions` 改成按分区分裂，最初实现按计划 5.0.12 的字面写法取名
`executions:<label>`。BullMQ 6 的 `QueueBase` 构造函数**显式拒绝**名字里含 `:` 的队列
——它自己用 `:` 拼 Redis key 的层级（`bull:<queue>:<id>`），队列名再带 `:` 会让 key 结构
产生歧义。计划里写 `executions:<label>` 时没有校对这条库约束。

失败点在 `new Worker(...)`，即模块顶层，所以进程直接退出而不是降级运行；API 侧
`executionQueue()` 是延迟建连的，第一次入队才会碰到同一个错误，因此表现为「只有 worker
起不来」。

**修法**

分隔符改为 `-`：`lib/queue.ts` 的 `executionQueueName()` 返回 `executions-<label>`。
不产生歧义——前缀固定，其后整段就是标签，而标签自身唯一（`RUNNER_LABEL_PATTERN`
不允许 `-` 之外的分隔符以外的字符，标签集合内无二义）。

`CANCEL_CHANNEL`（`executions:cancel`）**保持不变**：它是 Redis pub/sub 频道，不经
BullMQ 的队列名校验，改它只会造成无谓的兼容问题。

同步更新了把旧写法写进注释与文档的 7 处：`lib/queue.ts`、`worker.ts`、`routes/system.ts`、
`routes/environments.ts`、`migrations/027_p2_execution_partition.sql`、`.env.example`、
`DEVELOPMENT_PLAN.md`（4 处）。

**状态**：已修（待用户重启 worker 后确认）。

**附带事实**：修复后日志未刷新会造成误判——`worker.log` 是追加写的，进程崩掉后不会被清空，
所以「还是报一样的错」可能只是没重启。判断方法是比对 `stat` 的日志修改时间与源文件修改时间。
