import crypto from "node:crypto";
import vm from "node:vm";

/**
 * Sandbox for user scripts — assertions (计划 4.0.1) and 前置钩子 (P1-2).
 *
 * **What this is and is not.** `node:vm` was chosen over `isolated-vm` for zero
 * native dependencies, and it is not a hard security boundary — a determined
 * script can still reach the host realm through known prototype-chain tricks.
 * The real boundary is the worker process (P1-3): a script that escapes or
 * hangs damages a worker, never the API. This layer's job is to make the
 * obvious paths unavailable and to stop a runaway loop.
 *
 * Three specific hardening choices:
 *
 * 1. **No host object ever enters the context.** Passing `ctx` in directly
 *    would hand the script `ctx.constructor.constructor`, i.e. the host
 *    `Function`, and from there `process`. Instead the payload crosses as a
 *    JSON *string* — a primitive, copied by value — and is parsed inside the
 *    sandbox, so every object the script can touch belongs to the sandbox realm.
 * 2. **`codeGeneration` disabled.** `eval` and `new Function` are the shortest
 *    route to a fresh compiler, and no legitimate assertion needs them.
 * 3. **`console` is defined inside the sandbox**, collecting into a
 *    sandbox-realm array. A host function passed in would leak its own
 *    constructor, which is the same hole as (1).
 *
 * A fresh vm context already lacks `require`, `process`, `Buffer` and the timer
 * functions — those are Node globals, not JavaScript ones, so they never appear
 * unless deliberately injected.
 *
 * ## The one host function, and why it is safe enough
 *
 * Crypto cannot follow rule (1): a signature needs OpenSSL, and re-implementing
 * AES/SM4 in sandbox JS just to avoid a bridge would trade a small, auditable
 * hole for a large, unauditable one. So exactly **one** host function crosses,
 * and it is shaped to leak nothing:
 *
 * - **One JSON string in, one JSON string out.** No host object, array or Error
 *   is ever reachable through it. It never throws — a failure comes back as
 *   `{ error }` and the sandbox-side wrapper raises a *sandbox* `Error`, so even
 *   a stack trace belongs to the sandbox realm.
 * - **Re-prototyped into the sandbox realm.** `Object.setPrototypeOf(fn,
 *   sandboxFunctionPrototype)` makes `fn.constructor` resolve to the sandbox's
 *   `Function`, which `codeGeneration: false` has already disarmed. Without this
 *   the bridge itself would be the escape it was meant to avoid.
 * - **Unreachable after bootstrap.** The wrappers close over it and the global
 *   is deleted, so user code cannot reach the raw bridge to probe it.
 *
 * ## Secrets stay on the host
 *
 * A key may be given as `{ secret: "SIGN_KEY" }` instead of a literal. The
 * sandbox never receives the value — it is resolved here, at the bridge. That
 * keeps a signing key out of `ctx`, out of `console.log`, and therefore out of
 * the stored execution snapshot, while still letting the script sign with it.
 */

/** Long enough for any real assertion or signature, short enough that a hang is not a stall. */
const SCRIPT_TIMEOUT_MS = 1_000;
/** Logs are a debugging aid, not an output channel. */
const MAX_LOG_ENTRIES = 50;
const MAX_LOG_LENGTH = 2_000;
/** Recorded intermediate values (待签原串 etc.). Same budget, separate channel. */
const MAX_DEBUG_ENTRIES = 20;
const MAX_DEBUG_LENGTH = 4_000;
/** `ctx.assert` calls recorded per script. Soft mode can produce a lot of them. */
const MAX_CHECK_ENTRIES = 50;
const MAX_CHECK_LENGTH = 500;
/** A returned context snapshot. Evidence, not a verdict, so it is bounded. */
const MAX_RETURNED_LENGTH = 4_000;
/** Composed source (libraries + body). Guards against a pathological compile. */
const MAX_COMPOSED_SOURCE = 200_000;
/** One crypto call's payload. Signing a 5 MB body is not a thing we support. */
const MAX_CRYPTO_INPUT_BYTES = 1_000_000;

export type ByteEncoding = "utf8" | "hex" | "base64" | "base64url" | "latin1";
const BYTE_ENCODINGS: ByteEncoding[] = ["utf8", "hex", "base64", "base64url", "latin1"];

/**
 * Encodings a digest or ciphertext may be rendered in.
 *
 * Narrower than `ByteEncoding` on purpose: a hash is raw bytes, and asking for
 * it as `utf8` yields mojibake that silently differs from what any other tool
 * produces. Refusing it here turns a wrong signature into a clear message.
 */
export type TextEncoding = "hex" | "base64" | "base64url";
const TEXT_ENCODINGS: TextEncoding[] = ["hex", "base64", "base64url"];

/** A key or IV: a literal, or the *name* of an environment secret. */
export type KeyMaterial = string | { secret: string; encoding?: ByteEncoding } | { value: string; encoding?: ByteEncoding };

/**
 * What a script can read (确认: ctx 包裹, 预留扩展位).
 *
 * `request` is present for hooks and absent for assertions, which is what keeps
 * an assertion from quietly depending on a request shape it cannot influence.
 * `variables` is present for both: an assertion often needs the value an
 * upstream step produced in order to know what to expect, and it writes back
 * with `ctx.setVariable` for the same reason a hook does. Environment variables
 * reach the sandbox already resolved, so anything marked secret is a value the
 * caller decided this script may see — which is why assertion output is masked
 * on the way out (lib/assert.ts).
 */
export type ScriptContext = {
  response?: {
    status?: number;
    headers: Record<string, string>;
    /** Parsed JSON body, or `undefined` when the body was not JSON. */
    body?: unknown;
    /** Raw response text, always present, so non-JSON bodies stay assertable. */
    text?: string;
  };
  /** The fully-resolved request, for a 前置钩子 to inspect and rewrite. */
  request?: HookRequest;
  /** Flow variables visible at this step, values already resolved. */
  variables?: Record<string, unknown>;
};

/**
 * The request a hook sees and may rewrite.
 *
 * This is the request **after** `{{variable}}` resolution and auth injection —
 * the actual bytes about to go out. A signature computed over anything earlier
 * signs a template, which is the single most common way request signing is got
 * wrong.
 */
export type HookRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  /** Parsed body for `json`, absent otherwise. */
  body?: unknown;
  /** The exact serialized body string that would be sent, whatever the type. */
  bodyText?: string;
};

/** A value a script asked to have recorded, e.g. the string it signed. */
export type ScriptDebugEntry = { label: string; value: string };

/**
 * One `ctx.assert(...)` call and how it went.
 *
 * Recorded per call rather than reduced to a single boolean because a script is
 * now allowed to make several checks: "断言脚本失败了" is not actionable, while
 * "第 3 条 expected 200, got 500" is. Passing checks are kept too — a green run
 * that lists what it actually verified is the difference between a real
 * assertion and a script that silently checked nothing.
 */
export type ScriptCheck = { label: string; passed: boolean; message?: string };

export type ScriptOutcome = {
  passed: boolean;
  /** Thrown message, timeout, or a shape complaint. Surfaced to the user. */
  error?: string;
  /** `console.log` output, in order. */
  logs: string[];
  /** `ctx.debug(...)` output, in order. */
  debug: ScriptDebugEntry[];
  /** Every `ctx.assert(...)` call, in order. Empty when the script asserted nothing. */
  checks: ScriptCheck[];
  /**
   * What the script returned, rendered as text.
   *
   * Evidence only (用户确认: return 是上下文内容, 不作为校验结果). A script that
   * returns `false` and asserts nothing still passes, so this value must never
   * be folded into the verdict.
   */
  returned?: string;
  /** Values written with `ctx.setVariable`, for the caller's variable bag. */
  variables: Record<string, string>;
};

/** What a 前置钩子 produced. `ok: false` leaves the request untouched. */
export type HookOutcome = {
  ok: boolean;
  error?: string;
  logs: string[];
  debug: ScriptDebugEntry[];
  /**
   * `ctx.assert(...)` calls a hook made, in order.
   *
   * The same API as an assertion script, on purpose: a signing hook that wants
   * to check its inputs are present before signing should not have to learn a
   * second idiom, and a failed check there must abort the request rather than
   * send something the script already knew was wrong.
   */
  checks: ScriptCheck[];
  /** The rewritten request, present only when `ok`. */
  request?: HookRequest;
  /** Variables the hook wrote back, for the flow bag. */
  variables: Record<string, string>;
};

/** What a 脚本节点 produced (P2-2). `ok: false` fails the step. */
export type ScriptNodeOutcome = {
  ok: boolean;
  error?: string;
  logs: string[];
  debug: ScriptDebugEntry[];
  /** `ctx.assert(...)` calls the script made, in order. */
  checks: ScriptCheck[];
  /** The returned value rendered as text, for the record. */
  returned?: string;
  /** Values for the flow bag: returned object merged with `ctx.setVariable`. */
  variables: Record<string, string>;
};

/** What a post-response script produced (P2-2.1). */
export type ResponseScriptOutcome = {
  ok: boolean;
  error?: string;
  logs: string[];
  debug: ScriptDebugEntry[];
  checks: ScriptCheck[];
  returned?: string;
  /** Returned object merged with explicit ctx.setVariable writes. */
  variables: Record<string, string>;
};

/** Resolves `{ secret: "NAME" }` key material. Never enters the sandbox. */
export type SecretResolver = (name: string) => string | undefined;

/* ------------------------------------------------------------------ *
 * The crypto bridge (host side)
 * ------------------------------------------------------------------ */

type BridgeRequest = Record<string, unknown>;

function encodingOf(value: unknown, fallback: ByteEncoding): ByteEncoding {
  if (value === undefined) return fallback;
  const encoding = String(value) as ByteEncoding;
  if (!BYTE_ENCODINGS.includes(encoding)) throw new Error(`unsupported encoding "${encoding}"; use ${BYTE_ENCODINGS.join(", ")}`);
  return encoding;
}

/**
 * Same, for values that are raw bytes rendered as text (digests, MACs,
 * ciphertext, signatures). `utf8` and `latin1` are rejected rather than
 * tolerated: they turn arbitrary bytes into replacement characters, so the
 * script would receive a string that cannot round-trip and matches no other
 * implementation. Failing loudly here is the difference between "the platform
 * signs differently than curl" and a one-line error naming the encoding.
 */
function textEncodingOf(value: unknown, fallback: TextEncoding): TextEncoding {
  if (value === undefined) return fallback;
  const encoding = String(value) as TextEncoding;
  if (!TEXT_ENCODINGS.includes(encoding)) {
    throw new Error(`unsupported output encoding "${encoding}"; digests and ciphertext use ${TEXT_ENCODINGS.join(", ")}`);
  }
  return encoding;
}

function toBuffer(value: unknown, encoding: ByteEncoding, what: string): Buffer {
  if (typeof value !== "string") throw new Error(`${what} must be a string`);
  const buffer = Buffer.from(value, encoding);
  if (buffer.byteLength > MAX_CRYPTO_INPUT_BYTES) throw new Error(`${what} exceeds ${MAX_CRYPTO_INPUT_BYTES} bytes`);
  return buffer;
}

/**
 * Key material, resolved host-side.
 *
 * `{ secret: "NAME" }` is the recommended form precisely because the value never
 * crosses into the sandbox and therefore cannot end up in a log, a debug record
 * or a stored snapshot.
 */
function toKey(value: unknown, resolveSecret: SecretResolver, what: string): Buffer {
  if (typeof value === "string") return toBuffer(value, "utf8", what);
  if (value && typeof value === "object") {
    const spec = value as { secret?: unknown; value?: unknown; encoding?: unknown };
    const encoding = encodingOf(spec.encoding, "utf8");
    if (spec.secret !== undefined) {
      const name = String(spec.secret);
      const secret = resolveSecret(name);
      /* Distinguished from a wrong key on purpose: "the environment has no such
         secret" and "the signature is wrong" have completely different fixes. */
      if (secret === undefined) throw new Error(`no secret named "${name}" in this environment`);
      return toBuffer(secret, encoding, what);
    }
    if (spec.value !== undefined) return toBuffer(spec.value, encoding, what);
  }
  throw new Error(`${what} must be a string, { secret: "NAME" } or { value, encoding }`);
}

/**
 * Every crypto operation, behind one entry point.
 *
 * Algorithms are validated against **OpenSSL's own catalog** rather than a list
 * hand-picked here. A closed list is what makes a platform unable to sign the
 * one variant a team actually uses; `crypto.getHashes()` / `getCiphers()`
 * already knows about sm3, sm4-cbc, aes-256-gcm and everything else this build
 * supports, so the answer to "does it do X" stops depending on what we guessed.
 */
function bridge(request: BridgeRequest, resolveSecret: SecretResolver): unknown {
  const op = String(request.op ?? "");
  const inputEncoding = encodingOf(request.inputEncoding, "utf8");
  const outputEncoding = textEncodingOf(request.outputEncoding, "hex");

  switch (op) {
    case "hash": {
      const algorithm = String(request.algorithm ?? "").toLowerCase();
      if (!crypto.getHashes().includes(algorithm)) throw new Error(`unsupported hash "${algorithm}"`);
      return crypto.createHash(algorithm).update(toBuffer(request.data, inputEncoding, "data")).digest(outputEncoding);
    }
    case "hmac": {
      const algorithm = String(request.algorithm ?? "").toLowerCase();
      if (!crypto.getHashes().includes(algorithm)) throw new Error(`unsupported hash "${algorithm}"`);
      return crypto.createHmac(algorithm, toKey(request.key, resolveSecret, "key"))
        .update(toBuffer(request.data, inputEncoding, "data")).digest(outputEncoding);
    }
    case "encrypt":
    case "decrypt": {
      const algorithm = String(request.algorithm ?? "").toLowerCase();
      if (!crypto.getCiphers().includes(algorithm)) throw new Error(`unsupported cipher "${algorithm}"`);
      const key = toKey(request.key, resolveSecret, "key");
      /* ECB takes no IV; every other mode does, and a silently-zero IV would
         produce a signature that looks right and verifies nowhere. */
      const iv = request.iv === undefined ? null : toKey(request.iv, resolveSecret, "iv");
      const aad = request.aad === undefined ? undefined : toBuffer(request.aad, encodingOf(request.aadEncoding, "utf8"), "aad");
      const authTagLength = request.authTagLength === undefined ? undefined : Number(request.authTagLength);
      /* Held in a typed variable rather than passed as a literal: `algorithm` is a
         plain string, so TS resolves the generic `TransformOptions` overload of
         createCipheriv, and a fresh literal carrying authTagLength trips excess
         property checking. A named CipherCCMOptions is a structural subtype and
         passes. Only CCM/OCB/GCM read it; other modes ignore it. */
      const cipherOptions: crypto.CipherCCMOptions | undefined = authTagLength ? { authTagLength } : undefined;

      if (op === "encrypt") {
        const cipher = crypto.createCipheriv(algorithm, key, iv, cipherOptions);
        if (request.padding === false) cipher.setAutoPadding(false);
        if (aad) (cipher as crypto.CipherGCM).setAAD(aad);
        const data = toBuffer(request.data, inputEncoding, "data");
        const out = Buffer.concat([cipher.update(data), cipher.final()]);
        let authTag: string | undefined;
        try { authTag = (cipher as crypto.CipherGCM).getAuthTag().toString(outputEncoding); } catch { /* not an AEAD mode */ }
        return authTag === undefined ? out.toString(outputEncoding) : { data: out.toString(outputEncoding), authTag };
      }

      const decipher = crypto.createDecipheriv(algorithm, key, iv, cipherOptions);
      if (request.padding === false) decipher.setAutoPadding(false);
      if (aad) (decipher as crypto.DecipherGCM).setAAD(aad);
      if (request.authTag !== undefined) {
        (decipher as crypto.DecipherGCM).setAuthTag(toBuffer(request.authTag, encodingOf(request.authTagEncoding, outputEncoding), "authTag"));
      }
      const data = toBuffer(request.data, inputEncoding, "data");
      return Buffer.concat([decipher.update(data), decipher.final()]).toString(encodingOf(request.outputEncoding, "utf8"));
    }
    case "sign": {
      /* RSA / ECDSA: the private key is PEM, so `{ secret }` is the only sane
         way to hold one — a PEM pasted into a script body would be committed
         into the flow document and shown in every snapshot. */
      const algorithm = String(request.algorithm ?? "").toLowerCase();
      if (!crypto.getHashes().includes(algorithm)) throw new Error(`unsupported hash "${algorithm}"`);
      const key = toKey(request.key, resolveSecret, "key").toString("utf8");
      const signer = crypto.createSign(algorithm);
      signer.update(toBuffer(request.data, inputEncoding, "data"));
      return signer.sign({ key, passphrase: request.passphrase === undefined ? undefined : String(request.passphrase) }, outputEncoding);
    }
    case "encode":
      /* Pure re-encoding: base64 → hex, utf8 → base64url, and so on. */
      return toBuffer(request.data, inputEncoding, "data").toString(outputEncoding);
    case "xor": {
      /* Byte-level composition. Present because "AES, but xor a nonce in first"
         is exactly the kind of house rule a fixed signing helper cannot express. */
      const left = toBuffer(request.data, inputEncoding, "data");
      const right = toBuffer(request.with, encodingOf(request.withEncoding, inputEncoding), "with");
      if (!right.byteLength) throw new Error("xor needs at least one byte to combine with");
      const out = Buffer.allocUnsafe(left.byteLength);
      /* Repeating key xor: equal lengths are the common case, and a shorter
         operand cycling is the documented behaviour rather than a truncation. */
      for (let index = 0; index < left.byteLength; index += 1) out[index] = left[index] ^ right[index % right.byteLength];
      return out.toString(outputEncoding);
    }
    case "randomBytes": {
      const size = Math.min(Math.max(Math.floor(Number(request.size ?? 16)), 1), 1024);
      return crypto.randomBytes(size).toString(outputEncoding);
    }
    case "uuid":
      return crypto.randomUUID();
    case "algorithms":
      return { hashes: crypto.getHashes(), ciphers: crypto.getCiphers() };
    default:
      throw new Error(`unknown crypto operation "${op}"`);
  }
}

/* ------------------------------------------------------------------ *
 * Sandbox-side prelude
 * ------------------------------------------------------------------ */

/**
 * The wrappers user code actually calls.
 *
 * Written as sandbox source rather than injected objects so that every function
 * on `ctx` belongs to the sandbox realm; the bridge is captured in a closure and
 * its global deleted, so `__native` is not reachable from user code.
 */
const PRELUDE = `
  "use strict";
  (function () {
    var native = globalThis.__native;
    delete globalThis.__native;
    var payload = globalThis.__payload;
    delete globalThis.__payload;

    var logs = [];
    var debugEntries = [];
    /* Every ctx.assert call, and how many of them failed. The count is what the
       host reads for its verdict — in soft mode nothing throws, so the absence
       of an error cannot mean "passed" on its own. */
    var checks = [];
    var failedChecks = 0;
    /* Whether the last throw came out of record() (hard mode). Lets the host
       tell "an assertion failed" from "the script itself threw", so it can
       suppress a message that would merely repeat the check's own line. */
    var assertThrew = false;

    function stringify(value) {
      try { return typeof value === "string" ? value : JSON.stringify(value); }
      catch (error) { return String(value); }
    }

    globalThis.console = Object.freeze({
      log: function () {
        if (logs.length >= ${MAX_LOG_ENTRIES}) return;
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(stringify(arguments[i]));
        logs.push(parts.join(" ").slice(0, ${MAX_LOG_LENGTH}));
      },
    });

    /* One call, one JSON round trip. A failure comes back as data and is raised
       here as a sandbox Error, so no host Error object is ever reachable. */
    function call(request) {
      var answer = JSON.parse(native(JSON.stringify(request)));
      if (answer && answer.error) throw new Error(answer.error);
      return answer.result;
    }

    function hash(algorithm, data, options) {
      var o = options || {};
      return call({ op: "hash", algorithm: algorithm, data: data, inputEncoding: o.inputEncoding, outputEncoding: o.outputEncoding });
    }
    function named(algorithm) {
      return function (data, options) { return hash(algorithm, data, options); };
    }

    var crypto = Object.freeze({
      hash: hash,
      md5: named("md5"),
      sha1: named("sha1"),
      sha256: named("sha256"),
      sha512: named("sha512"),
      /* Available when this Node's OpenSSL provides it; the bridge validates. */
      sm3: named("sm3"),
      hmac: function (algorithm, data, key, options) {
        var o = options || {};
        return call({ op: "hmac", algorithm: algorithm, data: data, key: key, inputEncoding: o.inputEncoding, outputEncoding: o.outputEncoding });
      },
      encrypt: function (algorithm, data, options) {
        var o = options || {};
        return call({ op: "encrypt", algorithm: algorithm, data: data, key: o.key, iv: o.iv, aad: o.aad, aadEncoding: o.aadEncoding,
          authTagLength: o.authTagLength, padding: o.padding, inputEncoding: o.inputEncoding, outputEncoding: o.outputEncoding });
      },
      decrypt: function (algorithm, data, options) {
        var o = options || {};
        return call({ op: "decrypt", algorithm: algorithm, data: data, key: o.key, iv: o.iv, aad: o.aad, aadEncoding: o.aadEncoding,
          authTag: o.authTag, authTagEncoding: o.authTagEncoding, authTagLength: o.authTagLength, padding: o.padding,
          inputEncoding: o.inputEncoding, outputEncoding: o.outputEncoding });
      },
      sign: function (algorithm, data, options) {
        var o = options || {};
        return call({ op: "sign", algorithm: algorithm, data: data, key: o.key, passphrase: o.passphrase,
          inputEncoding: o.inputEncoding, outputEncoding: o.outputEncoding });
      },
      randomBytes: function (size, encoding) { return call({ op: "randomBytes", size: size, outputEncoding: encoding }); },
      uuid: function () { return call({ op: "uuid" }); },
      algorithms: function () { return call({ op: "algorithms" }); },
    });

    var encoding = Object.freeze({
      convert: function (data, from, to) { return call({ op: "encode", data: data, inputEncoding: from, outputEncoding: to }); },
      base64Encode: function (data, from) { return call({ op: "encode", data: data, inputEncoding: from || "utf8", outputEncoding: "base64" }); },
      base64Decode: function (data, to) { return call({ op: "encode", data: data, inputEncoding: "base64", outputEncoding: to || "utf8" }); },
      hexEncode: function (data, from) { return call({ op: "encode", data: data, inputEncoding: from || "utf8", outputEncoding: "hex" }); },
      hexDecode: function (data, to) { return call({ op: "encode", data: data, inputEncoding: "hex", outputEncoding: to || "utf8" }); },
      urlEncode: function (data) { return encodeURIComponent(String(data)); },
      xor: function (data, other, options) {
        var o = options || {};
        return call({ op: "xor", data: data, with: other, inputEncoding: o.inputEncoding, withEncoding: o.withEncoding, outputEncoding: o.outputEncoding });
      },
    });

    var written = {};
    var ctx = JSON.parse(payload);
    ctx.crypto = crypto;
    ctx.encoding = encoding;
    /* Recording the string that was signed is the difference between fixing a
       signature in one minute and guessing at key, order, encoding and case. */
    ctx.debug = function (label, value) {
      if (debugEntries.length >= ${MAX_DEBUG_ENTRIES}) return;
      debugEntries.push({ label: String(label).slice(0, 120), value: stringify(value === undefined ? "" : value).slice(0, ${MAX_DEBUG_LENGTH}) });
    };
    ctx.setVariable = function (name, value) { written[String(name)] = stringify(value); };

    /* ---------------------------------------------------------------- *
     * ctx.assert — assert in place instead of returning a verdict
     * ---------------------------------------------------------------- *
     *
     * A failed check throws by default, which is what makes the idiom read like
     * every other test framework: the line after a failed assert does not run.
     * The throw is caught by the wrapper below, so a failure arrives at the host
     * as an ordinary script error and needs no second reporting channel.
     *
     * ctx.assert.soft = true switches to collect-and-continue (用户确认:
     * 可选, 在脚本内设参数). Both modes record every call into checks, so a
     * hard-mode failure still shows which checks had already passed before it.
     */
    function record(label, passed, message) {
      if (checks.length < ${MAX_CHECK_ENTRIES}) {
        /* A passing check carries no message: the failure text reads "expected
           200, got 200" when it passed, which looks like a bug report on a green
           line. The label alone says what was checked. */
        checks.push({ label: String(label).slice(0, ${MAX_CHECK_LENGTH}), passed: passed, message: passed || message === undefined ? undefined : String(message).slice(0, ${MAX_CHECK_LENGTH}) });
      }
      if (passed) return;
      failedChecks += 1;
      /* Soft mode swallows the throw so the rest of the script runs; the host
         still fails the assertion because failedChecks is non-zero.
         The prefix is deliberate: without it "expected 200, got 500" is
         indistinguishable from a TypeError the script caused itself, and those
         two need completely different fixes. */
      if (!assert.soft) {
        assertThrew = true;
        throw new Error("assertion failed: " + message);
      }
    }

    /* Mirrors the host comparator (lib/assert.ts compare): two numeric operands
       compare as numbers, so the string "200" a header yields and the number 200
       a script types are the same value. Anything else compares as text. */
    function same(actual, expected) {
      if (actual === expected) return true;
      var left = stringify(actual);
      var right = stringify(expected);
      if (left === undefined || right === undefined) return false;
      if (left.trim() === "" || right.trim() === "") return left === right;
      if (isNaN(Number(left)) || isNaN(Number(right))) return left === right;
      return Number(left) === Number(right);
    }
    function show(value) {
      var text = stringify(value);
      return text === undefined ? String(value) : text;
    }

    function assert(condition, message) {
      record(message === undefined ? "assert" : message, Boolean(condition), message === undefined ? "assertion failed" : message);
    }
    /* Off by default: a script that makes one check reads better when the first
       failure stops it, and the flag is opt-in per script. */
    assert.soft = false;
    assert.ok = assert;
    assert.isTrue = function (value, message) {
      record(message === undefined ? "isTrue " + show(value) : message, value === true || Boolean(value), message === undefined ? "expected a truthy value, got " + show(value) : message);
    };
    assert.isFalse = function (value, message) {
      record(message === undefined ? "isFalse " + show(value) : message, !value, message === undefined ? "expected a falsy value, got " + show(value) : message);
    };
    assert.equal = function (actual, expected, message) {
      record(message === undefined ? "equal " + show(expected) : message, same(actual, expected), message === undefined ? "expected " + show(expected) + ", got " + show(actual) : message);
    };
    assert.notEqual = function (actual, expected, message) {
      record(message === undefined ? "notEqual " + show(expected) : message, !same(actual, expected), message === undefined ? "did not expect " + show(actual) : message);
    };
    assert.contains = function (container, part, message) {
      var haystack = show(container);
      var needle = show(part);
      record(message === undefined ? "contains " + needle : message, haystack.indexOf(needle) !== -1, message === undefined ? "expected " + haystack + " to contain " + needle : message);
    };
    assert.exists = function (value, message) {
      record(message === undefined ? "exists" : message, value !== undefined && value !== null, message === undefined ? "expected a value, got " + show(value) : message);
    };
    assert.notExists = function (value, message) {
      record(message === undefined ? "notExists" : message, value === undefined || value === null, message === undefined ? "expected no value, got " + show(value) : message);
    };
    assert.greaterThan = function (actual, expected, message) {
      record(message === undefined ? "greaterThan " + show(expected) : message, Number(actual) > Number(expected), message === undefined ? "expected " + show(actual) + " > " + show(expected) : message);
    };
    assert.lessThan = function (actual, expected, message) {
      record(message === undefined ? "lessThan " + show(expected) : message, Number(actual) < Number(expected), message === undefined ? "expected " + show(actual) + " < " + show(expected) : message);
    };
    /* Fail on purpose, for a branch the script decided is invalid. */
    assert.fail = function (message) {
      record(message === undefined ? "fail" : message, false, message === undefined ? "assert.fail()" : message);
    };
    ctx.assert = assert;

    globalThis.__ctx = ctx;
    globalThis.__finish = function (result, error) {
      /* Serialized inside the sandbox: the host receives a string, never a
         sandbox object, so the no-object rule holds in both directions. */
      return JSON.stringify({
        result: result === undefined ? null : result,
        hasResult: result !== undefined,
        isPromise: Boolean(result && typeof result.then === "function"),
        /* Rendered here rather than host-side: the host must not touch a sandbox
           object, and a returned value is now evidence, not a verdict. */
        returned: result === undefined ? null : stringify(result).slice(0, ${MAX_RETURNED_LENGTH}),
        request: ctx.request === undefined ? null : ctx.request,
        variables: written,
        logs: logs,
        debug: debugEntries,
        checks: checks,
        failedChecks: failedChecks,
        soft: Boolean(assert.soft),
        assertThrew: assertThrew,
        error: error === undefined ? null : String(error),
      });
    };
  })();
`;

type SandboxRun = {
  ok: boolean;
  error?: string;
  logs: string[];
  debug: ScriptDebugEntry[];
  /** Every `ctx.assert(...)` call the script made, in order. */
  checks: ScriptCheck[];
  /** How many of them failed. The verdict for an assertion script. */
  failedChecks: number;
  /** Whether the script opted into soft mode with `ctx.assert.soft = true`. */
  soft: boolean;
  /** Whether the (first) error was an assertion throw rather than script code. */
  assertThrew: boolean;
  hasResult: boolean;
  result: unknown;
  /** The returned value rendered as text, for the record. Never a verdict. */
  returned?: string;
  isPromise: boolean;
  request: HookRequest | null;
  variables: Record<string, string>;
};

/**
 * Compiles and runs one composed script body, returning only primitives.
 *
 * Libraries are prepended **inside the same function body**, so their `function`
 * and `const` declarations are ordinary locals the main script can see. That is
 * what makes a shared SM4 implementation reusable without copying it into every
 * script that needs it.
 */
function runInSandbox(source: string, libraries: string[], ctx: ScriptContext, resolveSecret: SecretResolver): SandboxRun {
  const empty: SandboxRun = {
    ok: false, logs: [], debug: [], checks: [], failedChecks: 0, soft: false, assertThrew: false,
    hasResult: false, result: undefined, isPromise: false, request: null, variables: {},
  };
  if (!source.trim()) return { ...empty, error: "script is empty" };

  const composed = [...libraries.filter((library) => library.trim()), source].join("\n;\n");
  if (composed.length > MAX_COMPOSED_SOURCE) {
    return { ...empty, error: `the script and its libraries exceed ${MAX_COMPOSED_SOURCE} characters combined` };
  }

  /* Object.create(null): no inherited prototype to walk back out of. */
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const globals = context as Record<string, unknown>;

  try {
    /**
     * The bridge is re-prototyped into the sandbox realm *before* it is exposed.
     * Skipping this step would make `ctx.crypto.md5.constructor` the host
     * `Function` — the exact escape the JSON-string payload exists to avoid.
     */
    new vm.Script(`globalThis.__fnProto = Object.getPrototypeOf(function () {});`).runInContext(context, { timeout: SCRIPT_TIMEOUT_MS });
    const sandboxFunctionPrototype = globals.__fnProto as object;
    delete globals.__fnProto;

    const native = (requestJson: string): string => {
      try {
        const result = bridge(JSON.parse(requestJson) as BridgeRequest, resolveSecret);
        return JSON.stringify({ result });
      } catch (error) {
        /* Errors cross as data. A thrown host Error would put a host object —
           and its constructor — in the script's hands. */
        return JSON.stringify({ error: error instanceof Error ? error.message : "crypto call failed" });
      }
    };
    Object.setPrototypeOf(native, sandboxFunctionPrototype);

    globals.__native = native;
    globals.__payload = safeStringify(ctx);
    new vm.Script(PRELUDE).runInContext(context, { timeout: SCRIPT_TIMEOUT_MS });

    /**
     * `ctx` is bound as a parameter rather than read off the global so a script
     * that assigns to `ctx` cannot corrupt anything read afterwards.
     */
    const wrapped = new vm.Script(`
      "use strict";
      globalThis.__out = (function (ctx) {
        try {
          return globalThis.__finish((function () {
${composed}
          })());
        } catch (error) {
          return globalThis.__finish(undefined, (error && error.message) || error);
        }
      })(globalThis.__ctx);
    `);
    wrapped.runInContext(context, { timeout: SCRIPT_TIMEOUT_MS });

    const parsed = JSON.parse(String(globals.__out)) as {
      result: unknown; hasResult: boolean; isPromise: boolean; returned: string | null;
      request: HookRequest | null; variables: Record<string, string>;
      logs: string[]; debug: ScriptDebugEntry[];
      checks: ScriptCheck[]; failedChecks: number; soft: boolean; assertThrew: boolean;
      error: string | null;
    };
    return {
      ok: !parsed.error,
      error: parsed.error ?? undefined,
      logs: parsed.logs.map(String),
      debug: parsed.debug.map((entry) => ({ label: String(entry.label), value: String(entry.value) })),
      checks: (parsed.checks ?? []).map((check) => ({
        label: String(check.label), passed: Boolean(check.passed),
        message: check.message === undefined || check.message === null ? undefined : String(check.message),
      })),
      failedChecks: Number(parsed.failedChecks ?? 0),
      soft: Boolean(parsed.soft),
      assertThrew: Boolean(parsed.assertThrew),
      hasResult: parsed.hasResult,
      result: parsed.result,
      returned: parsed.returned ?? undefined,
      isPromise: parsed.isPromise,
      request: parsed.request,
      variables: parsed.variables ?? {},
    };
  } catch (error) {
    /* A timeout surfaces as a plain Error whose message names the budget, which
       is not obvious to a user staring at their own code. */
    const message = error instanceof Error ? error.message : "script failed";
    const timedOut = message.includes("Script execution timed out");
    return { ...empty, error: timedOut ? `script exceeded the ${SCRIPT_TIMEOUT_MS}ms time limit` : message };
  }
}

/**
 * Runs a user script body and reduces it to a verdict.
 *
 * ## The contract (用户确认)
 *
 * A script **asserts in place** with `ctx.assert(...)`; it does not report by
 * returning. Three consequences, in the order they matter:
 *
 * 1. **A failed `ctx.assert` fails the assertion.** In hard mode it throws and
 *    the script stops; in soft mode (`ctx.assert.soft = true`) it is recorded and
 *    the script continues, and `failedChecks` is what fails the run. The absence
 *    of a thrown error cannot be the pass condition on its own, which is exactly
 *    why the count crosses the boundary.
 * 2. **No assert and no error means pass.** A script that just runs to the end is
 *    a script that found nothing wrong. Demanding a `return` or an assert would
 *    only reintroduce the ceremony this change removes.
 * 3. **`return` is evidence, never a verdict.** The returned value is recorded as
 *    context and deliberately ignored when judging, so `return false` in a script
 *    that asserts nothing still passes.
 *
 * This makes every pre-existing script that reported via `return` a no-op check
 * (用户确认: 存量脚本允许全部失效) — they now pass unconditionally until they are
 * rewritten with `ctx.assert`.
 *
 * A promise is rejected outright rather than awaited: assertion evaluation is
 * synchronous and sits on the write path that settles an execution, so
 * introducing an await point here would mean a run could not reach a terminal
 * state in one write.
 */
export function runScriptAssertion(source: string, ctx: ScriptContext, libraries: string[] = [], resolveSecret: SecretResolver = () => undefined): ScriptOutcome {
  const run = runInSandbox(source, libraries, ctx, resolveSecret);
  const base = { logs: run.logs, debug: run.debug, checks: run.checks, returned: run.returned, variables: run.variables };
  if (run.isPromise) return { passed: false, error: "script must run synchronously; async assertions are not supported", ...base };
  /* An error that came out of an assertion throw carries no message of its own:
     the check that failed is already recorded on `checks`, line by line, and a
     summary would print the same "expected 200, got 500" a second time (用户
    反馈: 太啰嗦). A real script error — TypeError, timeout, missing content —
     still gets one, because nothing in `checks` explains it. */
  if (run.error && !run.assertThrew) return { passed: false, error: run.error, ...base };
  return { passed: run.failedChecks === 0, ...base };
}

/**
 * Runs a request node's response script (P2-2.1).
 *
 * It has the assertion script's response context and the script node's output
 * semantics: ctx.assert decides whether it passes, while both a returned plain
 * object and ctx.setVariable propose writes to the node-local variable bag.
 */
export function runResponseScript(source: string, ctx: ScriptContext, libraries: string[] = [], resolveSecret: SecretResolver = () => undefined): ResponseScriptOutcome {
  const run = runInSandbox(source, libraries, ctx, resolveSecret);
  const base = { logs: run.logs, debug: run.debug, checks: run.checks, returned: run.returned };
  if (run.isPromise) return { ok: false, error: "a response script must run synchronously; async response scripts are not supported", ...base, variables: {} };
  if (run.error && !run.assertThrew) return { ok: false, error: run.error, ...base, variables: {} };
  if (run.failedChecks > 0) return { ok: false, error: `${run.failedChecks} of ${run.checks.length} checks failed`, ...base, variables: {} };

  const merged: Record<string, string> = { ...run.variables };
  if (run.hasResult && run.result !== null) {
    if (typeof run.result !== "object" || Array.isArray(run.result)) {
      return { ok: false, error: "a response script must return nothing, or a plain object of variables", ...base, variables: {} };
    }
    for (const [key, value] of Object.entries(run.result as Record<string, unknown>)) {
      if (!(key in merged)) merged[key] = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
    }
  }
  return { ok: true, ...base, variables: merged };
}

/**
 * Runs a 前置钩子 and returns the request it wants sent (P1-2).
 *
 * The hook mutates `ctx.request` in place — `ctx.request.headers.sign = ...` is
 * the whole idiom — and may also `return` an object that is merged on top, which
 * is the shorter form for the common "add one header" case. Both exist because
 * mutation reads naturally for multi-step signing while a return value reads
 * naturally for a one-liner, and refusing one of them would only invite people
 * to fight the API.
 *
 * A failing hook does **not** silently send the unsigned request: the caller
 * turns `ok: false` into a failed execution. Sending an unsigned request would
 * produce a confusing 401 from the target instead of the real error, which is
 * the script's.
 */
export function runScriptHook(source: string, request: HookRequest, options: {
  variables?: Record<string, unknown>;
  libraries?: string[];
  resolveSecret?: SecretResolver;
} = {}): HookOutcome {
  const run = runInSandbox(
    source,
    options.libraries ?? [],
    { request, variables: options.variables ?? {} },
    options.resolveSecret ?? (() => undefined),
  );

  const base = { logs: run.logs, debug: run.debug, checks: run.checks, variables: run.variables };
  if (run.isPromise) return { ok: false, error: "a hook must run synchronously; async hooks are not supported", ...base };
  /* Same rule as an assertion script: an assertion-throw needs no repeating
     message (its check is on `checks`), while a real script error does. */
  if (run.error && !run.assertThrew) return { ok: false, error: run.error, ...base };
  /* Soft-mode checks reach here without having thrown; a hook whose own
     preconditions failed must not sign and send anyway. The error is a bare
     count — run.ts folds it into the execution's top-level message, where the
     per-check detail would be out of context. */
  if (run.failedChecks > 0) {
    return { ok: false, error: `${run.failedChecks} of ${run.checks.length} checks failed`, ...base };
  }

  /* Start from what the script mutated, then layer the returned patch. */
  const next: HookRequest = run.request ? { ...request, ...run.request } : { ...request };
  if (run.hasResult && run.result !== null) {
    if (typeof run.result !== "object" || Array.isArray(run.result)) {
      return { ok: false, error: "a hook must return nothing, or an object such as { headers: { ... } }", ...base };
    }
    const patch = run.result as Partial<HookRequest>;
    /* Headers and query merge; a returned patch adds a signature rather than
       replacing every header the request already had. */
    if (patch.headers) next.headers = { ...next.headers, ...patch.headers };
    if (patch.query) next.query = { ...next.query, ...patch.query };
    if (patch.url !== undefined) next.url = String(patch.url);
    if (patch.method !== undefined) next.method = String(patch.method).toUpperCase();
    if ("body" in patch) next.body = patch.body;
    if (patch.bodyText !== undefined) next.bodyText = String(patch.bodyText);
  }

  const invalid = validateHookRequest(next);
  if (invalid) return { ok: false, error: invalid, ...base };
  return { ok: true, request: next, ...base };
}

/**
 * Runs a 脚本节点 (P2-2): a computation step over the variable bag.
 *
 * `ctx.variables` is a copy of the bag at this point; writes go through
 * `ctx.setVariable`, and a returned plain object is also merged into the bag.
 * The verdict uses the same sandbox contract as an assertion: a thrown error or
 * a failed `ctx.assert` fails the step, a clean run succeeds. `return` is
 * evidence *and* a write channel here — unlike an assertion, where it is
 * evidence only — because producing values is the entire purpose of this node.
 */
export function runScriptNode(source: string, options: {
  variables?: Record<string, unknown>;
  libraries?: string[];
  resolveSecret?: SecretResolver;
} = {}): ScriptNodeOutcome {
  const run = runInSandbox(
    source,
    options.libraries ?? [],
    { variables: options.variables ?? {} },
    options.resolveSecret ?? (() => undefined),
  );

  const base = { logs: run.logs, debug: run.debug, checks: run.checks, returned: run.returned };
  if (run.isPromise) return { ok: false, error: "a script node must run synchronously; async script nodes are not supported", ...base, variables: {} };
  if (run.error && !run.assertThrew) return { ok: false, error: run.error, ...base, variables: {} };
  if (run.failedChecks > 0) return { ok: false, error: `${run.failedChecks} of ${run.checks.length} checks failed`, ...base, variables: {} };

  /* Returned object merged first, explicit writes win — setVariable is the
     deliberate channel, a return value the convenience one. */
  let merged: Record<string, string> = { ...run.variables };
  if (run.hasResult && run.result !== null) {
    if (typeof run.result !== "object" || Array.isArray(run.result)) {
      return { ok: false, error: "a script node must return nothing, or a plain object of variables", ...base, variables: {} };
    }
    for (const [key, value] of Object.entries(run.result as Record<string, unknown>)) {
      if (!(key in merged)) merged[key] = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
    }
  }
  return { ok: true, ...base, variables: merged };
}

/**
 * A hook can write anything into the request, so the result is checked before it
 * reaches `fetch`. A script that sets `headers` to a string would otherwise fail
 * deep inside the transport with a message about neither the script nor the hook.
 */
function validateHookRequest(request: HookRequest): string | undefined {
  if (!request.url || typeof request.url !== "string") return "the hook left the request without a url";
  if (!/^https?:\/\//i.test(request.url)) return `the hook set a url that is not http(s): ${request.url.slice(0, 120)}`;
  for (const field of ["headers", "query"] as const) {
    const value = request[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) return `the hook set request.${field} to something that is not an object`;
    for (const [key, item] of Object.entries(value)) {
      /* Objects and arrays stringify to "[object Object]" in a header, which is
         a bug that reads like a server problem. Catch it here instead. */
      if (item !== null && typeof item === "object") return `request.${field}["${key}"] must be a string`;
    }
  }
  return undefined;
}

/** Circular structures come from parsed bodies, not from our own wrapper. */
function safeStringify(ctx: ScriptContext): string {
  try {
    return JSON.stringify(ctx) ?? "{}";
  } catch {
    return JSON.stringify({ ...ctx, response: ctx.response ? { ...ctx.response, body: undefined } : undefined, request: ctx.request }) ?? "{}";
  }
}
