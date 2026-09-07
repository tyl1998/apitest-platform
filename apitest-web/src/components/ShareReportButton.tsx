import { useEffect, useState } from "react";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import { Copy, Link2, Link2Off, Share2 } from "lucide-react";
import { api, type ReportShare, type ReportShareTarget } from "../api";
import { useCanWrite } from "../hooks/useMyRole";
import { Tip } from "../ui";

/**
 * 报告的分享控件（2026-09-02，验收反馈：所有报告支持分享、免登录查看）。
 *
 * 两个态：未分享（一个「分享」按钮，点了创建 + 复制链接）/ 已分享（链接框 + 复制 +
 * 取消分享）。进入页面先查一次当前分享——重复点「分享」在服务端是幂等的（一个目标
 * 同时只有一条有效链接），但界面先把「已经分享过了」亮出来，用户才不会以为每次
 * 点击都会换一条链接、把旧链接贴失效。
 *
 * 链接是 `/share/reports/:token`（公开路由，不携带任何凭据）——复制到剪贴板的是完整
 * 绝对地址，贴到聊天工具里直接可点。
 */
export function ShareReportButton({ projectId, targetType, targetId }: {
  projectId: string;
  targetType: ReportShareTarget;
  targetId: string;
}) {
  const { t } = useTranslation();
  /* viewer：创建/撤销分享都是写（P6-4），整个控件不渲染——已存在的链接由写角色维护。 */
  const canWrite = useCanWrite();
  const [share, setShare] = useState<ReportShare | null | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setShare(undefined);
    /* 静默查一次：失败按「未分享」处理（按钮点了会再试一次，错误在那里报）。 */
    void api.reportShare(projectId, targetType, targetId)
      .then((existing) => { if (alive) setShare(existing); })
      .catch(() => { if (alive) setShare(null); });
    return () => { alive = false; };
  }, [projectId, targetType, targetId]);

  const url = share ? `${window.location.origin}/share/reports/${share.token}` : "";

  async function create() {
    setBusy(true);
    try {
      const created = await api.createReportShare(projectId, targetType, targetId);
      setShare(created);
      await copy(`${window.location.origin}/share/reports/${created.token}`);
    } catch {
      message.error(t("share.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      message.success(t("share.copied"));
    } catch {
      /* 剪贴板权限被拒（http 环境 / 旧浏览器）：链接框已选中，Ctrl+C 交给用户。 */
      message.info(t("share.copyManual"));
    }
  }

  async function revoke() {
    if (!share) return;
    setBusy(true);
    try {
      await api.revokeReportShare(projectId, share.id);
      setShare(null);
      message.success(t("share.revoked"));
    } catch {
      message.error(t("share.revokeFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!canWrite || share === undefined) return null;

  if (!share) {
    return <button className="btn btn-with-icon" disabled={busy} onClick={() => void create()}>
      <Share2 size={14} />{t("share.create")}
    </button>;
  }
  return <div className="share-controls">
    <Link2 size={14} className="muted" />
    <input
      className="input mono share-url"
      readOnly
      value={url}
      onFocus={(event) => event.target.select()}
      aria-label={t("share.urlLabel")}
    />
    <button className="btn btn-small btn-with-icon" onClick={() => void copy(url)}>
      <Copy size={13} />{t("share.copy")}
    </button>
    <Tip text={t("share.revokeHint")}>
      <button className="btn btn-small btn-with-icon" disabled={busy} onClick={() => void revoke()}>
        <Link2Off size={13} />{t("share.revoke")}
      </button>
    </Tip>
  </div>;
}
