import { pool } from "../db.js";
import { validateExecution } from "./trigger.js";
import { isUuid } from "./uuid.js";
import {
  SUITE_MAX_MEMBERS,
  type SuiteExecutionConfig, type SuiteMemberRef,
} from "../models/types.js";

/**
 * 套件保存的校验与归一（P5-5b 自 `routes/suites.ts` 原样提取，P5-2 边界 8 的同一笔
 * 账：MCP 写工具与 REST 路由必须跑同一份校验，两份实现必然在默认值上分叉）。
 * 函数体逐字搬移：签名、错误文案、`partial` 语义零改动。
 */

export type SelectionInput = {
  type?: string;
  members?: SuiteMemberRef[];
  tags?: string[];
  match?: string;
  includeCases?: boolean;
  includeFlows?: boolean;
};

export type SuiteInput = {
  name?: string;
  description?: string;
  selection?: SelectionInput;
  execution?: Partial<SuiteExecutionConfig>;
  /** 套件级通知设置（P3-11）：整块替换，与 selection 同一种 PUT 语义。 */
  notify?: unknown;
  tags?: string[];
};

const SELECTION_TYPES = ["manual", "tag", "all"];
const MEMBER_TYPES = ["case", "flow"];

export function validateSelection(selection: SelectionInput | undefined): string | undefined {
  if (!selection || !selection.type) return "selection.type is required";
  if (!SELECTION_TYPES.includes(selection.type)) return `selection.type must be one of ${SELECTION_TYPES.join(", ")}`;

  /*
   * 空成员 / 空标签在**保存**时是合法的：新建一个套件必然从零成员开始，配置页正是
   * 用来把它填起来的。「套件里没有成员不能运行」是**执行**时的检查，属于 P2-4.2 的
   * 入队路径——放在这里会让创建流程根本走不通。
   */
  if (selection.type === "manual") {
    if (!Array.isArray(selection.members)) return "selection.members must be an array";
    if (selection.members.length > SUITE_MAX_MEMBERS) return `a suite may hold at most ${SUITE_MAX_MEMBERS} members`;
    /* 同一个成员出现两次没有语义：成员之间不传变量，跑两遍同一个用例得到的是两份
     * 相同的独立结果。明确拒绝而不是静默去重——静默去重会让用户以为自己加上了。 */
    const seen = new Set<string>();
    for (const member of selection.members) {
      if (!member || !MEMBER_TYPES.includes(member.type)) return `each member type must be one of ${MEMBER_TYPES.join(", ")}`;
      if (!isUuid(member.id)) return "each member id must be a UUID";
      const key = `${member.type}:${member.id}`;
      if (seen.has(key)) return "a member may only appear once in a suite";
      seen.add(key);
    }
    return undefined;
  }

  /* tag / all 都是动态选择：成员在入队那一刻才解析，所以这里只校验筛选条件本身。 */
  if (!selection.includeCases && !selection.includeFlows) return "selection must include cases, flows, or both";
  if (selection.type === "tag") {
    if (selection.tags !== undefined && !Array.isArray(selection.tags)) return "selection.tags must be an array";
    if (selection.match !== undefined && selection.match !== "any" && selection.match !== "all") return "selection.match must be any or all";
  }
  return undefined;
}

export function validateSuite(input: SuiteInput, partial = false): string | undefined {
  if (!partial || input.name !== undefined) if (!input.name?.trim()) return "name is required";
  if (!partial || input.selection !== undefined) {
    const invalid = validateSelection(input.selection);
    if (invalid) return invalid;
  }
  return validateExecution(input.execution);
}

/**
 * 通知配置校验（P3-11）：形状 + 渠道属于本项目 + 模版字段是短字符串。
 * 渠道存在性必须查库：悬空 id 会让「开关开了」的套件在终态静默少发一封通知，
 * 那比保存被拒绝难发现得多。
 */
export async function validateSuiteNotify(projectId: string, notify: unknown): Promise<string | undefined> {
  if (notify === undefined || notify === null) return undefined;
  if (typeof notify !== "object" || Array.isArray(notify)) return "notify must be an object";
  const raw = notify as Record<string, unknown>;
  if (raw.onSuccess !== undefined && typeof raw.onSuccess !== "boolean") return "notify.onSuccess must be a boolean";
  if (raw.onFailure !== undefined && typeof raw.onFailure !== "boolean") return "notify.onFailure must be a boolean";
  if (raw.channelIds !== undefined) {
    if (!Array.isArray(raw.channelIds)) return "notify.channelIds must be an array";
    const ids = raw.channelIds.map(String);
    for (const id of ids) if (!isUuid(id)) return "notify.channelIds must contain UUIDs";
    if (ids.length) {
      const found = await pool.query(
        "SELECT COUNT(*)::int AS total FROM notification_channels WHERE project_id = $1 AND id = ANY($2::uuid[])",
        [projectId, ids],
      );
      if (Number(found.rows[0].total) !== ids.length) return "notify.channelIds must reference channels in this project";
    }
  }
  if (raw.template !== undefined && raw.template !== null) {
    if (typeof raw.template !== "object" || Array.isArray(raw.template)) return "notify.template must be an object";
    for (const key of ["title", "body"] as const) {
      const value = (raw.template as Record<string, unknown>)[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") return `notify.template.${key} must be a string`;
      if (value.length > 2000) return `notify.template.${key} is too long (max 2000 characters)`;
    }
  }
  return undefined;
}

/**
 * 存进 `selection_config` 的形状必须与 `mapTestSuite` 读出来的形状严格对应。
 * 写一套读一套是这类 JSONB 列最常见的分叉来源，所以两处只能有一个人做决定：
 * 这里负责写，mapper 负责读，字段名一字不差。
 */
export function toSelectionConfig(selection: SelectionInput): Record<string, unknown> {
  if (selection.type === "manual") return { members: (selection.members ?? []).map((member) => ({ type: member.type, id: member.id })) };
  const include = { includeCases: Boolean(selection.includeCases), includeFlows: Boolean(selection.includeFlows) };
  if (selection.type === "tag") {
    return { ...include, tags: (selection.tags ?? []).map((tag) => tag.trim()).filter(Boolean), match: selection.match === "all" ? "all" : "any" };
  }
  return include;
}
