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
import { SuiteWorkspace } from "./components/SuiteWorkspace";
import { Environments } from "./components/Environments";
import { ExecutionRecords } from "./components/ExecutionRecords";
import { DataSourceList } from "./components/DataSourceList";
import { DataSourceDetail } from "./components/DataSourceDetail";
import { MockList } from "./components/MockList";
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
      </Route>

      <Route path="/" element={<Navigate to="/dashboard" replace />} />
    </Route>

    <Route path="*" element={<Navigate to={token ? "/dashboard" : "/login"} replace />} />
  </Routes></AntApp></ConfigProvider>;
}

createRoot(document.getElementById("root")!).render(<BrowserRouter><Root /></BrowserRouter>);
