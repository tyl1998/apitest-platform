/**
 * Living style reference for the Quiet Console design system.
 *
 * This page imports the same primitives the app uses, so it cannot drift
 * from production. Open /theme-preview.html to audit tokens, states, and
 * breakpoints against .kilo/skill/quiet-console/SKILL.md.
 */
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Bell, Globe, History, Plug } from "lucide-react";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./design-system.css";
import "./i18n";
import { useMode } from "./theme";
import { Empty, Method, Readout, RunStrip, RunStatus, Status, Waterfall } from "./ui";
import { IconNavButton, SidebarToggle } from "./components/SidebarControls";
import { useSidebarCollapsed } from "./stores/sidebarStore";

type Row = {
  id: string;
  method: string;
  name: string;
  path: string;
  ms: number | null;
  status: RunStatus | null;
  history: RunStatus[];
};

const rows: Row[] = [
  { id: "e1", method: "POST", name: "用户登录", path: "/api/v1/auth/login", ms: 269, status: "pass", history: ["pass","pass","pass","fail","pass","pass","pass","pass","pass","pass","pass","pass"] },
  { id: "e2", method: "POST", name: "创建订单", path: "/api/v1/orders", ms: 812, status: "fail", history: ["pass","pass","fail","fail","pass","pass","fail","pass","pass","fail","fail","fail"] },
  { id: "e3", method: "GET", name: "订单详情", path: "/api/v1/orders/{id}", ms: 143, status: "pass", history: ["pass","pass","pass","pass","pass","pass","pass","pass","pass","pass","pass","pass"] },
  { id: "e4", method: "PUT", name: "更新库存", path: "/api/v1/inventory/{sku}", ms: 397, status: "pass", history: ["pass","pass","pass","skip","skip","pass","pass","pass","pass","pass","fail","pass"] },
  { id: "e5", method: "PATCH", name: "支付回调", path: "/api/v1/payments/callback", ms: null, status: "running", history: ["pass","fail","pass","pass","pass","pass","skip","pass","pass","pass","pass","pass"] },
  { id: "e6", method: "DELETE", name: "取消订单", path: "/api/v1/orders/{id}", ms: 221, status: "skip", history: ["skip","skip","pass","pass","pass","skip","skip","skip","pass","pass","pass","skip"] },
  { id: "e7", method: "GET", name: "健康检查", path: "/api/v1/health", ms: null, status: null, history: [] },
];

function Reference() {
  const { mode, toggle } = useMode();
  const { t } = useTranslation();
  const collapsed = useSidebarCollapsed();

  return (
    <div className="console" data-collapsed={collapsed || undefined}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="lockup">
            <span className="lockup-mark mono">AT</span>
            <span className="lockup-name">ApiTrack</span>
          </div>
          {collapsed
            ? <IconNavButton className="nav-item nav-back" icon={<ArrowLeft size={14} />} label={t("nav.backHome")} />
            : <button className="nav-item nav-back">
                <ArrowLeft size={14} />{t("nav.backHome")}
              </button>}
        </div>
        <nav>
          <div className="nav-group">
            <span className="nav-section">{t("nav.interfaceAssets")}</span>
            {collapsed
              ? <IconNavButton className="nav-item is-active" icon={<Plug size={14} />} label={t("nav.endpoints")} ariaCurrent="page" />
              : <button className="nav-item is-active" aria-current="page"><Plug size={14} />{t("nav.endpoints")}</button>}
            {collapsed
              ? <IconNavButton className="nav-item" icon={<Globe size={14} />} label={t("nav.environments")} />
              : <button className="nav-item"><Globe size={14} />{t("nav.environments")}</button>}
          </div>
          <div className="nav-group">
            <span className="nav-section">{t("nav.common")}</span>
            {collapsed
              ? <IconNavButton className="nav-item" icon={<History size={14} />} label={t("nav.reports")} />
              : <button className="nav-item"><History size={14} />{t("nav.reports")}</button>}
            {collapsed
              ? <IconNavButton className="nav-item" icon={<Bell size={14} />} label={t("nav.alerts")} />
              : <button className="nav-item"><Bell size={14} />{t("nav.alerts")}</button>}
          </div>
        </nav>
        <div className="sidebar-foot">
          <span className="chip mono">staging</span>
          <button className="btn btn-icon" onClick={toggle}>{mode === "light" ? "深色" : "浅色"}</button>
          <SidebarToggle />
        </div>
      </aside>

      <div className="frame">
        <header className="topbar">
          <div className="crumb">
            <span className="truncate">结算平台</span>
            <span className="crumb-sep">/</span>
            <strong>样式参考</strong>
          </div>
          <div className="topbar-actions">
            <button className="btn">导入</button>
            <button className="btn btn-primary">运行全部</button>
          </div>
        </header>

        <main className="content">
          <div className="page-head">
            <div>
              <h1>样式参考</h1>
              <p>与线上共用同一套原语，用于核对 token、状态与断点</p>
            </div>
          </div>

          <div className="readouts">
            <Readout label="接口" value={7} />
            <Readout label="通过" value={4} tone="pass" />
            <Readout label="失败" value={1} tone="fail" />
            <Readout label="P95 延迟" value={397} unit="ms" />
            <Readout label="成功率" value="94.2" unit="%" />
          </div>

          <table className="grid">
            <thead>
              <tr>
                <th>接口</th>
                <th className="col-path">路径</th>
                <th className="col-num">耗时</th>
                <th className="col-history">最近运行</th>
                <th className="col-status">状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-clickable="" className={row.id === "e2" ? "is-selected" : undefined}>
                  <td>
                    <div className="cell-name">
                      <Method method={row.method} />
                      <span className="truncate">{row.name}</span>
                    </div>
                  </td>
                  <td className="col-path mono truncate">{row.path}</td>
                  <td className="col-num mono">{row.ms ?? <span className="muted">—</span>}</td>
                  <td className="col-history"><RunStrip history={row.history} /></td>
                  <td className="col-status">
                    {row.status ? <Status status={row.status} /> : <span className="muted">未执行</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <section className="panel">
            <div className="panel-head">
              <div className="cell-name">
                <Method method="POST" />
                <strong>创建订单</strong>
                <span className="mono muted truncate">/api/v1/orders</span>
              </div>
              <Status status="fail" />
            </div>
            <div className="panel-body split">
              <Waterfall total={812} timings={{ dns: 12, tcp: 34, tls: 58, ttfb: 142, body: 23 }} />
              <div className="assertions">
                <span className="label">断言</span>
                <ul>
                  <li data-status="pass"><span className="mono">status == 200</span><span className="mono muted">200</span></li>
                  <li data-status="pass"><span className="mono">body.code == 0</span><span className="mono muted">0</span></li>
                  <li data-status="fail"><span className="mono">body.data.orderId exists</span><span className="mono">null</span></li>
                  <li data-status="pass"><span className="mono">duration &lt; 1000ms</span><span className="mono muted">812</span></li>
                </ul>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><strong>空状态</strong></div>
            <div className="panel-body">
              <Empty
                title="还没有接口"
                hint="登记一个接口后即可在选定环境中运行验证。"
                action={<button className="btn btn-primary">创建接口</button>}
              />
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Reference />);
