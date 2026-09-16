import { useCallback, useEffect, useState } from "react";
import { Pagination, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { CheckCheck } from "lucide-react";
import { api, type UserNotification } from "../api";
import { useNotificationsStore } from "../stores/notificationsStore";
import { Empty } from "../ui";

/**
 * 通知列表页（P9-1，计划 13.3：全局层路由 /notifications）。
 *
 * 与铃铛下拉的分工：下拉是「最近 10 条」的速览，这里是全量分页 + 未读筛选。
 * 全局层页面（与数据看板/项目管理同款 page-card 形态，由 GlobalApp 的壳提供）。
 *
 * 行点击即读 + 跳转（边界 10 的深链语义）；「全部已读」在页头常驻（列表页的
 * 主用途之一就是清存量）。
 */

const PAGE_SIZES = [20, 50, 100];

export function NotificationsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [rows, setRows] = useState<UserNotification[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const setUnread = useNotificationsStore((state) => state.setUnread);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.notifications({ unread: unreadOnly, page, pageSize });
      setRows(result.items);
      setTotal(result.total);
    } catch {
      message.error(t("notifications.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [unreadOnly, page, pageSize, t]);

  useEffect(() => { void load(); }, [load]);

  async function openRow(row: UserNotification) {
    if (!row.readAt) {
      /* 就地标读（乐观更新行内状态，不等响应——已读只是视觉降级，失败不值得打断）。 */
      setRows((current) => current.map((item) => (item.id === row.id ? { ...item, readAt: new Date().toISOString() } : item)));
      void api.markNotificationRead(row.id)
        .then(() => api.notificationsUnreadCount().then((count) => setUnread(count.count)).catch(() => {}))
        .catch(() => {});
    }
    if (row.link) navigate(row.link);
  }

  async function readAll() {
    try {
      const result = await api.markAllNotificationsRead();
      setUnread(0);
      /* 当前页全部落为已读态（未读筛选下清空整页更诚实——它们已不属于这个筛选集）。 */
      if (unreadOnly) setRows([]);
      else setRows((current) => current.map((row) => ({ ...row, readAt: row.readAt ?? new Date().toISOString() })));
      setTotal(unreadOnly ? 0 : total);
      message.success(t("notifications.readAllDone", { count: result.updated }));
    } catch {
      message.error(t("notifications.readAllFailed"));
    }
  }

  return <>
    <div className="page-head">
      <div><h1>{t("notifications.title")}</h1><p>{t("notifications.hint")}</p></div>
      <div className="topbar-actions">
        {/* 手写 segmented（与执行器面板同款形态）：两档筛选不值得引 antd Segmented。 */}
        <div className="segmented" role="tablist" aria-label={t("notifications.readState")}>
          <button role="tab" aria-selected={!unreadOnly} className={`segmented-item${!unreadOnly ? " is-active" : ""}`} onClick={() => { setUnreadOnly(false); setPage(1); }}>{t("notifications.filterAll")}</button>
          <button role="tab" aria-selected={unreadOnly} className={`segmented-item${unreadOnly ? " is-active" : ""}`} onClick={() => { setUnreadOnly(true); setPage(1); }}>{t("notifications.filterUnread")}</button>
        </div>
        <button className="btn btn-with-icon" onClick={() => void readAll()}>
          <CheckCheck size={14} />{t("notifications.readAll")}
        </button>
      </div>
    </div>

    {loading && rows.length === 0 ? <p className="muted">{t("common.loading")}</p> : rows.length
      ? <div className="table-scroll"><table className="grid notification-grid">
        <thead><tr>
          <th>{t("notifications.notification")}</th>
          <th className="col-status">{t("notifications.kind")}</th>
          <th className="col-status">{t("notifications.readState")}</th>
          <th className="mono">{t("notifications.when")}</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id} data-clickable onClick={() => void openRow(row)}>
            <td>
              <div className="notification-cell">
                <span className="bell-item-dot" aria-hidden data-unread={row.readAt ? undefined : ""} />
                <div className="notification-cell-main">
                  {/* 标题不省略、允许折行（2026-09-11 用户反馈）：截断的长名字读不出
                     「是什么」。 */}
                  <span className="notification-cell-title">{row.title}</span>
                  {/* 正文是模版渲染的多行文本（结果/触发/链接/时间…）：按原换行展示、
                     自然折行——「过长截断」在这里就是「看不见结果」。 */}
                  {row.body && <span className="muted notification-cell-body">{row.body}</span>}
                  {row.projectName && <span className="mono muted notification-project">{row.projectName}</span>}
                </div>
              </div>
            </td>
            <td className="col-status"><span className="chip">{t(`notifications.kind_${row.kind}`)}</span></td>
            <td className="col-status">
              <span className={row.readAt ? "muted" : "notification-unread"}>
                {row.readAt ? t("notifications.read") : t("notifications.unread")}
              </span>
            </td>
            <td className="mono muted">{new Date(row.createdAt).toLocaleString()}</td>
          </tr>)}
        </tbody>
      </table></div>
      : !loading && <Empty
        title={unreadOnly ? t("notifications.emptyUnreadTitle") : t("notifications.emptyTitle")}
        hint={unreadOnly ? t("notifications.emptyUnreadHint") : t("notifications.emptyHint")}
      />}

    {rows.length > 0 && <div className="pager">
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
