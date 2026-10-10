import { parse as parseYaml } from "yaml";
import type { EndpointInput } from "../api";

type OpenApiOperation = {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: { name?: string; in?: string; example?: unknown; schema?: { default?: unknown } }[];
  requestBody?: { content?: Record<string, { example?: unknown }> };
};

type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>;
  servers?: { url?: string }[];
  basePath?: string;
  host?: string;
  schemes?: string[];
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

export function parseOpenApi(source: string): EndpointInput[] {
  const document = (source.trimStart().startsWith("{") ? JSON.parse(source) : parseYaml(source)) as OpenApiDocument;
  /* Swagger 2 uses host+basePath+schemes; OpenAPI 3 uses servers[]. */
  const baseUrl = document.servers?.[0]?.url
    ?? (document.host ? `${document.schemes?.[0] ?? "https"}://${document.host}${document.basePath ?? ""}` : document.basePath ?? "");

  return Object.entries(document.paths ?? {}).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => HTTP_METHODS.includes(method.toLowerCase()))
      .map(([method, operation]) => {
        const params = operation.parameters ?? [];
        const pick = (location: string) => Object.fromEntries(
          params
            .filter((param) => param.in === location && param.name)
            .map((param) => [param.name!, String(param.example ?? param.schema?.default ?? "")]),
        );
        const jsonBody = operation.requestBody?.content?.["application/json"]?.example;

        return {
          name: String(operation.summary ?? operation.operationId ?? `${method.toUpperCase()} ${path}`),
          description: String(operation.description ?? ""),
          method: method.toUpperCase(),
          url: `${baseUrl}${path}`,
          headers: pick("header"),
          queryParams: pick("query"),
          pathParams: pick("path"),
          bodyType: jsonBody === undefined ? "none" as const : "json" as const,
          body: jsonBody,
          tags: operation.tags ?? [],
        };
      }),
  );
}

/** Detects shell constructs a HTTP client cannot reproduce, so the UI can warn. */
export function hasUnsupportedShell(source: string) {
  return /\$\(|\$\{|`|(?:^|\s)@[^\s]+/.test(source);
}

/**
 * True when pasted text is a cURL command, so a URL box can recognize it
 * (2026-10-09). A leading shell prompt (`$ `) is tolerated — people copy the
 * line including it. A URL is required: a bare `curl` word is not a command.
 */
export function looksLikeCurl(source: string) {
  return /^\s*\$?\s*curl\b/i.test(source) && /https?:\/\//i.test(source);
}

/**
 * 路径清单（批量粘贴，2026-08-30）：每行 `METHOD /path [名称]`，`#` 开头是注释。
 *
 * 服务仓库模式团队「为了覆盖率把仓库里已有的接口清单再抄一遍」的那一步：他们手里往往
 * 就是一份路径列表，而不是 OpenAPI 文档。只建**最小接口**（无 headers/body/auth）——
 * 这批接口的职责是进覆盖分母，要调试再单个补全。
 *
 * url 记成 `{{baseUrl}}` + 路径：满足「绝对地址或含 `{{`」的 URL 契约，匹配归一时变量段
 * 会被剥掉，与未匹配区「一键登记」生成的接口同形。
 *
 * 解析是严格的：认不出的行直接抛错（带行号与内容），而不是悄悄丢掉——悄悄丢掉的行
 * 不会出现在任何计数里，用户会以为它导进来了。
 */
export function parsePaths(source: string): EndpointInput[] {
  const items: EndpointInput[] = [];
  const bad: string[] = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const tokens = trimmed.split(/\s+/);
    const method = (tokens[0] ?? "").toUpperCase();
    const path = tokens[1] ?? "";
    /* 方法表与后端 lib/http.ts 的 METHODS 同一张（HEAD/OPTIONS 都在），否则 import 路由
       会把校验不过的行静默跳过——那是这里的严格性要防的同一类静默丢失。 */
    if (!HTTP_METHODS.includes(method.toLowerCase()) || !path.startsWith("/")) {
      bad.push(`line ${index + 1}: ${trimmed}`);
      return;
    }
    items.push({
      name: tokens.slice(2).join(" ") || `${method} ${path}`,
      method,
      url: `{{baseUrl}}${path}`,
      tags: [],
    });
  });
  if (bad.length) throw new Error(bad.slice(0, 3).join(" · "));
  return items;
}

export function parseCurl(source: string): EndpointInput[] {
  const commands = source.split(/\n(?=\s*curl\b)/i).map((item) => item.trim()).filter(Boolean);

  return commands.map((command) => {
    const normalized = command.replace(/\\\s*\n/g, " ");
    /* Tokenise respecting quotes, so flag order and quoted values both work. */
    const tokens = [...normalized.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g)]
      .map((match) => match[1] ?? match[2] ?? match[3]);

    const headers: Record<string, string> = {};
    let method = "";
    let url = "";
    let bodyText: string | undefined;
    let auth: EndpointInput["auth"];

    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (["-X", "--request"].includes(token)) { method = (tokens[++index] ?? "GET").toUpperCase(); continue; }
      if (["-H", "--header"].includes(token)) {
        const header = tokens[++index] ?? "";
        const separator = header.indexOf(":");
        if (separator > 0) headers[header.slice(0, separator).trim()] = header.slice(separator + 1).trim();
        continue;
      }
      if (["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode"].includes(token)) { bodyText = tokens[++index]; continue; }
      if (["-u", "--user"].includes(token)) {
        const [username = "", password = ""] = (tokens[++index] ?? "").split(":");
        auth = { type: "basic", username, password };
        continue;
      }
      if (token.startsWith("-")) continue;
      if (/^https?:\/\//i.test(token)) url = token;
    }

    let bodyType: EndpointInput["bodyType"] = "none";
    let body: unknown;
    if (bodyText !== undefined) {
      try { body = JSON.parse(bodyText); bodyType = "json"; }
      catch {
        /* Not JSON: keep the raw text and classify by shape. */
        bodyType = /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(bodyText) ? "form" : "text";
      }
    }

    /* curl implies POST when a body is present and no method was given. */
    if (!method) method = bodyText === undefined ? "GET" : "POST";

    /* Query already in the URL stays there; splitting it out would be lossy. */
    return {
      name: `${method} ${url || "cURL"}`,
      method,
      url,
      headers,
      bodyType,
      body: bodyType === "json" ? body : undefined,
      bodyText: bodyType === "json" ? undefined : bodyText,
      auth,
      tags: [],
    };
  }).filter((item) => item.url);
}
