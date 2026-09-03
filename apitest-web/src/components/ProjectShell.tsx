import { useEffect, useState } from "react";
import { Select } from "antd";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Bell, Database, FolderGit2, Globe, History, Layers, LogOut, MessageSquare, Plug, ScrollText, TrendingUp, Workflow, type LucideIcon } from "lucide-react";
import { useRecordLastPage } from "../hooks/useRecordLastPage";
import { useAuthStore } from "../stores/authStore";
import { useNavGuardStore } from "../stores/navGuardStore";
import { useProjectStore } from "../stores/projectStore";
import { IconButton } from "./IconButton";

const PAGES = ["endpoints", "flows", "suites", "environments", "data-sources", "mocks", "repo", "reports", "suite-reports", "trends", "alerts"] as const;
export type ProjectPage = typeof PAGES[number];

/**
 * Route segments that belong to a nav section but are not that section's own name.
 * `pipeline-runs/:runId` is the repo task execution detail (an independent route, not
 * a `repo/*` child) — without the alias it falls through to the endpoints fallback and
 * the sidebar lights up 接口管理 while the user is inside 仓库模式.
 */
const SECTION_ALIASES: Partial<Record<string, ProjectPage>> = { "pipeline-runs": "repo" };

/** One outline mark per destination, so the rail scans without reading. */
const NAV_ICONS: Record<ProjectPage, LucideIcon> = {
  endpoints: Plug,
  flows: Workflow,
  suites: Layers,
  environments: Globe,
  "data-sources": Database,
  mocks: MessageSquare,
  repo: FolderGit2,
  reports: History,
  "suite-reports": ScrollText,
  trends: TrendingUp,
  alerts: Bell,
};

/** What a detail page hands up so the crumb can show its real name. */
export type DetailCrumbContext = { setDetailTitle: (title?: string) => void };

/**
 * Layout route for everything inside a project.
 *
 * Renders once and stays mounted across child navigations, so moving between
 * the endpoint list, an endpoint workspace and the execution records does not
 * tear down and rebuild the shell.
 *
 * Navigation runs through the nav guard, so an editor with unsaved changes can
 * still intervene even though the editor no longer carries its own back link.
 */
export function ProjectShell() {
  useRecordLastPage();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId } = useParams();
  const logout = useAuthStore((state) => state.logout);
  const confirmLeave = useNavGuardStore((state) => state.confirmLeave);
  const { projects, project, refresh, loadProject } = useProjectStore();

  const segments = location.pathname.split("/").filter(Boolean);
  const routeSegment = segments[2] ?? "endpoints";
  const active: ProjectPage = (PAGES as readonly string[]).includes(routeSegment)
    ? routeSegment as ProjectPage
    : SECTION_ALIASES[routeSegment] ?? "endpoints";
  /* A detail page is open when the path carries an id past the section. */
  const endpointOpen = active === "endpoints" && Boolean(segments[3]);
  const flowOpen = active === "flows" && Boolean(segments[3]);
  const suiteOpen = active === "suites" && Boolean(segments[3]);
  const dataSourceOpen = active === "data-sources" && Boolean(segments[3]);
  const suiteReportOpen = active === "suite-reports" && Boolean(segments[3]);
  /* 仓库执行详情是 repo 分组的子页（路由不在 repo/ 下，靠上面的别名归组）。它必须算
     detail 页：否则面包屑停在「仓库模式」这个不可点的标题上，进了执行详情就回不去
     任务列表（2026-09-02 验收缺陷）。 */
  const pipelineRunOpen = routeSegment === "pipeline-runs" && Boolean(segments[3]);
  const detailOpen = endpointOpen || flowOpen || suiteOpen || dataSourceOpen || suiteReportOpen || pipelineRunOpen;
  /* The report detail pushes its real name up through the outlet context so the
     crumb reads 项目/报告列表/{报告名称} rather than a generic「当前报告」. */
  const [detailTitle, setDetailTitle] = useState<string>();

  useEffect(() => { void refresh(); }, [refresh]);
  /* The URL owns which project is open, never leftover store state. */
  useEffect(() => { if (projectId) void loadProject(projectId); }, [projectId, loadProject]);

  async function go(to: string) {
    if (to === location.pathname) return;
    if (await confirmLeave()) navigate(to);
  }

  const nav: { group: string; items: [ProjectPage, string][] }[] = [
    { group: t("nav.interfaceAssets"), items: [["endpoints", t("nav.endpoints")], ["environments", t("nav.environments")], ["data-sources", t("nav.dataSources")], ["mocks", "Mock"]] },
    /* 定时调度没有独立页（P3-11）：配置入口在套件详情页的「定时调度」面板。 */
    { group: t("nav.orchestration"), items: [["flows", t("nav.flows")], ["suites", t("nav.suites")]] },
    /* 仓库模式是**一个导航项**（P4.5-14，计划 8.11 的 C 类）：任务 / 用例树 / 上报记录 /
       未匹配诊断 / 凭据五块共享同一个前提（测试代码在用户的仓库里），页内用标签条切换。
       P4.5-11 曾把它劈成「仓库用例」与「CI 任务」两项，结果「为什么 CI 任务要先绑仓库、
       另外几页不用」变成每次都要重新解释的问题；Git 来源搬到任务上之后那个前置条件也
       没了，于是一并收成一项。 */
    { group: t("nav.repoMode"), items: [["repo", t("nav.repoMode")]] },
    { group: t("nav.common"), items: [["reports", t("nav.reports")], ["suite-reports", t("nav.suiteReports")], ["trends", t("nav.trends")], ["alerts", t("nav.alerts")]] },
  ];
  /* kebab 路由段与 i18n 的 camelCase 键对不上（suite-reports ≠ suiteReports），与
     data-sources 同款在这里折中。 */
  const pageTitle = active === "data-sources" ? t("dataSources.title")
    : active === "suite-reports" ? t("suiteReports.title")
    : active === "repo" ? t("nav.repoMode")
    : active === "mocks" ? "Mock"
    : t(`${active}.title`);

  return <div className="console">
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="lockup"><span className="lockup-mark mono">AT</span><span className="lockup-name truncate">{project?.name ?? t("app.name")}</span></div>
        <button className="nav-item nav-back" onClick={() => void go("/dashboard")}>
          <ArrowLeft size={14} />{t("nav.backHome")}
        </button>
      </div>
      <nav>
        {nav.map((section) => <div key={section.group} className="nav-group">
          <span className="nav-section">{section.group}</span>
          {section.items.map(([key, label]) => {
            const Icon = NAV_ICONS[key];
            return (
              <button
                key={key}
                className={`nav-item${active === key ? " is-active" : ""}`}
                aria-current={active === key ? "page" : undefined}
                onClick={() => void go(`/projects/${projectId}/${key}`)}
              >
                <Icon size={14} />{label}
              </button>
            );
          })}
        </div>)}
      </nav>
      <div className="sidebar-foot">
        <IconButton
          icon={<LogOut size={15} />}
          label={t("action.logout")}
          onClick={() => { logout(); navigate(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`); }}
        />
      </div>
    </aside>
    <div className="frame">
      <header className="topbar">
        {/* Every crumb but the last is a link back to that level. */}
        <nav className="crumb" aria-label={t("nav.breadcrumb")}>
          <button className="crumb-link truncate" onClick={() => void go(`/projects/${projectId}/endpoints`)}>
            {project?.name ?? "—"}
          </button>
          <span className="crumb-sep">/</span>
          {detailOpen ? <>
             <button className="crumb-link" onClick={() => void go(`/projects/${projectId}/${active}`)}>{pageTitle}</button>
             <span className="crumb-sep">/</span>
             <strong className="truncate">{flowOpen ? t("flows.current") : suiteOpen ? t("suites.current") : dataSourceOpen ? t("dataSources.current") : suiteReportOpen ? (detailTitle ?? t("suiteReports.current")) : pipelineRunOpen ? (detailTitle ?? t("pipelineRun.title")) : t("editor.current")}</strong>
            </> : <strong>{pageTitle}</strong>}
        </nav>
        <div className="topbar-actions">
          <Select
            value={projectId}
            onChange={(id) => void go(`/projects/${id}/${active}`)}
            options={projects.map((item) => ({ value: item.id, label: item.name }))}
            placeholder={t("dashboard.projects")}
            style={{ width: 190 }}
          />
        </div>
      </header>
        <Outlet context={{ setDetailTitle } satisfies DetailCrumbContext} />
    </div>
  </div>;
}
