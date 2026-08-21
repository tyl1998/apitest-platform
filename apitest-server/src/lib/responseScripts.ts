import { runResponseScript, type SecretResolver } from "./sandbox.js";
import { sanitizeValue } from "./sanitize.js";
import type { ResponseScriptConfig, ResponseScriptResult } from "../models/types.js";

export type ResponseScriptSubject = {
  statusCode?: number;
  headers: Record<string, string>;
  body?: string;
};

/**
 * Runs enabled response scripts in declaration order.
 *
 * Every script sees pre-request/extract writes plus earlier response-script
 * writes. All writes remain local to this result; executeRequest decides whether
 * the completed request node may commit them to its caller.
 */
export function applyResponseScripts(
  scripts: ResponseScriptConfig[] | undefined,
  subject: ResponseScriptSubject,
  options: {
    variables: Record<string, unknown>;
    resolveSecret?: SecretResolver;
    secretValues?: string[];
  },
): { results: ResponseScriptResult[]; variables: Record<string, string>; failed?: ResponseScriptResult } {
  const results: ResponseScriptResult[] = [];
  const written: Record<string, string> = {};
  const foldedHeaders = Object.fromEntries(Object.entries(subject.headers).map(([key, value]) => [key.toLowerCase(), value]));
  let parsedBody: unknown;
  try { parsedBody = subject.body === undefined ? undefined : JSON.parse(subject.body); } catch { parsedBody = undefined; }

  for (const [index, config] of (scripts ?? []).entries()) {
    if (config.enabled === false) continue;
    const name = config.name?.trim() || `response script ${index + 1}`;
    const source = config.script?.content;
    if (!source) {
      const failed: ResponseScriptResult = { name, type: config.type, ok: false, error: "response script content is missing", logs: [], debug: [], checks: [], variables: {} };
      results.push(failed);
      return { results, variables: written, failed };
    }

    const outcome = runResponseScript(source, {
      response: { status: subject.statusCode, headers: foldedHeaders, body: parsedBody, text: subject.body },
      variables: { ...options.variables, ...written },
    }, config.script?.libraries ?? [], options.resolveSecret);
    const secretValues = options.secretValues ?? [];
    const sanitized = sanitizeValue({
      name, type: config.type, ok: outcome.ok, error: outcome.error,
      logs: outcome.logs, debug: outcome.debug, checks: outcome.checks,
      returned: outcome.returned, variables: outcome.variables,
    }, secretValues) as ResponseScriptResult;
    results.push(sanitized);
    if (!outcome.ok) return { results, variables: written, failed: sanitized };
    Object.assign(written, outcome.variables);
  }
  return { results, variables: written };
}
