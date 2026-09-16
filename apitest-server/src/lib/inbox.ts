import { randomUUID } from "node:crypto";
import { pool } from "../db.js";

/**
 * 站内通知的投递设施（P9-1，计划 13.2 的 `lib/inbox.ts`）。
 *
 * 两个入口，按收件口径分流（2026-09-11 用户确认的修订）：
 * - `deliverInbox`——**全体成员扇出**：member_change / plan_assign 两个源（P9 回补
 *   P6/P7；成员变更全员该知道、指派本来就是单人但走成员语义的扩展位）。
 * - `deliverInboxToUser`——**定点发给触发人**：alert / suite_result / ci_result
 *   三个终态源（谁触发发给谁；非人触发不发——受众不明确的广播只是噪声，需要
 *   关注定时 / Webhook 结果的人已由站外渠道覆盖）。
 *
 * 两者都 fire-and-forget（**通知写失败不能拖垮业务事务**，`writeAuditLogAsync` 的
 * 同一条取舍——返回 void，错误吞进日志）。
 */

export type InboxKind = "member_change" | "plan_assign" | "alert" | "suite_result" | "ci_result";

/**
 * 全体成员扇出（member_change / plan_assign）。
 *
 * 收件人 = 项目全体成员（含 viewer，边界 9——不做按人订阅偏好，第一版）；
 * `excludeUserId` 给 member_change 的「移除自己」用：被移除的人下次请求就 403，
 * 再给他发一条「你被移除了」只会制造一个打不开的深链。
 */
export function deliverInbox(input: {
  projectId: string;
  kind: InboxKind;
  title: string;
  body?: string;
  /** 站内相对路径（空串 = 无深链）。 */
  link?: string;
  /** 不给这个人发（member_change 移除场景：收件人已经进不了这个项目）。 */
  excludeUserId?: string;
}): void {
  /* gen_random_uuid() 是 PG13+ 内置（迁移 011 已在用）：行数由成员集决定，id 不能
     预生成——一次 INSERT … SELECT 全体成员，而不是逐人一条。 */
  void pool.query(
    `INSERT INTO notifications (id, user_id, project_id, kind, title, body, link)
     SELECT gen_random_uuid(), r.user_id, $1, $2, $3, $4, $5
       FROM user_project_roles r
      WHERE r.project_id = $1 AND ($6::uuid IS NULL OR r.user_id <> $6)`,
    [input.projectId, input.kind, input.title, input.body ?? "", input.link ?? "", input.excludeUserId ?? null],
  ).catch((error) => {
    /* 只记 console（与 scheduler.ts 的订阅管线同款姿态）：这里没有 request 上下文，
       Fastify logger 拿不到；静默吞掉比假装成功诚实。 */
    console.error("[inbox] notification could not be delivered", error);
  });
}

/**
 * 定点投递（P9-1 收件口径变更，2026-09-11）：alert / suite_result / ci_result 三类
 * 站内通知从「全体成员扇出」改为「谁触发发给谁」——受众不明确的广播只是噪声，
 * 真正需要关注非人触发（定时 / Webhook）结果的人已由站外渠道覆盖。
 *
 * `userId` 为空（非人触发 / 触发人被删）**不发**：宁缺毋滥——一条发给错误的人的
 * 通知比没有通知更糟（他会开始忽略铃铛）。
 */
export function deliverInboxToUser(input: {
  projectId: string;
  userId: string | null | undefined;
  kind: InboxKind;
  title: string;
  body?: string;
  link?: string;
}): void {
  if (!input.userId) return;
  void pool.query(
    `INSERT INTO notifications (id, user_id, project_id, kind, title, body, link)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), input.userId, input.projectId, input.kind, input.title, input.body ?? "", input.link ?? ""],
  ).catch((error) => {
    console.error("[inbox] notification could not be delivered", error);
  });
}
