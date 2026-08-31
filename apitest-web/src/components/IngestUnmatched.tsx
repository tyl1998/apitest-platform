import { useEffect, useState } from "react";
import { Modal, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { api, type Endpoint, type IngestPathRule, type UnmatchedPath } from "../api";
import { useProjectStore } from "../stores/projectStore";
import { Empty, Method } from "../ui";
import { IconButton } from "./IconButton";
import { RepoPageHead, RepoTabs } from "./RepoShell";

/**
 * 未匹配诊断视图（P4-9，边界 20）。
 *
 * **这是诊断视图，不是待办清单。** 这一页刻意**没有**：待处理计数、红点、「全部处理」
 * 按钮——清单会被清空，而清空的动作会鼓励把别的系统的接口批量拉进本项目的分母。
 *
 * 2026-08-30 修订（用户确认）：恢复**单行**「登记接口」动作。仓库模式团队不该为了覆盖率
 * 把仓库里已有的接口清单在平台再抄一遍——路径已经躺在这张表里了，登记只是把「去接口页
 * 填一张表」变成「确认一个预填好的模板」。边界 20 的精神不变：进分母始终是一次显式
 * 决定；仍无批量、无计数、无红点。
 *
 * 保留的另外两个动作：
 * - **关联到已登记接口**：安全，目标本来就在本项目、本来就在分母里。它解决的也不是归属
 *   问题，而是 path 归一没匹配上（`/users/abc-123` 这类）——那是技术缺陷，该修。
 * - **标为外部依赖并写成前缀规则**：命中即在这张列表里静默。它**只影响这张诊断列表的显示，
 *   不影响任何统计**——所以规则写错的代价是「列表里多一条或少一条」，不是一次分类错误。
 *
 * 每行三样都是**读时标注**而不是判定：频次与用例、phase 分布、别的项目是否登记过。
 * 错了也没有后果——它们从不参与任何数字。
 */

const PAGE_SIZES = [20, 50, 100];

/** phase 分布里占多数的那一段。集中在 setup 几乎一定是跨系统前置（唯一有判别力的信号）。 */
function dominantPhase(phases: UnmatchedPath["phases"]) {
  const entries = Object.entries(phases) as [keyof UnmatchedPath["phases"], number][];
  const top = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best), entries[0]);
  return top[1] > 0 ? top[0] : undefined;
}

export function IngestUnmatched() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();

  const [items, setItems] = useState<UnmatchedPath[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  /** 看被静默的那些：规则写错时这是唯一能查回来的入口。 */
  const [silenced, setSilenced] = useState(false);
  const [loading, setLoading] = useState(false);

  const [rules, setRules] = useState<IngestPathRule[]>([]);
  const [rulePrefix, setRulePrefix] = useState("");
  const [ruleNote, setRuleNote] = useState("");

  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [linking, setLinking] = useState<UnmatchedPath>();
  const [linkTarget, setLinkTarget] = useState<string>();
  /** 一键登记：路径预填当前模板但**可编辑**——通用归一只认「长得像 id」的段，`/users/abc`
      这类要人工改成 `/users/{username}`，否则下一轮其它取值仍然匹配不上。 */
  const [registering, setRegistering] = useState<UnmatchedPath>();
  const [registerPath, setRegisterPath] = useState("");
  const [registerName, setRegisterName] = useState("");

  async function load() {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    setLoading(true);
    try {
      const [list, ruleList] = await Promise.all([
        api.ingestUnmatched(projectId, { silenced, page, pageSize }),
        api.ingestPathRules(projectId),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setRules(ruleList);
    } catch { message.error(t("repoCases.unmatchedLoadFailed")); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [projectId, loadedProjectId, projectLoading, silenced, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (projectId) void api.endpoints(projectId).then(setEndpoints).catch(() => setEndpoints([])); }, [projectId]);

  async function createRule(prefix: string, note: string) {
    if (!projectId || !prefix.trim()) { message.error(t("repoCases.rulePrefixRequired")); return; }
    try {
      await api.createIngestPathRule(projectId, { pathPrefix: prefix.trim(), note: note.trim() });
      setRulePrefix(""); setRuleNote("");
      await load();
    } catch (error) {
      message.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t("repoCases.ruleCreateFailed"));
    }
  }

  function removeRule(rule: IngestPathRule) {
    if (!projectId) return;
    Modal.confirm({
      title: t("repoCases.ruleDeleteTitle", { prefix: rule.pathPrefix }),
      /* 说清「历史记录从未被改写」：静默是读时算的，删规则只是让它们重新显示出来。 */
      content: t("repoCases.ruleDeleteHint"),
      okText: t("action.delete"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.deleteIngestPathRule(projectId, rule.id); await load(); }
        catch { message.error(t("repoCases.ruleDeleteFailed")); }
      },
    });
  }

  async function link() {
    if (!projectId || !linking || !linkTarget) return;
    try {
      const result = await api.linkUnmatched(projectId, { method: linking.method, path: linking.path, endpointId: linkTarget });
      message.success(t("repoCases.linked", { records: result.linkedRecords, cases: result.linkedCases }));
      setLinking(undefined); setLinkTarget(undefined);
      await load();
    } catch { message.error(t("repoCases.linkFailed")); }
  }

  async function register() {
    if (!projectId || !registering || !registerPath.trim()) return;
    try {
      const result = await api.registerUnmatched(projectId, { method: registering.method, path: registerPath.trim(), name: registerName.trim() || undefined });
      message.success(t("repoCases.registered", { records: result.linkedRecords, cases: result.linkedCases }));
      setRegistering(undefined); setRegisterPath(""); setRegisterName("");
      await load();
    } catch (error) {
      /* 409（同形已登记，该用「关联」）之类的信息是服务器给的行动指引，原样透出而不是
         换成一句笼统的「失败」。 */
      message.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t("repoCases.registerFailed"));
    }
  }

  /** 「标为外部依赖」= 用这条路径的前缀直接写一条规则，省掉手抄一遍。 */
  function markExternal(item: UnmatchedPath) {
    /* 取到倒数第二段为止的前缀（`/api/v2/user/orders` → `/api/v2/user/`）：整条路径当
       前缀只能盖住它自己，而外部依赖通常是一整片。前缀可多层，且允许用户在下面改。 */
    const segments = item.path.split("/").filter(Boolean);
    const prefix = segments.length > 1 ? `/${segments.slice(0, -1).join("/")}/` : `/${segments[0] ?? ""}`;
    setRulePrefix(prefix);
    setRuleNote(t("repoCases.ruleNoteFrom", { method: item.method, path: item.path }));
  }

  return <main className="content">
    <RepoPageHead title={t("repoCases.unmatchedTitle")} hint={t("repoCases.unmatchedHint")} />
    <RepoTabs active="unmatched" />

    {/* 不变量必须写在页面上：这一整页的任何误判都不会让覆盖率虚高。 */}
    <p className="form-note">{t("repoCases.unmatchedInvariant")}</p>

    <div className="filter-bar">
      <label className="check-field">
        <input type="checkbox" checked={silenced} onChange={(event) => { setSilenced(event.target.checked); setPage(1); }} />
        {t("repoCases.showSilenced")}
      </label>
      <span className="filter-spacer" />
      <span className="muted mono">{t("repoCases.pathTotal", { total })}</span>
    </div>

    {loading && <p className="muted">{t("common.loading")}</p>}

    {items.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("repoCases.path")}</th>
        <th className="col-num">{t("repoCases.hitCount")}</th>
        <th>{t("repoCases.phaseSplit")}</th>
        <th>{t("repoCases.hitByCases")}</th>
        <th>{t("repoCases.registeredElsewhere")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {items.map((item) => {
          const dominant = dominantPhase(item.phases);
          return <tr key={`${item.method} ${item.path}`}>
            <td>
              <span className="cell-name">
                <Method method={item.method} />
                <span className="mono truncate" title={item.path}>{item.path}</span>
              </span>
              <span className="resource-type mono">{item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : "—"}</span>
            </td>
            <td className="col-num mono">{item.hitCount}</td>
            {/* phase 分布不用语义色（见 design-system 的 .phase-split 注释）：它说的是
                「请求发生在哪个阶段」，不是通过/失败。 */}
            <td>
              <span className="phase-split">
                <span data-dominant={dominant === "setup" ? "" : undefined}>setup {item.phases.setup}</span>
                <span data-dominant={dominant === "call" ? "" : undefined}>call {item.phases.call}</span>
                <span data-dominant={dominant === "teardown" ? "" : undefined}>teardown {item.phases.teardown}</span>
              </span>
              {dominant === "setup" && <span className="resource-type">{t("repoCases.setupHeavyHint")}</span>}
            </td>
            <td className="truncate" title={item.caseNames.join("\n")}>
              {item.caseNames.length ? `${item.caseNames[0]}${item.caseCount > 1 ? t("repoCases.andMoreCases", { count: item.caseCount - 1 }) : ""}` : "—"}
            </td>
            {/* 空着**不代表**「这是我们的」：别的项目还没做自动化时它就是空的（边界 20）。 */}
            <td className="truncate">{item.registeredInProjects.length ? item.registeredInProjects.join("、") : <span className="muted">—</span>}</td>
            <td className="col-actions">
              <div className="row-actions">
                <button className="btn btn-small" onClick={() => { setRegistering(item); setRegisterPath(item.path); setRegisterName(""); }}>{t("repoCases.register")}</button>
                <button className="btn btn-small" onClick={() => { setLinking(item); setLinkTarget(undefined); }}>{t("repoCases.link")}</button>
                <button className="btn btn-small" onClick={() => markExternal(item)}>{t("repoCases.markExternal")}</button>
              </div>
            </td>
          </tr>;
        })}
      </tbody>
    </table></div> : !loading && <Empty
      title={silenced ? t("repoCases.silencedEmpty") : t("repoCases.unmatchedEmpty")}
      hint={silenced ? t("repoCases.silencedEmptyHint") : t("repoCases.unmatchedEmptyHint")}
    />}

    {total > pageSize && <div className="pager">
      <Pagination current={page} pageSize={pageSize} total={total} pageSizeOptions={PAGE_SIZES} showSizeChanger onChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }} />
    </div>}

    <section className="panel">
      <div className="panel-head"><strong>{t("repoCases.rules")}</strong></div>
      <div className="panel-body">
        <p className="form-note">{t("repoCases.rulesHint")}</p>
        <div className="filter-bar">
          <input className="input mono" value={rulePrefix} onChange={(event) => setRulePrefix(event.target.value)} placeholder="/api/v2/user/" style={{ width: 240 }} />
          <input className="input" value={ruleNote} onChange={(event) => setRuleNote(event.target.value)} placeholder={t("repoCases.ruleNotePlaceholder")} style={{ width: 280 }} />
          <button className="btn btn-primary btn-with-icon" onClick={() => void createRule(rulePrefix, ruleNote)}><Plus size={14} />{t("repoCases.createRule")}</button>
        </div>
        {rules.length ? <table className="grid">
          <thead><tr>
            <th className="mono">{t("repoCases.rulePrefix")}</th>
            <th>{t("repoCases.ruleNote")}</th>
            <th>{t("status.time")}</th>
            <th className="col-actions" />
          </tr></thead>
          <tbody>
            {rules.map((rule) => <tr key={rule.id}>
              <td className="mono">{rule.pathPrefix}</td>
              <td className="muted truncate">{rule.note || "—"}</td>
              <td className="mono muted">{new Date(rule.createdAt).toLocaleString()}</td>
              <td className="col-actions">
                <div className="row-actions">
                  <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => removeRule(rule)} />
                </div>
              </td>
            </tr>)}
          </tbody>
        </table> : <p className="form-note">{t("repoCases.rulesEmpty")}</p>}
      </div>
    </section>

    <Modal
      title={t("repoCases.linkTitle")}
      open={Boolean(linking)}
      onCancel={() => { setLinking(undefined); setLinkTarget(undefined); }}
      onOk={() => void link()}
      okButtonProps={{ disabled: !linkTarget }}
      okText={t("repoCases.link")}
      cancelText={t("action.cancel")}
    >
      {linking && <>
        <p className="mono">{linking.method} {linking.path}</p>
        {/* 只能选**本项目已登记**的接口：这就是它安全的原因。这里刻意没有「新建接口」
            入口——新建走「登记接口」，它有自己的同形拦截与说明。 */}
        <Select
          value={linkTarget}
          onChange={setLinkTarget}
          placeholder={t("repoCases.linkPlaceholder")}
          style={{ width: "100%" }}
          showSearch
          optionFilterProp="label"
          options={endpoints.map((endpoint) => ({ value: endpoint.id, label: `${endpoint.method} ${endpoint.url}` }))}
        />
        <p className="form-note">{t("repoCases.linkHint")}</p>
      </>}
    </Modal>

    {/* 一键登记：method 固定取行上的，模板可编辑（见 registering 的注释），名称可选。 */}
    <Modal
      title={t("repoCases.registerTitle")}
      open={Boolean(registering)}
      onCancel={() => { setRegistering(undefined); setRegisterPath(""); setRegisterName(""); }}
      onOk={() => void register()}
      okButtonProps={{ disabled: !registerPath.trim().startsWith("/") }}
      okText={t("repoCases.register")}
      cancelText={t("action.cancel")}
    >
      {registering && <>
        <p className="mono">{registering.method}</p>
        <label className="label" htmlFor="register-path">{t("repoCases.registerPath")}</label>
        <input id="register-path" className="input mono" value={registerPath} onChange={(event) => setRegisterPath(event.target.value)} style={{ width: "100%" }} />
        <label className="label" htmlFor="register-name" style={{ display: "block", marginTop: 10 }}>{t("repoCases.registerName")}</label>
        <input id="register-name" className="input" value={registerName} onChange={(event) => setRegisterName(event.target.value)} placeholder={t("repoCases.registerNamePlaceholder")} style={{ width: "100%" }} />
        <p className="form-note" style={{ marginTop: 10 }}>{t("repoCases.registerHint")}</p>
      </>}
    </Modal>
  </main>;
}
