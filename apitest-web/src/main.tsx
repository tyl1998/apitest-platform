import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { App as AntApp, ConfigProvider } from "antd";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./design-system.css";
import "./i18n";
import { Login } from "./components/Login";
import { Register } from "./components/Register";
import { ChangePassword } from "./components/ChangePassword";
import { GlobalApp } from "./components/GlobalApp";
import { ProjectShell } from "./components/ProjectShell";
import { EndpointList } from "./components/EndpointList";
import { EndpointWorkspace } from "./components/EndpointWorkspace";
import { FlowList } from "./components/FlowList";
import { FlowWorkspace } from "./components/FlowWorkspace";
import { SuiteList } from "./components/SuiteList";
import { Alerts } from "./components/Alerts";
import { SuiteReports, SuiteReportPage } from "./components/SuiteReports";
import { Trends } from "./components/Trends";
import { SuiteWorkspace } from "./components/SuiteWorkspace";
import { Environments } from "./components/Environments";
import { ExecutionRecords } from "./components/ExecutionRecords";
import { ExecutionResolver } from "./components/ExecutionResolver";
import { DataSourceList } from "./components/DataSourceList";
import { DataSourceDetail } from "./components/DataSourceDetail";
import { MockList } from "./components/MockList";
import { McpPage } from "./components/McpPage";
import { RepoCaseTreePage } from "./components/RepoCaseTree";
import { RepoCredentials } from "./components/RepoCredentials";
import { IngestRuns } from "./components/IngestRuns";
import { IngestUnmatched } from "./components/IngestUnmatched";
import { CiTaskList } from "./components/CiTaskList";
import { CiTaskEditor } from "./components/CiTaskEditor";
import { PipelineRunPage } from "./components/PipelineRunPage";
import { ShareReportPage } from "./components/ShareReportPage";
import { Members } from "./components/Members";
import { SpecCases } from "./components/SpecCases";
import { TestPlans, TestPlanPage } from "./components/TestPlans";
import { AssistantDock } from "./components/AssistantDock";
import { antdTheme, useMode } from "./theme";
import { useAuthStore } from "./stores/authStore";
import { useLimitsStore } from "./stores/limitsStore";
import { useNotificationPolling } from "./hooks/useNotifications";

function Protected() {
  const token = useAuthStore((state) => state.token);
  return token ? <Outlet /> : <Navigate to="/login" replace />;
}

/**
 * 强制改密闸（P6-3）：`mustChangePassword` 为 true 时，除 /change-password 外一律
 * 弹回改密页。初始密码是管理员或重置给的（多半躺在一次聊天记录里），在它换掉之前
 * 不该拿着别人的初始凭据逛平台。守卫在 Protected 内层：先有 token 才谈得上改密。
 *
 * 布局路由的 element 必须渲染 <Outlet />（不是 children——React Router 从不向
 * element 传 children，渲染 children 等于渲染空，全部页面白屏）。
 */
function PasswordGate() {
  const mustChangePassword = useAuthStore((state) => state.mustChangePassword);
  const location = useLocation();
  return mustChangePassword && location.pathname !== "/change-password"
    ? <Navigate to="/change-password" replace />
    : <Outlet />;
}

/**
 * 受保护层共用壳（2026-09-16 对话用户级化）：页面内容 + 站内助手。助手全局
 * 常驻——全局页与项目页同一份会话（路由 /api/v1/assistant/*，迁移 062）；挂在
 * PasswordGate 内层（强制改密期间不出现）、Routes 树内（AssistantDock 的
 * useParams 拿得到 /projects/:projectId 段）。入口按钮 portal 进两个壳顶栏的
 * #assistant-topbar-slot（原铃铛位）——壳互斥渲染，组件本体只挂这一份。
 */
function DockedShell() {
  return <>
    <Outlet />
    <AssistantDock />
  </>;
}

function Root() {
  const { mode, preference, setPreference } = useMode();
  const token = useAuthStore((state) => state.token);
  const hydrate = useAuthStore((state) => state.hydrate);
  const loadLimits = useLimitsStore((state) => state.load);
  /**
   * Restores the signed-in user on a reload.
   *
   * The token survives in localStorage, so routing works without this, but
   * `user` would stay null for the whole session — and anything gated on
   * `isSystemAdmin` would silently render as if the user had no rights.
   */
  useEffect(() => { void hydrate(); }, [hydrate]);

  /**
   * 平台执行预算，登录后拉一次（P2-4.2）。
   *
   * 在这里而不是各个编辑器里各拉一次：请求并发、循环并发、等待上限、套件成员并发四个
   * 输入框都要用它，分散拉取会让同一个常量被请求四遍，而它整个会话都不变。
   */
  useEffect(() => { if (token) void loadLimits(); }, [token, loadLimits]);

  return <ConfigProvider theme={antdTheme(mode)}><AntApp>
    {/* 站内通知轮询（P9-1）：60s + 获焦即拉 + 新到达弹窗。挂在 AntApp 内的一个
        空渲染组件里（useApp 的 notification 需要 <App> 上下文，Root 自身不在其内）；
        挂在壳之外——壳是互斥渲染的，「换壳不掉轮询基线」在这里最便宜。 */}
    <NotificationPoller />
    <Routes>
    <Route path="/login" element={token ? <Navigate to="/dashboard" replace /> : <Login />} />

    {/* 邀请码注册（P6-3）：在 Protected 之外——码即凭据，与报告分享页同层。带
        ?invite= 预填码，链接由签发人带外转给本人。 */}
    <Route path="/register" element={<Register />} />

    {/* 强制改密（P6-3）：在 Protected 内、PasswordGate 外——改密页自己不受闸门
        限制，否则会被自己弹回去。 */}
    <Route element={<Protected />}>
      <Route path="/change-password" element={<ChangePassword />} />

      <Route element={<PasswordGate />}>
        {/* 受保护层共用壳（2026-09-16）：全局页与项目层都在壳内——站内助手圆钮
            全局常驻（对话用户级化，见 DockedShell 注释）。 */}
        <Route element={<DockedShell />}>
        <Route path="/dashboard" element={<GlobalApp page="dashboard" themePreference={preference} onThemeChange={setPreference} />} />
        <Route path="/projects" element={<GlobalApp page="projects" themePreference={preference} onThemeChange={setPreference} />} />
        <Route path="/system" element={<GlobalApp page="system" themePreference={preference} onThemeChange={setPreference} />} />
        {/* P12-2：个人中心（全局层 `/me`，四个 tab）。通知整页迁为其 `/me/notifications`
            tab；旧 `/notifications` 路由删除——未发布无包袱，不留兼容跳转。`/me/:tab`
            覆盖 notifications / mcp / credentials（未知段由 MePage 回落基本信息）。 */}
        <Route path="/me" element={<GlobalApp page="me" themePreference={preference} onThemeChange={setPreference} />} />
        <Route path="/me/:tab" element={<GlobalApp page="me" themePreference={preference} onThemeChange={setPreference} />} />

      {/* One shell for the whole project layer, so child navigation never rebuilds it. */}
      <Route path="/projects/:projectId" element={<ProjectShell />}>
        {/* 进入项目默认落在「数据统计」（P8 边界 22）：统计页是项目的质量读数起点；
            overview 的重定向维持指 endpoints——「概览」是资产语义，改指统计会把它
            变成第二个统计入口。 */}
        <Route index element={<Navigate to="trends" replace />} />
        <Route path="overview" element={<Navigate to="../endpoints" replace />} />
        <Route path="endpoints" element={<EndpointList />} />
        {/* Opening an endpoint is opening its editor; there is no separate read-only view. */}
        <Route path="endpoints/:endpointId" element={<EndpointWorkspace />} />
        <Route path="endpoints/:endpointId/edit" element={<Navigate to=".." relative="path" replace />} />
        <Route path="flows" element={<FlowList />} />
        {/* Same rule as endpoints: opening a flow is opening its canvas. */}
        <Route path="flows/:flowId" element={<FlowWorkspace />} />
        <Route path="suites" element={<SuiteList />} />
        {/* Same rule again: opening a suite is opening its configuration. */}
        <Route path="suites/:suiteId" element={<SuiteWorkspace />} />
        <Route path="environments" element={<Environments />} />
        <Route path="data-sources" element={<DataSourceList />} />
        <Route path="data-sources/:dataSourceId" element={<DataSourceDetail />} />
        <Route path="mocks" element={<MockList />} />
        {/* P5：MCP 管理页（开关 / 端点 / Token / 工具清单）。只读展示 + 管理动作，
            不做对话式创建 UI（交互文档 3.10 的边界）。 */}
        <Route path="mcp" element={<McpPage />} />
        {/* P9-4 修订（2026-09-14）：站内助手默认开启、无项目配置页（assistant_enabled
            闸门随迁移 058 作废）；对话入口在顶栏（AssistantDock，2026-09-16
            用户级化后挂 DockedShell——全局常驻，按钮在两壳 topbar 的原铃铛位）。 */}
        <Route path="reports" element={<ExecutionRecords />} />
        {/* P8-7：统一执行入口（交互 6.2d）——按 indexId 解析到真实详情路由；统计侧
            深链从此只认这一个执行地址。在 ExecutionRecords 之前注册（路由匹配按
            声明顺序，reports 是前缀但这里是更长的具体段）。 */}
        <Route path="executions/by-index/:indexId" element={<ExecutionResolver />} />
        {/* P3：报告 / 趋势 / 告警。报告详情是只读派生物，独立路由而不是抽屉——
            它要能被分享、被收藏（执行记录页的父执行抽屉仍是另一个入口）。
            定时调度没有独立页：配置入口在套件详情页（P3-11）。 */}
        <Route path="suite-reports" element={<SuiteReports />} />
        <Route path="suite-reports/:executionId" element={<SuiteReportPage />} />
        <Route path="trends" element={<Trends />} />
        <Route path="alerts" element={<Alerts />} />
        {/* P6-4：成员与权限。页面本身 viewer 可读（「知道找谁要权限」），管理面在
            页内按 useMyRole 隐藏；路由不藏——后端守卫才是权限的单一事实。 */}
        <Route path="members" element={<Members />} />
        {/* P7-2：用例库（文本用例）。列表视图 + 详情抽屉先行；树视图/导入/绑定/
            测试计划在 P7-3…P7-7 逐批落进本页或同分组。 */}
        <Route path="spec-cases" element={<SpecCases />} />
        {/* P7-7：测试计划。列表 + 详情独立路由（照 suite-reports 先例——详情是
            按模块分组的大表，可收藏转发）。 */}
        <Route path="test-plans" element={<TestPlans />} />
        <Route path="test-plans/:planId" element={<TestPlanPage />} />
        {/* P4 + P4.5-14：仓库模式收成一个导航项、五个平级页面。各有自己的真实路由而不是
            `?tab=`——凭据页会被贴进别人的 CI 说明、上报记录会被贴进排查群，两者都要是一条
            能直接打开的地址。P4.5-15 起任务编辑也是独立页（`/repo/tasks/new|:taskId`，
            8.12 ①：8 个分区 + Monaco + 调度/通知面板，抽屉盛不下）。 */}
        <Route path="repo" element={<CiTaskList />} />
        <Route path="repo/tasks/new" element={<CiTaskEditor />} />
        <Route path="repo/tasks/:taskId" element={<CiTaskEditor />} />
        <Route path="repo/tree" element={<RepoCaseTreePage />} />
        <Route path="repo/runs" element={<IngestRuns />} />
        <Route path="repo/unmatched" element={<IngestUnmatched />} />
        <Route path="repo/credentials" element={<RepoCredentials />} />
        {/* P4.5-11/13：CI 执行详情。独立路由而不是执行记录页的抽屉——实时日志与报告
            视图都是长驻内容，抽屉盛不下；执行记录页的 runner 行跳到这里。 */}
        <Route path="pipeline-runs/:runId" element={<PipelineRunPage />} />
      </Route>

        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Route>
    </Route>

    {/* 报告分享的公开落地页（2026-09-02）：在 Protected 之外——链接即凭据，登录与否
        都能看。404（撤销/删除）由页面内 Empty 承担，不跳登录页（跳了就等于告诉一个
        未登录的访客「登录就能看」，而这份报告恰恰不需要登录）。 */}
    <Route path="/share/reports/:token" element={<ShareReportPage />} />

    <Route path="*" element={<Navigate to={token ? "/dashboard" : "/login"} replace />} />
  </Routes></AntApp></ConfigProvider>;
}

/** 轮询挂载点（见 Root 内注释）：空渲染，只出副作用。 */
function NotificationPoller() {
  useNotificationPolling();
  return null;
}

createRoot(document.getElementById("root")!).render(<BrowserRouter><Root /></BrowserRouter>);
