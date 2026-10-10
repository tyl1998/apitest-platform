import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * 来源取数的安全出站通道（P17 边界 7）。
 *
 * 接口来源让管理员贴一条 URL，平台就去 GET 它——这是一条**把请求发到任意地址**的
 * 能力，必须收口：仅 http(s)、禁内网段与云元数据地址 `169.254.169.254`、超时 +
 * 体积上限。防线放在这里而不是各驱动里，是让「不管哪个来源类型都不能打内网」成为
 * 通道的属性，而不是每个驱动各写一遍、漏一个就破一个。
 *
 * 与 Runner 侧（`apitest-runner/src/executor/container/network.ts`）同一类威胁：那段
 * 代码在宿主 iptables 上封 deny CIDR，这里在进程内先判地址——平台自己出站没有
 * iptables 可用，只能在发出前把非公网目标拦下。
 *
 * 重定向单独跟：`fetch` 默认自己跟随重定向，一次 302 就能绕过首跳的地址校验，所以
 * 这里手动跟随每一跳并对每个新地址重新校验。
 */

const TIMEOUT_MS = Number(process.env.SPEC_SOURCE_TIMEOUT_MS ?? 10_000) || 10_000;
const MAX_BYTES = Number(process.env.SPEC_SOURCE_MAX_BYTES ?? 5_000_000) || 5_000_000;
const MAX_REDIRECTS = 3;

/** 纯格式判断：只在建来源时用（不在存储时刻做 DNS，一次网络抖动不该让管理员存不进 URL）。 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function inV4Range(value: number, base: string, bits: number): boolean {
  const baseValue = ipv4ToInt(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) >>> 0 === (baseValue & mask) >>> 0;
}

/**
 * 非公网 IPv4 段（RFC 1918 私网 + 回环 + 链路本地含云元数据 + CGNAT + 保留段）。
 * 这段列表就是「不能打的目标」的完整定义——宽一点比漏一个安全。
 */
function isBlockedV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === undefined) return true;
  return [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ].some(([base, bits]) => inV4Range(value, base as string, bits as number));
}

function isBlockedV6(raw: string): boolean {
  const ip = raw.toLowerCase().split("%")[0];
  if (ip === "::1" || ip === "::") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isBlockedV4(mapped[1]);
  /* fc00::/7（唯一本地地址）与 fe80::/10（链路本地）只看前缀即可。 */
  if (/^f[cd]/.test(ip)) return true;
  if (/^fe[89ab]/.test(ip)) return true;
  if (/^ff/.test(ip)) return true;
  return false;
}

function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

/**
 * 把主机名解析成地址再逐个判段。只判字面量 IP 会漏掉 `evil.example.com → 127.0.0.1`
 * 这种 DNS 指向内网的情形——SSRF 的经典绕过，所以必须解析后判每一个答案。
 */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host.toLowerCase() === "localhost") throw new Error("spec source host is not allowed");
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error("spec source host resolves to a private or reserved address");
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error(`spec source host could not be resolved: ${host}`);
  }
  if (!addresses.length || addresses.some((entry) => isBlockedIp(entry.address))) {
    throw new Error("spec source host resolves to a private or reserved address");
  }
}

/** 有上限地读响应体：先看 Content-Length，流式读时再兜一道（分块响应可没有长度头）。 */
async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared && declared > MAX_BYTES) throw new Error(`spec source document is too large (over ${MAX_BYTES} bytes)`);
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error(`spec source document is too large (over ${MAX_BYTES} bytes)`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type SpecFetchResult = { text: string; etag?: string };

/** 出站请求选项：远端检索适配器要带方法和请求体（关键词），静态文档只用 GET。 */
export type SpecFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

/**
 * 取一份来源文档 / 调一次远端检索。`options.headers` 由驱动组装（如可选的凭据头）。
 * 重定向沿用同一方法跟随（检索多为 GET；POST 跟随保持同一方法，够用且不放大跨方法跳转）。
 */
export async function fetchSpecDocument(url: string, options: SpecFetchOptions = {}): Promise<SpecFetchResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed: URL;
    try { parsed = new URL(current); } catch { throw new Error("spec source URL is not a valid URL"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("spec source URL must be http(s)");
    await assertPublicHost(parsed.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, { redirect: "manual", signal: controller.signal, method: options.method ?? "GET", headers: options.headers, body: options.body });
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError" ? `spec source timed out after ${TIMEOUT_MS}ms` : `spec source request failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new Error(message);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`spec source redirected with no location header (HTTP ${response.status})`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`spec source returned HTTP ${response.status}`);
    const text = await readLimited(response);
    return { text, etag: response.headers.get("etag") ?? undefined };
  }
  throw new Error("spec source redirected too many times");
}
