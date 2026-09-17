import { useCallback, useEffect, useState } from "react";
import { Drawer, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
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
 *
 * P11-10（边界 7/8）：同一份面板多了**项目作用域**（`projectId` 属性）——项目审计路由
 * 从 project_admin 放宽到 developer（viewer 仍 403），项目内入口在项目配置 → 审计日志页；
 * 另外多了 `targetType` 过滤与 `ChangeHistoryDrawer`（资源详情的「变更历史」，按
 * `target_type + target_id` 下钻，只列动作/时间/操作者/字段名，不做 diff）。
 */

const PAGE_SIZES = [20, 50, 100];

/** detail 里最常见的几个键的展示顺序；其余键按对象序跟在后面。 */
const DETAIL_KEYS = ["email", "name", "from", "to", "role", "triggeredBy", "gate", "outcome", "scope", "count", "fields", "ids", "imported"];

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

/**
 * 审计表（系统作用域与项目作用域共用）。
 *
 * `projectId` 存在时走项目路由，并且：
 * - 不再需要「项目」这一列（每一行都属于当前项目），第二行改标 target_id 短前缀；
 * - 提示文案换成项目口径；
 * - `targetType` 过滤可用（资源「变更历史」是这一路的单目标特例）。
 *
 * 系统作用域下行为与 P6-2 完全一致（`/system/audit-logs`，含项目列）。
 */
export function AuditLogsPanel({ projectId }: { projectId?: string } = {}) {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [action, setAction] = useState<string | undefined>();
  const [targetType, setTargetType] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (next: { page: number; pageSize: number; action?: string; targetType?: string }) => {
    setLoading(true);
    try {
      const result = projectId ? await api.projectAuditLogs(projectId, next) : await api.auditLogs(next);
      setLogs(result.items);
      setTotal(result.total);
    } catch {
      message.error(t("audit.loadFailed"));
    } finally { setLoading(false); }
  }, [projectId, t]);

  useEffect(() => {
    void load({ page, pageSize, action, targetType });
  }, [load, page, pageSize, action, targetType]);

  /* 候选 = 当前页出现过的动作 / 目标类型（下一页的自然补进来）。硬编码清单会在新批次
     加动作时过期，这里宁可窄一点也不造假（P6-2 的纪律，P11-10 扩到 targetType）。 */
  const actionOptions = [...new Set(logs.map((log) => log.action))].sort().map((value) => ({ value, label: value }));
  const targetTypeOptions = [...new Set(logs.map((log) => log.targetType))].sort().map((value) => ({ value, label: value }));

  return <>
    <p className="form-note">{projectId ? t("audit.projectHint") : t("audit.hint")}</p>

    <div className="filter-bar">
      <Select
        allowClear
        value={action}
        onChange={(value) => { setAction(value); setPage(1); }}
        options={actionOptions}
        placeholder={t("audit.actionFilter")}
        style={{ width: 240 }}
      />
      <Select
        allowClear
        value={targetType}
        onChange={(value) => { setTargetType(value); setPage(1); }}
        options={targetTypeOptions}
        placeholder={t("audit.targetTypeFilter")}
        style={{ width: 200 }}
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
            {/* 多态目标只展示类型（完整 target_id 是 UUID，对人没有意义；detail 里才有
                email/name 这类可读证据）。系统作用域的第三行是项目归属（或「系统级」），
                项目作用域下每行都属于当前项目，改标目标 id 短前缀——「这一行打的是哪一个」。 */}
            <span className="mono">{log.targetType}</span>
            <div className="muted mono">
              {projectId ? (log.targetId ? log.targetId.slice(0, 8) : "—") : (log.projectName ?? t("audit.systemLevel"))}
            </div>
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

/**
 * 项目审计页（P11-10 边界 7）：项目配置 → 审计日志。页面不做角色判断——入口在
 * `ProjectShell` 里对 viewer 隐藏，路由不藏（P6-4 边界 6：后端守卫才是权限的单一事实，
 * viewer 直达时后端照拒）。
 */
export function ProjectAuditPage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  return <main className="content">
    <div className="page-head"><div><h1>{t("audit.title")}</h1></div></div>
    {projectId && <AuditLogsPanel projectId={projectId} />}
  </main>;
}

/**
 * 资源「变更历史」抽屉（P11-10 边界 8）：按 `target_type + target_id` 拉该资源的审计行。
 *
 * **不做 diff 视图**：只列动作、时间、操作者与字段名列表——「改成什么」是 P10 14.3
 * （接口变更追踪）的范围，本抽屉回答的是「谁在什么时候动过它、动了哪些键」。
 * 不分页：单条资源的变更行是「建 + 改 + 删」量级，50 条封顶足够；真的改到 50 次以上，
 * 列表本身也早就说明问题了。
 */
export function ChangeHistoryDrawer({ projectId, targetType, targetId, name, open, onClose }: {
  projectId: string;
  targetType: string;
  targetId: string;
  /** 资源名（标题用）；缺省回落到动作类型。 */
  name?: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let aborted = false;
    setLoading(true);
    api.projectAuditLogs(projectId, { targetType, targetId, pageSize: 50 })
      .then((result) => { if (!aborted) setLogs(result.items); })
      .catch(() => { if (!aborted) message.error(t("audit.loadFailed")); })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, [open, projectId, targetType, targetId, t]);

  return <Drawer
    title={name ? t("audit.historyTitle", { name }) : t("audit.history")}
    open={open}
    onClose={onClose}
    width={720}
  >
    <p className="form-note">{t("audit.historyHint")}</p>
    {logs.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("audit.action")}</th>
        <th>{t("audit.operator")}</th>
        <th>{t("audit.fields")}</th>
        <th>{t("audit.time")}</th>
      </tr></thead>
      <tbody>
        {logs.map((log) => <tr key={log.id}>
          <td><span className="mono">{log.action}</span></td>
          <td className="mono muted">{log.userEmail ?? t("audit.nonUser")}</td>
          {/* 证据块（含 `fields` 字段名列表）：删除类动作没有字段，显示「—」。 */}
          <td><AuditDetail detail={log.detail} /></td>
          <td className="mono muted">{new Date(log.createdAt).toLocaleString()}</td>
        </tr>)}
      </tbody>
    </table></div> : !loading && <Empty title={t("audit.historyEmptyTitle")} hint={t("audit.historyEmptyHint")} />}
  </Drawer>;
}

/** detail 值的展示：数组拍平、对象递归一层、null/undefined 显示 —。 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
