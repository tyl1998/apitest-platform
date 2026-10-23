/**
 * 页面上下文（P9-4c）：把前端随消息送来的「用户正站在哪」元数据归一、封
 * `apitest-page-context` 围栏**后缀**拼进转发 message；历史回放时把围栏剥掉。
 *
 * 形状是给 agent 看的提示材料，不是受信输入——消费终点是「用户自己的 agent 收到的
 * 一段文本」，不进任何 SQL / 权限判断。因此校验只做两件事：顶层键白名单（未知键
 * 丢弃）+ 值浅校验（string/number/boolean，长度封顶）；坏形状整体降级为不注入
 * （宁缺毋滥——上下文是增强不是前置，坏数据不配 400）。secret 值由前端保证不送
 * （上下文只带标识符与面包屑）；这里再压一道长度上限兜底。
 */

/** 序列化后的上下文 JSON 封顶：围栏是消息后缀，不该喧宾夺主。 */
const MAX_CONTEXT_JSON_CHARS = 2048;

/** 单个值（实体名 / URL / 筛选词）封顶。 */
const MAX_VALUE_CHARS = 256;

/** 勾选行 id 的条数封顶（批量调试一次最多 100 接口，留一半余量）。 */
const MAX_SELECTION_ITEMS = 50;

/** 围栏标记：拼装与剥离共用，避免两处字面量漂移。 */
const CONTEXT_FENCE_OPEN = "```apitest-page-context\n";
const CONTEXT_FENCE_CLOSE = "\n```";

export type PageContext = {
  page: string;
  route?: string;
  entities?: Record<string, string>;
  focus?: string;
  filters?: Record<string, string>;
  selection?: string[];
};

/** 值浅校验：只认标量，转字符串、去空白、截长度；键数封顶后丢弃空值。 */
function cleanRecord(input: unknown, maxKeys: number): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(result).length >= maxKeys) break;
    if (value === null || value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    const text = String(value).trim().slice(0, MAX_VALUE_CHARS);
    if (text) result[key.slice(0, 64)] = text;
  }
  return Object.keys(result).length ? result : undefined;
}

function fitsBudget(context: PageContext): boolean {
  return JSON.stringify(context).length <= MAX_CONTEXT_JSON_CHARS;
}

/**
 * 归一前端送来的 context：page 必填（缺了视为没有上下文），其余键缺省丢弃。
 * 尺寸预算超标时先丢 selection（最长）、再丢 filters；仍超则整体不注入。
 */
export function normalizePageContext(input: unknown): PageContext | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const page = typeof source.page === "string" ? source.page.trim().slice(0, 64) : "";
  if (!page) return undefined;
  const context: PageContext = { page };
  if (typeof source.route === "string" && source.route.trim()) context.route = source.route.trim().slice(0, 512);
  const entities = cleanRecord(source.entities, 24);
  if (entities) context.entities = entities;
  if (typeof source.focus === "string" && source.focus.trim()) context.focus = source.focus.trim().slice(0, 64);
  const filters = cleanRecord(source.filters, 16);
  if (filters) context.filters = filters;
  if (Array.isArray(source.selection)) {
    const selection = source.selection
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().slice(0, 128))
      .filter(Boolean)
      .slice(0, MAX_SELECTION_ITEMS);
    if (selection.length) context.selection = selection;
  }
  if (!fitsBudget(context)) {
    context.selection = undefined;
    if (!fitsBudget(context)) {
      context.filters = undefined;
      if (!fitsBudget(context)) return undefined;
    }
  }
  return context;
}

/**
 * 转发 message = 用户原文 + 空行 + 围栏（紧凑 JSON）。协议配置零改动：`{{message}}`
 * 渲染的就是这里拼好的全文——只有一个 message 字段的上游也能吃。
 *
 * 围栏放**末尾**：上游拿首条消息当会话标题/摘要时，标题取的是开头的用户原文，
 * 而不是一段机器元数据。agent 语义上对「块在前后」不敏感，读末尾同样能解析指代。
 */
export function composeForwardedMessage(message: string, context: PageContext | undefined): string {
  if (!context) return message;
  return `${message}\n\n${CONTEXT_FENCE_OPEN}${JSON.stringify(context)}${CONTEXT_FENCE_CLOSE}`;
}

/** 历史回放剥围栏：气泡永远只显示用户打的字（live 气泡本来就没有后缀，这里管上游回放）。
 *  以**最后一个**起始标记为准，且要求其后的内容确实是一个完整闭合的 JSON 围栏块——
 *  用户原文里自带的同类围栏不会被误剥。 */
export function stripContextSuffix(text: string): string {
  const at = text.lastIndexOf(CONTEXT_FENCE_OPEN);
  if (at < 0) return text;
  const body = text.slice(at + CONTEXT_FENCE_OPEN.length);
  const normalized = body.replace(/\s+$/, "");
  if (!normalized.endsWith(CONTEXT_FENCE_CLOSE)) return text;
  try {
    JSON.parse(normalized.slice(0, -CONTEXT_FENCE_CLOSE.length));
  } catch {
    return text;
  }
  return text.slice(0, at).replace(/\s+$/, "");
}
