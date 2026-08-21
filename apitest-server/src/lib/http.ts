import type { BodyType } from "../models/types.js";

/**
 * Shared HTTP vocabulary.
 *
 * Split out of run.ts so flow.ts (which validates flow requests and would
 * otherwise import run.ts while run.ts imports flow.ts for extract evaluation)
 * does not participate in a module cycle.
 */
export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
export const BODY_TYPES: BodyType[] = ["none", "json", "form", "text"];
