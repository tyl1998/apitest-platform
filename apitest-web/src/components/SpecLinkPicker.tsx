import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal, Pagination, message } from "antd";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { api, type Endpoint, type FlowSummary, type RepoTestCase, type SpecCaseLink, type SpecLinkTargetType, type TestCaseSummary } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { Tip } from "../ui";
import { apiMessage } from "./DataSourceList";

/**
 * 绑定目标选择器（P7-6，计划 11.3）：四类目标四个 tab——接口 / 接口用例 / 流程 /
 * 仓库用例。数据源与 SuiteMemberPicker 同一套（接口用例按接口分组、流程平铺），
 * 仓库用例走 `repoCases` 平表（keyword 搜索 + active 行；removed 行不可选——
 * 绑定 identity 是 key，但选目标从活行里选）。选择即提交（每选一条发一次
 * POST，返回的 link 由父组件就地合入）——不用「勾一批再确定」：绑定是轻动作，
 * 逐条反馈比批量确认更直接（错误也逐条暴露）。
 *
 * 已绑定的目标勾选置灰（同一目标两条绑定没有语义，后端也会 409）。
 *
 * 独立文件（2026-09-08 反馈拆出）：抽屉（SpecCases）与脑图右键（SpecMindMap）
 * 两个入口共用——留在 SpecCases.tsx 里会让 SpecMindMap 反向 import 它，与
 * SpecCases → SpecMindMap 构成循环。
 *
 * 表格布局（同日反馈：长标题把后面一列顶没）：弹窗 640→760；colgroup 定死
 * 三列（名称 47% / 元信息 45% / 动作 8%）+ table-layout:fixed——单元格内容
 * 省略号收缩，**悬停 Tip 吐完整信息**（名称 + method/url / case_key 一串），
 * 截断不吞信息。`truncate` 是行内 span，table-layout:fixed 下要 display:block
 * 才吃得到 overflow（.picker-name 见 design-system.css）。
 */
export function SpecLinkPicker({ projectId, caseId, open, existing, onClose, onLinked }: {
  projectId: string;
  /** 绑定挂靠的文本用例（已存在的用例——绑定需要 id）。 */
  caseId: string;
  open: boolean;
  existing: SpecCaseLink[];
  onClose: () => void;
  onLinked: (link: SpecCaseLink) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SpecLinkTargetType>("case");
  const [keyword, setKeyword] = useState("");
  const debouncedKeyword = useDebounced(keyword);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [endpointTotal, setEndpointTotal] = useState(0);
  const [endpointPage, setEndpointPage] = useState(1);
  const [cases, setCases] = useState<TestCaseSummary[]>([]);
  const [caseTotal, setCaseTotal] = useState(0);
  const [casePage, setCasePage] = useState(1);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [flowPage, setFlowPage] = useState(1);
  const [repoCases, setRepoCases] = useState<RepoTestCase[]>([]);
  const [repoPage, setRepoPage] = useState(1);
  const [repoTotal, setRepoTotal] = useState(0);

  const alreadyLinked = useMemo(() => new Set(existing.map((link) => `${link.targetType}:${link.targetId}`)), [existing]);

  /* 每次打开重置（SuiteMemberPicker 同款）：留着上次的 tab 与关键字会让人以为已经加过了。 */
  useEffect(() => {
    if (!open) return;
    setKeyword("");
    setCasePage(1);
    setFlowPage(1);
    setRepoPage(1);
    setEndpointPage(1);
    setTab("case");
  }, [open]);

  useEffect(() => { setCasePage(1); setRepoPage(1); setFlowPage(1); setEndpointPage(1); }, [debouncedKeyword, tab]);

  /* 四个 tab 各取各的分页读法（页大小 20 与 SuiteMemberPicker 一致）；keyword
     全部走服务端（在已加载页里筛只会让人以为目标不存在）。仓库用例树是
     「接口 → 用例」分页在接口上的形状，这里拍平成行（绑定选择器不需要分组）。 */
  useEffect(() => {
    if (!open || !projectId) return;
    setLoading(true);
    const request = tab === "endpoint"
      ? api.endpointsPaged(projectId, { keyword: debouncedKeyword, page: endpointPage, pageSize: 20 })
        .then((page) => { setEndpoints(page.items); setEndpointTotal(page.total); })
      : tab === "case"
        ? api.projectCases(projectId, { keyword: debouncedKeyword, page: casePage, pageSize: 20 })
          .then((page) => { setCases(page.items); setCaseTotal(page.total); })
        : tab === "flow"
          ? api.flows(projectId, { keyword: debouncedKeyword }).then(setFlows)
          : api.repoCases(projectId, { keyword: debouncedKeyword, page: repoPage, pageSize: 20 })
            .then((page) => { setRepoCases(page.endpoints.flatMap((group) => group.cases)); setRepoTotal(page.total); });
    void request
      .catch(() => message.error(t("specCases.links.pickerLoadFailed")))
      .finally(() => setLoading(false));
  }, [open, projectId, tab, debouncedKeyword, casePage, repoPage, endpointPage, t]);

  async function link(targetType: SpecLinkTargetType, targetId: string) {
    if (busyId) return;
    setBusyId(targetId);
    try {
      const created = await api.createSpecCaseLink(projectId, caseId, { targetType, targetId });
      message.success(t("specCases.links.linked"));
      onLinked(created);
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.links.linkFailed"));
    } finally {
      setBusyId(undefined);
    }
  }

  /**
   * 四个 tab 的公共行渲染：点行即绑定（data-clickable 光标 + 置灰已绑定行）。
   * `tip` 是悬停吐出的**完整**信息（名称 + 元信息一串）——列内省略号收缩，
   * 信息不丢（同日反馈：尽量吐完整信息）。
   */
  function row(targetType: SpecLinkTargetType, id: string, name: string, meta?: ReactNode, tip?: string) {
    const key = `${targetType}:${id}`;
    const disabled = alreadyLinked.has(key);
    const busy = busyId === id;
    const fullText = tip ?? name;
    return <tr key={key} data-clickable={disabled ? undefined : ""} style={disabled ? { opacity: 0.55 } : undefined}
      onClick={() => { if (!disabled && !busy) void link(targetType, id); }}>
      <td className="picker-col-name"><Tip text={fullText}><span className="truncate picker-name">{name}</span></Tip></td>
      <td className="mono muted"><Tip text={fullText}><span className="truncate picker-name">{disabled ? t("specCases.links.pickerAlready") : meta ?? "—"}</span></Tip></td>
      <td className="col-actions">{busy ? <span className="muted">…</span> : !disabled && <Plus size={14} className="muted" />}</td>
    </tr>;
  }

  /* 用例按接口分组（SuiteMemberPicker 同款）。 */
  const grouped = useMemo(() => {
    const groups: { endpointId: string; endpointName: string; items: TestCaseSummary[] }[] = [];
    for (const item of cases) {
      const last = groups[groups.length - 1];
      if (last && last.endpointId === item.endpointId) last.items.push(item);
      else groups.push({ endpointId: item.endpointId, endpointName: item.endpointName, items: [item] });
    }
    return groups;
  }, [cases]);

  const flowPageCount = Math.max(1, Math.ceil(flows.length / 20));
  const currentFlowPage = Math.min(flowPage, flowPageCount);
  const visibleFlows = flows.slice((currentFlowPage - 1) * 20, currentFlowPage * 20);

  return <Modal
    title={t("specCases.links.pickerTitle")}
    open={open}
    width={760}
    onCancel={onClose}
    footer={null}
  >
    <div className="filter-bar">
      <div className="segmented">
        {(["case", "flow", "endpoint", "repo_case"] as const).map((type) => (
          <button key={type} className={`segmented-item${tab === type ? " is-active" : ""}`} onClick={() => setTab(type)}>
            {t(`specCases.links.pickerTab_${type}`)}
          </button>
        ))}
      </div>
      <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)}
        placeholder={t("specCases.links.pickerSearch")} />
    </div>

    {loading && <p className="muted">{t("filter.searching")}</p>}

    <div className="picker-scroll">
      <table className="grid picker-grid">
        <colgroup>
          {/* 三列定宽（名称吃大头）：table-layout:fixed 下首行定列宽，行内容
              省略号收缩不再互相挤占（2026-09-08 反馈：长标题盖掉后面一列）。 */}
          <col style={{ width: "47%" }} />
          <col style={{ width: "45%" }} />
          <col style={{ width: "8%" }} />
        </colgroup>
        <tbody>
          {tab === "endpoint"
            ? endpoints.map((item) => row("endpoint", item.id, item.name, `${item.method} ${item.url}`, `${item.name} — ${item.method} ${item.url}`))
            : tab === "case"
              ? grouped.map((group) => <Fragment key={group.endpointId}>
                <tr className="picker-group"><td colSpan={3}><span className="truncate picker-name">{group.endpointName}</span></td></tr>
                {group.items.map((item) => row("case", item.id, item.name, t("suites.assertionCount", { count: item.assertionCount }), `${item.name} · ${group.endpointName}`))}
              </Fragment>)
              : tab === "flow"
                ? visibleFlows.map((flow) => row("flow", flow.id, flow.name, t("flows.stepCount", { count: flow.nodeCount })))
                : repoCases.map((item) => row("repo_case", item.id, item.name, item.caseKey, `${item.name} · ${item.caseKey}`))}
        </tbody>
      </table>
    </div>

    {tab === "endpoint" && endpointTotal > 20 && <div className="pager"><Pagination current={endpointPage} pageSize={20} total={endpointTotal} showSizeChanger={false} onChange={setEndpointPage} /></div>}
    {tab === "case" && caseTotal > 20 && <div className="pager"><Pagination current={casePage} pageSize={20} total={caseTotal} showSizeChanger={false} onChange={setCasePage} /></div>}
    {tab === "flow" && flows.length > 20 && <div className="pager"><Pagination current={currentFlowPage} pageSize={20} total={flows.length} showSizeChanger={false} onChange={setFlowPage} /></div>}
    {tab === "repo_case" && repoTotal > 20 && <div className="pager"><Pagination current={repoPage} pageSize={20} total={repoTotal} showSizeChanger={false} onChange={setRepoPage} /></div>}
    <p className="form-note">{t("specCases.links.pickerHint")}</p>
  </Modal>;
}
