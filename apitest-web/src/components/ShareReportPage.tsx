import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { api, type PublicReportShare, type RunnerReportPayload, type SuiteReport } from "../api";
import { Empty } from "../ui";
import { PipelineReportBody } from "./PipelineRunPage";
import { SuiteReportDetail } from "./SuiteReports";

/**
 * 报告分享的公开落地页（`/share/reports/:token`，2026-09-02 验收反馈）。
 *
 * 不在 `Protected` 路由之下：链接就是凭据，登录与否都能看。外壳是极简版 console
 * （只有一条顶栏 + 滚动内容区）——公开页面不暴露任何项目导航，也不给任何写入口；
 * 渲染组件与项目内详情共用（`SuiteReportDetail` / `PipelineReportBody`），公开态
 * (`publicView`) 关掉的只有分享按钮（创建分享要 write 权限）——成员证据抽屉自
 * 2026-09-03 起在公开页同样可用，取数走 token 端点（见 `SuiteReportDetail`）。
 *
 * 404（token 撤销 / 目标删除 / 从未存在）与「链接还在」说不同的话：前者提示去找
 * 分享人，后者直接进报告。
 */
export function ShareReportPage() {
  const { t } = useTranslation();
  const { token } = useParams();
  const [data, setData] = useState<PublicReportShare>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    setData(undefined);
    setFailed(false);
    void api.publicReportShare(token)
      .then((result) => { if (alive) setData(result); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [token]);

  return <div className="share-shell">
    <header className="share-topbar">
      <div className="lockup"><span className="lockup-mark mono">AT</span><span className="lockup-name">ApiTrack</span></div>
      {data && <span className="muted truncate">
        {t("share.publicBadge", { project: data.projectName, time: new Date(data.sharedAt).toLocaleString() })}
      </span>}
    </header>
    <main className="content">
      {failed && <Empty title={t("share.goneTitle")} hint={t("share.goneHint")} />}
      {!failed && !data && <p className="muted">{t("common.loading")}</p>}
      {data?.kind === "suite" && (
        <SuiteReportDetail report={data.report as SuiteReport} t={t} publicView shareToken={token} />
      )}
      {data?.kind === "runner" && <RunnerShareView payload={data.report as RunnerReportPayload} token={token!} />}
    </main>
  </div>;
}

/** 仓库执行报告的公开读法：页头（任务名 + git 事实）+ 与 report tab 同一主体的报告视图。 */
function RunnerShareView({ payload, token }: { payload: RunnerReportPayload; token: string }) {
  /* useCallback 固定身份（2026-09-02 第三批 ①）：AttachmentView 的取数 effect 依赖它，
     每次渲染换新函数会让在途请求被丢弃、附件停在「正在加载」。 */
  const loadAttachment = useCallback(
    (source: string) => api.publicReportAttachment(token, source),
    [token],
  );
  return <>
    <div className="page-head">
      <div>
        <h1 className="mono">{payload.taskName} #{payload.run.runNumber}</h1>
        <p className="mono muted">{payload.run.gitRef}{payload.run.commitSha ? ` @ ${payload.run.commitSha.slice(0, 8)}` : ""}</p>
      </div>
    </div>
    <PipelineReportBody
      run={payload.run}
      cases={payload.cases}
      report={payload.report}
      reportLoaded
      loadAttachment={loadAttachment}
    />
  </>;
}
