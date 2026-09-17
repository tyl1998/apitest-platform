import { validateDeclarativeAssertions } from "./assert.js";
import { validateExtracts, validateHooks, validateResponseScripts } from "./flow.js";
import { BODY_TYPES, METHODS } from "./run.js";
import type { Assertion, BodyType, EndpointAuth, FlowExtract, HookConfig, RequestSnapshot, ResponseScriptConfig } from "../models/types.js";

export type EndpointInput = {
  name?: string;
  description?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  pathParams?: Record<string, string>;
  bodyType?: BodyType;
  body?: unknown;
  bodyText?: string;
  auth?: EndpointAuth;
  tags?: string[];
  defaultEnvironmentId?: string | null;
};

export type CaseInput = {
  name?: string;
  description?: string;
  environmentId?: string | null;
  request?: Partial<RequestSnapshot>;
  assertions?: Assertion[];
  preRequestHooks?: HookConfig[];
  extracts?: FlowExtract[];
  responseScripts?: ResponseScriptConfig[];
  tags?: string[];
};

/**
 * Extracted from `routes/endpoints.ts` and `routes/cases.ts` (P5-2, 边界 8) so
 * the MCP write tools can run the exact same checks as the REST routes — two
 * copies would mean two semantics. Move only: behavior, signatures (message
 * string, not a thrown error) and the `partial` flag are untouched.
 */
export function validateEndpoint(input: EndpointInput, partial = false): string | undefined {
  if (!partial || input.name !== undefined) if (!input.name?.trim()) return "name is required";
  if (!partial || input.method !== undefined) {
    if (!input.method) return "method is required";
    if (!METHODS.includes(input.method.toUpperCase())) return `method must be one of ${METHODS.join(", ")}`;
  }
  if (!partial || input.url !== undefined) {
    if (!input.url?.trim()) return "url is required";
    /* Variables are resolved at run time, so only validate literal URLs here. */
    if (!input.url.includes("{{") && !/^https?:\/\//i.test(input.url.trim())) return "url must start with http:// or https://";
  }
  if (input.bodyType !== undefined && !BODY_TYPES.includes(input.bodyType)) return `bodyType must be one of ${BODY_TYPES.join(", ")}`;
  /* 2026-09-17：bodyType=json 时 body 必须是对象（数组也算对象）。字符串 body 是调用侧
     序列化错误（如 Java Map.toString），JSON.stringify 会把它双重编码成 jsonb string
     静默落库——这里变成显式错误。null 保留三态「清空」语义（partial 更新）。 */
  const effectiveBodyType = input.bodyType ?? (input.body === undefined ? undefined : "json");
  if (effectiveBodyType === "json" && input.body !== undefined && input.body !== null && typeof input.body !== "object") {
    return "body must be an object when bodyType is json";
  }
  return undefined;
}

export function validateCase(input: CaseInput, partial = false): string | undefined {
  if (!partial || input.name !== undefined) if (!input.name?.trim()) return "name is required";
  if (!partial || input.request !== undefined) {
    const request = input.request;
    if (!request) return "request is required";
    if (!request.method || !METHODS.includes(request.method.toUpperCase())) return `request.method must be one of ${METHODS.join(", ")}`;
    if (!request.url?.trim()) return "request.url is required";
    /* Variables are resolved at run time, so only validate literal URLs here. */
    if (!request.url.includes("{{") && !/^https?:\/\//i.test(request.url.trim())) return "request.url must start with http:// or https://";
    if (request.bodyType !== undefined && !BODY_TYPES.includes(request.bodyType)) return `request.bodyType must be one of ${BODY_TYPES.join(", ")}`;
    const effectiveCaseBodyType = request.bodyType ?? (request.body === undefined ? undefined : "json");
    if (effectiveCaseBodyType === "json" && request.body !== undefined && request.body !== null && typeof request.body !== "object") {
      return "request.body must be an object when bodyType is json";
    }
  }
  return validateDeclarativeAssertions(input.assertions)
    ?? validateHooks(input.preRequestHooks, "case")
    ?? validateExtracts(input.extracts, "case")
    ?? validateResponseScripts(input.responseScripts, "case");
}
