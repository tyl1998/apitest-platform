import type { DataSourceOperation, DataSourceType } from "./api";

/**
 * mongo/redis 操作模板。
 *
 * 以**对象**保存而不是 JSON 字符串：模板要经 `formatOperation` 缩进后才进编辑器，
 * 早先写成一行的字符串直接塞进去，用户看到的默认内容是压缩过的。
 * 同时这里是唯一一份——数据源详情页和流程数据库节点各存一份时，两边的可选操作会走偏。
 */
export type OperationTemplate = { label: string; operation: DataSourceOperation };

export const MONGO_TEMPLATES: OperationTemplate[] = [
  { label: "find", operation: { op: "find", collection: "users", filter: { userId: "{{userId}}" } } },
  { label: "aggregate", operation: { op: "aggregate", collection: "orders", pipeline: [{ $match: { status: "{{status}}" } }] } },
  { label: "count", operation: { op: "count", collection: "users", filter: {} } },
  { label: "distinct", operation: { op: "distinct", collection: "users", field: "status", filter: {} } },
  { label: "insertOne", operation: { op: "insertOne", collection: "users", document: { name: "{{name}}" } } },
  { label: "updateOne", operation: { op: "updateOne", collection: "users", filter: { userId: "{{userId}}" }, update: { $set: { status: "{{status}}" } } } },
  { label: "deleteMany", operation: { op: "deleteMany", collection: "users", filter: { userId: "{{userId}}" } } },
];

export const REDIS_TEMPLATES: OperationTemplate[] = [
  { label: "GET", operation: { op: "command", command: "GET", args: ["{{key}}"] } },
  { label: "SET", operation: { op: "command", command: "SET", args: ["{{key}}", "{{value}}"] } },
  { label: "DEL", operation: { op: "command", command: "DEL", args: ["{{key}}"] } },
  { label: "EXISTS", operation: { op: "command", command: "EXISTS", args: ["{{key}}"] } },
  { label: "INCR", operation: { op: "command", command: "INCR", args: ["{{key}}"] } },
  { label: "TTL", operation: { op: "command", command: "TTL", args: ["{{key}}"] } },
  { label: "LRANGE", operation: { op: "command", command: "LRANGE", args: ["{{key}}", 0, -1] } },
  { label: "HGETALL", operation: { op: "command", command: "HGETALL", args: ["{{key}}"] } },
  { label: "HGET", operation: { op: "command", command: "HGET", args: ["{{key}}", "{{field}}"] } },
  { label: "SMEMBERS", operation: { op: "command", command: "SMEMBERS", args: ["{{key}}"] } },
];

export function operationTemplates(type: DataSourceType | undefined): OperationTemplate[] {
  return type === "mongodb" ? MONGO_TEMPLATES : type === "redis" ? REDIS_TEMPLATES : [];
}

/** 编辑器里的文本形态。缩进 2 空格，和读取已保存定义时的展示保持一致。 */
export function formatOperation(operation: unknown): string {
  return JSON.stringify(operation, null, 2);
}

/** 某个数据源类型的默认操作文本（模板列表第一项）。 */
export function defaultOperationText(type: DataSourceType | undefined): string {
  const first = operationTemplates(type)[0];
  return first ? formatOperation(first.operation) : "";
}

/**
 * 一个操作读作哪个标签：Redis 看命令名，Mongo 看 `op`。
 *
 * 用来把操作下拉框做成受控的——否则重新打开一条已保存的定义时，下拉框只显示占位符，
 * 看不出这条定义到底是哪种操作。手写了模板列表以外的命令时返回命令本身，
 * antd 会把它当自定义值显示出来，这正是想要的。
 */
export function operationLabel(operation: unknown): string | undefined {
  if (!operation || typeof operation !== "object") return undefined;
  const record = operation as { op?: unknown; command?: unknown };
  if (record.op === "command") return typeof record.command === "string" && record.command.trim() ? record.command.trim().toUpperCase() : undefined;
  return typeof record.op === "string" && record.op.trim() ? record.op : undefined;
}

/** 同上，但输入是编辑器里的文本；解析不出来就没有选中项。 */
export function operationLabelFromText(text: string): string | undefined {
  try { return operationLabel(JSON.parse(text)); } catch { return undefined; }
}
