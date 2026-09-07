import { useCallback, useEffect, useState } from "react";
import { Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { api, type AuditLog } from "../api";
import { Empty } from "../ui";

/**
 * 审计日志（P6-2，计划 10.0 边界 11「从只写到可读」；系统管理员）。
 *
 * 表在 P4.5-8 就开始写、写入点遍布触发/Token/成员路径，本页缺的从来只是一条 SELECT
 * 和一张表。action 筛选用**服务端出现过的动作**做候选（不硬编码清单——新动作随批
 * 次长出来，这里自动跟上演示，不需要同步两份列表）。
 *
 * detail 渲染为键值行而不是原始 JSON 转储：它已经被写入侧的护栏限制成决策证据
 * （≤4KB、无 secret），但仍然可能只是个 `{}`——空 detail 显示「—」而不是空括号。
 */

const PAGE_SIZES = [20, 50, 100];

/** detail 里最常见的几个键的展示顺序；其余键按对象序跟在后面。 */
const DETAIL_KEYS = ["email", "name", "from", "to", "role", "triggeredBy", "gate", "outcome", "scope", "count"];

/**
 * detail 的键值行渲染，全局面板与项目成员页的「最近审计」共用同一形状（P6-4 起导出）。
 * detail 已被写入侧的护栏限制成决策证据（≤4KB、无 secret），空对象显示「—」。
 */
export function AuditDetail({ detail }: { detail: Record<string, unknown> }) {
  const entries = Object.entries(detail ?? {});
  if (!entries.length) return <span className="muted">—</span>;
  const ordered = [
    ...DETAIL_KEYS.filter((key) => key in detail).map((key) => [key, detail[key]] as const),
    ...entries.filter(([key]) => !DETAIL_KEYS.includes(key)),
  ];
  return <div className="audit-detail">
    {ordered.map(([key, value]) => <div key={key} className="mono">
      <span className="muted">{key}</span>
      <span>{formatValue(value)}</span>
    </div>)}
  </div>;
}

export function AuditLogsPanel() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [action, setAction] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (next: { page: number; pageSize: number; action?: string }) => {
    setLoading(true);
    try {
      const result = await api.auditLogs(next);
      setLogs(result.items);
      setTotal(result.total);
    } catch {
      message.error(t("audit.loadFailed"));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load({ page, pageSize, action });
  }, [load, page, pageSize, action]);

  /* 候选 = 当前页出现过的动作（下一页的动作翻页时自然补进来）。硬编码清单会在
     P6-3/P6-4 加 invite 与 member 系动作时过期，这里宁可窄一点也不造假。 */
  const actionOptions = [...new Set(logs.map((log) => log.action))].sort().map((value) => ({ value, label: value }));

  return <>
    <p className="form-note">{t("audit.hint")}</p>

    <div className="filter-bar">
      <Select
        allowClear
        value={action}
        onChange={(value) => { setAction(value); setPage(1); }}
        options={actionOptions}
        placeholder={t("audit.actionFilter")}
        style={{ width: 240 }}
      />
      <span className="filter-spacer" />
      <span className="muted mono">{t("audit.totalCount", { count: total })}</span>
    </div>

    {logs.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("audit.action")}</th>
        <th>{t("audit.operator")}</th>
        <th>{t("audit.target")}</th>
        <th>{t("audit.detailColumn")}</th>
        <th>{t("audit.time")}</th>
      </tr></thead>
      <tbody>
        {logs.map((log) => <tr key={log.id}>
          <td><span className="mono">{log.action}</span></td>
          <td className="mono muted">{log.userEmail ?? t("audit.nonUser")}</td>
          <td>
            {/* 多态目标只展示类型（target_id 是 UUID，对人没有意义；detail 里才有
                email/name 这类可读证据）。系统级行顺带标注项目归属为「系统级」。 */}
            <span className="mono">{log.targetType}</span>
            <div className="muted">{log.projectName ?? t("audit.systemLevel")}</div>
          </td>
          <td><AuditDetail detail={log.detail} /></td>
          <td className="mono muted">{new Date(log.createdAt).toLocaleString()}</td>
        </tr>)}
      </tbody>
    </table></div> : !loading && <Empty title={t("audit.emptyTitle")} hint={t("audit.emptyHint")} />}

    {total > pageSize && <div className="pager">
      <Pagination
        current={page}
        pageSize={pageSize}
        total={total}
        pageSizeOptions={PAGE_SIZES}
        showSizeChanger
        onChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
      />
    </div>}
  </>;
}

/** detail 值的展示：数组拍平、对象递归一层、null/undefined 显示 —。 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
