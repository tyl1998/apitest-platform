import { createHash } from "node:crypto";
import { createRedis } from "./queue.js";

/**
 * 查询缓存（P10-3，计划 14.1）——热点只读聚合的 Redis 共享缓存。
 *
 * 替换 P8-4 落在 `stats.ts` 里的进程内 30s TTL Map：多个 API 实例共享同一份缓存，
 * 数字不再随「命中哪个实例」漂移；worker 侧执行落终态时也能跨进程失效同一份缓存。
 * 复用既有的 `createRedis()`（零新依赖，Redis 本就是队列/事件的必备设施）。
 *
 * 三条纪律：
 * - **可见项目集维度进 key**（`scopeHash`）：聚合结果按「读者看得见哪些项目」分片，
 *   越权命中他人聚合结果在键层面就不可能（验收门槛 6 的缓存侧对齐）。
 * - **写失效不靠纯 TTL**：写操作（执行落终态 / 资产 CRUD / 归因变更 / 成员变更）主动
 *   `DEL` 相关 key。缓存条目落库时按其依赖的项目集打「标签」（每个项目一个 Redis SET），
 *   写某项目时读该项目的标签集、`DEL` 其中全部 key——系统管理员的全量聚合挂在
 *   `ALL_TAG` 上，任一项目写入都会带上它。TTL 仅作兜底（Redis 抖动丢标签时的上限）。
 * - **永不阻塞请求**：每个缓存操作都被 `safe()` 包一层 try/catch + 200ms 超时。Redis
 *   不可达时读当作 miss、写/失效当作 no-op，请求照常走数据库，绝不因缓存挂起或报错。
 */

/** 与 stats 边界 16 的原 30s TTL 对齐；dashboard / projects 同档。 */
export const DEFAULT_TTL_SECONDS = 30;
/** 单次缓存操作的硬上限：超时即放弃（读→miss，写→no-op），不拖累请求。 */
const CACHE_OP_TIMEOUT_MS = 200;
/** 每个项目一个标签 SET，成员是依赖该项目的缓存 key。 */
const TAG_PREFIX = "qcache:tag:";
/** 系统管理员的全量聚合（scope.all）：任一项目写入都要失效，挂这一个全局标签。 */
const ALL_TAG = "qcache:tag:__all__";

/** 缓存分片维度：`all`（系统管理员未收窄）= 依赖全部项目；否则是一份具体项目 id 集。 */
export type CacheScope = { all: boolean; ids: string[] };

let client: ReturnType<typeof createRedis> | undefined;

/** 懒建单例（与 events.ts publisher / webhookTriggers nonceRedis 同款）：单跑迁移等
    脚本不触发缓存就不连 Redis。 */
function cacheRedis(): ReturnType<typeof createRedis> {
  client ??= createRedis();
  return client;
}

/**
 * 把一次缓存操作限时执行：抛错或超时都回落到 `fallback`，绝不让缓存拖垮请求。
 * `createRedis()` 的 `maxRetriesPerRequest: null` 会在断连时让命令无限等重连——对缓存
 * 是灾难（读会挂住整个请求），所以这里用超时兜底而不是依赖 ioredis 的重试语义。
 */
async function safe<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), CACHE_OP_TIMEOUT_MS); });
  /* op 的 reject 先 catch 成 fallback：否则 timeout 赢了 race 后 op 迟到的 reject 会变成
     未处理拒绝。race 结束后清掉计时器（op 赢时不留悬挂的 timer）。 */
  const result = await Promise.race([op().catch(() => fallback), timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

/** 可见集哈希：排序后哈希，集合相同、顺序不同的两个请求命中同一份（stats 与 dashboard
    共用同一实现，保证两侧对同一集合产出同一分片键 / 同一标签）。 */
export function scopeHash(scope: CacheScope): string {
  if (scope.all) return "all";
  return createHash("sha1").update([...scope.ids].sort().join(",")).digest("hex").slice(0, 16);
}

/** 读缓存：miss / 坏数据 / Redis 不可达一律回 undefined（调用方回落到数据库）。 */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const raw = await safe(() => cacheRedis().get(key), null);
  if (raw === null) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

/**
 * 写缓存并按依赖的项目集打标签。`scope.all`（系统管理员全量）挂 `ALL_TAG`；否则挂
 * scope 里每个项目的标签。标签集的 TTL 比缓存条目长一点——过期的 key 引用留在集合里
 * 无害（失效时 `DEL` 打空拳），只是防标签集无界增长。
 */
export async function cacheSet(key: string, scope: CacheScope, data: unknown, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
  const payload = JSON.stringify(data);
  await safe(async () => {
    const redis = cacheRedis();
    const tags = scope.all ? [ALL_TAG] : scope.ids.map((id) => TAG_PREFIX + id);
    const pipeline = redis.pipeline();
    pipeline.set(key, payload, "EX", ttlSeconds);
    for (const tag of tags) {
      pipeline.sadd(tag, key);
      pipeline.expire(tag, ttlSeconds + 60);
    }
    await pipeline.exec();
    return undefined;
  }, undefined);
}

/**
 * 失效一批项目相关的缓存：收集这些项目标签集 + `ALL_TAG` 的全部成员 key，一次性 `DEL`，
 * 再删标签集本身。空数组只清 `ALL_TAG`（用于项目建/删这类只动全量分片的写）。
 */
export async function invalidateProjects(projectIds: string[]): Promise<void> {
  await safe(async () => {
    const redis = cacheRedis();
    const tags = [ALL_TAG, ...projectIds.map((id) => TAG_PREFIX + id)];
    const readPipeline = redis.pipeline();
    for (const tag of tags) readPipeline.smembers(tag);
    const results = await readPipeline.exec();
    const keys = new Set<string>();
    for (const entry of results ?? []) {
      const members = entry?.[1] as string[] | undefined;
      for (const key of members ?? []) keys.add(key);
    }
    const delPipeline = redis.pipeline();
    if (keys.size) delPipeline.del(...[...keys]);
    delPipeline.del(...tags);
    await delPipeline.exec();
    return undefined;
  }, undefined);
}
