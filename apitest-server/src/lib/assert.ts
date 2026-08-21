import Ajv from "ajv";
import type { Assertion, AssertionOperator, AssertionResult, AssertionType } from "../models/types.js";

export const ASSERTION_TYPES: AssertionType[] = ["status", "header", "jsonPath", "jsonSchema"];
export const DECLARATIVE_ASSERTION_TYPES = ASSERTION_TYPES;
export const ASSERTION_OPERATORS: AssertionOperator[] = ["equals", "notEquals", "contains", "exists", "notExists", "greaterThan", "lessThan", "matchesSchema", "isTrue"];

const ajv = new Ajv.default({ allErrors: true });

/** `exists` / `notExists` test presence, so they carry no expected value. */
const PRESENCE_OPERATORS: AssertionOperator[] = ["exists", "notExists"];

/** The value an assertion reads. `header` and `jsonPath` also need a target. */
export type AssertionSubject = {
  statusCode?: number;
  headers: Record<string, string>;
  /** Raw response text. Parsed on demand, once, for jsonPath assertions. */
  body?: string;
};

export function validateAssertions(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "assertions must be an array";
  if (value.length > 50) return "assertions must contain at most 50 entries";
  for (const item of value as Assertion[]) {
    if (!item || typeof item !== "object") return "each assertion must be an object";
    if (!ASSERTION_TYPES.includes(item.type)) return `assertion type must be one of ${ASSERTION_TYPES.join(", ")}`;
    if (!ASSERTION_OPERATORS.includes(item.operator)) return `assertion operator must be one of ${ASSERTION_OPERATORS.join(", ")}`;
    
    /* jsonSchema has its own input shape; others need a target. */
    if (item.type === "jsonSchema") {
      if (item.operator !== "matchesSchema") return "jsonSchema assertions must use the matchesSchema operator";
      if (!item.expected?.trim()) return "jsonSchema assertions require a schema in the expected field";
    } else if (item.type !== "status" && !item.target?.trim()) {
      return "header and jsonPath assertions require a target";
    }
    
    /* An empty string is a legitimate expected value, so only absence is rejected. */
    if (!PRESENCE_OPERATORS.includes(item.operator) && item.operator !== "matchesSchema" && item.operator !== "isTrue" && item.expected === undefined) {
      return "this operator requires an expected value";
    }
    if (item.type === "status" && !PRESENCE_OPERATORS.includes(item.operator) && Number.isNaN(Number(item.expected))) {
      return "a status assertion expects a number";
    }
  }
  return undefined;
}

/** Request lifecycles keep custom code in post-response scripts (P2-2.1). */
export function validateDeclarativeAssertions(value: unknown): string | undefined {
  const invalid = validateAssertions(value);
  if (invalid) return invalid;
  if ((value as Assertion[] | undefined)?.some((item) => !DECLARATIVE_ASSERTION_TYPES.includes(item.type))) {
    return `assertion type must be one of ${DECLARATIVE_ASSERTION_TYPES.join(", ")}; use a response script for custom JavaScript`;
  }
  return undefined;
}

/**
 * Reads `$.a.b[0].c` out of a parsed body.
 *
 * A deliberate JSONPath subset: dotted names, quoted names and numeric
 * indexes. Filters, wildcards and recursive descent are not supported, because
 * an assertion the user cannot predict is worse than one they cannot write.
 * Returns `undefined` for a path that does not resolve, which is exactly what
 * `exists` needs to report.
 */
export function readPath(root: unknown, path: string): unknown {
  const trimmed = path.trim().replace(/^\$\.?/, "");
  if (!trimmed) return root;
  let current: unknown = root;
  for (const [, dotted, quoted, index] of trimmed.matchAll(/(?:^|\.)([^.[\]]+)|\[['"]([^'"]+)['"]\]|\[(\d+)\]/g)) {
    if (current === null || current === undefined) return undefined;
    const key = dotted ?? quoted ?? index;
    if (index !== undefined) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index)];
    } else {
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

function display(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Compares as numbers when both sides are numeric, otherwise as text.
 *
 * Assertions are authored as strings in a form, so `200` typed against a
 * numeric status code has to match. Falling back to text keeps `equals` usable
 * for ids and tokens.
 */
function compare(actual: unknown, expected: string, operator: AssertionOperator): boolean {
  const actualText = display(actual) ?? "";
  const bothNumeric = actual !== null && actual !== undefined && actualText.trim() !== "" && expected.trim() !== "" && !Number.isNaN(Number(actualText)) && !Number.isNaN(Number(expected));
  switch (operator) {
    case "equals": return bothNumeric ? Number(actualText) === Number(expected) : actualText === expected;
    case "notEquals": return bothNumeric ? Number(actualText) !== Number(expected) : actualText !== expected;
    case "contains": return actualText.includes(expected);
    case "greaterThan": return bothNumeric && Number(actualText) > Number(expected);
    case "lessThan": return bothNumeric && Number(actualText) < Number(expected);
    default: return false;
  }
}

/**
 * Reserved options object kept so existing call sites need not branch when
 * evaluating database and HTTP declarative assertions.
 */
export type AssertionOptions = Record<string, never>;

/**
 * What an evaluation produced beyond the per-assertion verdicts.
 *
 * `variables` remains in the return shape for callers compiled against the
 * prior contract. Declarative rules never write variables.
 */
export type AssertionEvaluation = { results: AssertionResult[]; variables: Record<string, string> };

export function evaluateAssertions(assertions: Assertion[], subject: AssertionSubject, options: AssertionOptions = {}): AssertionEvaluation {
  /* Parsed once per run rather than per assertion, and only when needed. */
  let parsedBody: unknown;
  let bodyParsed = false;
  let bodyError: string | undefined;
  function body() {
    if (!bodyParsed) {
      bodyParsed = true;
      try { parsedBody = subject.body === undefined ? undefined : JSON.parse(subject.body); }
      catch { bodyError = "response body is not JSON"; }
    }
    return parsedBody;
  }

  /* Header names are case-insensitive per RFC 9110, so both sides fold down. */
  const headers = Object.fromEntries(Object.entries(subject.headers).map(([key, value]) => [key.toLowerCase(), value]));

  const written: Record<string, string> = {};

  const results = assertions.map((assertion) => {
    let actual: unknown;
    let message: string | undefined;

    if (assertion.type === "jsonSchema") {
      /* JSON Schema validates the whole body, not a path. */
      const parsed = body();
      if (bodyError) {
        return { ...assertion, passed: false, message: bodyError };
      }
      try {
        const schema = JSON.parse(assertion.expected ?? "{}");
        const validate = ajv.compile(schema);
        const valid = validate(parsed);
        return {
          ...assertion,
          passed: valid,
          actual: display(parsed),
          message: valid ? undefined : ajv.errorsText(validate.errors),
        };
      } catch (error) {
        return {
          ...assertion,
          passed: false,
          message: error instanceof Error ? `schema parse error: ${error.message}` : "invalid schema",
        };
      }
    }

    /* Standard status/header/jsonPath evaluation. */
    if (assertion.type === "status") actual = subject.statusCode;
    else if (assertion.type === "header") actual = headers[assertion.target!.trim().toLowerCase()];
    else {
      actual = readPath(body(), assertion.target!);
      if (bodyError) message = bodyError;
    }

    const passed = message
      ? false
      : assertion.operator === "exists" ? actual !== undefined
      : assertion.operator === "notExists" ? actual === undefined
      : compare(actual, assertion.expected ?? "", assertion.operator);

    return { ...assertion, passed, actual: display(actual), message };
  });

  return { results, variables: written };
}
