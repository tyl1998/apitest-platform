import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../../db.js";

/**
 * 助手上游预置（assistant_providers）。
 *
 * 仓库随包的 `data/assistant-providers/*.json` 是**首次开箱**的供应商清单：服务启动时
 * 逐个「**只插不改**」——按名字（大小写不敏感）判断，库里已经有的**整行跳过**，
 * 一条 SQL 都不写。
 *
 * 为什么不是 upsert（2026-10-27 修订）：预置只是为了让空库启动后有可选上游，
 * 而 provider 一旦落库就属于**管理员的运维资产**——他改过的协议、改过的名字大小写、
 * 甚至刻意保留的旧配置，都不该在每次重启时被清单里的出厂值覆盖回去。清单要更新
 * 已存在的那一行，走「导入 JSON」或管理面编辑（都是显式动作、有审计），不靠重启。
 *
 * 其余纪律不变：写入侧不 import 路由做深校验（路由依赖 Fastify 实例），只做「文件
 * 读得懂、名字非空」的失败保护——清单写错是发布事故，让它启动即报错，而不是静默
 * 少一行；第一条**新插入**的预置行同时成为默认行，此后启动只认名字，管理员切换过
 * 默认就保持管理员的决定。
 *
 * 镜像里目录随 dist 一起带进来（Dockerfile 的 COPY data）：`dist/lib/assistant/`
 * 往上三级就是包根，与 src 下的相对位置一致。
 */
const seedDirectory = fileURLToPath(new URL("../../../data/assistant-providers/", import.meta.url));

type ProviderSeed = {
  name: string;
  protocol: Record<string, unknown>;
  userParams: unknown[];
};

async function readSeeds(): Promise<ProviderSeed[]> {
  let files: string[];
  try {
    files = (await readdir(seedDirectory)).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const seeds: ProviderSeed[] = [];
  for (const filename of files) {
    const parsed = JSON.parse(await readFile(join(seedDirectory, filename), "utf8")) as Partial<ProviderSeed>;
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) throw new Error(`assistant provider seed ${filename} must define a name`);
    seeds.push({
      name,
      protocol: typeof parsed.protocol === "object" && parsed.protocol !== null ? parsed.protocol : {},
      userParams: Array.isArray(parsed.userParams) ? parsed.userParams : [],
    });
  }
  return seeds;
}

export async function seedAssistantProviders() {
  for (const seed of await readSeeds()) {
    /* 只插不改：已有同名行（大小写不敏感）整行跳过——`WHERE NOT EXISTS` 与 INSERT 是
       同一条语句，两个实例同时启动也不会插出两行（`name` 上还有唯一约束兜底）。
       默认位只在「当前没有任何默认行」时给，且只给这一次插入。 */
    await pool.query(
      `INSERT INTO assistant_providers (id, name, protocol, user_params, enabled, is_default)
       SELECT $1::uuid, $2, $3::jsonb, $4::jsonb, true,
              NOT EXISTS (SELECT 1 FROM assistant_providers WHERE is_default)
       WHERE NOT EXISTS (SELECT 1 FROM assistant_providers WHERE lower(name) = lower($2))
       ON CONFLICT DO NOTHING`,
      [randomUUID(), seed.name, JSON.stringify(seed.protocol), JSON.stringify(seed.userParams)],
    );
  }
}
