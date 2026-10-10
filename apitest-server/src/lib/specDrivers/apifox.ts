import { parse as parseYaml } from "yaml";
import { fetchSpecDocument } from "../specFetch.js";
import { normalizeOpenApi, type OpenApiDocument } from "./openapi.js";
import type { SourceOperation, SpecSourceContext, SpecSourceDriver } from "./types.js";

/**
 * Apifox 分享文档驱动（P17 type=apifox，2026-10-09 立项）。
 *
 * Apifox 的在线分享文档是客户端渲染，HTML 抓不到接口；但它的机器可读入口
 * `<分享根>/llms.txt` 会列出全部**接口页**（`api-<id>.md`），每个接口页里嵌一段
 * OpenAPI YAML。本驱动据此：llms.txt → 逐个接口页 → 抽 YAML → 合并成一份 OpenAPI
 * 文档 → 复用 `normalizeOpenApi` 归一（与静态文档来源同一套判据，不复制解析规则）。
 *
 * `context.url` 可以是分享根（`https://s.apifox.cn/<shareId>`）或任一接口页
 * （`.../<shareId>/api-491785721`），驱动会剥掉页尾的 `api-<id>` 段还原根。
 */

/** 分享 ID 只出现在 s.apifox.cn（或发布文档站子域）下；其它 host 不算 Apifox 来源。 */
function isApifoxHost(hostname: string): boolean {
  return hostname === "apifox.cn" || hostname.endsWith(".apifox.cn");
}

/** 由分享链接还原「根」：剥掉页尾的 `api-<id>` 段（接口页链接也能直接用）。 */
export function apifoxShareRoot(input: string): string | undefined {
  let url: URL;
  try { url = new URL(input); } catch { return undefined; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!isApifoxHost(url.hostname)) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length && /^api-\d+$/.test(parts[parts.length - 1])) parts.pop();
  return parts.length ? `${url.origin}/${parts.join("/")}` : url.origin;
}

/** llms.txt 里的接口页链接：只收 `api-<数字>.md`（doc / folder 页是说明文档，没有 OpenAPI）。 */
function parseIndex(index: string): string[] {
  const urls = new Set<string>();
  for (const match of index.matchAll(/\]\((https?:\/\/[^\s)]+\.md)\)/g)) {
    const raw = match[1];
    try {
      if (/^api-\d+\.md$/.test(new URL(raw).pathname.split("/").pop() ?? "")) urls.add(raw);
    } catch { /* 非 URL 行跳过 */ }
  }
  return [...urls];
}

const YAML_BLOCK_RE = /```ya?ml\n([\s\S]*?)\n```/;

/** 接口页 markdown → OpenAPI 文档；没有 OpenAPI 代码块返回 undefined（说明页 / 解析失败）。 */
function extractDocument(markdown: string): OpenApiDocument | undefined {
  const block = YAML_BLOCK_RE.exec(markdown);
  if (!block) return undefined;
  try {
    const parsed = parseYaml(block[1]) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as OpenApiDocument;
  } catch {
    return undefined;
  }
}

/** 合并各接口页的 paths：同 path 不同方法合并；同 path 同方法以后到者为准。 */
function mergeDocuments(documents: OpenApiDocument[]): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const document of documents) {
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      paths[path] = { ...(paths[path] ?? {}), ...(item as Record<string, unknown>) };
    }
  }
  return { paths } as OpenApiDocument;
}

/** 有并发上限地跑一批任务，结果按输入顺序返回（保持 llms.txt 的接口顺序）。 */
async function mapPool<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 单次快照的接口页上限：防一个大分享拖垮取数（刷新是显式动作，超限只取前 N 页）。 */
const MAX_PAGES = 500;
const PAGE_CONCURRENCY = 8;

const driver: SpecSourceDriver = {
  type: "apifox",
  async list(context: SpecSourceContext): Promise<SourceOperation[]> {
    const root = apifoxShareRoot(context.url);
    if (!root) throw new Error("apifox source url must be an s.apifox.cn share link");
    const { text: index } = await fetchSpecDocument(`${root}/llms.txt`);
    const pages = parseIndex(index).slice(0, MAX_PAGES);
    if (!pages.length) throw new Error("apifox share has no interface pages (llms.txt listed none)");
    const documents = await mapPool(pages, PAGE_CONCURRENCY, async (pageUrl) => {
      try {
        const { text } = await fetchSpecDocument(pageUrl);
        return extractDocument(text);
      } catch {
        /* 单页取不到不整体失败：分享里偶尔有失效页，剩下的照常归一。 */
        return undefined;
      }
    });
    const operations = normalizeOpenApi(mergeDocuments(documents.filter((doc): doc is OpenApiDocument => doc !== undefined)));
    if (!operations.length) throw new Error("apifox share yielded no operations");
    return operations;
  },
};

export default driver;