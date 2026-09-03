import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { App as AntApp, ConfigProvider } from "antd";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./design-system.css";
import "./i18n";
import { Login } from "./components/Login";
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
import { DataSourceList } from "./components/DataSourceList";
import { DataSourceDetail } from "./components/DataSourceDetail";
import { MockList } from "./components/MockList";
import { RepoCaseTreePage } from "./components/RepoCaseTree";
import { RepoCredentials } from "./components/RepoCredentials";
import { IngestRuns } from "./components/IngestRuns";
import { IngestUnmatched } from "./components/IngestUnmatched";
import { CiTaskList } from "./components/CiTaskList";
import { CiTaskEditor } from "./components/CiTaskEditor";
import { PipelineRunPage } from "./components/PipelineRunPage";
import { ShareReportPage } from "./components/ShareReportPage";
import { antdTheme, useMode } from "./theme";
import { useAuthStore } from "./stores/authStore";
import { useLimitsStore } from "./stores/limitsStore";

function Protected() {
  const token = useAuthStore((state) => state.token);
  return token ? <Outlet /> : <Navigate to="/login" replace />;
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

  return <ConfigProvider theme={antdTheme(mode)}><AntApp><Routes>
    <Route path="/login" element={token ? <Navigate to="/dashboard" replace /> : <Login />} />

    <Route element={<Protected />}>
      <Route path="/dashboard" element={<GlobalApp page="dashboard" themePreference={preference} onThemeChange={setPreference} />} />
      <Route path="/projects" element={<GlobalApp page="projects" themePreference={preference} onThemeChange={setPreference} />} />
      <Route path="/system" element={<GlobalApp page="system" themePreference={preference} onThemeChange={setPreference} />} />

      {/* One shell for the whole project layer, so child navigation never rebuilds it. */}
      <Route path="/projects/:projectId" element={<ProjectShell />}>
        <Route index element={<Navigate to="endpoints" replace />} />
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
        <Route path="reports" element={<ExecutionRecords />} />
        {/* P3：报告 / 趋势 / 告警。报告详情是只读派生物，独立路由而不是抽屉——
            它要能被分享、被收藏（执行记录页的父执行抽屉仍是另一个入口）。
            定时调度没有独立页：配置入口在套件详情页（P3-11）。 */}
        <Route path="suite-reports" element={<SuiteReports />} />
        <Route path="suite-reports/:executionId" element={<SuiteReportPage />} />
        <Route path="trends" element={<Trends />} />
        <Route path="alerts" element={<Alerts />} />
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

    {/* 报告分享的公开落地页（2026-09-02）：在 Protected 之外——链接即凭据，登录与否
        都能看。404（撤销/删除）由页面内 Empty 承担，不跳登录页（跳了就等于告诉一个
        未登录的访客「登录就能看」，而这份报告恰恰不需要登录）。 */}
    <Route path="/share/reports/:token" element={<ShareReportPage />} />

    <Route path="*" element={<Navigate to={token ? "/dashboard" : "/login"} replace />} />
  </Routes></AntApp></ConfigProvider>;
}

createRoot(document.getElementById("root")!).render(<BrowserRouter><Root /></BrowserRouter>);
