import { fetchSpecDocument } from "../specFetch.js";
import { readAdapterConfig, type AdapterFieldMap } from "./adapterConfig.js";
import type { SourceOperation, SpecSourceContext, SpecSourceDriver } from "./types.js";

/**
 * 通用「远端平台检索适配器」（P17 type=adapter）。
 *
 * 远端平台没有统一检索协议，所以这里不是一个写死 vendor 的驱动，而是**由来源 config
 * 描述**的通用适配器：往哪个检索端点发、怎么带关键词、结果数组在响应的哪个点路径、
 * 每个 operation 的字段从哪取（见 `adapterConfig.ts`）。换平台 = 改配置，零代码。
 *
 * 只有 `search()` 没有 `list()`：远端检索是实时透传，本地不留快照（边界 1、4）。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 点路径取值：`data.items`，支持纯数字段访问数组元素。 */
function readPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
    else if (isRecord(current)) current = current[key];
    else return undefined;
  }
  return current;
}

function asStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    out[key] = String(item);
  }
  return out;
}

/** 一条远端结果 → SourceOperation。缺方法或路径的行丢掉（无法预填）。 */
function toOperation(item: unknown, map: AdapterFieldMap): SourceOperation | undefined {
  if (!isRecord(item)) return undefined;
  const method = String(readPath(item, map.method) ?? "").trim().toUpperCase();
  let path = String(readPath(item, map.path) ?? readPath(item, map.url) ?? "").trim();
  if (!method || !path) return undefined;
  /* 远端可能回完整 URL：只留 path，host 归环境变量（边界 6）。 */
  if (/^https?:\/\//i.test(path)) {
    try { path = new URL(path).pathname; } catch { /* 保原样 */ }
  }
  if (!path.startsWith("/")) path = `/${path}`;
  const summary = readPath(item, map.summary) ?? readPath(item, map.name);
  const tags = readPath(item, map.tags);
  return {
    method,
    path,
    summary: String(summary ?? `${method} ${path}`),
    description: String(readPath(item, map.description) ?? ""),
    headers: asStringMap(readPath(item, map.headers)),
    queryParams: asStringMap(readPath(item, map.query)),
    pathParams: asStringMap(readPath(item, map.pathParams)),
    bodyType: "none",
    tags: Array.isArray(tags) ? tags.map((tag) => String(tag)) : [],
  };
}

const driver: SpecSourceDriver = {
  type: "adapter",
  async search(context: SpecSourceContext, keyword: string) {
    const parsed = readAdapterConfig(context.config);
    if ("error" in parsed) throw new Error(parsed.error);
    const config = parsed.config;

    const url = new URL(config.searchPath, context.url);
    const headers: Record<string, string> = { ...config.extraHeaders };
    if (context.credential) {
      const configured = typeof context.config.headerName === "string" ? context.config.headerName.trim() : "";
      headers[configured || "Authorization"] = context.credential;
    }
    let body: string | undefined;
    if (config.searchMethod === "GET") {
      url.searchParams.set(config.keywordParam, keyword);
    } else {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      body = JSON.stringify({ [config.keywordParam]: keyword });
    }

    const { text } = await fetchSpecDocument(url.toString(), { method: config.searchMethod, headers, body });
    const payload: unknown = text.trim() ? JSON.parse(text) : undefined;
    const results = config.resultPath ? readPath(payload, config.resultPath) : payload;
    if (!Array.isArray(results)) return [];
    return results
      .map((item) => toOperation(item, config.fieldMap))
      .filter((operation): operation is SourceOperation => operation !== undefined);
  },
};

export default driver;
