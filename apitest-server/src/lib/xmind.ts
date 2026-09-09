import { readZip } from "./zip.js";

/**
 * XMind 工作簿解析（P7-4，计划 11.0 边界 3/4）。
 *
 * 兼容两代格式（用户 2026-09-08 要求，验收线是 2025-06 之后保存的文件）：
 * - **新格式**（XMind Zen / XMind 2020+，2019 至今的默认保存格式）：zip 内
 *   `content.json`，单文件 JSON，`JSON.parse` 直接读——计划边界 3 的原案。
 * - **旧格式**（XMind 8 及更早）：zip 内 `content.xml`。计划原案是直接拒绝，
 *   但真实语料里仍有两份（2024-11 / 2025-01）在用，且解析成本可控，这里
 *   用一个只读不动脑的极简 XML 读取器兼容（见下）。超过 2025-06 的语料
 *   全部是新格式，旧格式路径是尽力而为：解析失败如实报 1001。
 *
 * zip 读取复用 `lib/zip.ts`（零依赖 + 三道 zip 炸弹闸），不引任何新依赖。
 * 文件**不落盘、不进对象存储**：preview 是内存里的一次性解析（计划 11.0
 * 边界 7——归一化 JSON 由前端持有，S3/本地存储都不参与导入链路）。
 */

/** 用得上才向上抛的格式错误：路由层映射成 400 + 1001，而不是 500。 */
export class XmindFormatError extends Error {}

/* ── 归一化后的形状（两代格式解析到同一个结构上） ──────────────────────────── */

export type XmindTopicNode = {
  title: string;
  /** 备注（新格式 notes.plain.content / 旧格式 <notes><plain>）。 */
  notes: string;
  labels: string[];
  /** 原样 marker id（priority-1 / tag-red / symbol-question …），映射在归一层做。 */
  markerIds: string[];
  children: XmindTopicNode[];
};

export type XmindSheet = { title: string; root: XmindTopicNode };

export type XmindParseResult = { format: "json" | "xml"; sheets: XmindSheet[] };

/* ── 层级映射（计划边界 4，2026-09-08 用户收窄） ───────────────────────────── */

export type SpecImportPriority = "P0" | "P1" | "P2" | "P3";

export type XmindNormalizedCase = {
  /** DB 形态的模块路径（'/模块A/子模块/'）；模块树深上限 6，超出截断。 */
  modulePath: string;
  title: string;
  preconditions: string;
  steps: { step: string; expected: string }[];
  priority: SpecImportPriority;
  tags: string[];
  /** 文件自带的用例编号（XMind 两代格式都没有编号位，恒 null；Excel 导入才有）。 */
  itemKey: string | null;
  /** 祖先链超过 6 层被截断——预览里要能看出来，否则「目录少了一层」读作丢数据。 */
  pathClamped: boolean;
};

/** 模块树深上限（迁移 052 / P7-1 的口径，手工建模块同一条约束）。 */
const MAX_MODULE_DEPTH = 6;

/**
 * 用例节点前缀：`tc：` / `tc:` / `用例：`，后跟任意段 `-` 分段链再接冒号。分段
 * 有两种语义（语料实测三种形态：`tc：`×1784、`tc-pN：`×59、`tc-pN-类别：`×155）：
 * - `p0`…`p3` → 优先级（写在优先级段，`tc-p0-功能测试：`）；
 * - 其余段（如「功能测试」）是用例类别，剥前缀时**并入标签**——丢弃会把
 *   「这是功能测试还是异常测试」这条信息吞掉。
 * 冒号全半角都认——输入法随手切出来两种。
 */
const CASE_PREFIX_RE = /^\s*(?:tc|用例)((?:\s*-\s*[^\s:：]+)*)\s*[:：]\s*/i;

/** 前缀分段链里的优先级段形态（p0–p9；映射时 ≥4 并到 P3）。 */
const PRIORITY_SEGMENT_RE = /^p([0-9])$/i;

/** 前置条件子节点前缀：`pc：` / `前置：`（语料里 pc 无分段变体，保持朴素）。 */
const PRECONDITION_PREFIX_RE = /^\s*(?:pc|前置)\s*[:：]\s*/i;

/** marker-id 里的优先级（priority-1 最高）。 */
const PRIORITY_MARKER_RE = /^priority-([1-9])$/;

/**
 * 优先级映射：XMind priority-1 是「最高」，平台词汇里对应 P0（同是最高档）；
 * priority-2 → P1、priority-3 → P2、priority-4 及以下并到 P3。前缀 `tc-pN` 的
 * N 直接对应 P(N)。缺省 P2（与手工建用例的默认一致）。marker 优先于前缀
 * （界面上手动打的标记是更明确的动作）；语料里两者从不共存。
 */
function markerPriority(markerIds: string[]): SpecImportPriority | undefined {
  for (const id of markerIds) {
    const match = PRIORITY_MARKER_RE.exec(id);
    if (!match) continue;
    const level = Number(match[1]);
    if (level <= 1) return "P0";
    if (level === 2) return "P1";
    if (level === 3) return "P2";
    return "P3";
  }
  return undefined;
}

function prefixPriority(level: number | undefined): SpecImportPriority | undefined {
  if (level === undefined) return undefined;
  if (level <= 0) return "P0";
  if (level === 1) return "P1";
  if (level === 2) return "P2";
  return "P3";
}

/**
 * 文本归一（两代格式共用）：剥掉 NUL（Postgres text 存不了 \0）、\r 归一成
 * \n（旧格式实体 `&#13;` 会带出孤立 \r）。标题类再 trim。
 */
function cleanText(raw: string): string {
  return raw.replace(/\0/g, "").replace(/\r\n?/g, "\n");
}

/**
 * 模块名段的归一：路径分隔符 `/` 换成全角 `／`（P7-1 的硬约束是模块名不能含
 * `/`——path 物化拿它当分隔符；换成视觉近似的全角斜杠比静默丢弃温和），
 * 换行压成空格（模块名是路径的一段，多行名会把树压歪）。空段返回空串，
 * 由调用方跳过（空名祖先对路径透明，不占层级）。
 */
function moduleSegment(raw: string): string {
  return cleanText(raw).replace(/\//g, "／").replace(/[\n]+/g, " ").trim();
}

/** 路径链 → DB 形态 path；超过 6 层截断并标记。 */
function buildPath(segments: string[]): { path: string; clamped: boolean } {
  const capped = segments.slice(0, MAX_MODULE_DEPTH);
  return { path: `/${capped.join("/")}/`, clamped: segments.length > capped.length };
}

/** 前缀分段链的解析：第一段 pN 是优先级，其余段是用例类别（进标签）。 */
function parseCaseSegments(raw: string): { priorityLevel?: number; categories: string[] } {
  const segments = raw ? raw.split(/\s*-\s*/).map((segment) => segment.trim()).filter(Boolean) : [];
  let priorityLevel: number | undefined;
  const categories: string[] = [];
  for (const segment of segments) {
    const priority = PRIORITY_SEGMENT_RE.exec(segment);
    if (priority && priorityLevel === undefined) priorityLevel = Number(priority[1]);
    else categories.push(segment);
  }
  return { priorityLevel, categories };
}

/**
 * 层级映射 + 字段拆解（计划边界 4；2026-09-08 用户收窄为**只保留 tc: 标记**一种：
 * 「叶子即用例」解析出来的全是碎片——预期结果、步骤说明都被当成独立用例，
 * 「出来也是乱的」，删掉；没有 tc 约定的文件就是 0 条，如实返回）。
 *
 * `tc：`/`用例：` 开头的节点是用例（不必是叶子），其子树按约定拆字段——
 * `pc：`/`前置：` 子节点 → 前置（多个换行拼接）、其余子节点 → 步骤、
 * 步骤的子节点 → 预期（换行拼接）；其余节点一律是目录结构。
 *
 * `rootPrefix`（可选，DB 形态 '/目录1/目录2/'）：用户选定的导入根目录——
 * 整份文件的层级挂到它下面（`/目录1/目录2/文件根/…/`）；缺省 '/' 即不挂前缀，
 * 行为与最初版一致（根节点标题为顶层模块）。
 */
export function normalizeXmindCases(result: XmindParseResult, fallbackRootName: string, rootPrefix = "/"): XmindNormalizedCase[] {
  const cases: XmindNormalizedCase[] = [];
  /* 前缀段过一遍 moduleSegment：路径来自自家 DB，本就干净，这里是防御性归一。 */
  const baseSegments = rootPrefix.split("/").map(moduleSegment).filter(Boolean);

  const emitCase = (segments: string[], node: XmindTopicNode, title: string, priority: SpecImportPriority, preconditions: string, steps: { step: string; expected: string }[], categoryTags: string[] = []) => {
    const { path, clamped } = buildPath(segments);
    cases.push({
      modulePath: path,
      title,
      preconditions,
      steps: steps.filter((row) => row.step !== "" || row.expected !== ""),
      priority,
      /* labels（XMind 标签）在前、前缀类别段（tc-p0-功能测试：）在后，都进 tags。 */
      tags: [...node.labels.map((label) => cleanText(label).trim()), ...categoryTags.map((tag) => cleanText(tag).trim())].filter(Boolean),
      itemKey: null,
      pathClamped: clamped,
    });
  };

  /** marker 模式里拆一个 tc 节点的子树（pc / 步骤 / 预期）。 */
  const splitCaseSubtree = (node: XmindTopicNode): { preconditions: string; steps: { step: string; expected: string }[] } => {
    const preconditionParts: string[] = [];
    const steps: { step: string; expected: string }[] = [];
    for (const child of node.children) {
      const text = cleanText(child.title).trim();
      /* 前缀剥掉后正文可能为空（有人只写了个「pc：」）——跳过而不是产出空步骤。 */
      if (PRECONDITION_PREFIX_RE.test(text)) {
        const body = text.replace(PRECONDITION_PREFIX_RE, "").trim();
        if (body) preconditionParts.push(body);
        continue;
      }
      const expected = child.children.map((grandchild) => cleanText(grandchild.title).trim()).filter(Boolean).join("\n");
      if (!text && !expected) continue;
      steps.push({ step: text, expected });
    }
    /* notes → 前置（边界 4 的字段映射；marker 模式下拼在 pc 正文之后）。 */
    const notes = cleanText(node.notes).trim();
    if (notes) preconditionParts.push(notes);
    return { preconditions: preconditionParts.join("\n"), steps };
  };

  const walk = (node: XmindTopicNode, segments: string[]) => {
    const title = cleanText(node.title);
    const match = CASE_PREFIX_RE.exec(title);
    if (match) {
      const caseTitle = title.slice(match[0].length).trim();
      if (caseTitle) {
        const { priorityLevel, categories } = parseCaseSegments(match[1] ?? "");
        const priority = markerPriority(node.markerIds) ?? prefixPriority(priorityLevel) ?? "P2";
        const { preconditions, steps } = splitCaseSubtree(node);
        emitCase(segments, node, caseTitle, priority, preconditions, steps, categories);
        return;
      }
      /* 前缀后面是空的：读作用例写了一半，当普通模块走——子树里的下一个 tc
         仍然会被认出来。 */
    }

    const segment = moduleSegment(title);
    const next = segment ? [...segments, segment] : segments;
    for (const child of node.children) walk(child, next);
  };

  for (const sheet of result.sheets) {
    /* 根节点标题 → 顶层模块（计划「祖先链 = 目录路径」的直读）。空标题退到
       sheet 名，再退到调用方给的文件名——保证用例永远有可挂的模块。根是结构
       （画布主题），不参与 tc 识别。 */
    const rootSegment = moduleSegment(sheet.root.title) || moduleSegment(sheet.title) || moduleSegment(fallbackRootName) || "Imported";
    for (const child of sheet.root.children) walk(child, [...baseSegments, rootSegment]);
  }
  return cases;
}

/* ── 新格式：content.json ──────────────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function jsonTopic(raw: Record<string, unknown>): XmindTopicNode {
  const title = typeof raw.title === "string" ? raw.title : "";
  /* notes 形状：{ plain: { content } }。老版本 Zen 可能缺 plain——缺了就是没有备注。 */
  const plain = asRecord(asRecord(raw.notes)?.plain);
  const notes = typeof plain?.content === "string" ? plain.content : "";
  const labels = Array.isArray(raw.labels) ? raw.labels.map((label) => String(label ?? "")) : [];
  const markerIds = Array.isArray(raw.markers)
    ? raw.markers.map((marker) => String(asRecord(marker)?.markerId ?? "")).filter(Boolean)
    : [];
  const attached = Array.isArray(asRecord(raw.children)?.attached) ? (asRecord(raw.children)!.attached as unknown[]) : [];
  return {
    title, notes, labels, markerIds,
    children: attached.flatMap((child) => {
      const record = asRecord(child);
      return record ? [jsonTopic(record)] : [];
    }),
  };
}

/* ── 旧格式：content.xml 的极简读取器 ──────────────────────────────────────── */

type XmlElement = { tag: string; attrs: Record<string, string>; children: XmlElement[]; text: string };

/**
 * 只服务 content.xml 的极简 XML 解析：元素 + 属性 + 文本 + CDATA + 五个预定义
 * 实体 + 数字实体（旧文件里 `&#13;` 很常见）。注释 / PI / DOCTYPE 跳过。不做
 * DTD、不做 namespace 解析（XMind 的标签都在默认命名空间上，带前缀的只有
 * 属性如 svg:width，按名忽略即可）。这是「尽力兼容」的边界：超出这个子集
 * 的文件会得到一句明确的 1001，而不是 500。
 */
function parseXmlDocument(source: string): XmlElement {
  let cursor = 0;
  const depthLimit = 256;

  function skipInsignificants(): void {
    while (cursor < source.length) {
      const rest = source.slice(cursor);
      if (/\s/.test(source[cursor]!)) { cursor += 1; continue; }
      if (rest.startsWith("<?")) { const end = source.indexOf("?>", cursor); if (end < 0) throw new XmindFormatError("malformed XML: unterminated processing instruction"); cursor = end + 2; continue; }
      if (rest.startsWith("<!--")) { const end = source.indexOf("-->", cursor); if (end < 0) throw new XmindFormatError("malformed XML: unterminated comment"); cursor = end + 3; continue; }
      if (rest.startsWith("<!")) { const end = source.indexOf(">", cursor); if (end < 0) throw new XmindFormatError("malformed XML: unterminated declaration"); cursor = end + 1; continue; }
      return;
    }
  }

  function decodeEntities(text: string): string {
    return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
      if (body === "lt") return "<";
      if (body === "gt") return ">";
      if (body === "quot") return "\"";
      if (body === "apos") return "'";
      if (body === "amp") return "&";
      return whole;
    }).replace(/\0/g, "");
  }

  function parseElement(depth: number): XmlElement {
    if (source[cursor] !== "<") throw new XmindFormatError("malformed XML: expected element");
    if (depth > depthLimit) throw new XmindFormatError("malformed XML: nesting too deep");
    cursor += 1;
    const nameMatch = /^[a-zA-Z_:][\w.:-]*/.exec(source.slice(cursor));
    if (!nameMatch) throw new XmindFormatError("malformed XML: bad element name");
    const tag = nameMatch[0];
    cursor += tag.length;

    const attrs: Record<string, string> = {};
    const children: XmlElement[] = [];
    let text = "";
    let selfClosing = false;

    for (;;) {
      while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
      if (source.startsWith("/>", cursor)) { cursor += 2; selfClosing = true; break; }
      if (source[cursor] === ">") { cursor += 1; break; }
      const attrMatch = /^[a-zA-Z_:][\w.:-]*\s*=\s*("([^"]*)"|'([^']*)')/.exec(source.slice(cursor));
      if (!attrMatch) throw new XmindFormatError(`malformed XML: bad attribute in <${tag}>`);
      attrs[attrMatch[1].replace(/\s*=\s*$/, "")] = decodeEntities(attrMatch[2].slice(1, -1));
      cursor += attrMatch[0].length;
    }
    if (selfClosing) return { tag, attrs, children, text };

    for (;;) {
      if (cursor >= source.length) throw new XmindFormatError(`malformed XML: <${tag}> not closed`);
      if (source.startsWith("</", cursor)) {
        const close = new RegExp(`^</${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*>`).exec(source.slice(cursor));
        if (!close) throw new XmindFormatError(`malformed XML: mismatched closing tag for <${tag}>`);
        cursor += close[0].length;
        return { tag, attrs, children, text };
      }
      if (source.startsWith("<![CDATA[", cursor)) {
        const end = source.indexOf("]]>", cursor);
        if (end < 0) throw new XmindFormatError("malformed XML: unterminated CDATA");
        text += source.slice(cursor + 9, end);
        cursor = end + 3;
        continue;
      }
      if (source[cursor] === "<") { skipInsignificants(); if (source[cursor] === "<" && !source.startsWith("</", cursor)) children.push(parseElement(depth + 1)); continue; }
      const next = source.indexOf("<", cursor);
      const chunk = next < 0 ? source.slice(cursor) : source.slice(cursor, next);
      text += decodeEntities(chunk);
      cursor = next < 0 ? source.length : next;
    }
  }

  skipInsignificants();
  if (source[cursor] !== "<") throw new XmindFormatError("malformed XML: no root element");
  return parseElement(0);
}

function xmlChild(element: XmlElement, tag: string): XmlElement | undefined {
  return element.children.find((child) => child.tag === tag);
}

function xmlChildren(element: XmlElement, tag: string): XmlElement[] {
  return element.children.filter((child) => child.tag === tag);
}

function xmlTopic(element: XmlElement): XmindTopicNode {
  const title = xmlChild(element, "title")?.text ?? "";
  const notes = xmlChild(xmlChild(element, "notes") ?? { tag: "", attrs: {}, children: [], text: "" }, "plain")?.text ?? "";
  const labels = xmlChildren(element, "labels").flatMap((labelsElement) => xmlChildren(labelsElement, "label").map((label) => label.text));
  const markerIds = xmlChildren(element, "marker-refs")
    .flatMap((refs) => xmlChildren(refs, "marker-ref").map((ref) => ref.attrs["marker-id"] ?? ""))
    .filter(Boolean);
  const children = xmlChildren(element, "children")
    .flatMap((childrenElement) => xmlChildren(childrenElement, "topics"))
    /* detached（浮动主题）不进结构；type 缺省按 attached 读。 */
    .filter((topics) => (topics.attrs["type"] ?? "attached") === "attached")
    .flatMap((topics) => xmlChildren(topics, "topic").map(xmlTopic));
  return { title, notes, labels, markerIds, children };
}

/* ── 入口 ──────────────────────────────────────────────────────────────────── */

export function parseXmindWorkbook(buffer: Buffer): XmindParseResult {
  let entries;
  try {
    entries = readZip(buffer);
  } catch (error) {
    /* zip 炸弹 / 加密 / 损坏：zip.ts 的护栏消息直接透出（验收 5：明确报错）。 */
    throw new XmindFormatError(error instanceof Error ? `not a readable .xmind file: ${error.message}` : "not a readable .xmind file");
  }

  const jsonEntry = entries.find((entry) => entry.name === "content.json");
  if (jsonEntry) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonEntry.read().toString("utf8"));
    } catch {
      throw new XmindFormatError("content.json could not be parsed — the file may be corrupted");
    }
    const sheets = Array.isArray(parsed) ? parsed : [];
    return {
      format: "json",
      sheets: sheets.flatMap((sheet) => {
        const record = asRecord(sheet);
        const root = asRecord(record?.rootTopic);
        if (!root) return [];
        return [{ title: typeof record?.title === "string" ? record.title : "", root: jsonTopic(root) }];
      }),
    };
  }

  const xmlEntry = entries.find((entry) => entry.name === "content.xml");
  if (xmlEntry) {
    const document = parseXmlDocument(xmlEntry.read().toString("utf8"));
    return {
      format: "xml",
      sheets: xmlChildren(document, "sheet").flatMap((sheet) => {
        const root = xmlChild(sheet, "topic");
        return root ? [{ title: xmlChild(sheet, "title")?.text ?? "", root: xmlTopic(root) }] : [];
      }),
    };
  }

  throw new XmindFormatError("no content.json or content.xml found — this does not look like an XMind workbook");
}
