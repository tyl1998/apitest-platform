import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireProjectAccess } from "../lib/rbac.js";
import { fail, success } from "../lib/response.js";
import { isUuid } from "../lib/uuid.js";
import {
  normalizeXmindCases, parseXmindWorkbook, XmindFormatError,
  type SpecImportPriority, type XmindNormalizedCase, type XmindParseResult,
} from "../lib/xmind.js";
import { buildExcelTemplate, ExcelFormatError, parseExcelCases } from "../lib/excel.js";
import { buildXmindTemplate } from "../lib/xmindWriter.js";

/**
 * 文本用例导入（P7-4/P7-5，计划 11.0 边界 6/7）：两阶段 preview → commit。
 *
 * - **preview**：`.xmind` / `.xlsx` 原始流上传（`application/octet-stream`，照
 *   Runner 产物直传的写法，不引 `@fastify/multipart`——两个文件类型、没有多
 *   文件场景），内存解析 + 逐条判定（新增 / 已存在未变 / 已存在有变 / 文件内
 *   重复），不落库。`rootModuleId`（可选）＝用户选定的导入根目录：整份文件
 *   挂到该模块下（`/选中目录/文件根/…/`），不传则按文件自身结构（根节点标题
 *   为顶层模块）。
 * - **commit**：提交用户确认后的归一化 JSON（前端持有，不落暂存表——所以
 *   **文件不进对象存储**，S3 / 本地存储都不参与导入链路；将来若要留源文件
 *   存档，走 `lib/objectStore.ts` 那套抽象另起一个批次）。
 *
 * 判重键（边界 7 + 2026-09-07 增补）：优先「用例编号」（`item_key`，Excel 导入
 * 才有编号位，XMind 两代格式都无）；无编号回落 `(模块路径, 标题)`——改标题会
 * 变成新用例，预览页明说。文件带的编号与已生成的 `TC-###` 撞键时按「已存在
 * 有变」处理；**无编号行插入时统一走服务端 TC- 序列取号**，与手工建用例同一
 * 个序列。
 *
 * 层级映射只有 `tc:` 标记一种（2026-09-08 用户收窄：「叶子即用例」解析出来的
 * 全是碎片，删掉；没有 tc 约定的文件就是 0 条，如实返回）。
 */

/** 上传体积上限（验收 5）：路线级 bodyLimit + 流式读取双保险。 */
const IMPORT_UPLOAD_LIMIT = 8 * 1024 * 1024;

/** 单次导入用例上限（边界 7）。preview 超限只标记不拒绝——先把模式选对。 */
const IMPORT_MAX_CASES = 2000;

/** commit 的 JSON 载荷上限：2000 条 × 长步骤的真实量级，默认 1MB 盛不下。 */
const IMPORT_COMMIT_BODY_LIMIT = 16 * 1024 * 1024;

const PRIORITIES: SpecImportPriority[] = ["P0", "P1", "P2", "P3"];

type ImportCase = {
  modulePath: string;
  title: string;
  preconditions: string;
  steps: { step: string; expected: string }[];
  priority: SpecImportPriority;
  tags: string[];
  itemKey: string | null;
};

type ExistingCaseRow = {
  id: string;
  itemKey: string | null;
  title: string;
  preconditions: string;
  steps: unknown;
  priority: string;
  tags: string[];
  modulePath: string;
};

/** 与手工路径同一条纪律：NUL 剥掉、\r 归一（文件解析侧已做，这里防直发客户端）。 */
function cleanText(raw: string): string {
  return raw.replace(/\0/g, "").replace(/\r\n?/g, "\n");
}

/**
 * commit 入参的校验 + 归一（形状照 `specCases.ts` 的 validateSpecCase /
 * normalizeSteps，另加 modulePath 的段级清洗：`/` → `／`、换行压空格、
 * 深度钳到 6）。返回消息串表示拒绝；preview 产物天然过这套校验。
 */
function readImportCase(raw: Record<string, unknown>): { error?: string; value?: ImportCase } {
  const title = typeof raw.title === "string" ? cleanText(raw.title).trim() : "";
  if (!title) return { error: "title is required" };
  const preconditions = typeof raw.preconditions === "string" ? cleanText(raw.preconditions) : "";

  let steps: { step: string; expected: string }[] = [];
  if (raw.steps !== undefined && raw.steps !== null) {
    if (!Array.isArray(raw.steps)) return { error: "steps must be an array" };
    for (const item of raw.steps) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return { error: "each step must be an object" };
      const record = item as { step?: unknown; expected?: unknown };
      if (record.step !== undefined && typeof record.step !== "string") return { error: "step text must be a string" };
      if (record.expected !== undefined && typeof record.expected !== "string") return { error: "expected text must be a string" };
      steps.push({ step: cleanText(String(record.step ?? "")), expected: cleanText(String(record.expected ?? "")) });
    }
    /* 两列全空的行丢弃（行内表格极易留空行）——与手工路径同一规则两端各持一份。 */
    steps = steps.filter((row) => row.step.trim() !== "" || row.expected.trim() !== "");
  }

  const priority = raw.priority === undefined || raw.priority === null ? "P2" : String(raw.priority);
  if (!(PRIORITIES as string[]).includes(priority)) return { error: `priority must be one of ${PRIORITIES.join(", ")}` };

  let tags: string[] = [];
  if (raw.tags !== undefined && raw.tags !== null) {
    if (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== "string")) return { error: "tags must be an array of strings" };
    tags = (raw.tags as string[]).map((tag) => cleanText(tag).trim()).filter(Boolean);
  }

  let itemKey: string | null = null;
  if (raw.itemKey !== undefined && raw.itemKey !== null && String(raw.itemKey).trim() !== "") {
    itemKey = String(raw.itemKey).trim().slice(0, 64);
  }

  const rawPath = typeof raw.modulePath === "string" ? raw.modulePath : "";
  const segments = rawPath
    .split("/")
    .map((segment) => cleanText(segment).replace(/\//g, "／").replace(/[\n]+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);
  if (!segments.length) return { error: "modulePath must resolve to at least one module level" };

  return { value: { modulePath: `/${segments.join("/")}/`, title, preconditions, steps, priority: priority as SpecImportPriority, tags, itemKey } };
}

/** DB 行的步骤归一（jsonb 不信形状，读成 [{step, expected}]，两列全空丢弃）。 */
function dbSteps(raw: unknown): { step: string; expected: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      step: String((item as { step?: unknown })?.step ?? ""),
      expected: String((item as { expected?: unknown })?.expected ?? ""),
    }))
    .filter((row) => row.step.trim() !== "" || row.expected.trim() !== "");
}

/** 「已存在未变」的比较面：内容五字段 + 模块路径。status / source / 绑定不比。 */
function sameCase(incoming: ImportCase, row: ExistingCaseRow): boolean {
  return row.title === incoming.title
    && row.preconditions === incoming.preconditions
    && JSON.stringify(dbSteps(row.steps)) === JSON.stringify(incoming.steps)
    && row.priority === incoming.priority
    && (row.tags ?? []).join("\u0001") === incoming.tags.join("\u0001")
    && row.modulePath === incoming.modulePath;
}

function mapExistingRow(row: Record<string, unknown>): ExistingCaseRow {
  return {
    id: String(row.id),
    itemKey: row.item_key === null || row.item_key === undefined ? null : String(row.item_key),
    title: String(row.title ?? ""),
    preconditions: String(row.preconditions ?? ""),
    steps: row.steps,
    priority: String(row.priority ?? "P2"),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    modulePath: String(row.module_path ?? ""),
  };
}

/** 判重候选拉取：编号命中或标题命中（路径在内存里精确比对），一条 SQL 出全量。 */
async function loadExistingCases(projectId: string, itemKeys: string[], titles: string[]): Promise<Map<string, ExistingCaseRow>[]> {
  const result = await pool.query(
    `SELECT c.id, c.item_key, c.title, c.preconditions, c.steps, c.priority, c.tags, m.path AS module_path
       FROM spec_cases c JOIN spec_modules m ON m.id = c.module_id
      WHERE c.project_id = $1 AND (c.item_key = ANY($2::text[]) OR c.title = ANY($3::text[]))`,
    [projectId, itemKeys, titles],
  );
  const rows = result.rows.map(mapExistingRow);
  const byKey = new Map<string, ExistingCaseRow>();
  const byPathTitle = new Map<string, ExistingCaseRow>();
  for (const row of rows) {
    if (row.itemKey !== null && !byKey.has(row.itemKey)) byKey.set(row.itemKey, row);
    /* 同 (path,title) 多行（历史允许）取第一行：判重只回答「是否已存在」。 */
    const pathTitleKey = `${row.modulePath}\u0001${row.title}`;
    if (!byPathTitle.has(pathTitleKey)) byPathTitle.set(pathTitleKey, row);
  }
  return [byKey, byPathTitle];
}

async function readRawBody(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    /* Fastify 的 octet-stream parser 给的是 Buffer；万一有 string chunk（Node 流的
       通用形状）也收进 Buffer。断言只写 string——`ArrayBufferLike` 会让 Buffer.from
       的重载匹配不上（TS lib 的新版把 ArrayBuffer 从重载里拆出去了）。 */
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += piece.length;
    if (total > limit) throw new Error(`file exceeds the ${Math.round(limit / (1024 * 1024))}MB import limit`);
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

export async function specImportRoutes(app: FastifyInstance) {
  /* 与 runners.ts 同款且同理由：octet-stream 原样放行，request.raw 是事实源。
     必须在本插件内注册——Fastify 插件封装作用域，runners 那份不跨作用域。 */
  app.addContentTypeParser("application/octet-stream", (_request, body, done) => {
    done(null, body);
  });

  /**
   * 模板下载（P7-5，边界 5「平台提供模板下载」；`?format=xmind` 是 2026-09-08
   * 用户增补——XMind 的导入约定靠示例演示比靠文档读快）：读权限即可——模板不
   * 含任何项目数据，viewer 拿去准备文件没有越权面。裸二进制流 + attachment
   * （与日志下载同款例外：二进制下载不走 envelope）；文件名 ASCII 保底，前端
   * 下载时以本地化名另存。
   */
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/api/v1/projects/:id/spec-cases/import/template", async (request, reply) => {
    const context = await requireProjectAccess(request, reply);
    if (!context) return;
    /* 缺省 excel（第一个模板形态）；给了值就只认这两个——错拼静默回落会把
        「我要 XMind 却下到 Excel」藏起来。 */
    const format = request.query.format ?? "excel";
    if (format !== "excel" && format !== "xmind") return fail(reply, 400, 1001, "format must be excel or xmind");
    if (format === "xmind") {
      reply.header("content-type", "application/octet-stream");
      reply.header("content-disposition", 'attachment; filename="spec-cases-template.xmind"');
      return reply.send(buildXmindTemplate());
    }
    const buffer = await buildExcelTemplate();
    reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("content-disposition", 'attachment; filename="spec-cases-template.xlsx"');
    return reply.send(buffer);
  });

  /**
   * 预览（写权限——上传解析是导入动作的一半，viewer 不该能向平台投喂任意文件）。
   * 不落库、不落暂存表：归一化结果由前端持有，commit 时原样带回。超 2000 条
   * **不在这里拒绝**（标记 exceededLimit）：先让用户看到计数，拆分文件后分批
   * 导，而不是一头撞死在报错上。
   */
  app.post<{ Params: { id: string }; Querystring: { filename?: string; rootModuleId?: string } }>(
    "/api/v1/projects/:id/spec-cases/import/preview",
    { bodyLimit: IMPORT_UPLOAD_LIMIT },
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, true);
      if (!context) return;

      /* content-length 先拒（bodyLimit 对流式体不一定拦得住，双保险在流上还有一道）。 */
      const declared = Number(request.headers["content-length"] ?? NaN);
      if (Number.isFinite(declared) && declared > IMPORT_UPLOAD_LIMIT) {
        return fail(reply, 400, 1001, "file exceeds the 8MB import limit");
      }
      let buffer: Buffer;
      try {
        buffer = await readRawBody(request.raw, IMPORT_UPLOAD_LIMIT);
      } catch (error) {
        return fail(reply, 400, 1001, error instanceof Error ? error.message : "upload could not be read");
      }
      if (!buffer.length) return fail(reply, 400, 1001, "uploaded file is empty");

      /* 白名单扩展名（验收 5）：解析之前拒，不是读完再静默。P7-5 起 .xlsx 走
          固定模板解析（exceljs 按需导入）。 */
      const filename = (request.query.filename ?? "").trim();
      const isExcel = /\.xlsx$/i.test(filename);
      if (!isExcel && !/\.xmind$/i.test(filename)) {
        return fail(reply, 400, 1001, "only .xmind and .xlsx files are supported");
      }

      /* 导入根目录（可选）：不传 = 按文件自身结构。先验 uuid 再查归属（规则 5），
          引用照 suites / specCases 的先例给 400 + 1001，404 只留给 URL 资源本身。 */
      let rootPrefix = "/";
      if (request.query.rootModuleId) {
        if (!isUuid(request.query.rootModuleId)) return fail(reply, 400, 1001, "rootModuleId must be a UUID");
        const rootModule = await pool.query(
          "SELECT id, path FROM spec_modules WHERE id = $1 AND project_id = $2",
          [request.query.rootModuleId, context.project.id],
        );
        if (!rootModule.rowCount) return fail(reply, 400, 1001, "root module not found in this project");
        rootPrefix = String(rootModule.rows[0].path);
      }

      let normalized: XmindNormalizedCase[];
      let format: "json" | "xml" | "excel";
      if (isExcel) {
        try {
          normalized = await parseExcelCases(buffer, rootPrefix);
        } catch (error) {
          if (error instanceof ExcelFormatError) return fail(reply, 400, 1001, error.message);
          throw error;
        }
        format = "excel";
      } else {
        let parsed: XmindParseResult;
        try {
          parsed = parseXmindWorkbook(buffer);
        } catch (error) {
          if (error instanceof XmindFormatError) return fail(reply, 400, 1001, error.message);
          throw error;
        }
        normalized = normalizeXmindCases(parsed, filename.replace(/\.xmind$/i, ""), rootPrefix);
        format = parsed.format;
      }

      /* 文件内判重（同一 (路径,标题) 或同编号出现两次：后者只进「重复」，不二次落库）
         + 库内判定。编号优先：撞上已生成的 TC-### 按「已存在（未变/有变）」走。 */
      const itemKeys = [...new Set(normalized.map((each) => each.itemKey).filter((key): key is string => Boolean(key)))];
      const titles = [...new Set(normalized.map((each) => each.title).filter(Boolean))];
      const [byKey, byPathTitle] = await loadExistingCases(context.project.id, itemKeys, titles);

      const seenPathTitles = new Set<string>();
      const seenKeys = new Set<string>();
      const judged = normalized.map((each) => {
        const pathTitleKey = `${each.modulePath}\u0001${each.title}`;
        const inFileDuplicate = (each.itemKey !== null && seenKeys.has(each.itemKey)) || seenPathTitles.has(pathTitleKey);
        if (each.itemKey !== null) seenKeys.add(each.itemKey);
        seenPathTitles.add(pathTitleKey);

        if (inFileDuplicate) return { ...each, judgment: "duplicate" as const };
        const row = (each.itemKey !== null ? byKey.get(each.itemKey) : undefined) ?? byPathTitle.get(pathTitleKey);
        if (!row) return { ...each, judgment: "new" as const };
        return { ...each, judgment: sameCase(each, row) ? ("unchanged" as const) : ("changed" as const), existingId: row.id };
      });

      const counts = {
        total: judged.length,
        new: judged.filter((each) => each.judgment === "new").length,
        unchanged: judged.filter((each) => each.judgment === "unchanged").length,
        changed: judged.filter((each) => each.judgment === "changed").length,
        duplicate: judged.filter((each) => each.judgment === "duplicate").length,
      };
      return success({
        format,
        cases: judged,
        summary: { ...counts, exceededLimit: counts.total > IMPORT_MAX_CASES },
      });
    },
  );

  /**
   * 提交（写权限）。判定**不信任客户端**：预览到提交之间库可能已变（别人先导了
   * 一份），同一套判重在事务里重跑一遍。整个提交一个事务：模块补建 + 用例
   * 插入/更新要么全成要么全不动——导一半失败留下一堆模块是下次导入的坑。
   */
  app.post<{ Params: { id: string }; Body: { source?: string; cases?: unknown } }>(
    "/api/v1/projects/:id/spec-cases/import",
    { bodyLimit: IMPORT_COMMIT_BODY_LIMIT },
    async (request, reply) => {
      const context = await requireProjectAccess(request, reply, true);
      if (!context) return;
      const body = request.body ?? {};
      const source = body.source === "excel" ? "excel" : "xmind";
      if (!Array.isArray(body.cases) || !body.cases.length) return fail(reply, 400, 1001, "cases are required");
      if (body.cases.length > IMPORT_MAX_CASES) return fail(reply, 400, 1001, `imports are capped at ${IMPORT_MAX_CASES} cases per run`);

      const cases: ImportCase[] = [];
      for (const [index, raw] of body.cases.entries()) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail(reply, 400, 1001, `cases[${index}]: each case must be an object`);
        const { error, value } = readImportCase(raw as Record<string, unknown>);
        if (error || !value) return fail(reply, 400, 1001, `cases[${index}]: ${error ?? "case is invalid"}`);
        cases.push(value);
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        /* 1. 模块解析：全量读回 + 逐前缀补建。ON CONFLICT DO NOTHING 兜并发导入
              （READ COMMITTED 下冲突行提交后重查即可见）；父级在前缀步进中必然已就位。 */
        const modulesResult = await client.query("SELECT id, path FROM spec_modules WHERE project_id = $1", [context.project.id]);
        const modulesByPath = new Map<string, string>(modulesResult.rows.map((row: Record<string, unknown>) => [String(row.path), String(row.id)]));
        let modulesCreated = 0;

        const distinctPaths = [...new Set(cases.map((each) => each.modulePath))];
        /* 段数少者在前：同一条链的前缀按层就位；跨链顺序无关（各自独立补齐）。 */
        distinctPaths.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
        for (const path of distinctPaths) {
          const segments = path.split("/").filter(Boolean);
          for (let depth = 1; depth <= segments.length; depth++) {
            const prefix = `/${segments.slice(0, depth).join("/")}/`;
            if (modulesByPath.has(prefix)) continue;
            const parentId = depth === 1 ? null : modulesByPath.get(`/${segments.slice(0, depth - 1).join("/")}/`) ?? null;
            const inserted = await client.query(
              `INSERT INTO spec_modules (id, project_id, parent_id, name, path, position)
               VALUES ($1, $2, $3, $4, $5, 0)
               ON CONFLICT (project_id, path) DO NOTHING RETURNING id`,
              [randomUUID(), context.project.id, parentId, segments[depth - 1], prefix],
            );
            let moduleId = inserted.rowCount ? String(inserted.rows[0].id) : undefined;
            if (!moduleId) {
              const raced = await client.query("SELECT id FROM spec_modules WHERE project_id = $1 AND path = $2", [context.project.id, prefix]);
              if (!raced.rowCount) throw new Error(`module ${prefix} disappeared mid-import`);
              moduleId = String(raced.rows[0].id);
            } else {
              modulesCreated++;
            }
            modulesByPath.set(prefix, moduleId);
          }
        }

        /* 2. 判重重跑（不信客户端的预览判定）。 */
        const itemKeys = [...new Set(cases.map((each) => each.itemKey).filter((key): key is string => Boolean(key)))];
        const titles = [...new Set(cases.map((each) => each.title))];
        const existing = await client.query(
          `SELECT c.id, c.item_key, c.title, c.preconditions, c.steps, c.priority, c.tags, m.path AS module_path
             FROM spec_cases c JOIN spec_modules m ON m.id = c.module_id
            WHERE c.project_id = $1 AND (c.item_key = ANY($2::text[]) OR c.title = ANY($3::text[]))`,
          [context.project.id, itemKeys, titles],
        );
        const byKey = new Map<string, ExistingCaseRow>();
        const byPathTitle = new Map<string, ExistingCaseRow>();
        for (const raw of existing.rows as Record<string, unknown>[]) {
          const row = mapExistingRow(raw);
          if (row.itemKey !== null && !byKey.has(row.itemKey)) byKey.set(row.itemKey, row);
          const pathTitleKey = `${row.modulePath}\u0001${row.title}`;
          if (!byPathTitle.has(pathTitleKey)) byPathTitle.set(pathTitleKey, row);
        }

        /* 3. 取号基数一次算好（无编号行统一走服务端 TC- 序列）：事务内逐条
              nextItemKey 式重查是 200 次同构 MAX 扫描，这里一次取基数递增。
              并发导入撞号由 UNIQUE (project_id, item_key) 兜底 → 23505 整单回滚。 */
        const base = await client.query(
          `SELECT (COALESCE(MAX((substring(item_key FROM 4))::int), 0) + 1)::int AS base
             FROM spec_cases WHERE project_id = $1 AND item_key ~ '^TC-[0-9]+$'`,
          [context.project.id],
        );
        let nextNumber = Number(base.rows[0].base);

        /* 4. 逐条：同次提交内重复只记数；已存在未变跳过；有变更新（status /
              source / item_key 不动——编号是系统身份，生命周期归平台管）；新行插入。 */
        const seenPathTitles = new Set<string>();
        const seenKeys = new Set<string>();
        let created = 0;
        let updated = 0;
        let skipped = 0;
        let duplicate = 0;

        for (const each of cases) {
          const pathTitleKey = `${each.modulePath}\u0001${each.title}`;
          const inFileDuplicate = (each.itemKey !== null && seenKeys.has(each.itemKey)) || seenPathTitles.has(pathTitleKey);
          if (each.itemKey !== null) seenKeys.add(each.itemKey);
          seenPathTitles.add(pathTitleKey);
          if (inFileDuplicate) { duplicate++; continue; }

          const row = (each.itemKey !== null ? byKey.get(each.itemKey) : undefined) ?? byPathTitle.get(pathTitleKey);
          const moduleId = modulesByPath.get(each.modulePath);
          if (!moduleId) throw new Error(`module ${each.modulePath} was not created`);

          if (row) {
            if (sameCase(each, row)) { skipped++; continue; }
            await client.query(
              `UPDATE spec_cases SET
                  module_id = $2, title = $3, preconditions = $4, steps = $5::jsonb,
                  priority = $6, tags = $7, updated_at = now()
                WHERE id = $1 AND project_id = $8`,
              [row.id, moduleId, each.title, each.preconditions, JSON.stringify(each.steps), each.priority, each.tags, context.project.id],
            );
            updated++;
            continue;
          }

          const itemKey = each.itemKey ?? `TC-${String(nextNumber).padStart(3, "0")}`;
          if (each.itemKey === null) nextNumber++;
          await client.query(
            `INSERT INTO spec_cases (id, project_id, module_id, item_key, title, preconditions, steps, priority, tags, status, source, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'unreviewed', $10, $11)`,
            [randomUUID(), context.project.id, moduleId, itemKey, each.title, each.preconditions, JSON.stringify(each.steps), each.priority, each.tags, source, context.user.id],
          );
          created++;
        }

        await client.query("COMMIT");
        return success({ created, updated, skipped, duplicate, modulesCreated });
      } catch (error) {
        await client.query("ROLLBACK");
        /* 撞号 = 并发导入把同一段 TC- 序列拿走了：整单回滚、明确告知重试，
           而不是留半份。其余入库错误按批量的先例给 400 + 消息。 */
        if ((error as { code?: string }).code === "23505") {
          return fail(reply, 409, 2003, "case numbers were claimed by a concurrent import — run the import again");
        }
        return fail(reply, 400, 1001, error instanceof Error ? error.message : "import could not be committed");
      } finally {
        client.release();
      }
    },
  );
}
