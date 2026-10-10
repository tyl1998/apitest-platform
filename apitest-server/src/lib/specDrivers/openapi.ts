import { parse as parseYaml } from "yaml";
import { fetchSpecDocument } from "../specFetch.js";
import type { SourceOperation, SpecSourceContext, SpecSourceDriver } from "./types.js";

/**
 * OpenAPI / Swagger 静态文档驱动（P17 边界 3 的唯一真实驱动）。
 *
 * 归一规则与前端 `importers.ts:parseOpenApi`（粘贴导入）保持一致——两处解析判据
 * 分居前后端是需要记录的重复（计划 21 章「已知重复」）。差异只在 url：粘贴导入把
 * document 的 servers/host 拼进 url，来源归一**丢掉 host**、只留 path，由路由层
 * 补 `{{baseUrl}}`（边界 6：host 归环境变量）。
 */

type OpenApiParameter = { name?: string; in?: string; example?: unknown; schema?: { default?: unknown } };
type OpenApiOperation = {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: { content?: Record<string, { example?: unknown }> };
};
export type OpenApiDocument = { paths?: Record<string, Record<string, OpenApiOperation>> };

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

export function normalizeOpenApi(document: OpenApiDocument): SourceOperation[] {
  return Object.entries(document.paths ?? {}).flatMap(([path, pathItem]) =>
    Object.entries(pathItem ?? {})
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
          method: method.toUpperCase(),
          path,
          summary: String(operation.summary ?? operation.operationId ?? `${method.toUpperCase()} ${path}`),
          description: String(operation.description ?? ""),
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

/** 可选凭据头：配置里可指定 header 名（默认 Authorization），证书/Token 一律走 `credential_cipher`。 */
function credentialHeaders(context: SpecSourceContext): Record<string, string> | undefined {
  const credential = context.credential?.trim();
  if (!credential) return undefined;
  const configured = typeof context.config.headerName === "string" ? context.config.headerName.trim() : "";
  return { [configured || "Authorization"]: credential };
}

const driver: SpecSourceDriver = {
  type: "openapi",
  async list(context) {
    const { text } = await fetchSpecDocument(context.url, { headers: credentialHeaders(context) });
    const document = (text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text)) as OpenApiDocument;
    return normalizeOpenApi(document);
  },
};

export default driver;
