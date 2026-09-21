import { useEffect, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Bell, Bot, CalendarCheck, ChevronDown, ChevronRight, Database, FileClock, FolderGit2, Globe, History, Layers, ListChecks, Lock, Mail, MessageSquare, Plug, ScrollText, TrendingUp, Users, Workflow, type LucideIcon } from "lucide-react";
import { api, type AccessRequest, type ProjectIdentity, type ProjectRole } from "../api";
import { useCanWrite } from "../hooks/useMyRole";
import { useRecordLastPage } from "../hooks/useRecordLastPage";
import { useNavGuardStore } from "../stores/navGuardStore";
import { useProjectStore } from "../stores/projectStore";
import { useIsWideViewport, useSidebarCollapsed } from "../stores/sidebarStore";
import { IconNavButton, SidebarToggle } from "./SidebarControls";

const PAGES = ["endpoints", "flows", "suites", "environments", "data-sources", "mocks", "mcp", "repo", "spec-cases", "test-plans", "reports", "suite-reports", "trends", "alerts", "members", "audit"] as const;
export type ProjectPage = typeof PAGES[number];

/**
 * Route segments that belong to a nav section but are not that section's own name.
 * `pipeline-runs/:runId` is the repo task execution detail (an independent route, not
 * a `repo/*` child) — without the alias it falls through to the endpoints fallback and
 * the sidebar lights up 接口管理 while the user is inside 仓库模式.
 *
 * 2026-09-09（P8-3 验收反馈③）：从报告列表进入的仓库执行详情（`?from=suite-reports`）
 * 归「报告列表」而不是仓库——见 active 计算处的 fromSection 分叉；2026-09-10
 * （P8-6 验收反馈）扩到执行记录（`?from=reports`）：从哪进的就归哪。
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
  mcp: Bot,
  repo: FolderGit2,
  "spec-cases": ListChecks,
  "test-plans": CalendarCheck,
  reports: History,
  "suite-reports": ScrollText,
  trends: TrendingUp,
  alerts: Bell,
  members: Users,
  audit: FileClock,
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
  const confirmLeave = useNavGuardStore((state) => state.confirmLeave);
  const { projects, project, refresh, loadProject } = useProjectStore();
  /* 收起态驱动 `.console[data-collapsed]`（grid 轨道 + rail 排版一处声明）。
     宽度并进结果：940px 以下顶栏模式没有可收起的栏。 */
  const sidebarCollapsed = useSidebarCollapsed();
  /* 手风琴只在「桌面展开态」存在：顶栏模式（组溶解、条目平铺）与收起 rail
     都是平铺形态，折叠状态在那里没有排版意义。 */
  const accordionOn = useIsWideViewport() && !sidebarCollapsed;

  const segments = location.pathname.split("/").filter(Boolean);
  /* 兜底段同步默认页（P8 边界 22）：未知段回落「数据统计」而不是接口管理——与
     main.tsx 的 index 重定向同一个落点，两处不一致会出现「侧栏亮错项」。 */
  const routeSegment = segments[2] ?? "trends";
  /* 仓库执行详情的归属按入口区分（P8-3 验收反馈③；P8-6 反馈扩到执行记录）：URL 带
     `?from=<section>`（报告列表 / 执行记录的行点击写入）时归该 section，面包屑
     上级与侧栏高亮都是它；仓库模式内的入口（CI 任务/用例树/调度）不带参数，归
     「仓库」。query 是唯一事实源——刷新、新标签、分享链接都保持同一归属。 */
  const fromSection = routeSegment === "pipeline-runs" ? new URLSearchParams(location.search).get("from") : undefined;
  const fromReports = fromSection !== null && (PAGES as readonly string[]).includes(fromSection ?? "");
  const active: ProjectPage = (PAGES as readonly string[]).includes(routeSegment)
    ? routeSegment as ProjectPage
    : fromReports ? fromSection as ProjectPage
    : SECTION_ALIASES[routeSegment] ?? "trends";
  /* A detail page is open when the path carries an id past the section. */
  const endpointOpen = active === "endpoints" && Boolean(segments[3]);
  const flowOpen = active === "flows" && Boolean(segments[3]);
  const suiteOpen = active === "suites" && Boolean(segments[3]);
  const dataSourceOpen = active === "data-sources" && Boolean(segments[3]);
  const suiteReportOpen = routeSegment === "suite-reports" && Boolean(segments[3]);
  /* 测试计划详情同款：`test-plans/:planId` 打开时面包屑要走 detail 分叉。 */
  const testPlanOpen = active === "test-plans" && Boolean(segments[3]);
  /* 仓库执行详情是 repo 分组的子页（路由不在 repo/ 下，靠上面的别名归组）。它必须算
     detail 页：否则面包屑停在「仓库模式」这个不可点的标题上，进了执行详情就回不去
     任务列表（2026-09-02 验收缺陷）。 */
  const pipelineRunOpen = routeSegment === "pipeline-runs" && Boolean(segments[3]);
  const detailOpen = endpointOpen || flowOpen || suiteOpen || dataSourceOpen || suiteReportOpen || pipelineRunOpen || testPlanOpen;
  /* The report detail pushes its real name up through the outlet context so the
     crumb reads 项目/报告列表/{报告名称} rather than a generic「当前报告」. */
  const [detailTitle, setDetailTitle] = useState<string>();

  /**
   * P14-1 可见性两层的访问闸：非成员 URL 直达项目时，壳不再照常拉受保护数据
   * （environments/endpoints/settings 会一路 403，弹出全局无权限 toast），而是先问
   * 身份端点（登录即可读，边界 2），拿到「是不是成员」再决定渲染。
   * - undefined：还没问出来 → 壳先不渲染正文（避免闪一帧再弹 403）。
   * - isMember=false：渲染「无权限」落地页（找管理员降级态，申请入口在 P14-2）。
   * - isMember=true / 系统管理员：照常进壳。
   * 项目不存在（404）也归落地页——身份端点回 undefined 时 identity 为 null。
   */
  const [identity, setIdentity] = useState<ProjectIdentity | null>();
  useEffect(() => {
    if (!projectId) return;
    setIdentity(undefined);
    let alive = true;
    api.projectIdentity(projectId)
      .then((value) => { if (alive) setIdentity(value); })
      .catch(() => { if (alive) setIdentity(null); });
    return () => { alive = false; };
  }, [projectId]);
  const accessGranted = identity?.isMember ?? false;

  useEffect(() => { if (accessGranted) void refresh(); }, [refresh, accessGranted]);
  /* The URL owns which project is open, never leftover store state.
     只有成员才 loadProject——非成员的 loadProject 会触发受保护端点 403（P14-1）。 */
  useEffect(() => { if (projectId && accessGranted) void loadProject(projectId); }, [projectId, loadProject, accessGranted]);

  async function go(to: string) {
    if (to === location.pathname) return;
    if (await confirmLeave()) navigate(to);
  }

  /* 手风琴分组（2026-09-09 密度反馈）：15 项平铺读成一整坨，组标题改成可点的
     折叠头。默认态：前四组展开、项目配置收起（MCP/告警/成员是低频管理页）。
     导航到收起组内的页面时自动展开该组（elsewhere 展开不了当前页所在组会是
     「active 项看不见」的缺陷）。 */
  /* P11-10 边界 7：审计入口对 viewer 不渲染（路由不藏——后端守卫才是权限的单一事实）。
     这是侧栏唯一一处角色过滤：审计行含 email 与 IP，viewer 是唯一连页面都进不去的
     项目页，「一个你永远打不开的 tab 只是杂物」（边界 6）。 */
  const canReadAudit = useCanWrite();
  const nav: { group: ProjectPage; label: string; items: [ProjectPage, string][]; defaultOpen: boolean }[] = [
    /* 测试跟踪（2026-09-09）：文本用例与测试计划是「设计用例 → 跟踪执行」的
       起点，放在最上面——测试工作流从这里开始，往下才是编排与回归。 */
    { group: "spec-cases", label: t("nav.testTracking"), items: [["spec-cases", t("nav.specCases")], ["test-plans", t("nav.testPlans")]], defaultOpen: true },
    { group: "endpoints", label: t("nav.interfaceAssets"), items: [["endpoints", t("nav.endpoints")]], defaultOpen: true },
    { group: "flows", label: t("nav.orchestration"), items: [["flows", t("nav.flows")], ["suites", t("nav.suites")], ["repo", t("nav.repoMode")]], defaultOpen: true },
    /* 测试资源（2026-09-09 重组）：环境/数据源/Mock 从「接口资产」拆出——它们
       服务所有测试形态，不独属接口模式。 */
    { group: "environments", label: t("nav.testResources"), items: [["environments", t("nav.environments")], ["data-sources", t("nav.dataSources")], ["mocks", "Mock"]], defaultOpen: true },
    { group: "reports", label: t("nav.common"), items: [["reports", t("nav.reports")], ["suite-reports", t("nav.suiteReports")], ["trends", t("nav.trends")]], defaultOpen: true },
    /* 项目配置：默认收起。MCP / 告警 / 成员是配置完就不再来的页面。助手无项目页
       （P9-4 修订：默认开启、无项目闸门），对话入口在右下角常驻抽屉。
       审计（P11-10）挂在同一组：它是「这个项目里谁动过什么」的完整视图。 */
    { group: "members", label: t("nav.projectConfig"), items: [["mcp", "MCP"], ["alerts", t("nav.alerts")], ["audit", t("nav.audit")], ["members", t("nav.members")]], defaultOpen: false },
  ];
  const GROUP_OF: Partial<Record<ProjectPage, ProjectPage>> = Object.fromEntries(
    nav.flatMap((section) => section.items.map(([key]) => [key, section.group])),
  );
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<ProjectPage>>(() => {
    const defaults = nav.filter((section) => !section.defaultOpen).map((section) => section.group);
    return new Set(defaults);
  });
  /* 切换分组开合；当前组不能被收到看不见（active 项必须始终可见）。 */
  function toggleGroup(group: ProjectPage) {
    if (group === active) return;
    setClosedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  }
  /* kebab 路由段与 i18n 的 camelCase 键对不上（suite-reports ≠ suiteReports），与
     data-sources 同款在这里折中。 */
  const pageTitle = active === "data-sources" ? t("dataSources.title")
    : active === "suite-reports" ? t("suiteReports.title")
    : active === "spec-cases" ? t("specCases.title")
    : active === "test-plans" ? t("testPlans.title")
    : active === "repo" ? t("nav.repoMode")
    : active === "mocks" ? "Mock"
    : t(`${active}.title`);

  /* 访问闸（P14-1）：身份未问出前壳不渲染正文，问出非成员则渲染落地页。放在所有
     hook 之后——早返回不能越过 hook 调用。 */
  if (projectId && identity === undefined) return <div className="console-gate" />;
  if (projectId && !accessGranted) return <NoProjectAccess projectId={projectId} identity={identity ?? null} onBack={() => navigate("/projects")} />;

  return <div className="console" data-collapsed={sidebarCollapsed || undefined}>
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="lockup"><span className="lockup-mark mono">AT</span><span className="lockup-name truncate">{project?.name ?? t("app.name")}</span></div>
        {sidebarCollapsed
          ? <IconNavButton className="nav-item nav-back" icon={<ArrowLeft size={14} />} label={t("nav.backHome")} onClick={() => void go("/dashboard")} />
          : <button className="nav-item nav-back" onClick={() => void go("/dashboard")}>
              <ArrowLeft size={14} />{t("nav.backHome")}
            </button>}
      </div>
      <nav>
        {nav.map((section) => {
          /* 手风琴只存在于桌面展开态：940px 顶栏模式组已溶解成一条平铺
             流（收着的组在那里 = 页面凭空消失），收起 rail 同理恒平铺。
             当前页所在组视为展开（不写 state：URL 是唯一事实源，收着的组一旦
             成为 active 自动亮出来，离开后回落到用户的开合偏好）。 */
          const open = accordionOn && (!closedGroups.has(section.group) || GROUP_OF[active] === section.group);
          const GroupIcon = NAV_ICONS[section.group];
          return <div key={section.group} className="nav-group">
            {accordionOn
              ? <button
                  type="button"
                  className="nav-section"
                  aria-expanded={open}
                  onClick={() => toggleGroup(section.group)}
                >
                  <GroupIcon size={12} />
                  {section.label}
                  <span className="batch-caret" aria-hidden>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                </button>
              : <span className="nav-section" title={section.label}><GroupIcon size={12} />{section.label}</span>}
            {(!accordionOn || open) && section.items.filter(([key]) => key !== "audit" || canReadAudit).map(([key, label]) => {
              const Icon = NAV_ICONS[key];
              /* 收起态：标签交给 Tooltip（0.1s，与 Tip 同档）；展开态是普通按钮，
                 文字直接在位。aria-label 恒在——图标不能是它唯一的名字。 */
              return sidebarCollapsed
                ? <IconNavButton
                    key={key}
                    className={`nav-item${active === key ? " is-active" : ""}`}
                    icon={<Icon size={14} />}
                    label={label}
                    ariaCurrent={active === key ? "page" : undefined}
                    onClick={() => void go(`/projects/${projectId}/${key}`)}
                  />
                : (
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
          </div>;
        })}
      </nav>
      <div className="sidebar-foot">
        {/* 账号区不在这里（P12-2 修订 2026-09-16）：个人中心 / 登出在站内助手的
            抽屉头（与通知/换形象/主题/语言同排），顶栏右缘只留助手入口与项目切换。 */}
        <SidebarToggle />
      </div>
    </aside>
      <div className="frame">
        <header className="topbar">
        {/* Every crumb but the last is a link back to that level. */}
        <nav className="crumb" aria-label={t("nav.breadcrumb")}>
          {/* 面包屑的项目名是「返回项目」——落点是默认页（P8 边界 22 + 验收门槛 14：
              进入项目（含从这里进）默认落在数据统计页）。 */}
          <button className="crumb-link truncate" onClick={() => void go(`/projects/${projectId}/trends`)}>
            {project?.name ?? "—"}
          </button>
          <span className="crumb-sep">/</span>
          {detailOpen ? <>
             <button className="crumb-link" onClick={() => void go(`/projects/${projectId}/${active}`)}>{pageTitle}</button>
             <span className="crumb-sep">/</span>
              <strong className="truncate">{flowOpen ? t("flows.current") : suiteOpen ? t("suites.current") : dataSourceOpen ? t("dataSources.current") : suiteReportOpen ? (detailTitle ?? t("suiteReports.current")) : pipelineRunOpen ? (detailTitle ?? t("pipelineRun.title")) : testPlanOpen ? (detailTitle ?? t("testPlans.current")) : t("editor.current")}</strong>
            </> : <strong>{pageTitle}</strong>}
        </nav>
        <div className="topbar-actions">
          {/* 助手入口槽位（2026-09-16）：原铃铛位——AssistantDock 的头像按钮
              portal 进来（通知未读徽标也在这），抽屉内有最近通知。 */}
          <span id="assistant-topbar-slot" className="assistant-topbar-slot" />
          <Select
            value={projectId}
            onChange={(id) => void go(`/projects/${id}/${active}`)}
            /* 切换器只列成员项目（P14-1 边界 7 倾向）：切换器是「进入」的入口，非成员
               项目进去只有落地页；「发现」交给项目目录页。 */
            options={projects.filter((item) => item.isMember).map((item) => ({ value: item.id, label: item.name }))}
            placeholder={t("dashboard.projects")}
            style={{ width: 190 }}
          />
        </div>
      </header>
        {/* key={projectId}：切项目时重挂页面正文（壳保持挂载，不闪），页面本地列表状态
            随之复位——否则不重挂会显示上一个项目的旧数据（P10-7 同族缺陷）。 */}
        <Outlet key={projectId} context={{ setDetailTitle } satisfies DetailCrumbContext} />
    </div>
</div>;
}

/** 建议角色下拉的三档（与成员管理同一套词汇）；「不指定」= 交给管理员定。 */
const SUGGESTED_ROLES: ProjectRole[] = ["viewer", "developer", "project_admin"];

/**
 * 无权限落地页（P14-1 边界 2 / 验收门槛 2；P14-2 接自助申请入口）：非成员 URL 直达
 * 项目时渲染这里，而不是裸 403。展示项目身份（名称/描述）+ 管理员线索（姓名/邮箱，
 * 边界 7），并给出「申请加入」入口。
 *
 * 申请状态随落地页一并拉（`myAccessRequests` 过滤本项目）：已有 pending 时入口换成
 * 「申请审批中」的只读态（边界 6：单 pending，重复提交会 409，不给能点的按钮）；
 * 被拒 / 无申请时给「申请加入」按钮，可带一个建议角色（边界 7，管理员批准时可改定）。
 *
 * `identity` 为 null = 项目不存在（身份端点 404）或加载失败：退成「项目不存在」，
 * 不暴露管理员线索、也不给申请入口（一个不存在的项目没有可申请的对象）。
 */
function NoProjectAccess({ projectId, identity, onBack }: { projectId: string; identity: ProjectIdentity | null; onBack: () => void }) {
  const { t } = useTranslation();
  const missing = !identity;

  /* 本项目下我的申请（undefined = 还没问出来；null = 没有）。只看最近一条：被拒后
     可再申请，pending 唯一，approved 意味着我已是成员（不该还停在落地页）。 */
  const [myRequest, setMyRequest] = useState<AccessRequest | null>();
  const [applyOpen, setApplyOpen] = useState(false);
  const [suggestedRole, setSuggestedRole] = useState<ProjectRole | undefined>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (missing) { setMyRequest(null); return; }
    let alive = true;
    api.myAccessRequests()
      .then((list) => { if (alive) setMyRequest(list.find((request) => request.projectId === projectId) ?? null); })
      .catch(() => { if (alive) setMyRequest(null); });
    return () => { alive = false; };
  }, [projectId, missing]);

  const pending = myRequest?.status === "pending";

  async function submitApply() {
    setSubmitting(true);
    try {
      const created = await api.createAccessRequest(projectId, suggestedRole ? { suggestedRole } : undefined);
      setMyRequest(created);
      setApplyOpen(false);
      message.success(t("access.applySubmitted"));
    } catch (error) {
      const code = (error as { response?: { data?: { code?: number } } })?.response?.data?.code;
      /* 409 = 已是成员或已有 pending（并发窗口）：拉一次最新状态而不是报错。 */
      if (code === 2003) {
        api.myAccessRequests().then((list) => setMyRequest(list.find((request) => request.projectId === projectId) ?? null)).catch(() => {});
        message.info(t("access.applyConflict"));
        setApplyOpen(false);
      } else {
        message.error(t("access.applyFailed"));
      }
    } finally { setSubmitting(false); }
  }

  return <div className="access-landing">
    <div className="access-landing-card">
      <div className="access-landing-mark" aria-hidden><Lock size={20} /></div>
      {missing ? <>
        <h1>{t("access.missingTitle")}</h1>
        <p className="muted">{t("access.missingHint")}</p>
      </> : <>
        <p className="access-landing-eyebrow">{t("access.eyebrow")}</p>
        <h1>{identity.name}</h1>
        {identity.description && <p className="access-landing-desc">{identity.description}</p>}
        <p className="muted">{t("access.noAccessHint")}</p>
        {identity.admins.length ? <div className="access-landing-admins">
          <p className="access-landing-admins-label">{t("access.adminsLabel")}</p>
          <ul>
            {identity.admins.map((admin) => <li key={admin.email}>
              <span className="truncate">{admin.name}</span>
              <a className="access-admin-mail" href={`mailto:${admin.email}`}><Mail size={13} />{admin.email}</a>
            </li>)}
          </ul>
        </div> : <p className="muted access-landing-noadmin">{t("access.noAdminHint")}</p>}
        {/* 申请状态条：pending 时是只读的「审批中」，被拒时提示可再申请。 */}
        {pending && <p className="access-landing-pending">{t("access.applyPending")}</p>}
        {myRequest?.status === "rejected" && <p className="muted access-landing-rejected">{myRequest.note ? t("access.applyRejectedNote", { note: myRequest.note }) : t("access.applyRejected")}</p>}
      </>}
      <div className="access-landing-actions">
        <button className="btn" onClick={onBack}>{t("access.backToProjects")}</button>
        {!missing && myRequest !== undefined && !pending && (
          <button className="btn btn-primary" onClick={() => { setSuggestedRole(undefined); setApplyOpen(true); }}>
            {myRequest?.status === "rejected" ? t("access.applyAgain") : t("access.apply")}
          </button>
        )}
      </div>
    </div>

    {/* 申请弹窗：可选一个建议角色（管理员批准时可改定，边界 7）。 */}
    <Modal
      open={applyOpen}
      title={t("access.applyTitle")}
      okText={t("access.applySubmit")}
      cancelText={t("action.cancel")}
      confirmLoading={submitting}
      onOk={() => void submitApply()}
      onCancel={() => setApplyOpen(false)}
    >
      <p className="form-note">{t("access.applyHint")}</p>
      <label className="field" style={{ marginTop: "var(--s4)" }}>
        <span>{t("access.suggestedRole")}</span>
        <Select
          allowClear
          value={suggestedRole}
          onChange={(value) => setSuggestedRole(value)}
          placeholder={t("access.suggestedRolePlaceholder")}
          options={SUGGESTED_ROLES.map((role) => ({ value: role, label: role }))}
          style={{ width: "100%" }}
        />
      </label>
      <p className="form-note">{t("access.suggestedRoleHint")}</p>
    </Modal>
  </div>;
}
