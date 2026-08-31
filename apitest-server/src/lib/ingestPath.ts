import { pool } from "../db.js";

/**
 * path 归一与接口匹配（P4-4，计划 7.0 边界 15/16）。
 *
 * **归一留在平台侧，SDK 只报 raw path**：规则一定会随 `endpoints` 的实际形状演进，而
 * SDK 装在用户仓库里、版本完全不可控——规则冻在用户机器上就再也改不动了。
 *
 * 匹配是 `(method, path)` → `endpoints.id`。匹配不上进未匹配区（边界 20），
 * **绝不自动登记 endpoint**（边界 16）：分母跟着分子长的话覆盖率永远是 100%。
 */

/**
 * 从一条接口 URL 里取出可比较的路径。
 *
 * 接口 URL 常带变量前缀（`{{baseUrl}}/orders/:id`），所以不能直接 `new URL()`——它会
 * 抛。做法是先砍掉 `{{…}}` 段与 scheme://host，剩下的第一个 `/` 起就是路径。
 * query 与 fragment 一并丢掉：上报的 `path_raw` 只有路径，比较两边必须同形。
 */
export function endpointPath(url: string): string {
  let rest = url.trim();
  /* 变量可能整段就是 host（`{{baseUrl}}`），也可能嵌在中间；先剥掉 scheme。 */
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  /* `{{var}}` 里含 `/` 时会把路径切错，所以先把变量整体挖成一个不含斜杠的占位。 */
  rest = rest.replace(/\{\{[^}]*\}\}/g, "\u0000");
  const cut = rest.search(/[?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  const slash = rest.indexOf("/");
  const path = slash >= 0 ? rest.slice(slash) : "";
  return path || "/";
}

/** 路径切段：忽略首尾斜杠与空段，`/a//b/` 与 `a/b` 视为同一形状。 */
function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** 一段是不是接口定义里的路径参数（`:id` 或 `{id}` 两种写法都算）。 */
function isTemplateSegment(segment: string): boolean {
  return segment.startsWith(":") || (segment.startsWith("{") && segment.endsWith("}"));
}

/**
 * 一段是不是「看起来是个 id」。
 *
 * 这条规则只服务于**未匹配记录的聚合展示**（诊断视图按频次排序，边界 20），不参与任何
 * 统计口径，所以宁可宽一点：漏判的后果是列表里多几行，误判的后果也只是少几行。
 * 已登记接口的匹配不走这里——那边按接口自己的模板逐段比，不猜。
 */
function looksLikeId(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^[0-9a-f]{24,}$/i.test(segment)) return true;
  /* 含数字的混合串（`order-2024-11`、`u1234`）：纯字母段一律当资源名保留。 */
  return segment.length >= 8 && /\d/.test(segment) && /^[\w.-]+$/.test(segment);
}

/**
 * 通用归一：把像 id 的段换成 `{id}`。
 *
 * 用在**匹配不上**任何已登记接口时（迁移 035 的注释说明了为什么这一列不留空）：
 * 诊断视图要按频次聚合，按 `path_raw` 分组会把 `/users/1`…`/users/900` 变成 900 行各
 * 出现一次的列表，那张表就再也读不出「哪条路径最常被打到」。
 */
export function normalizePath(pathRaw: string): string {
  const parts = segments(pathRaw);
  if (!parts.length) return "/";
  return `/${parts.map((part) => (looksLikeId(part) ? "{id}" : part)).join("/")}`;
}

export type EndpointShape = { id: string; method: string; path: string };

/** 项目里已登记接口的可匹配形状。上报一次读一次，不做进程内缓存——接口随时会新增。 */
export async function loadEndpointShapes(projectId: string): Promise<EndpointShape[]> {
  const result = await pool.query("SELECT id, method, url FROM endpoints WHERE project_id = $1", [projectId]);
  return result.rows.map((row) => ({ id: String(row.id), method: String(row.method).toUpperCase(), path: endpointPath(String(row.url)) }));
}

/** 匹配键：method + 段数。段数不同的接口永远不可能匹配同一条记录。 */
function shapeKey(method: string, segmentCount: number) {
  return `${method} ${segmentCount}`;
}

export type EndpointMatch = { endpointId: string; path: string };

export type EndpointMatcher = {
  match: (method: string, pathRaw: string) => EndpointMatch | undefined;
};

/**
 * 建一个匹配器。
 *
 * 按 `(method, 段数)` 分桶，桶内逐段比：字面段要求相等（大小写敏感——`/Orders` 与
 * `/orders` 在多数框架里是两条路由），模板段（`:id` / `{id}`）通配一段。
 *
 * 同一个桶里有多条候选时，**字面段更多的赢**：`/orders/count` 与 `/orders/{id}` 同时
 * 存在时，`/orders/count` 该归给前者。按登记顺序取第一条会让结果取决于谁先被创建。
 *
 * 尾部斜杠、重复斜杠在切段时已经被吃掉；query 由调用方在传入前剥掉。
 */
export function buildEndpointMatcher(shapes: EndpointShape[]): EndpointMatcher {
  const buckets = new Map<string, { id: string; path: string; parts: string[]; literals: number }[]>();
  for (const shape of shapes) {
    const parts = segments(shape.path);
    const key = shapeKey(shape.method, parts.length);
    const bucket = buckets.get(key) ?? [];
    bucket.push({ id: shape.id, path: shape.path, parts, literals: parts.filter((part) => !isTemplateSegment(part)).length });
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => b.literals - a.literals);

  return {
    match(method, pathRaw) {
      const parts = segments(pathRaw);
      const bucket = buckets.get(shapeKey(method.toUpperCase(), parts.length));
      if (!bucket) return undefined;
      for (const candidate of bucket) {
        let ok = true;
        for (let index = 0; index < parts.length; index += 1) {
          const expected = candidate.parts[index]!;
          if (isTemplateSegment(expected)) continue;
          if (expected !== parts[index]) { ok = false; break; }
        }
        if (ok) return { endpointId: candidate.id, path: candidate.path };
      }
      return undefined;
    },
  };
}

/** SDK 报的 path 可能带 query（协议只要求「实际路径」），比较前统一剥掉。 */
export function stripQuery(pathRaw: string): string {
  const cut = pathRaw.search(/[?#]/);
  return cut >= 0 ? pathRaw.slice(0, cut) : pathRaw;
}

/**
 * 归一后的展示模板：匹配到接口就用接口自己的路径，否则用通用归一。
 *
 * 接口定义里的 `:id` 统一写成 `{id}`，与通用归一的输出同形——同一列里混着两种占位符
 * 写法时，「这两行是同一条路径吗」要靠人眼去翻译。
 */
export function templateFor(matchedPath: string | undefined, pathRaw: string): string {
  if (matchedPath === undefined) return normalizePath(pathRaw);
  const parts = segments(matchedPath).map((part) => (part.startsWith(":") ? `{${part.slice(1)}}` : part));
  return parts.length ? `/${parts.join("/")}` : "/";
}

/**
 * 只用于**跨项目比对**的形状：任何占位符段都归成 `{}`。
 *
 * 两边的占位符名字必然不同——本项目未匹配记录归一出的是 `/users/{id}`（通用归一不知道
 * 别人管它叫什么），而用户中心那边登记的可能是 `/users/{userId}`。按原样比，
 * 「别的项目登记过这条路径」这条标注几乎永远为空，而它空着与「真的没人登记」看起来一样
 * ——一条永远不出现的标注比没有这条标注更糟。
 *
 * 这个形状服务于诊断视图的显示，也是覆盖统计去重键（`coverageShapeKey`）的底座——两者
 * 必须共用同一个等价关系。它仍不参与任何记录归属判定，也不落库。
 */
export function comparableTemplate(path: string): string {
  const parts = segments(path).map((part) => (isTemplateSegment(part) ? "{}" : part));
  return parts.length ? `/${parts.join("/")}` : "/";
}

/**
 * 覆盖统计的去重键：`METHOD /users/{}`（2026-08-30，基数未按 path 去重的缺陷）。
 *
 * `endpoints` 里同一逻辑接口可能有多行——手工建接口不查重，import 的冲突键又是**精确
 * URL 字符串**：`:id` 与 `{id}`、不同 `{{host}}` 变量、尾斜杠都是不同字符串、同一个匹配
 * 形状。覆盖率的分母按行数算的话，这些接口被数成 N 个；而 `buildEndpointMatcher` 只会把
 * 用例挂到其中一行（同形候选里字面段更多者胜，全同则登记在前的胜），于是分母虚高、分子
 * 最多 1，覆盖率被压低。树上的行数与此处分母从此是两个口径，重复登记是登记侧的问题，
 * 不该由统计数字替它圆谎。
 *
 * 键与 `comparableTemplate` 是**同一个等价关系**（占位符无名化）：哪天等价关系要变（比如
 * 决定忽略段大小写），两边必须一起变。方法名进键——GET 与 POST 打同一路径是两条接口。
 */
export function coverageShapeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${comparableTemplate(path)}`;
}
