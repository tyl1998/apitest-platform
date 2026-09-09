import type { SpecImportPriority, XmindNormalizedCase } from "./xmind.js";

/**
 * Excel 固定模板（P7-5，计划 11.0 边界 5）：解析 + 模板生成 + 导出，全走
 * `exceljs` 且**按需 `import()`**——照 `lib/adapters/index.ts` 与 `@aws-sdk`
 * 的先例，不为一个低频动作把 78 个包拖进 API 进程的启动路径。运行时形状已
 * 实测（NodeNext ESM 下 CJS 互操作）：`import("exceljs")` 的 `default` 才是
 * 命名空间本体，`mod.Workbook` 是 undefined。
 *
 * 列固定为八列（模板是平台发的契约，不做列映射）：
 * `模块路径 | 用例编号 | 用例标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 标签`
 * （「模块路径」读法对齐 P7-2 的词汇统一——计划原文的「目录路径」按此对齐。）
 *
 * 解析语义（一并在模板的示例行里演示）：
 * - **一行一步骤**：同一用例的多行靠「用例编号」或「(模块路径, 用例标题)」
 *   归组；三格全空的行是续行（继承上一组）。单元格合并也自然落进这个语义
 *   ——合并后只有左上有值，其余读空。
 * - 前置条件 / 优先级 / 标签取组内**首个非空**值；步骤列非空的行各贡献一步。
 * - 模块路径用 `/` 分隔多级；段级清洗与 XMind 路径同一条纪律（`/`→`／`、
 *   换行压空格、深度截 6 并标记 pathClamped——预览里看得见，否则「目录少了
 *   一层」读作丢数据）。
 * - 标签用 `,`／`，`／`、`／`;` 分隔。
 * - 模板是平台契约，行级数据错误（缺标题 / 缺模块路径 / 优先级不合法）**整
 *   份拒**并指名行号（验收 5 的「明确报错」）——静默吞掉或半份导入都会让
 *   「模板往返」失去意义。
 */

/** 用得着才向上抛的格式错误：路由层映射成 400 + 1001，而不是 500。 */
export class ExcelFormatError extends Error {}

/** exceljs 的 CJS 互操作形状（见文件头注释）。 */
type ExcelModule = { default: { Workbook: new () => ExcelWorkbook } };
type ExcelWorkbook = {
  worksheets: ExcelWorksheet[];
  xlsx: {
    load(buffer: Buffer): Promise<unknown>;
    writeBuffer(): Promise<unknown>;
  };
};
type ExcelWorksheet = {
  name: string;
  eachRow(callback: (row: ExcelRow, number: number) => void): void;
  getRow(number: number): ExcelRow;
  addRow(row: string[]): void;
  columns?: { header?: string; width?: number }[];
};
type ExcelRow = {
  values: unknown[];
  font?: unknown;
  fill?: unknown;
  alignment?: unknown;
};

/** 模板八列（顺序即列序；解析按表头名映射，不依赖位置）。 */
const TEMPLATE_HEADERS = ["模块路径", "用例编号", "用例标题", "前置条件", "步骤", "预期结果", "优先级", "标签"] as const;

const PRIORITIES: SpecImportPriority[] = ["P0", "P1", "P2", "P3"];

/** 行数护栏：2000 条用例上限（边界 7）× 每条几行的真实量级之外再留一档余量。 */
const MAX_ROWS = 20000;

/** Excel 单元格 32767 字符硬上限之内留的截断线（防御性——正常步骤远够）。 */
const CELL_CHAR_LIMIT = 32000;

async function loadExceljs(): Promise<ExcelModule> {
  try {
    return (await import("exceljs")) as unknown as ExcelModule;
  } catch {
    /* 装包失败不该是 500：exceljs 是本路由的专属依赖，缺了就是明确的环境问题。 */
    throw new ExcelFormatError("exceljs could not be loaded — check the server installation");
  }
}

/** 单元格值 → 文本：exceljs 的值形状有 string / number / boolean / Date / 富文本 / 公式 / 超链接。 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.richText)) {
      return record.richText.map((part) => String((part as { text?: unknown })?.text ?? "")).join("");
    }
    if (typeof record.text === "string") return record.text;
    if (record.result !== undefined) return cellText(record.result);
    if (typeof record.hyperlink === "string") return record.hyperlink;
    if (record.error !== undefined) return "";
  }
  return String(value);
}

/** 与 xmind.ts 的 cleanText 同一条纪律：NUL 剥掉（Postgres text 存不了 \0）、\r 归一。 */
function cleanText(raw: string): string {
  return raw.replace(/\0/g, "").replace(/\r\n?/g, "\n");
}

/** 与 xmind.ts 的 moduleSegment 同款段级清洗：`/` → 全角、换行压空格。 */
function moduleSegment(raw: string): string {
  return cleanText(raw).replace(/\//g, "／").replace(/[\n]+/g, " ").trim();
}

/** 表头行定位：前 10 行内找「用例标题」（最独特的列名）。找不到 = 不是本平台的模板。 */
function findHeaderRow(sheet: ExcelWorksheet): { number: number; columns: Map<string, number> } | undefined {
  for (let rowNumber = 1; rowNumber <= 10; rowNumber++) {
    const values = sheet.getRow(rowNumber).values ?? [];
    const columns = new Map<string, number>();
    for (let column = 1; column < values.length; column++) {
      const text = cellText(values[column]).trim();
      if (text && TEMPLATE_HEADERS.includes(text as (typeof TEMPLATE_HEADERS)[number]) && !columns.has(text)) {
        columns.set(text, column);
      }
    }
    if (columns.has("用例标题")) return { number: rowNumber, columns };
  }
  return undefined;
}

/**
 * 解析 .xlsx（固定模板）。返回与 XMind 归一层同一个形状，preview 的判定流
 * 零分叉。`rootPrefix`（可选，DB 形态 '/目录1/'）与 XMind 导入同语义：整份
 * 文件的模块路径挂到它下面（深度截断按最终路径算）；缺省 '/' 即不挂前缀。
 * 注意：选中根目录**不豁免**模块路径列——文件自带路径是模板契约，空路径行
 * 指名行号拒绝，不做「挂到所选根目录」的隐式魔法。
 */
export async function parseExcelCases(buffer: Buffer, rootPrefix = "/"): Promise<XmindNormalizedCase[]> {
  const ExcelJS = await loadExceljs();
  const workbook = new ExcelJS.default.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new ExcelFormatError("not a readable .xlsx file — it may be corrupted or not an Excel workbook");
  }
  if (!workbook.worksheets.length) throw new ExcelFormatError("the workbook has no sheets");

  /* 多 sheet：**每个**带合法表头的工作表都解析（导出按 1 级目录分 sheet，
     2026-09-08 用户要求——回导必须整本收回来，闭环才不断；用户加的「填写
     说明」sheet 没有表头，天然不参与）。 */
  const dataSheets = workbook.worksheets
    .map((candidate) => ({ sheet: candidate, header: findHeaderRow(candidate) }))
    .filter((each): each is { sheet: ExcelWorksheet; header: { number: number; columns: Map<string, number> } } => each.header !== undefined);
  if (!dataSheets.length) {
    throw new ExcelFormatError(`header row not found — the template must contain these columns: ${TEMPLATE_HEADERS.join(" / ")}`);
  }
  /* 错误消息只在多表文件里带 sheet 名——单表（模板）带着是噪音。 */
  const multiSheet = dataSheets.length > 1;

  /* 前缀段先过一遍 moduleSegment：路径来自自家 DB，本就干净，这里是防御性归一。 */
  const baseSegments = rootPrefix.split("/").map(moduleSegment).filter(Boolean);
  const errors: string[] = [];

  /* 行 → 组：编号优先，回落 (模块路径, 标题)；三格全空 = 续行。归组跨 sheet
     连续（编号同键的两张表各一行 = 同一条用例的两个步骤）。 */
  type Group = {
    modulePath: string | null;
    itemKey: string | null;
    title: string;
    preconditions: string;
    priority: SpecImportPriority;
    tags: string[];
    pathClamped: boolean;
    steps: { step: string; expected: string }[];
  };
  const groups: Group[] = [];
  let rowCount = 0;

  for (const { sheet, header } of dataSheets) {
    const columnOf = (name: string): number => header.columns.get(name) ?? 0;
    const rowError = (rowNumber: number, message: string): void => {
      if (errors.length < 5) errors.push(`${multiSheet ? `sheet「${sheet.name}」` : ""}row ${rowNumber}: ${message}`);
    };

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= header.number) return;
      if (++rowCount > MAX_ROWS) throw new ExcelFormatError(`the workbook has more than ${MAX_ROWS} data rows — split the file`);
      const values = row.values ?? [];
      const text = (name: string): string => cleanText(cellText(values[columnOf(name)] ?? null)).trim();

      const modulePathRaw = text("模块路径");
      const itemKeyRaw = text("用例编号").slice(0, 64);
      const title = text("用例标题");
      const step = text("步骤");
      const expected = text("预期结果");

      if (!modulePathRaw && !itemKeyRaw && !title && !step && !expected && !text("前置条件") && !text("优先级") && !text("标签")) {
        return; /* 整行空白（含样式行）：跳过。 */
      }

      const isContinuation = !modulePathRaw && !itemKeyRaw && !title;
      let group: Group | undefined;
      if (isContinuation) {
        /* 续行（三格全空）＝ 上一组：合并单元格 / 手写省略都落在这个语义里。 */
        group = groups[groups.length - 1];
      } else if (itemKeyRaw) {
        group = groups.find((each) => each.itemKey === itemKeyRaw);
      } else {
        group = groups.find((each) => !each.itemKey && each.title === title && (each.modulePath ?? "") === modulePathRaw);
      }

      if (group) {
        /* 组内首个非空的前置条件：首行没写、续行补上也认（模板往返对称）。 */
        if (!group.preconditions.trim()) {
          const preconditions = cleanText(cellText(values[columnOf("前置条件")] ?? null));
          if (preconditions.trim()) group.preconditions = preconditions;
        }
      } else {
        /* 新组：模块路径 / 标题 / 优先级在这里一次校验（模板契约——指名行号整份拒）。 */
        const segments = modulePathRaw
          .split("/")
          .map(moduleSegment)
          .filter(Boolean);
        if (!segments.length) { rowError(rowNumber, "模块路径 is required (use / to separate levels)"); return; }
        if (!title) { rowError(rowNumber, "用例标题 is required"); return; }
        const priorityRaw = text("优先级").toUpperCase();
        let priority: SpecImportPriority = "P2";
        if (priorityRaw) {
          if (!(PRIORITIES as string[]).includes(priorityRaw)) { rowError(rowNumber, `优先级 must be one of ${PRIORITIES.join(" / ")} (got "${priorityRaw}")`); return; }
          priority = priorityRaw as SpecImportPriority;
        }
        const pathClamped = [...baseSegments, ...segments].length > 6;
        group = {
          modulePath: `/${[...baseSegments, ...segments].slice(0, 6).join("/")}/`,
          itemKey: itemKeyRaw || null,
          title,
          preconditions: cleanText(cellText(values[columnOf("前置条件")] ?? null)),
          priority,
          tags: text("标签").split(/[,，、;；]/).map((tag) => tag.trim()).filter(Boolean),
          pathClamped,
          steps: [],
        };
        groups.push(group);
      }

      if (step || expected) {
        /* step / expected 都出自 text()（clean + trim）——与手工路径的步骤归一同口径。 */
        group.steps.push({ step, expected });
      }
    });
  }

  if (errors.length) {
    throw new ExcelFormatError(`the workbook has invalid rows — ${errors.join("; ")}${errors.length >= 5 ? " …" : ""}`);
  }

  return groups.map((group) => ({
    modulePath: group.modulePath!,
    title: group.title,
    preconditions: group.preconditions,
    steps: group.steps.filter((each) => each.step !== "" || each.expected !== ""),
    priority: group.priority,
    tags: group.tags,
    itemKey: group.itemKey,
    pathClamped: group.pathClamped,
  }));
}

/** 导出 / 模板共用的行形状（DB 行经 mapSpecCase 后的字段子集）。 */
export type ExcelExportCase = {
  modulePath: string;
  itemKey?: string;
  title: string;
  preconditions: string;
  steps: { step: string; expected: string }[];
  priority: SpecImportPriority;
  tags: string[];
};

/** '/A/B/' → 'A/B'：与用例库列表的模块路径列同一展示口径（解析两种形态都收）。 */
export function displayPath(path: string): string {
  return path.replace(/^\//, "").replace(/\/$/, "");
}

function cellValue(text: string): string {
  /* 32767 是 Excel 硬上限；截断加尾标，不静默截。 */
  return text.length > CELL_CHAR_LIMIT ? `${text.slice(0, CELL_CHAR_LIMIT)}…(truncated)` : text;
}

/**
 * Excel sheet 名的合法化：≤31 字符、不含 `: \ / ? * [ ]`、首尾不留 `'`、全簿
 * 唯一（模块名可以撞这些约束——清洗 + `~N` 去重，撞名后缀保唯一）。
 */
function sheetName(name: string, used: Set<string>): string {
  const clean = name.replace(/^'+|'+$/g, "").replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31) || "用例";
  let candidate = clean;
  let suffix = 2;
  while (used.has(candidate)) {
    const tag = `~${suffix}`;
    candidate = clean.slice(0, 31 - tag.length) + tag;
    suffix++;
  }
  used.add(candidate);
  return candidate;
}

type ExcelSheetData = { name: string; rows: string[][] };

async function buildWorkbook(sheets: ExcelSheetData[]): Promise<Buffer> {
  const ExcelJS = await loadExceljs();
  const workbook = new ExcelJS.default.Workbook();
  /* Excel 工作簿至少要有一张表：空导出（0 条命中）也给一张带表头的空表，
     用户拿到文件能看懂「导出了 0 条」而不是打不开。 */
  const dataSheets = sheets.length ? sheets : [{ name: "用例", rows: [] as string[][] }];
  const used = new Set<string>();
  for (const sheetData of dataSheets) {
    const sheet = workbook.addWorksheet(sheetName(sheetData.name, used));
    sheet.columns = [
      { header: TEMPLATE_HEADERS[0], width: 34 },
      { header: TEMPLATE_HEADERS[1], width: 12 },
      { header: TEMPLATE_HEADERS[2], width: 36 },
      { header: TEMPLATE_HEADERS[3], width: 30 },
      { header: TEMPLATE_HEADERS[4], width: 34 },
      { header: TEMPLATE_HEADERS[5], width: 34 },
      { header: TEMPLATE_HEADERS[6], width: 9 },
      { header: TEMPLATE_HEADERS[7], width: 18 },
    ];
    for (const row of sheetData.rows) {
      sheet.addRow(row.map(cellValue));
    }
    /* 表头行加粗 + 浅底 + 顶端对齐（长文本不撑行高）；数据行统一顶端对齐。 */
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF3" } };
    headerRow.alignment = { vertical: "top" };
    for (let number = 2; number <= sheetData.rows.length + 1; number++) {
      sheet.getRow(number).alignment = { vertical: "top", wrapText: true };
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer);
}

/**
 * 模板下载（边界 5「平台提供模板下载」）：单表 + 三行示例——一个多步骤用例
 * （两行，演示「一行一步骤」的续行写法）+ 一个单行无步骤用例。示例行落在
 * 「示例模块」下并冠「示例：」前缀，用户忘了删也能一眼认出。
 */
export async function buildExcelTemplate(): Promise<Buffer> {
  return buildWorkbook([
    {
      name: "用例",
      rows: [
        ["登录模块", "TC-001", "示例：正确密码登录成功", "示例账号已存在且未锁定", "打开登录页，输入正确账号与密码", "登录成功，跳转首页", "P0", "冒烟,回归"],
        ["登录模块", "TC-001", "示例：正确密码登录成功", "", "退出登录", "回到登录页", "P0", ""],
        ["示例模块", "", "示例：只有前置没有步骤的用例", "这是一条说明性用例", "", "", "P2", "说明"],
      ],
    },
  ]);
}

/**
 * 用例导出（2026-09-08 用户要求）：与模板同列；**按 1 级目录分 sheet**（与
 * XMind 导出同构——每个 top 模块一张表，翻表即换模块）。注意分 sheet 只是
 * **组织形态**：模块路径列仍写全路径（`登录模块/异常`），回导按列还原、不读
 * sheet 名——一张表里跨模块的行也照常解析。「一行一步骤」且每行自带全部字段
 * （Excel 里筛序不依赖上下行）；无步骤用例占一行（步骤 / 预期留空，回导按空
 * 步骤行解析回原形）。编号原样带出：回导按编号判重（边界 7），不填编号的行
 * 回导时由服务端重新取号。
 */
export async function buildExcelExport(cases: ExcelExportCase[]): Promise<Buffer> {
  /* 1 级目录 → 行集；cases 已按 m.path 排序，首现序即 path 序（与 XMind 的
     sheet 顺序同口径）。 */
  const byTop = new Map<string, string[][]>();
  for (const each of cases) {
    const top = each.modulePath.split("/").filter(Boolean)[0] ?? "用例";
    let rows = byTop.get(top);
    if (!rows) { rows = []; byTop.set(top, rows); }
    const base = [
      displayPath(each.modulePath),
      each.itemKey ?? "",
      each.title,
      each.preconditions,
    ];
    if (!each.steps.length) {
      rows.push([...base, "", "", each.priority, each.tags.join(",")]);
      continue;
    }
    for (const step of each.steps) {
      rows.push([...base, step.step, step.expected, each.priority, each.tags.join(",")]);
    }
  }
  return buildWorkbook([...byTop.entries()].map(([name, rows]) => ({ name, rows })));
}
