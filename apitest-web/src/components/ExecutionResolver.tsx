import { useEffect, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useProjectStore } from "../stores/projectStore";
import { Empty } from "../ui";

/**
 * 统一执行入口（P8-7，交互 6.2d 的预留路由）：`/projects/:id/executions/by-index/:indexId`
 * 按 kind 把一次执行**在客户端重定向**到它自己的详情页。
 *
 * 统计侧（图表下钻 / 通知深链 / 文档引用）从此只认这一个执行地址，不用知道「一次
 * 执行的详情页长什么样」——kind 的分派在这里收敛一次。后端 `routes/executionIndex.ts`
 * 有同一条路由（REST 302 版），两侧的分派语义逐字相同：
 * - `runner` → `pipeline-runs/:runId`（`?from=` 透传，面包屑归属机制）；
 * - `ingest` → `repo/runs`（仓库上报没有平台侧详情页，P4 边界 1）；
 * - `flow` / `suite`（含单步调试的自指行）→ 执行记录页 `?parent=` 深链，抽屉装载
 *   本来就按 indexId 走，不碰 detail_id。
 *
 * 之所以前端也放一份而不是只靠后端 302：站内跳转走 React Router 不发整页请求，
 * 深链才是这份组件的主场景。找不到行（删除/别的项目）给空态而不是跳登录——
 * 与报告分享页同一条纪律。
 */
export function ExecutionResolver() {
  const { t } = useTranslation();
  const { projectId, indexId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();
  const [searchParams] = useSearchParams();
  const [resolved, setResolved] = useState<string>();

  useEffect(() => {
    if (!projectId || !indexId || !loadedProjectId || projectLoading) return;
    let alive = true;
    setResolved(undefined);
    void api.executionIndexDetail(projectId, indexId)
      .then((row) => {
        if (!alive) return;
        /* from 只认 ProjectShell 的 PAGES 白名单——与后端 302 版同一条校验，这里
           防的是把任意 query 拼进站内跳转。 */
        const from = searchParams.get("from") ?? "";
        const fromQuery = from && ["endpoints", "flows", "suites", "environments", "data-sources", "mocks", "mcp", "repo", "spec-cases", "test-plans", "reports", "suite-reports", "trends", "alerts", "members"].includes(from) ? `&from=${encodeURIComponent(from)}` : "";
        if (row.kind === "runner") setResolved(`/projects/${projectId}/pipeline-runs/${row.detailId}${fromQuery ? `?${fromQuery.slice(1)}` : ""}`);
        else if (row.kind === "ingest") setResolved(`/projects/${projectId}/repo/runs`);
        else setResolved(`/projects/${projectId}/reports?type=parent&parent=${row.id}${fromQuery}`);
      })
      .catch(() => { if (alive) setResolved("not-found"); });
    return () => { alive = false; };
  }, [projectId, indexId, loadedProjectId, projectLoading, searchParams]);

  if (resolved === "not-found") {
    return <main className="content">
      <Empty title={t("resolver.notFoundTitle")} hint={t("resolver.notFoundHint")} />
    </main>;
  }
  if (resolved) return <Navigate to={resolved} replace />;
  return <main className="content"><p className="muted">{t("common.loading")}</p></main>;
}
