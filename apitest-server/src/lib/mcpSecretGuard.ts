import type { EndpointAuth, RequestSnapshot } from "../models/types.js";

/**
 * 写工具的字面量 secret 拒绝（P5-5a，计划 9.0 边界 4——写侧最锋利的一条）。
 *
 * `auth`、`headers`、`body` 里出现疑似凭据的字面量（`Authorization` 头有值、字段名命中
 * `token|secret|password|key`）一律返回错误并指向「先在环境里建一个 secret，再用
 * `{{name}}` 引用」。理由是**对话记录会留在平台之外**：agent 平台自己会存 transcript，
 * 模型厂商也可能存。让凭据字面量流经工具入参，等于把 secret 抄进一份平台管不着的日志。
 * 这一条与 4.6 的「secret 永不离开服务器」同向；CI 任务的仓库凭据更严——只引用既有
 * 凭据条目，永不经工具入参传递（边界 4 末段，落在 mcpToolsWriteCrud 的 create/update
 * _ci_task 里）。
 *
 * 判据刻意**宽于**脱敏的 `SENSITIVE_HEADERS`：脱敏遮的是「一定敏感的头」，这里挡的是
 * 「名字像凭据的一切字段」——宁可误伤一个叫 `token` 的普通字段（改名即可），不放过
 * 一个真凭据。误伤的修法（换个字段名或改用 `{{var}}`）在错误消息里说清。
 */

/** 头名命中即拒（不区分大小写）。`Authorization` 有值就拒——模板值除外（见下）。 */
const SENSITIVE_HEADER_PATTERN = /^(authorization|proxy-authorization|cookie|x-api-key)$/i;

/** 字段名命中即拒（headers / body 的对象键、auth 的字段名）。 */
const CREDENTIAL_FIELD_PATTERN = /(token|secret|password|apikey|api_key|private[_-]?key|credential)/i;

/** `{{name}}` 引用是**唯一**合法形态：值整段就是一个变量引用时放行。 */
const VARIABLE_REFERENCE = /^\{\{\s*[^}]+\s*\}\}$/;

const REFUSAL = "literal credential-looking values are rejected: create the secret in an environment (UI) and reference it as {{name}} here instead";

/** 认证方案前缀（`Bearer ` / `Basic ` / `Token `）——只吃方案词本身，余下的留给引用
 *  判定（吃掉 `{{…}}` 会让「前缀 + 引用」的正确写法被整段误判）。 */
const BEARER_LIKE = /^(bearer|basic|token)\s+/i;

function isLiteralSecret(name: string, value: string): boolean {
  const text = value.trim();
  /* `{{token}}` / `{{ apiKey }}` 是**唯一**合法形态：值整段就是一个变量引用时放行，
     名字像凭据不影响引用本身。 */
  if (VARIABLE_REFERENCE.test(text)) return false;
  const sensitiveName = SENSITIVE_HEADER_PATTERN.test(name);
  if (!sensitiveName && !CREDENTIAL_FIELD_PATTERN.test(name)) return false;
  /* `Bearer {{auth}}`（方案前缀 + 纯引用）是写 auth 头的惯用形态：剥掉前缀后剩下的
     仍是纯引用就放行——整段判定会把它误伤，而这是 secret 的标准写法。 */
  const scheme = BEARER_LIKE.exec(text);
  if (scheme && VARIABLE_REFERENCE.test(text.slice(scheme[0].length).trim())) return false;
  /* 到这里还没放行的：敏感头（authorization/cookie/x-api-key）或凭据名字段带着一个
     非引用的字面量值——拒绝。宁可误伤一个叫 token 的普通字段（改名即可），不放过
     一个真凭据。 */
  return true;
}

function scanHeaders(headers: Record<string, string> | undefined): string | undefined {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string" && isLiteralSecret(name, value)) {
      return `header "${name}" carries a literal credential value; ${REFUSAL}`;
    }
  }
  return undefined;
}

function scanAuth(auth: EndpointAuth | undefined): string | undefined {
  if (!auth || auth.type === "none") return undefined;
  /* apiKey 案件最多：value 就是凭据本体。bearer/basic 的字段同理。任何一个是纯
     `{{var}}` 引用就合法——secret 的正确写法正是这样。 */
  for (const field of ["token", "username", "password", "value"] as const) {
    const value = (auth as Record<string, unknown>)[field];
    if (typeof value === "string" && !VARIABLE_REFERENCE.test(value.trim())) {
      return `auth.${auth.type}.${field} carries a literal credential value; ${REFUSAL}`;
    }
  }
  return undefined;
}

/** 递归扫 body 的对象键与数组。文本 body（bodyText）无法按字段判，跳过。 */
function scanBody(body: unknown, path: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (Array.isArray(body)) {
    for (const [index, item] of body.entries()) {
      const found = scanBody(item, `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string" && !VARIABLE_REFERENCE.test(value.trim()) && CREDENTIAL_FIELD_PATTERN.test(key)) {
      return `body field "${path}${path ? "." : ""}${key}" carries a literal credential value; ${REFUSAL}`;
    }
    const found = scanBody(value, `${path}${path ? "." : ""}${key}`);
    if (found) return found;
  }
  return undefined;
}

/**
 * endpoint 写入前的整份检查：headers / auth / body（含 queryParams 的敏感名键）。
 * 变量、`{{reference}}`、环境 secret 的既有形态全部放行——拒绝的只有「把真凭据字面量
 * 粘进工具入参」这一件事。
 */
export function rejectLiteralSecrets(input: {
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  auth?: EndpointAuth;
  body?: unknown;
}): string | undefined {
  return scanHeaders(input.headers)
    ?? scanHeaders(input.queryParams)
    ?? scanAuth(input.auth)
    ?? scanBody(input.body, "");
}

/**
 * 用例 / 流程节点的 request 快照走同一份检查（快照与 endpoint 定义携带同一批字段，
 * 校验语义不允许两份）。P5-2 提取的 `validateCase` 已管形状，这里只管凭据字面量。
 */
export function rejectLiteralSecretsInSnapshot(request: Partial<RequestSnapshot> | undefined): string | undefined {
  if (!request) return undefined;
  return rejectLiteralSecrets({
    headers: request.headers,
    queryParams: request.queryParams,
    auth: request.auth,
    body: request.body,
  });
}

/**
 * 环境普通变量的凭据名拒绝（`upsert_environment`，2026-09-06 增补）：名字命中
 * `token|secret|password|…` 的变量值是**明文**——`list_environments` 会原样读回，
 * 等于把敏感值放进一个任何工具可见的通道。敏感值只能作为 secret 在 UI 里录
 * （契约第 7 条），这里指名拒绝并给出正确写法。
 */
export function rejectCredentialNamedVariables(variables: Record<string, string>): string | undefined {
  for (const name of Object.keys(variables)) {
    if (CREDENTIAL_FIELD_PATTERN.test(name)) {
      return `variable "${name}" looks like a credential; plain variables are readable by every tool — store it as an environment secret in the UI and reference it as {{${name}}} instead`;
    }
  }
  return undefined;
}
