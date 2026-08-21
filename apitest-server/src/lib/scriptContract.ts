import { parse } from "acorn";

export type ScriptRuntimeKind = "assertion" | "hook" | "response" | "node" | "library";

export type ScriptCompletionSymbol = {
  name: string;
  kind: "function" | "class" | "constant" | "property" | "method";
  insertText: string;
  detail: string;
  documentation: string;
};

type CtxSchema = {
  kind: Exclude<ScriptRuntimeKind, "library">;
  symbols: ScriptCompletionSymbol[];
};

const common: ScriptCompletionSymbol[] = [
  symbol("ctx", "property", "ctx", "script context", "Runtime context for this script kind."),
  symbol("ctx.variables", "property", "ctx.variables", "Record<string, unknown>", "Read the resolved variable bag for this step."),
  symbol("ctx.setVariable", "method", "ctx.setVariable(${1:name}, ${2:value})", "(name, value) => void", "Write a node-local value. It is committed only after the whole request node succeeds."),
  symbol("ctx.debug", "method", "ctx.debug(${1:label}, ${2:value})", "(label, value) => void", "Record a bounded diagnostic value in the execution evidence."),
  symbol("ctx.assert", "method", "ctx.assert(${1:value}, ${2:message})", "(value, message?) => void", "Assert that a value is truthy. Hard assertions throw by default; set ctx.assert.soft = true to collect failures."),
  symbol("ctx.assert.soft", "property", "ctx.assert.soft", "boolean", "Set true to collect failed checks and continue the script."),
  symbol("ctx.assert.ok", "method", "ctx.assert.ok(${1:value}, ${2:message})", "(value, message?) => void", "Assert that a value is truthy."),
  symbol("ctx.assert.isTrue", "method", "ctx.assert.isTrue(${1:value}, ${2:message})", "(value, message?) => void", "Assert that a value is exactly true."),
  symbol("ctx.assert.equal", "method", "ctx.assert.equal(${1:actual}, ${2:expected}, ${3:message})", "(actual, expected, message?) => void", "Assert loose numeric/text equality."),
  symbol("ctx.assert.notEqual", "method", "ctx.assert.notEqual(${1:actual}, ${2:expected}, ${3:message})", "(actual, expected, message?) => void", "Assert inequality."),
  symbol("ctx.assert.contains", "method", "ctx.assert.contains(${1:container}, ${2:part}, ${3:message})", "(container, part, message?) => void", "Assert that text, an array, or an object contains a value."),
  symbol("ctx.crypto", "property", "ctx.crypto", "crypto helpers", "Host-side bounded cryptography. Secret key material may use { secret: \"NAME\" }."),
  symbol("ctx.crypto.hash", "method", "ctx.crypto.hash(${1:algorithm}, ${2:data}, ${3:options})", "(algorithm, data, options?) => string", "Hash data with an algorithm provided by Node/OpenSSL."),
  ...["md5", "sha1", "sha256", "sha512", "sm3"].map((name) => symbol(`ctx.crypto.${name}`, "method", `ctx.crypto.${name}(\${1:data}, \${2:options})`, `(data, options?) => string`, `Compute a ${name} digest.`)),
  symbol("ctx.crypto.hmac", "method", "ctx.crypto.hmac(${1:algorithm}, ${2:data}, ${3:key}, ${4:options})", "(algorithm, data, key, options?) => string", "Compute HMAC. key may be { secret: \"NAME\" }."),
  symbol("ctx.crypto.encrypt", "method", "ctx.crypto.encrypt(${1:algorithm}, ${2:data}, ${3:options})", "(algorithm, data, options) => string", "Encrypt with bounded key/iv/encoding options."),
  symbol("ctx.crypto.decrypt", "method", "ctx.crypto.decrypt(${1:algorithm}, ${2:data}, ${3:options})", "(algorithm, data, options) => string", "Decrypt with bounded key/iv/encoding options."),
  symbol("ctx.crypto.sign", "method", "ctx.crypto.sign(${1:algorithm}, ${2:data}, ${3:options})", "(algorithm, data, options) => string", "Sign data with a private key."),
  symbol("ctx.crypto.randomBytes", "method", "ctx.crypto.randomBytes(${1:size}, ${2:encoding})", "(size, encoding?) => string", "Generate random bytes."),
  symbol("ctx.crypto.uuid", "method", "ctx.crypto.uuid()", "() => string", "Generate a UUID."),
  symbol("ctx.crypto.algorithms", "method", "ctx.crypto.algorithms()", "() => { hashes, ciphers }", "List algorithms available in the current Node/OpenSSL runtime."),
  symbol("ctx.encoding", "property", "ctx.encoding", "encoding helpers", "Encoding conversion helpers."),
  symbol("ctx.encoding.convert", "method", "ctx.encoding.convert(${1:data}, ${2:from}, ${3:to})", "(data, from, to) => string", "Convert between utf8, hex, base64, base64url, and latin1."),
  ...["base64Encode", "base64Decode", "hexEncode", "hexDecode"].map((name) => symbol(`ctx.encoding.${name}`, "method", `ctx.encoding.${name}(\${1:data}, \${2:encoding})`, `(data, encoding?) => string`, `${name} data.`)),
  symbol("ctx.encoding.urlEncode", "method", "ctx.encoding.urlEncode(${1:data})", "(data) => string", "URL-encode text."),
  symbol("ctx.encoding.xor", "method", "ctx.encoding.xor(${1:data}, ${2:other}, ${3:options})", "(data, other, options?) => string", "XOR two byte sequences."),
];

const responseOnly = [
  symbol("ctx.response", "property", "ctx.response", "response snapshot", "Available to response scripts."),
  symbol("ctx.response.status", "property", "ctx.response.status", "number | undefined", "HTTP response status code."),
  symbol("ctx.response.headers", "property", "ctx.response.headers", "Record<string, string>", "Lower-cased response headers."),
  symbol("ctx.response.body", "property", "ctx.response.body", "unknown", "Parsed JSON response body, when valid JSON."),
  symbol("ctx.response.text", "property", "ctx.response.text", "string | undefined", "Raw response text."),
];

const hookOnly = [
  symbol("ctx.request", "property", "ctx.request", "resolved request", "Available only to pre-request hook scripts."),
  ...["method", "url", "headers", "query", "body", "bodyText"].map((name) => symbol(`ctx.request.${name}`, "property", `ctx.request.${name}`, "request field", `Read or rewrite request.${name}.`)),
];

export const SCRIPT_CTX_SCHEMAS: CtxSchema[] = [
  { kind: "assertion", symbols: [...common, ...responseOnly] },
  { kind: "response", symbols: [...common, ...responseOnly] },
  { kind: "hook", symbols: [...common, ...hookOnly] },
  { kind: "node", symbols: common },
];

function symbol(name: string, kind: ScriptCompletionSymbol["kind"], insertText: string, detail: string, documentation: string): ScriptCompletionSymbol {
  return { name, kind, insertText, detail, documentation };
}

type AcornNode = {
  type: string;
  start?: number;
  end?: number;
  id?: { type?: string; name?: string };
  declarations?: Array<{ id?: { type?: string; name?: string }; init?: AcornNode | null }>;
  params?: Array<{ type?: string; name?: string }>;
  [key: string]: unknown;
};

/**
 * A library is declarations only: no call, loop, branch, assignment, or other
 * side effect runs merely because another script selected the library.
 */
export function inspectLibrarySource(source: string): { symbols: ScriptCompletionSymbol[]; error?: string } {
  let program: { body: AcornNode[]; comments?: Array<{ value?: string; end?: number; type?: string }> };
  try {
    const comments: Array<{ value?: string; end?: number; type?: string }> = [];
    program = parse(source, {
      ecmaVersion: "latest", sourceType: "script", locations: true,
      onComment: (block, text, _start, end) => comments.push({ value: text, end, type: block ? "Block" : "Line" }),
    }) as unknown as typeof program;
    program.comments = comments;
  } catch (error) {
    return { symbols: [], error: error instanceof Error ? error.message : "library is not valid JavaScript" };
  }

  const symbols: ScriptCompletionSymbol[] = [];
  for (const statement of program.body) {
    const documentation = precedingDoc(source, statement.start, program.comments) ?? "Declared by this library.";
    if (statement.type === "FunctionDeclaration" && statement.id?.name) {
      const params = parameterNames(statement.params);
      symbols.push(symbol(statement.id.name, "function", `${statement.id.name}(${params.map((name, index) => `\${${index + 1}:${name}}`).join(", ")})`, `function ${statement.id.name}(${params.join(", ")})`, documentation));
      continue;
    }
    if (statement.type === "ClassDeclaration" && statement.id?.name) {
      if (!safeClass(statement)) return { symbols: [], error: `library class "${statement.id.name}" contains an executable static initializer` };
      symbols.push(symbol(statement.id.name, "class", `new ${statement.id.name}()`, `class ${statement.id.name}`, documentation));
      continue;
    }
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations ?? []) {
        if (declaration.id?.type !== "Identifier" || !declaration.id.name) return { symbols: [], error: "library variable declarations must use simple identifiers" };
        const initializer = declaration.init;
        if (!safeInitializer(initializer)) return { symbols: [], error: `library variable "${declaration.id.name}" has an executable initializer; use a side-effect-free expression or function` };
        const callable = initializer?.type === "ArrowFunctionExpression" || initializer?.type === "FunctionExpression";
        const params = callable ? parameterNames(initializer?.params) : [];
        symbols.push(callable
          ? symbol(declaration.id.name, "function", `${declaration.id.name}(${params.map((name, index) => `\${${index + 1}:${name}}`).join(", ")})`, `function ${declaration.id.name}(${params.join(", ")})`, documentation)
          : symbol(declaration.id.name, "constant", declaration.id.name, `constant ${declaration.id.name}`, documentation));
      }
      continue;
    }
    if (statement.type === "EmptyStatement") continue;
    return { symbols: [], error: "library scripts may contain only top-level function, class, and variable declarations" };
  }
  return { symbols };
}

function parameterNames(params: AcornNode["params"]): string[] {
  return (params ?? []).map((param, index) => param.type === "Identifier" && param.name ? param.name : `arg${index + 1}`);
}

function precedingDoc(source: string, start: number | undefined, comments: Array<{ value?: string; end?: number; type?: string }> | undefined) {
  if (start === undefined) return undefined;
  const comment = [...(comments ?? [])].reverse().find((item) => item.type === "Block" && item.end !== undefined && item.end <= start && !source.slice(item.end, start).trim());
  const value = comment?.value?.trim();
  if (!value?.startsWith("*")) return undefined;
  return value.replace(/^\*+/, "").split("\n").map((line) => line.replace(/^\s*\* ?/, "")).join("\n").trim();
}

function safeInitializer(node: AcornNode | null | undefined): boolean {
  if (!node) return true;
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return true;
  if (["Literal", "Identifier"].includes(node.type)) return true;
  if (["CallExpression", "NewExpression", "AssignmentExpression", "UpdateExpression", "AwaitExpression", "YieldExpression", "TaggedTemplateExpression"].includes(node.type)) return false;
  for (const [key, value] of Object.entries(node)) {
    if (["type", "start", "end", "loc"].includes(key) || value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (!value.every((item) => typeof item !== "object" || safeInitializer(item as AcornNode))) return false;
    } else if (typeof value === "object" && !safeInitializer(value as AcornNode)) return false;
  }
  return true;
}

function safeClass(node: AcornNode): boolean {
  const superClass = node.superClass as AcornNode | null | undefined;
  if (!safeInitializer(superClass)) return false;
  const body = node.body as AcornNode | undefined;
  const elements = (body?.body as AcornNode[] | undefined) ?? [];
  for (const element of elements) {
    if (element.type === "StaticBlock") return false;
    if (element.type === "PropertyDefinition" && element.static === true && !safeInitializer(element.value as AcornNode | null | undefined)) return false;
    if (element.computed === true && !safeInitializer(element.key as AcornNode | undefined)) return false;
  }
  return true;
}
