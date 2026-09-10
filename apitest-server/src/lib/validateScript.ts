import { inspectLibrarySource } from "./scriptContract.js";
import { isUuid } from "./uuid.js";

/**
 * Extracted from `routes/scripts.ts` (P5-6，边界 8——同 `validateSpecCase` 的先例)
 * so the MCP write tools run the exact same checks as the REST routes. Move only:
 * behavior, signatures (message string, not a thrown error) and the `partial` flag
 * are untouched.
 */

export const MAX_SCRIPT_LENGTH = 20_000;
/* `assertion` remains readable for historical rows, but new custom response
   logic is stored as `response` after P2-2.1. */
export const SCRIPT_KINDS = ["assertion", "hook", "response", "library", "node"];
export const CREATABLE_SCRIPT_KINDS = ["hook", "response", "library", "node"];

export type ScriptInput = { name?: string; content?: string; kind?: string; dependencies?: string[] };

export function validateScript(input: ScriptInput, partial = false): string | undefined {
  if (!partial || input.name !== undefined) {
    if (!input.name?.trim()) return "name is required";
    if (input.name.trim().length > 100) return "name must be at most 100 characters";
  }
  if (!partial || input.content !== undefined) {
    if (!input.content?.trim()) return "content is required";
    if (input.content.length > MAX_SCRIPT_LENGTH) return `content must be at most ${MAX_SCRIPT_LENGTH} characters`;
  }
  if (input.kind !== undefined && !SCRIPT_KINDS.includes(input.kind)) {
    return `kind must be one of ${SCRIPT_KINDS.join(", ")}`;
  }
  if (input.kind === "library" && input.content !== undefined) {
    const inspected = inspectLibrarySource(input.content);
    if (inspected.error) return inspected.error;
  }
  if (input.dependencies !== undefined) {
    if (!Array.isArray(input.dependencies)) return "dependencies must be an array";
    if (input.dependencies.some((id) => !isUuid(id))) return "dependencies must be script ids";
    if (input.dependencies.length > 10) return "a script may reference at most 10 libraries";
  }
  return undefined;
}
