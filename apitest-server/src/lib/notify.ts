import { createHmac, randomUUID } from "node:crypto";
import { pool } from "../db.js";
import type { NotificationChannelType } from "../models/types.js";

/**
 * 通知投递（P3-5，计划 6.2，边界 8 / 10）。
 *
 * 只做「POST 一段 JSON 到一个 URL」这一族（边界 8）：通用 Webhook / 企业微信群机器人 /
 * 钉钉群机器人 / Slack Incoming Webhook，差别只在默认模板与钉钉的加签。Email 不做——
 * SMTP 是另一套基础设施，塞进来只会做成一个发不出去的开关。
 *
 * 每次 POST 都落一行 `notification_deliveries`（边界 10）：通知是「发出去就看不见了」
 * 的动作，不留投递记录时「没收到告警」的三种原因（规则没命中 / 渠道配错 / 对方 5xx）
 * 没有证据就只能猜。payload 列存**实际发出的那份 JSON**——复现「对方到底收到了什么」
 * 只能靠它。
 */

/** 投递预算：渠道是告警链路，不是被测系统，10 秒足够且不该更久。 */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * 企业微信 markdown 消息的内容上限 4096 字节。多出来的部分静默截断而不是报错——
 * 告警迟到的危害大于告警末尾几行丢字。
 */
const MAX_TEXT_BYTES = 3_900;

/** 规则命中后要说的内容：标题一行 + 明细若干行，各渠道模板从这里渲染。 */
export type AlertMessage = {
  title: string;
  lines: string[];
};

/**
 * 套件通知的模版上下文（P3-11，6.8）与渲染。
 *
 * 渲染是纯字符串替换：未知占位符**原样保留**——写错的 `{{suuteName}}` 留在收到的
 * 消息里一眼可见，静默吞掉则让人以为占位符没有值。这是文案不是代码，不做嵌套、
 * 不做条件、不做转义。
 */
export type TemplateValues = Record<string, string>;

export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, key: string) => (key in values ? values[key] : whole));
}

/** 自定义正文按行拆（`AlertMessage.lines` 是行的列表）；空行保留，用户用它分段。 */
export function renderBody(template: string, values: TemplateValues): string[] {
  return renderTemplate(template, values).split("\n");
}

/** 一个已解密的渠道（alerts.ts 从库里读出并解好密再传进来）。 */
export type AlertChannel = {
  id: string;
  name: string;
  type: NotificationChannelType;
  url: string;
  /** 钉钉加签密钥（明文，仅在投递的这一瞬间存在）；其它渠道不使用。 */
  secret?: string;
  templatePrefix?: string;
};

function formatClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 按字节截断（企业微信按字节计数），UTF-8 边界处退一个字符，不切出半个字。 */
function truncateBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  let cut = text.slice(0, Math.floor((maxBytes * text.length) / bytes));
  while (Buffer.byteLength(cut, "utf8") > maxBytes - 3) cut = cut.slice(0, -1);
  return `${cut}...`;
}

/** 渲染成通用文本：可选前缀（template_prefix 是文案不是模板语言，边界 8）+ 标题 + 明细。 */
function renderText(channel: AlertChannel, message: AlertMessage): string {
  const body = [message.title, "", ...message.lines].join("\n");
  return channel.templatePrefix ? `${channel.templatePrefix}\n${body}` : body;
}

/**
 * 钉钉加签：`HMAC-SHA256(timestamp + "\n" + secret)` 的 base64 拼回 URL。
 * 企业微信 / Slack / 通用 Webhook 的准入凭据都在 URL 本身里，secret 列对它们不参与
 * 投递（P3-6 允许存，但只作为文档化的配置位）。
 */
function signedUrl(channel: AlertChannel): string {
  if (channel.type !== "dingtalk" || !channel.secret) return channel.url;
  const timestamp = Date.now();
  const sign = createHmac("sha256", channel.secret).update(`${timestamp}\n${channel.secret}`).digest("base64");
  const joiner = channel.url.includes("?") ? "&" : "?";
  return `${channel.url}${joiner}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

/** 各渠道的消息体：同一份事实，四种信封。 */
function buildPayload(channel: AlertChannel, message: AlertMessage): { url: string; body: Record<string, unknown> } {
  const text = truncateBytes(renderText(channel, message), MAX_TEXT_BYTES);
  switch (channel.type) {
    case "wecom":
      /* 企业微信群机器人：markdown 消息。 */
      return { url: channel.url, body: { msgtype: "markdown", markdown: { content: text } } };
    case "dingtalk":
      /* 钉钉群机器人：markdown 消息，title 是通知栏/会话列表里的摘要。 */
      return { url: signedUrl(channel), body: { msgtype: "markdown", markdown: { title: message.title, text } } };
    case "slack":
      /* Slack Incoming Webhook：text 支持 mrkdwn，按纯文本发最稳。 */
      return { url: channel.url, body: { text } };
    default:
      /* 通用 Webhook：自描述结构，消费方按需取字段；lines 保留结构而不是拼死在一段文字里。 */
      return { url: channel.url, body: { title: message.title, text, lines: message.lines, sentAt: formatClock(new Date()) } };
  }
}

async function postJson(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, statusCode: response.status };
    /* 非 2xx：把响应开头留在证据里——「渠道返回 401」与「返回 500」是两种不同的修法。 */
    const detail = truncateBytes((await response.text()).trim(), 400);
    return { ok: false, statusCode: response.status, error: detail ? `channel responded ${response.status}: ${detail}` : `channel responded ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "delivery failed" };
  }
}

/** 落一行投递证据（边界 10）。渠道/规则的 FK 都是 SET NULL，证据活过被引用方的删除。 */
async function recordDelivery(input: {
  projectId: string; channelId: string; ruleId?: string; executionIndexId?: string;
  status: "sent" | "failed"; statusCode?: number; error?: string; payload: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO notification_deliveries (id, project_id, channel_id, rule_id, execution_index_id, status, status_code, error, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [randomUUID(), input.projectId, input.channelId, input.ruleId ?? null, input.executionIndexId ?? null, input.status, input.statusCode ?? null, input.error ?? null, JSON.stringify(input.payload)],
  );
}

/**
 * 把一条命中了规则的消息投给它声明的全部渠道。
 *
 * 渠道之间并行（各 10 秒预算，串行会把 3 个渠道的故障叠加成 30 秒）；每个渠道独立
 * 落证据——一个渠道 5xx 不该让其它渠道的投递也跟着丢。`ruleId` 可空：渠道「测试」
 * 路由（P3-6）也走同一条投递路径，它没有规则，证据行 rule_id 为 NULL。
 */
export async function dispatchAlert(input: {
  projectId: string;
  ruleId?: string;
  /** 触发这次评估的父执行（事件型是失败的那次，窗口型是让窗口跨过阈值的最后一次）。 */
  executionIndexId?: string;
  channels: AlertChannel[];
  message: AlertMessage;
}): Promise<{ sent: number; failed: number }> {
  const results = await Promise.all(input.channels.map(async (channel) => {
    const { url, body } = buildPayload(channel, input.message);
    const result = await postJson(url, body);
    await recordDelivery({
      projectId: input.projectId, channelId: channel.id, ruleId: input.ruleId,
      executionIndexId: input.executionIndexId,
      status: result.ok ? "sent" : "failed",
      statusCode: result.statusCode, error: result.error,
      payload: body,
    });
    return result.ok;
  }));
  return { sent: results.filter(Boolean).length, failed: results.length - results.filter(Boolean).length };
}
