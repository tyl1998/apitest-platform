import { readZip, type ZipEntry } from "./zip.js";

/**
 * allure 报告视图的解析（P4.5-13，边界 19 的报告层）。
 *
 * 输入是 Runner 上传的 allure-results.zip（`kind='report'` 产物），视图输出三块：
 * - cases：`*-result.json` 归一后的清单（steps 树 / parameters / labels / 附件引用）；
 * - containers：`*-container.json` 的 before/after 归一（fixture 步骤挂哪条 case）；
 * - attachments：附件实体名（allure 的 `source`）→ 媒体类型（下载走附件路由，按
 *   source 匹配 zip 内实体，内容不进这个 JSON）。
 *
 * 数值护栏与 Runner 侧写入器同值（4096 文件）；JSON 单条 64MB 对齐报告文件上限。
 * 解析失败的文件**跳过并计数**，不抛——zip 里混几个坏文件不该废掉整份报告视图。
 */

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;
/** steps 树的深度上限：allure 的 step 可以嵌套，防一个手造的深环把递归栈吃穿。 */
const MAX_STEP_DEPTH = 64;
/** 单条 case 归一后的 steps 数量上限。 */
const MAX_STEPS = 5000;

export type ReportStep = {
  name: string;
  status: string;
  /** epoch 毫秒，缺省 null。 */
  start?: number;
  stop?: number;
  children?: ReportStep[];
  attachments?: ReportAttachment[];
};

/**
 * 报告附件（2026-09-02 验收反馈第三批 ①）。
 *
 * allure 结果 JSON 里的一条附件引用有两个名字：`name` 是展示名（`log` / `stdout` /
 * 截图名），`source` 是报告包里的**实体文件名**（`<uuid>-attachment.txt`）。原先视图
 * 只保留 `name`，附件下载路由按「zip 内 basename」匹配实体——`?name=log` 永远 404，
 * 用例的执行日志/截图全部加载不出来。两个字段都带出去：`name` 给显示，`source`
 * 给取数（`type` 是 allure 报的媒体类型，空串时前端按扩展名猜）。
 */
export type ReportAttachment = {
  name: string;
  source: string;
  type: string;
};

export type ReportViewCase = {
  uid: string;
  name: string;
  fullName: string;
  /** 注释（pytest 的 docstring 落这里）；allure 允许 string 或 {content} 两种形状。 */
  description: string | null;
  suiteName: string;
  parentSuiteName: string;
  status: string;
  message: string | null;
  trace: string | null;
  start?: number;
  stop?: number;
  durationMs: number;
  host: string | null;
  thread: string | null;
  parameters: { name: string; value: string }[];
  labels: { name: string; value: string }[];
  steps: ReportStep[];
  /** fixture（container 的 before/after）：container 的 children 圈住哪条 case，fixture 就挂哪条。 */
  befores: ReportViewFixture[];
  afters: ReportViewFixture[];
  attachments: ReportAttachment[];
};

export type ReportViewFixture = {
  name: string;
  type: "before" | "after";
  status: string;
  start?: number;
  stop?: number;
  steps: ReportStep[];
  attachments: ReportAttachment[];
};

export type ReportViewContainer = {
  uid: string;
  children: string[];
  befores: ReportViewFixture[];
  afters: ReportViewFixture[];
};

export type ReportView = {
  cases: ReportViewCase[];
  containers: ReportViewContainer[];
  /** 附件实体名（source）→ content-type。下载路由按它回 Content-Type，浏览器 inline
   *  渲染截图；键是 source（zip 内实体名）而不是展示名，与附件路由的匹配口径一致。 */
  attachments: Record<string, string>;
  /** 解析失败被跳过的文件数——报告页顶部一行降级提示，不静默。 */
  skippedFiles: number;
};

export function parseAllureReportBundle(zipBytes: Buffer): ReportView {
  const entries = readZip(zipBytes);
  const view: ReportView = { cases: [], containers: [], attachments: {}, skippedFiles: 0 };

  for (const entry of entries) {
    if (view.cases.length + view.containers.length > MAX_ENTRIES) break;
    const name = entry.name.split("/").pop() ?? entry.name;

    if (/-result\.json$/i.test(name)) {
      const parsed = parseJsonEntry(entry);
      if (parsed) view.cases.push(normalizeCase(parsed));
      else view.skippedFiles += 1;
    } else if (/-container\.json$/i.test(name)) {
      const parsed = parseJsonEntry(entry);
      if (parsed) view.containers.push(normalizeContainer(parsed));
      else view.skippedFiles += 1;
    } else if (/-attachment\.json$/i.test(name)) {
      const parsed = parseJsonEntry(entry);
      if (parsed && typeof parsed.name === "string" && parsed.name) {
        const record = parsed as { source?: unknown; type?: unknown };
        const key = typeof record.source === "string" && record.source ? record.source : parsed.name;
        view.attachments[key] = typeof record.type === "string" && record.type ? record.type : "application/octet-stream";
      }
    }
    /* 其余（附件实体、history、categories.json 等）：实体走下载路由按需取，
       history 不采（趋势从 pipeline_runs 算，边界 19）。 */
  }

  joinFixtures(view);
  /* 附件类型清单按 source 归位（上面只收了 `-attachment.json`，pytest 适配器根本不产
     那种文件——类型在结果 JSON 的 attachments[].type 里，跟着 case/step/fixture 走）。 */
  registerAttachmentTypes(view);
  view.cases.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.name.localeCompare(b.name));
  return view;
}

/** 把 cases（含步骤树与 fixture）上的附件类型汇进 `view.attachments`，键 = source。 */
function registerAttachmentTypes(view: ReportView): void {
  const add = (list: ReportAttachment[]): void => {
    for (const each of list) if (each.type) view.attachments[each.source] = each.type;
  };
  const walkSteps = (steps: ReportStep[]): void => {
    for (const step of steps) {
      if (step.attachments) add(step.attachments);
      if (step.children) walkSteps(step.children);
    }
  };
  for (const each of view.cases) {
    add(each.attachments);
    for (const fixture of each.befores) {
      add(fixture.attachments);
      walkSteps(fixture.steps);
    }
    for (const fixture of each.afters) {
      add(fixture.attachments);
      walkSteps(fixture.steps);
    }
    walkSteps(each.steps);
  }
}

/**
 * container → case 的 fixture 归位：allure 把 before/after（pytest 的 fixture）放在
 * `*-container.json` 里、用 `children`（case uid 清单）圈作用域。不加这一步，pytest
 * 用户的报告里所有 fixture 都不可见——而 fixture 恰恰是「这条用例执行前做了什么」的
 * 主要事实（他们的测试很少手写 allure.step）。
 *
 * 上限 50：一个手造的容器声称包含全部 uid 时，别让每条 case 都背上几千个 fixture。
 */
const MAX_FIXTURES_PER_CASE = 50;

function joinFixtures(view: ReportView): void {
  const beforesByChild = new Map<string, ReportViewFixture[]>();
  const aftersByChild = new Map<string, ReportViewFixture[]>();
  for (const container of view.containers) {
    for (const child of container.children) {
      if (container.befores.length) {
        const list = beforesByChild.get(child) ?? [];
        list.push(...container.befores);
        beforesByChild.set(child, list);
      }
      if (container.afters.length) {
        const list = aftersByChild.get(child) ?? [];
        list.push(...container.afters);
        aftersByChild.set(child, list);
      }
    }
  }
  for (const each of view.cases) {
    const befores = beforesByChild.get(each.uid);
    if (befores?.length) each.befores = befores.slice(0, MAX_FIXTURES_PER_CASE);
    const afters = aftersByChild.get(each.uid);
    if (afters?.length) each.afters = afters.slice(0, MAX_FIXTURES_PER_CASE);
  }
}

function parseJsonEntry(entry: ZipEntry): Record<string, unknown> | null {
  try {
    /* 先读再量：read() 里 inflate 有 maxOutputLength 兜底，这里再按字符数挡一道
       （JSON 解析的内存开销远大于文本本身）。 */
    const text = entry.read().toString("utf8");
    if (text.length > MAX_JSON_BYTES) return null;
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asTimestamp(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : undefined;
}

function normalizeStep(raw: unknown, depth: number, counter: { count: number }): ReportStep | null {
  if (!raw || typeof raw !== "object" || depth > MAX_STEP_DEPTH || counter.count >= MAX_STEPS) return null;
  const record = raw as Record<string, unknown>;
  const step: ReportStep = {
    name: asString(record.name).slice(0, 512) || "(unnamed step)",
    status: asString(record.status) || "unknown",
  };
  const start = asTimestamp(record.start);
  const stop = asTimestamp(record.stop);
  if (start !== undefined) step.start = start;
  if (stop !== undefined) step.stop = stop;
  counter.count += 1;
  const steps = Array.isArray(record.steps) ? record.steps : [];
  const children: ReportStep[] = [];
  for (const child of steps) {
    const normalized = normalizeStep(child, depth + 1, counter);
    if (normalized) children.push(normalized);
  }
  if (children.length) step.children = children;
  const attachments = normalizeAttachments(record.attachments);
  if (attachments.length) step.attachments = attachments;
  return step;
}

function normalizeAttachments(raw: unknown): ReportAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ReportAttachment[] = [];
  for (const each of raw) {
    if (!each || typeof each !== "object") continue;
    const record = each as Record<string, unknown>;
    /* source 是 zip 内实体文件名；没有 source 的适配器退 name——下载路由按 basename
       匹配，name 恰好是实体名时仍能命中，不命中也只是那一格加载失败。 */
    const source = asString(record.source).slice(0, 512);
    const name = asString(record.name).slice(0, 512) || source;
    if (!name) continue;
    out.push({ name, source: source || name, type: asString(record.type).slice(0, 128) });
  }
  return out;
}

function normalizeCase(parsed: Record<string, unknown>): ReportViewCase {
  const labelsRaw = Array.isArray(parsed.labels) ? parsed.labels : [];
  const labels: { name: string; value: string }[] = [];
  const labelValue = (key: string): string => {
    for (const each of labelsRaw) {
      if (!each || typeof each !== "object") continue;
      const record = each as Record<string, unknown>;
      if (asString(record.name) === key && asString(record.value)) return asString(record.value);
    }
    return "";
  };
  for (const each of labelsRaw) {
    if (!each || typeof each !== "object") continue;
    const record = each as Record<string, unknown>;
    const name = asString(record.name);
    const value = asString(record.value);
    if (name && value) labels.push({ name: name.slice(0, 128), value: value.slice(0, 512) });
  }

  const parametersRaw = Array.isArray(parsed.parameters) ? parsed.parameters : [];
  const parameters: { name: string; value: string }[] = [];
  for (const each of parametersRaw) {
    if (!each || typeof each !== "object") continue;
    const record = each as Record<string, unknown>;
    const name = asString(record.name);
    if (name) parameters.push({ name: name.slice(0, 256), value: asString(record.value).slice(0, 2000) });
  }

  const counter = { count: 0 };
  const stepsRaw = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps: ReportStep[] = [];
  for (const child of stepsRaw) {
    const normalized = normalizeStep(child, 0, counter);
    if (normalized) steps.push(normalized);
  }

  const details = parsed.statusDetails && typeof parsed.statusDetails === "object"
    ? parsed.statusDetails as Record<string, unknown>
    : {};
  const start = asTimestamp(parsed.start);
  const stop = asTimestamp(parsed.stop);
  const name = asString(parsed.name) || "(unnamed case)";

  return {
    uid: asString(parsed.uid).slice(0, 128) || name,
    name: name.slice(0, 512),
    fullName: (asString(parsed.fullName) || name).slice(0, 1024),
    description: normalizeDescription(parsed.description),
    suiteName: labelValue("suite").slice(0, 512),
    parentSuiteName: labelValue("parentSuite").slice(0, 512),
    status: asString(parsed.status) || "unknown",
    message: asString(details.message).slice(0, 8000) || null,
    trace: asString(details.trace).slice(0, 64_000) || null,
    ...(start !== undefined ? { start } : {}),
    ...(stop !== undefined ? { stop } : {}),
    durationMs: start !== undefined && stop !== undefined ? Math.max(0, stop - start) : 0,
    host: labelValue("host").slice(0, 512) || null,
    thread: labelValue("thread").slice(0, 512) || null,
    parameters,
    labels,
    steps,
    befores: [],
    afters: [],
    attachments: normalizeAttachments(parsed.attachments),
  };
}

/**
 * allure 的 `description` 有两种合法形状：纯字符串，或 `{content, type}`（allure-java
 * 的大多数字段都是这个二态）。两种都收，Markdown 类型也当纯文本回——报告页只做
 * `white-space: pre-wrap` 展示，不在平台里引入 Markdown 渲染器（边界 19：不 vendor
 * allure 的展示层，也不替它发明一个）。
 */
function normalizeDescription(raw: unknown): string | null {
  if (typeof raw === "string" && raw.length) return raw.slice(0, 8000);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const content = (raw as Record<string, unknown>).content;
    if (typeof content === "string" && content.length) return content.slice(0, 8000);
  }
  return null;
}

function normalizeFixture(raw: unknown): ReportViewFixture | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const counter = { count: 0 };
  const steps: ReportStep[] = [];
  for (const child of Array.isArray(record.steps) ? record.steps : []) {
    const normalized = normalizeStep(child, 0, counter);
    if (normalized) steps.push(normalized);
  }
  const start = asTimestamp(record.start);
  const stop = asTimestamp(record.stop);
  const type = asString(record.type) === "after" ? "after" : "before";
  return {
    name: asString(record.name).slice(0, 512) || "(unnamed fixture)",
    type,
    status: asString(record.status) || "unknown",
    ...(start !== undefined ? { start } : {}),
    ...(stop !== undefined ? { stop } : {}),
    steps,
    attachments: normalizeAttachments(record.attachments),
  };
}

function normalizeContainer(parsed: Record<string, unknown>): ReportViewContainer {
  const childrenRaw = Array.isArray(parsed.children) ? parsed.children : [];
  const children: string[] = [];
  for (const each of childrenRaw) {
    if (typeof each === "string" && each) children.push(each.slice(0, 128));
  }
  const befores: ReportViewFixture[] = [];
  for (const each of Array.isArray(parsed.befores) ? parsed.befores : []) {
    const normalized = normalizeFixture(each);
    if (normalized) befores.push(normalized);
  }
  const afters: ReportViewFixture[] = [];
  for (const each of Array.isArray(parsed.afters) ? parsed.afters : []) {
    const normalized = normalizeFixture(each);
    if (normalized) afters.push(normalized);
  }
  return {
    uid: asString(parsed.uid).slice(0, 128) || children.join(","),
    children,
    befores,
    afters,
  };
}
