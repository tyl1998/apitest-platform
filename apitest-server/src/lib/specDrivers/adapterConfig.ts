/**
 * 通用「远端平台检索适配器」的来源配置（P17 type=adapter）。
 *
 * 远端平台没有统一检索协议，所以适配器不由代码写死某个 vendor，而由来源 `config`
 * **描述**：检索端点在哪、怎么传关键词、响应里结果数组与字段怎么取。换一个远端平台
 * 往往只是改一份配置，零开发。
 *
 * 这份文件是**纯解析**（无网络），既给路由建 / 改来源时做同步校验，也给驱动运行期读默认值
 * ——两处共用一套规则，不会分叉。
 */

export type AdapterFieldMap = {
  method: string;
  path: string;
  url: string;
  summary: string;
  name: string;
  description: string;
  tags: string;
  headers: string;
  query: string;
  pathParams: string;
};

export type AdapterConfig = {
  searchPath: string;
  searchMethod: "GET" | "POST";
  keywordParam: string;
  /** 响应里结果数组的点路径（如 `data.items`）；留空表示响应体本身就是数组。 */
  resultPath: string;
  /** 静态附加请求头（远端平台的固定头，如租户标识）。 */
  extraHeaders: Record<string, string>;
  fieldMap: AdapterFieldMap;
};

const FIELD_DEFAULTS: AdapterFieldMap = {
  method: "method",
  path: "path",
  url: "url",
  summary: "summary",
  name: "name",
  description: "description",
  tags: "tags",
  headers: "headers",
  query: "queryParams",
  pathParams: "pathParams",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

/** 解析并归一配置；返回 `{ error }` 或 `{ config }`。`baseUrl` 由来源行自己的 `url` 提供，不在配置里。 */
export function readAdapterConfig(input: Record<string, unknown>): { config: AdapterConfig } | { error: string } {
  const searchPath = readString(input.searchPath);
  if (!searchPath) return { error: "remote adapter config.searchPath is required" };
  if (!searchPath.startsWith("/") && !/^https?:\/\//i.test(searchPath)) return { error: "remote adapter config.searchPath must start with \"/\" or be an http(s) URL" };

  const rawMethod = readString(input.searchMethod)?.toUpperCase() ?? "GET";
  if (rawMethod !== "GET" && rawMethod !== "POST") return { error: "remote adapter config.searchMethod must be GET or POST" };

  const keywordParam = readString(input.keywordParam) || "keyword";

  const rawHeaders = input.extraHeaders;
  const extraHeaders: Record<string, string> = {};
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (!isRecord(rawHeaders)) return { error: "remote adapter config.extraHeaders must be an object of string values" };
    for (const [key, value] of Object.entries(rawHeaders)) {
      const name = key.trim();
      if (!name) continue;
      if (typeof value !== "string") return { error: `remote adapter config.extraHeaders["${name}"] must be a string` };
      extraHeaders[name] = value;
    }
  }

  const fieldMap: AdapterFieldMap = { ...FIELD_DEFAULTS };
  if (input.fieldMap !== undefined && input.fieldMap !== null) {
    if (!isRecord(input.fieldMap)) return { error: "remote adapter config.fieldMap must be an object" };
    for (const key of Object.keys(FIELD_DEFAULTS) as (keyof AdapterFieldMap)[]) {
      const value = readString(input.fieldMap[key]);
      if (value) fieldMap[key] = value;
    }
  }

  return {
    config: {
      searchPath,
      searchMethod: rawMethod,
      keywordParam,
      resultPath: readString(input.resultPath) ?? "",
      extraHeaders,
      fieldMap,
    },
  };
}
