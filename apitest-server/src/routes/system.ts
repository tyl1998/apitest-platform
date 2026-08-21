import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { currentUser } from "../lib/auth.js";
import { executionQueue } from "../lib/queue.js";
import { requireSystemAdmin } from "../lib/rbac.js";
import { success } from "../lib/response.js";
import { mapWorker } from "../models/types.js";

type Preferences = { theme?: "light" | "dark" | "system"; language?: "zh-CN" | "en"; restoreLastPage?: boolean };

/**
 * How long a worker may go unheard from before it reads as offline.
 *
 * Three heartbeats, so one dropped beat or a brief GC pause does not make a
 * healthy worker flicker between states in the UI.
 */
const OFFLINE_AFTER_SECONDS = 30;

export async function systemRoutes(app: FastifyInstance) {
  app.get("/api/v1/system/preferences", async (request, reply) => { const user = await currentUser(request, reply); if (!user) return; const result = await pool.query("SELECT preferences FROM users WHERE id = $1", [user.id]); return success(result.rows[0]?.preferences ?? {}); });
  app.put<{ Body: Preferences }>("/api/v1/system/preferences", async (request, reply) => { const user = await currentUser(request, reply); if (!user) return; const result = await pool.query("UPDATE users SET preferences = preferences || $1::jsonb WHERE id = $2 RETURNING preferences", [JSON.stringify(request.body), user.id]); return success(result.rows[0].preferences); });

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
       one against it would be a plain lie — hence the mode-keyed shape. */
    const counts = await executionQueue().getJobCounts("wait", "active", "delayed", "failed");

    const rows = workers.rows.map(mapWorker);
    const live = rows.filter((each) => each.online);
    return success({
      workers: rows,
      queues: {
        endpoint: { waiting: counts.wait ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0 },
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
    });
  });
}
