import { useTranslation } from "react-i18next";

/**
 * 资产归属单元格（P11 边界 7/9）：创建人 / 更新人。
 *
 * 取值三态：
 * 1. 有 email → 显示 email（调用方的 `<td>` 带 `mono muted truncate`，与审计面板同一形制）；
 * 2. 没有 email、但「更新时间晚于创建时间」→ 显示「系统」——那是调度器 / 告警引擎 / 对账
 *    等系统路径改的（边界 3），不是没人改过；
 * 3. 其余 → 「—」。
 *
 * 只有**更新人**会读到「系统」：系统路径改资产，但不会建资产，所以创建人列的空值一律是「—」。
 *
 * `environments` 没有 created_at / updated_at（001 起就没有，P11-5 的发现），所以那张表永远
 * 落在第 3 态——不是没接线，是没有时间可判。`spec_cases` 有 created_by 但没有 updated_by
 * （边界 2），所以用例列表只加创建人一列。
 */
export function OwnerCell({ kind, email, createdAt, updatedAt }: {
  kind: "created" | "updated";
  email?: string | null;
  createdAt?: string;
  updatedAt?: string;
}) {
  const { t } = useTranslation();
  if (email) return <>{email}</>;
  if (kind === "updated" && createdAt && updatedAt && updatedAt > createdAt) return <>{t("common.bySystem")}</>;
  return <>—</>;
}
