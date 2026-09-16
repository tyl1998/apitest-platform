/**
 * 页面上下文（P9-4c）：把前端随消息送来的「用户正站在哪」元数据归一、封
 * `apitest-page-context` 围栏前缀拼进转发 message；历史回放时把围栏剥掉。
 *
 * 形状是给 agent 看的提示材料，不是受信输入——消费终点是「用户自己的 agent 收到的
 * 一段文本」，不进任何 SQL / 权限判断。因此校验只做两件事：顶层键白名单（未知键
 * 丢弃）+ 值浅校验（string/number/boolean，长度封顶）；坏形状整体降级为不注入
 * （宁缺毋滥——上下文是增强不是前置，坏数据不配 400）。secret 值由前端保证不送
 * （上下文只带标识符与面包屑）；这里再压一道长度上限兜底。
 */

/** 序列化后的上下文 JSON 封顶：围栏是消息前缀，不该喧宾夺主。 */
const MAX_CONTEXT_JSON_CHARS = 2048;

/** 单个值（实体名 / URL / 筛选词）封顶。 */
const MAX_VALUE_CHARS = 256;

/** 勾选行 id 的条数封顶（批量调试一次最多 100 接口，留一半余量）。 */
const MAX_SELECTION_ITEMS = 50;

/** 历史行剥离围栏用：JSON.stringify 无裸换行，非贪婪到第一个收尾围栏即止。 */
const CONTEXT_FENCE_PATTERN = /^```apitest-page-context\n[\s\S]*?\n```\n\n?/;

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
 * 转发 message = 围栏（紧凑 JSON）+ 空行 + 用户原文。协议配置零改动：`{{message}}`
 * 渲染的就是这里拼好的全文——只有一个 message 字段的上游（agent-vendor）也能吃。
 */
export function composeForwardedMessage(message: string, context: PageContext | undefined): string {
  if (!context) return message;
  return `\`\`\`apitest-page-context\n${JSON.stringify(context)}\n\`\`\`\n\n${message}`;
}

/** 历史回放剥围栏：气泡永远只显示用户打的字（live 气泡本来就没有前缀，这里管上游回放）。 */
export function stripContextPrefix(text: string): string {
  return text.replace(CONTEXT_FENCE_PATTERN, "");
}
