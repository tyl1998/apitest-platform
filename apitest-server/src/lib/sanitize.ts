const SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);

export function sanitizeHeaders(headers: Record<string, string>, secretValues: string[] = []) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    SENSITIVE_HEADERS.has(key.toLowerCase()) || secretValues.some((secret) => secret && value.includes(secret)) ? "***" : value,
  ]));
}

export function sanitizeValue(value: unknown, secretValues: string[]): unknown {
  if (typeof value === "string") return secretValues.reduce((result, secret) => secret ? result.replaceAll(secret, "***") : result, value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, secretValues));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, secretValues)]));
  return value;
}
