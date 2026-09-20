/*
 * P10-5（计划 14.3 读侧）：两版内容快照的**服务端** diff。
 *
 * ★ 硬验收项：变更历史必须能看到「改成什么」，不是只有时间与作者。所以 diff 在服务端算好
 * 再下发——前端只上色，不自己比对（比对逻辑放前端就会和写侧的快照口径分叉）。
 *
 * 比对的是 `asset_versions.snapshot` —— camelCase、与资产 API 出参同形的内容子集。逐个
 * **顶层字段**比：值深相等则跳过；一边缺 = 新增/删除；两边都有且不等 = 修改。修改与新增/
 * 删除都再产一份**逐行 diff**（对字符串用原文、对结构化值用缩进 JSON 的规范串），这样
 * 嵌套结构（headers / request / assertions / steps…）也能一行一行上色，而不是「整块变了」。
 *
 * secret 纪律：环境快照的 `secretKeys` 只是**键名数组**（写侧从不落值），所以这里对它的
 * diff 天然只显示「哪个键名增/删」，永远碰不到明文（迁移 067 头「secret 纪律」，Spec 4.6）。
 */

export type FieldDiffKind = "added" | "removed" | "changed";
export type LineDiffKind = "add" | "del" | "same";
export type LineDiff = { kind: LineDiffKind; text: string };

export type FieldDiff = {
  /** 顶层字段名（snapshot 的键）。 */
  field: string;
  kind: FieldDiffKind;
  /** 修改/删除侧的旧值（新增时缺席）。 */
  before?: unknown;
  /** 修改/新增侧的新值（删除时缺席）。 */
  after?: unknown;
  /** 逐行 diff：字符串用原文、其余用缩进 JSON 的规范串比对。 */
  lines: LineDiff[];
};

export type SnapshotDiff = {
  /** 有改动的字段（无改动的字段不进），按字段名排序保证两端稳定。 */
  fields: FieldDiff[];
  /** 两版之间一处改动都没有（同内容再存一版：回滚回原样、无实质编辑的保存）。 */
  identical: boolean;
};

/** 深相等（值语义）：对象按键集合逐键比，数组按序比，其余按 `Object.is`。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key)
    && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** 一个值渲染成可逐行比对的文本：字符串用原文，其余用缩进 JSON（键序稳定靠 JS 的插入序）。 */
function toText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * 逐行 LCS diff。快照是单个资产的内容（行数小），标准 DP 足够，不引第三方库。
 *
 * 相同行标 `same`，只在旧侧标 `del`，只在新侧标 `add`——前端按 kind 上色（删红增绿）。
 */
function lineDiff(beforeText: string, afterText: string): LineDiff[] {
  /* 空串按「零行」处理：一个空字符串 split 会得到 [""]，会把「新增一个空值」错标成改了一行。 */
  const before = beforeText === "" ? [] : beforeText.split("\n");
  const after = afterText === "" ? [] : afterText.split("\n");
  const rows = before.length;
  const cols = after.length;
  /* lcs[i][j] = before[i..] 与 after[j..] 的最长公共子序列长度。 */
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: LineDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) { out.push({ kind: "same", text: before[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: "del", text: before[i] }); i++; }
    else { out.push({ kind: "add", text: after[j] }); j++; }
  }
  while (i < rows) { out.push({ kind: "del", text: before[i] }); i++; }
  while (j < cols) { out.push({ kind: "add", text: after[j] }); j++; }
  return out;
}

/**
 * 两版快照的字段级 diff。`before` 是较旧一版、`after` 是较新一版的 snapshot。
 *
 * 只比两侧出现过的顶层键的并集：写侧快照构造器给同类资产产出的键是固定的，但两版之间
 * 若跨过字段增删（快照形状演进），并集能如实把「这一版多了/少了某字段」也标出来。
 */
export function diffSnapshots(before: Record<string, unknown>, after: Record<string, unknown>): SnapshotDiff {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const fields: FieldDiff[] = [];
  for (const field of keys) {
    const inBefore = Object.prototype.hasOwnProperty.call(before, field);
    const inAfter = Object.prototype.hasOwnProperty.call(after, field);
    const beforeValue = before[field];
    const afterValue = after[field];
    if (inBefore && inAfter && deepEqual(beforeValue, afterValue)) continue;
    /* 两边都在但都是 undefined/等值已被上面挡掉；这里只剩真差异。 */
    if (inBefore && !inAfter) {
      fields.push({ field, kind: "removed", before: beforeValue, lines: lineDiff(toText(beforeValue), "") });
    } else if (!inBefore && inAfter) {
      fields.push({ field, kind: "added", after: afterValue, lines: lineDiff("", toText(afterValue)) });
    } else {
      fields.push({ field, kind: "changed", before: beforeValue, after: afterValue, lines: lineDiff(toText(beforeValue), toText(afterValue)) });
    }
  }
  return { fields, identical: fields.length === 0 };
}
