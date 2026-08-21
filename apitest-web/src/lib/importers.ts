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
