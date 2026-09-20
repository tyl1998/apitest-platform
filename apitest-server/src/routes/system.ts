import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { AUDIT_ACTIONS, writeAuditLogAsync } from "../lib/audit.js";
import { currentUser } from "../lib/auth.js";
import {
  EXECUTION_RETENTION_MONTHS,
  PARTITION_MAINTENANCE_TICK_MS,
  countStrandedRows,
  dropArchivedPartition,
  isArchivedPartitionName,
  listArchivedPartitions,
  listLivePartitions,
} from "../lib/executionArchive.js";
import { FLOW_PARALLELISM, MAX_LOOP_CONCURRENCY, MAX_LOOP_ITERATIONS, MAX_WAIT_MS, SUITE_LEAF_BUDGET } from "../lib/flow.js";
import { storageDriverName } from "../lib/objectStore.js";
import { DEFAULT_RUNNER_LABEL, executionQueue } from "../lib/queue.js";
import { requireSystemAdmin } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { WORKER_OFFLINE_AFTER_SECONDS, mapWorker, SUITE_MAX_CONCURRENCY, SUITE_MAX_MEMBERS } from "../models/types.js";

/* avatarSeed / avatarNightmare（P9-6 人物生成器）：种子覆盖（无值 = 身份种子
   users.id，前端确定性画头像）与 nightmare 物种开关（默认移出，无界面入口）。
   PUT 是直通 jsonb 合并、不逐键校验——与 theme/language 同款信任边界，前端
   读写侧自防护。 */
type Preferences = { theme?: "light" | "dark" | "system"; language?: "zh-CN" | "en"; restoreLastPage?: boolean; avatarSeed?: string; avatarNightmare?: boolean };

/**
 * How long a worker may go unheard from before it reads as offline.
 *
 * 阈值本身在 `models/types.ts`：入队前的分区在线检查（`lib/enqueue.ts`）必须用同一个数，
 * 否则「面板显示在线、入队却说没有执行器」就会成立。
 */
const OFFLINE_AFTER_SECONDS = WORKER_OFFLINE_AFTER_SECONDS;

export async function systemRoutes(app: FastifyInstance) {
  app.get("/api/v1/system/preferences", async (request, reply) => { const user = await currentUser(request, reply); if (!user) return; const result = await pool.query("SELECT preferences FROM users WHERE id = $1", [user.id]); return success(result.rows[0]?.preferences ?? {}); });
  app.put<{ Body: Preferences }>("/api/v1/system/preferences", async (request, reply) => { const user = await currentUser(request, reply); if (!user) return; const result = await pool.query("UPDATE users SET preferences = preferences || $1::jsonb WHERE id = $2 RETURNING preferences", [JSON.stringify(request.body), user.id]); return success(result.rows[0].preferences); });

  /**
   * 执行预算与保护性上限（P2-4.2）。
   *
   * 存在的理由很具体：P2-4.2 起请求节点的并发是**原子领取**的，所以「一个请求最多并发几次」
   * 等于 `FLOW_PARALLELISM`，而它是环境变量。编辑器把这个上限写死就必然与服务端不一致
   * ——用户填得进去、保存却被拒。所以由服务端说出这些数，界面只负责显示。
   *
   * 只要登录即可读（不是 `requireSystemAdmin`）：任何能编辑流程或套件的人都需要它，而
   * 这里没有任何一项是敏感信息。
   */
  app.get("/api/v1/system/limits", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;
    return success({
      /* 一次流程执行同时在飞的叶子数，同时也是请求节点并发的上限。 */
      flowParallelism: FLOW_PARALLELISM,
      /* 一次套件执行共享的令牌池容量，同时也是「成员并发」的上限。 */
      suiteLeafBudget: SUITE_LEAF_BUDGET,
      /* 成员并发另有一条与预算无关的保护性上限，两条取更严的那个才是界面该显示的。 */
      suiteMaxConcurrency: SUITE_MAX_CONCURRENCY,
      maxLoopIterations: MAX_LOOP_ITERATIONS,
      maxLoopConcurrency: MAX_LOOP_CONCURRENCY,
      maxWaitMs: MAX_WAIT_MS,
      suiteMaxMembers: SUITE_MAX_MEMBERS,
    });
  });

  /**
   * 执行分区标签目录（P2-8 后续增量）：环境编辑器的分区输入框用。
   *
   * 与 `/system/workers` 的差别在受众：任何能编辑环境的用户都需要这份列表（下拉建议、
   * 「这个分区没有在线执行器」的提示），而 worker 清单带 hostname/pid/version，只给
   * 系统管理员。所以这里单独一条路由，而不是放宽那一条的权限——只回标签与台数，够做
   * 建议和提示，不泄露机器信息。
   */
  app.get("/api/v1/system/runner-labels", async (request, reply) => {
    const user = await currentUser(request, reply); if (!user) return;

    const workers = await pool.query(
      `SELECT labels, (last_seen_at > now() - ($1 || ' seconds')::interval) AS online FROM workers`,
      [OFFLINE_AFTER_SECONDS],
    );
    const configured = await pool.query("SELECT DISTINCT runner_label FROM environments");

    /* 全集口径与 `/system/workers` 一致：有 worker 的 ∪ 有环境配置的 ∪ default。「配了
       但没人服务」的分区必须出现且 online=0，输入框的提示才有据可依。多标签 worker 在
       每个分区里各算一次，与分区表同款。 */
    const stats = new Map<string, { online: number; total: number }>();
    const bump = (label: string, online: boolean) => {
      const entry = stats.get(label) ?? { online: 0, total: 0 };
      entry.total += 1;
      if (online) entry.online += 1;
      stats.set(label, entry);
    };
    for (const row of workers.rows) {
      const labels = (row.labels as string[] | null)?.length ? (row.labels as string[]) : [DEFAULT_RUNNER_LABEL];
      for (const label of labels) bump(label, Boolean(row.online));
    }
    for (const label of configured.rows.map((row) => String(row.runner_label))) {
      if (!stats.has(label)) stats.set(label, { online: 0, total: 0 });
    }
    if (!stats.has(DEFAULT_RUNNER_LABEL)) stats.set(DEFAULT_RUNNER_LABEL, { online: 0, total: 0 });

    return success(
      [...stats.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, { online, total }]) => ({ label, online, total })),
    );
  });

  /**
   * 执行器状态（P1-3）. Read-only: this reports the fleet, it does not steer it.
   *
   * Workers are reported from their own heartbeats rather than from the queue,
   * because BullMQ can only tell us which Redis connections exist — not how much
   * capacity each one has or how much of it is in use.
   */
  app.get("/api/v1/system/workers", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;

    const workers = await pool.query(
      `SELECT *, (last_seen_at > now() - ($1 || ' seconds')::interval) AS online
         FROM workers ORDER BY mode, hostname, pid`,
      [OFFLINE_AFTER_SECONDS],
    );

    /* Queue depth comes from Redis, which is the only place that knows what has
       been handed out but not yet claimed.

       This is the `executions` queue specifically, so it describes endpoint work
       only. A future repository mode will have its own queue, and reporting this
       one against it would be a plain lie — hence the mode-keyed shape.

       P2-8 起这条队列按分区分裂成 `executions-<label>` 多条，所以 mode 键下的数字是
       **全部分区的合计**，按分区拆开的那份在 `partitions[]` 里。mode 与 labels 是正交
       轴，不是嵌套的两层 record。 */
    const rows = workers.rows.map(mapWorker);
    const live = rows.filter((each) => each.online);

    /**
     * 分区全集 = `workers.labels` ∪ `DISTINCT environments.runner_label` ∪ `'default'`。
     *
     * 取并集而不是只列有 worker 的那些：一个「配了但没人服务」的分区必须**显式出现在
     * 面板上且 online=0**，那正是用户最需要看到的一行——否则「为什么这个环境的执行全都
     * 报 2004」只能靠猜。
     */
    const configured = await pool.query("SELECT DISTINCT runner_label FROM environments");
    const labels = [...new Set([
      DEFAULT_RUNNER_LABEL,
      ...rows.flatMap((each) => each.labels),
      ...configured.rows.map((row) => String(row.runner_label)),
    ])].sort();

    const partitions = await Promise.all(labels.map(async (label) => {
      const serving = live.filter((each) => each.labels.includes(label));
      const counts = await executionQueue(label).getJobCounts("wait", "active", "delayed", "failed");
      return {
        label,
        /* 在线台数 / 总台数：同一台机器可能同时服务多个分区，所以这里是按分区计数而
           不是把 worker 表分组——一台服务两个分区的 worker 在两行里各算一次。 */
        online: serving.length,
        total: rows.filter((each) => each.labels.includes(label)).length,
        /* 多标签 worker 的 `concurrency` 已经是拆分后的总量（worker.ts
           `REPORTED_CONCURRENCY`），所以这里按标签数均摊才是这个分区真实的容量。 */
        capacity: serving.reduce((sum, each) => sum + Math.floor(each.concurrency / each.labels.length), 0),
        inflight: serving.reduce((sum, each) => sum + Math.floor(each.inflight / each.labels.length), 0),
        waiting: counts.wait ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      };
    }));

    return success({
      workers: rows,
      /* mode 键下是**全部分区的合计**：这一层回答「接口执行整体积压了多少」，分区拆分
         在 `partitions[]` 里。 */
      queues: {
        endpoint: {
          waiting: partitions.reduce((sum, each) => sum + each.waiting, 0),
          active: partitions.reduce((sum, each) => sum + each.active, 0),
          delayed: partitions.reduce((sum, each) => sum + each.delayed, 0),
          failed: partitions.reduce((sum, each) => sum + each.failed, 0),
        },
      },
      /* Per mode, so the UI never sums capacity across workers that cannot do
         each other's work. Live workers only — an offline one contributes none. */
      capacity: {
        endpoint: live.filter((each) => each.mode === "endpoint").reduce((sum, each) => sum + each.concurrency, 0),
        repository: live.filter((each) => each.mode === "repository").reduce((sum, each) => sum + each.concurrency, 0),
      },
      inflight: {
        endpoint: live.filter((each) => each.mode === "endpoint").reduce((sum, each) => sum + each.inflight, 0),
        repository: live.filter((each) => each.mode === "repository").reduce((sum, each) => sum + each.inflight, 0),
      },
      /* 执行分区轴（P2-8）。不把 `queues` 改成两层嵌套 record：mode 与 label 正交，
         嵌套会逼前端为一个不存在的组合（repository × prod-dmz）准备渲染分支。 */
      partitions,
    });
  });

  /**
   * 执行历史的分区与归档现状（P10-2，计划 14.1）。仅系统管理员。
   *
   * **与上面 `/system/workers` 里的 `partitions` 不是一回事**：那里的「执行分区」是 P2-8 的
   * 网段标签（`runner_label`，决定一次执行从哪个网段发出）；这里的分区是 `executions` 表按季
   * 切出来的**物理存储分区**。两个词在本仓库里撞了名，读代码时以所在路由为准。
   *
   * 这条路由存在的理由很具体：归档是「DETACH + 改名保留」，自动维护**永不 DROP**，所以库里
   * 会持续积累已脱离的表，而「该清哪些」如果只能靠人记，就会变成无人负责的堆积。它把这件事
   * 变成看得见的清单：哪些分区还在服役、哪些已脱离多久、清掉能回收多少空间。
   */
  app.get("/api/v1/system/execution-partitions", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    const [partitions, archives, strandedRows] = await Promise.all([
      listLivePartitions(),
      listArchivedPartitions(),
      countStrandedRows(),
    ]);
    return success({
      /* 0 = 自动归档关闭（默认），维护拍只预建分区。 */
      retentionMonths: EXECUTION_RETENTION_MONTHS,
      maintenanceIntervalHours: PARTITION_MAINTENANCE_TICK_MS / 3_600_000,
      /* 当前对象存储驱动：清理时驱动对不上的大响应体会被跳过（见 DELETE 的 objectsSkipped），
         没有这个字段，那个数字就没法解释。 */
      storageDriver: storageDriverName(),
      /* 兜底分区里的滞留行数，正常恒为 0。非 0 = 维护拍停过，这批行既不会被归档也会挡住
         该季分区的创建（scheduler 会打出 blocked 告警）。 */
      strandedRows,
      partitions,
      archives,
    });
  });

  /**
   * 清理一张已脱离的分区（P10-2）。仅系统管理员，**不可逆**。
   *
   * 这是平台里唯一会删除大响应体对象的通路（2026-09-20 用户拍板：对象与行同生命周期，只在
   * 表被真正 DROP 时才删）。**绕过它直接在 psql 里 `DROP TABLE` 会留下永久孤儿对象**——
   * 那正是 14.1 点名要避免的「只归档行、留下孤儿对象」。
   *
   * 目标只能是已脱离的归档表（`executions_archived_YYYYqN`）：在役分区不在这条路径上，
   * 想删必须先等它到期被归档。删在役分区等于绕过保留窗口，那不是「清理」而是事故。
   */
  app.delete<{ Params: { name: string } }>("/api/v1/system/execution-partitions/:name", async (request, reply) => {
    const user = await requireSystemAdmin(request, reply); if (!user) return;
    const name = request.params.name.trim();
    /* 形状不对（含在役分区名、任意标识符）与「形状对但查无此表」是两个不同的回答。 */
    if (!isArchivedPartitionName(name)) return fail(reply, 400, 1001, "not an archived execution partition name");

    const outcome = await dropArchivedPartition(name, user.id);
    if (!outcome) return fail(reply, 404, 2001, "archived execution partition not found");

    writeAuditLogAsync({
      action: AUDIT_ACTIONS.executionPartitionDrop,
      targetType: "execution_partition",
      targetId: null,
      userId: user.id,
      detail: { partition: name, rows: outcome.rowCount, objectsDeleted: outcome.objectsDeleted, objectsSkipped: outcome.objectsSkipped },
      ip: request.ip,
    });
    return success(outcome);
  });
}
