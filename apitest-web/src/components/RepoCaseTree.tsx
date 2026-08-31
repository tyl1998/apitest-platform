import { Fragment, useEffect, useState } from "react";
import { Drawer, Pagination, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, type RepoCaseTree, type RepoTestCase } from "../api";
import { useProjectStore } from "../stores/projectStore";
import { Empty, Method, Readout, Tip, toRunStatus } from "../ui";
import { RepoPageHead, RepoTabs } from "./RepoShell";
import { RunStatusTag } from "./RunStatusTag";

/**
 * 仓库用例树（P4-8，交互 3.11.1）。
 *
 * 树是「系统 → 接口 → 用例」：**接口下有用例 = 已覆盖**。分页分在接口上（服务端同款），
 * 因为一个接口下的用例要一起显示才有意义——切页会让「这个接口有几条用例」随页码变。
 *
 * 树底部两个并列分组（边界 21）：**未归位用例**（有用例、一个接口都没打到）与进入未匹配
 * 诊断的入口。两者是同一件事的两端：一个是「有用例找不到接口」，一个是「有记录找不到
 * 接口」。未归位**不能藏掉**——藏了之后「上报了 36 条用例，树上只数出 31 条」会被当成
 * bug 报上来。
 */

const PAGE_SIZES = [20, 50, 100];

/** 用例的最近结果 → 设计系统的状态词。`not_run` 是 P4.5 勾选执行才会出现的第四态。 */
function caseStatus(result: RepoTestCase["lastResult"]) {
  if (result === "passed") return "pass" as const;
  if (result === "failed") return "fail" as const;
  return toRunStatus("skip");
}

/** 点用例行打开详情抽屉。`stopPropagation` 是必须的：行嵌在可折叠的接口行里，
    不拦的话点一下会同时把整组收起来。 */
function CaseRow({ item, showEndpointCount, onOpen }: { item: RepoTestCase; showEndpointCount?: boolean; onOpen?: (item: RepoTestCase) => void }) {
  const { t } = useTranslation();
  return <tr
    data-removed={item.status === "removed" ? "" : undefined}
    data-clickable={onOpen ? "" : undefined}
    onClick={onOpen ? (event) => { event.stopPropagation(); onOpen(item); } : undefined}
  >
    <td>
      <span className="cell-name">
        <Tip text={item.name}><span className="truncate">{item.name}</span></Tip>
        {/* 软删的用例默认置灰保留（交互 3.11.1）：它的历史与最后结果仍然读得通，
            下次再出现会自动回 active。 */}
        {item.status === "removed" && <span className="chip chip-warn">{t("repoCases.removed")}</span>}
      </span>
      <Tip text={item.caseKey}><span className="resource-type mono truncate">{item.caseKey}</span></Tip>
    </td>
    <Tip text={item.filePath}><td className="mono muted truncate">{item.filePath || "—"}</td></Tip>
    <Tip text={item.tags.join(" ")}><td className="mono muted truncate">{item.tags.length ? item.tags.join(" ") : "—"}</td></Tip>
    {showEndpointCount && <td className="col-num mono">{item.endpoints?.length ?? 0}</td>}
    <td className="col-num mono">{item.requestCount ?? "—"}</td>
    <td className="mono muted">{item.lastRunAt ? new Date(item.lastRunAt).toLocaleString() : "—"}</td>
    <td className="col-status"><RunStatusTag status={caseStatus(item.lastResult)} /></td>
  </tr>;
}

/**
 * 用例详情抽屉（2026-08-30 第二轮改版，用户确认的取舍）。
 *
 * **不展示请求步骤**：用户要的「步骤」是 allure 式的用例内步骤描述，而桩挂在传输层、
 * 看不见 `allure.step`，现在能拿到的只有请求记录——那已经在 run 明细页有了，抽屉里
 * 重复一遍价值不大（用户原话：不好拿就算了）。**不展示涉及的接口**：树本身已经是
 * 「接口 → 用例」，点开哪条用例、它在哪个接口下是已知的。
 *
 * 留下的是身份事实（路径/文件/标签/最近执行）+ **参数化场景**（records 里 distinct
 * param_id，后端聚合）：这是树上看不到、且「这条用例跑了哪几个场景」的真实信息。
 */
function CaseDetailDrawer({ caseId, onClose }: { caseId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.repoCase>>>();

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    setDetail(undefined);
    void api.repoCase(projectId, caseId)
      .then((result) => { if (alive) setDetail(result); })
      .catch(() => { if (alive) message.error(t("repoCases.loadFailed")); });
    return () => { alive = false; };
  }, [projectId, caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  return <Drawer title={t("repoCases.caseDetail")} open onClose={onClose} width={560} destroyOnClose>
    {!detail ? <p className="muted">{t("common.loading")}</p> : <>
      <div className="cell-name">
        <strong className="truncate" title={detail.name}>{detail.name}</strong>
        <RunStatusTag status={caseStatus(detail.lastResult)} />
        {detail.status === "removed" && <span className="chip chip-warn">{t("repoCases.removed")}</span>}
      </div>
      {detail.description && <p className="form-note">{detail.description}</p>}
      {/* 一块事实清单（.detail-facts：标签列固定、值列截断配悬停），替代上一版散落的
          三四行 <p>——那版每行样式不一、对不齐，是「太丑」的根源。 */}
      <dl className="detail-facts">
        <div>
          <dt>{t("repoCases.caseKeyLabel")}</dt>
          <dd><Tip text={detail.caseKey}><span className="mono truncate">{detail.caseKey}</span></Tip></dd>
        </div>
        <div>
          <dt>{t("repoCases.filePath")}</dt>
          <dd><Tip text={detail.filePath}><span className="mono truncate">{detail.filePath || "—"}</span></Tip></dd>
        </div>
        <div>
          <dt>{t("repoCases.tags")}</dt>
          <dd>{detail.tags.length ? detail.tags.map((tag) => <span key={tag} className="chip">{tag}</span>) : <span className="muted">—</span>}</dd>
        </div>
        <div>
          <dt>{t("repoCases.lastRunAt")}</dt>
          <dd className="mono muted">{detail.lastRunAt ? new Date(detail.lastRunAt).toLocaleString() : "—"}</dd>
        </div>
        {detail.params.length > 0 && <div>
          <dt>{t("repoCases.params")}</dt>
          <dd>{detail.params.map((param) => <span key={param} className="chip mono">{param}</span>)}</dd>
        </div>}
      </dl>
    </>}
  </Drawer>;
}

export function RepoCaseTreePage() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();
  const [searchParams, setSearchParams] = useSearchParams();

  /* 筛选走地址栏（与接口列表同款约定）：一份筛好的树要能被贴给别人。 */
  const keyword = searchParams.get("keyword") ?? "";
  const status = searchParams.get("status") ?? "active";
  const page = Number(searchParams.get("page") ?? 1);
  const pageSize = Number(searchParams.get("pageSize") ?? 20);

  const [tree, setTree] = useState<RepoCaseTree & { total: number }>();
  const [unplaced, setUnplaced] = useState<RepoTestCase[]>([]);
  const [unplacedTotal, setUnplacedTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [unplacedOpen, setUnplacedOpen] = useState(false);
  const [detailCaseId, setDetailCaseId] = useState<string>();

  function patchParams(next: Record<string, string | undefined>) {
    setSearchParams((current) => {
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined || value === "") current.delete(key);
        else current.set(key, value);
      }
      return current;
    }, { replace: true });
  }

  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    let alive = true;
    setLoading(true);
    void api.repoCases(projectId, { keyword, status, page, pageSize })
      .then((result) => { if (alive) setTree(result); })
      .catch(() => { if (alive) message.error(t("repoCases.loadFailed")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, loadedProjectId, projectLoading, keyword, status, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 未归位用例单独取：它不在任何接口下，与树的分页无关。展开时才拉明细，但计数一直
     显示——「有几条挂不上」是这一页必须先说清的事实。 */
  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId || !unplacedOpen) return;
    let alive = true;
    void api.unplacedRepoCases(projectId, 1, 100)
      .then((result) => { if (alive) { setUnplaced(result.items); setUnplacedTotal(result.total); } })
      .catch(() => { if (alive) message.error(t("repoCases.loadFailed")); });
    return () => { alive = false; };
  }, [projectId, loadedProjectId, unplacedOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const coverage = tree?.coverage;
  const coverageRate = coverage && coverage.endpointTotal > 0
    ? Math.round((coverage.coveredEndpointTotal / coverage.endpointTotal) * 1000) / 10
    : null;

  return <main className="content">
    <RepoPageHead title={t("repoCases.title")} hint={t("repoCases.hint")} />
    <RepoTabs active="tree" />

    {coverage && <div className="readouts">
      {/* 这份覆盖只在本页算、本页显示（边界 2）：看板的覆盖率口径本阶段一个字都不改。 */}
      <Readout label={t("repoCases.coveredEndpoints")} value={`${coverage.coveredEndpointTotal}/${coverage.endpointTotal}`} />
      <Readout label={t("repoCases.coverageRate")} value={coverageRate === null ? "—" : coverageRate.toFixed(1)} unit="%" />
      <Readout label={t("repoCases.distinctCases")} value={coverage.distinctCaseTotal} />
      <Readout label={t("repoCases.unplacedCases")} value={coverage.unplacedCaseTotal} />
    </div>}
    {/* 两个计数口径不同，必须写明（边界 9）：接口上的「用例数」是关系数，项目级是
        distinct case_key，相加不相等。 */}
    <p className="form-note">{t("repoCases.countingNote")}</p>

    <div className="filter-bar">
      <input
        className="input mono"
        value={keyword}
        onChange={(event) => patchParams({ keyword: event.target.value, page: undefined })}
        placeholder={t("repoCases.searchPlaceholder")}
        style={{ width: 260 }}
      />
      <label className="check-field">
        <input
          type="checkbox"
          checked={status === "all"}
          onChange={(event) => patchParams({ status: event.target.checked ? "all" : undefined, page: undefined })}
        />
        {t("repoCases.showRemoved")}
      </label>
      <span className="filter-spacer" />
      {coverage && <span className="muted mono">{t("repoCases.removedTotal", { count: coverage.removedCaseTotal })}</span>}
    </div>

    {loading && <p className="muted">{t("common.loading")}</p>}

    {tree && tree.endpoints.length > 0 && <div className="table-scroll"><table className="grid grid-fixed">
      {/* 列宽固定（grid-fixed）：auto 布局下展开一组用例行会让列宽随全部行内容重新
          分配、整表跳一次；fixed + 显式宽度让列宽与展开状态无关。 */}
      <colgroup>
        <col />
        <col style={{ width: 200 }} />
        <col style={{ width: 120 }} />
        <col style={{ width: 70 }} />
        <col style={{ width: 150 }} />
        <col style={{ width: 90 }} />
      </colgroup>
      <thead><tr>
        <th>{t("repoCases.caseName")}</th>
        <th>{t("repoCases.filePath")}</th>
        <th>{t("repoCases.tags")}</th>
        <th className="col-num">{t("repoCases.requestCount")}</th>
        <th>{t("repoCases.lastRunAt")}</th>
        <th className="col-status">{t("repoCases.lastResult")}</th>
      </tr></thead>
      <tbody>
        {tree.endpoints.map((endpoint) => {
          const open = !collapsed.has(endpoint.endpointId);
          return <Fragment key={endpoint.endpointId}>
            {/* 接口是树的中间层，它自己不是一次执行，所以这一行只有身份与计数。 */}
            <tr data-clickable onClick={() => setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(endpoint.endpointId)) next.delete(endpoint.endpointId); else next.add(endpoint.endpointId);
              return next;
            })}>
              <td colSpan={5}>
                <span className="cell-name">
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <Method method={endpoint.method} />
                  <Tip text={endpoint.name}><strong className="truncate">{endpoint.name}</strong></Tip>
                  <Tip text={endpoint.url}><span className="mono muted truncate">{endpoint.url}</span></Tip>
                </span>
              </td>
              <td className="col-status mono">{t("repoCases.caseCount", { count: endpoint.caseCount })}</td>
            </tr>
            {open && endpoint.cases.map((item) => <CaseRow key={`${endpoint.endpointId}:${item.id}`} item={item} onOpen={(clicked) => setDetailCaseId(clicked.id)} />)}
          </Fragment>;
        })}
      </tbody>
    </table></div>}

    {tree && !tree.endpoints.length && !loading && <Empty
      title={keyword ? t("repoCases.emptyFilterTitle") : t("repoCases.emptyTitle")}
      hint={keyword ? t("repoCases.emptyFilterHint") : t("repoCases.emptyHint")}
    />}

    {tree && tree.total > pageSize && <div className="pager">
      <Pagination
        current={page}
        pageSize={pageSize}
        total={tree.total}
        pageSizeOptions={PAGE_SIZES}
        showSizeChanger
        onChange={(nextPage, nextSize) => patchParams({ page: String(nextPage), pageSize: nextSize === 20 ? undefined : String(nextSize) })}
      />
    </div>}

    {/* ── 未归位用例（边界 21）：与未匹配诊断并列的第二个分组 ─────────────── */}
    {coverage && coverage.unplacedCaseTotal > 0 && <section className="panel">
      <div className="panel-head">
        <strong>{t("repoCases.unplacedGroup", { count: coverage.unplacedCaseTotal })}</strong>
        <button className="btn" onClick={() => setUnplacedOpen((current) => !current)}>
          {unplacedOpen ? t("action.close") : t("repoCases.expand")}
        </button>
      </div>
      <div className="panel-body">
        <p className="form-note">{t("repoCases.unplacedHint")}</p>
        {unplacedOpen && (unplaced.length ? <div className="table-scroll"><table className="grid grid-fixed">
          {/* 与主树同款固定列宽：展开/收起面板时列宽不跳。 */}
          <colgroup>
            <col />
            <col style={{ width: 200 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 70 }} />
            <col style={{ width: 70 }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 90 }} />
          </colgroup>
          <thead><tr>
            <th>{t("repoCases.caseName")}</th>
            <th>{t("repoCases.filePath")}</th>
            <th>{t("repoCases.tags")}</th>
            <th className="col-num">{t("repoCases.endpointCount")}</th>
            <th className="col-num">{t("repoCases.requestCount")}</th>
            <th>{t("repoCases.lastRunAt")}</th>
            <th className="col-status">{t("repoCases.lastResult")}</th>
          </tr></thead>
          <tbody>{unplaced.map((item) => <CaseRow key={item.id} item={item} showEndpointCount onOpen={(clicked) => setDetailCaseId(clicked.id)} />)}</tbody>
        </table></div> : <p className="muted">{t("common.loading")}</p>)}
        {unplacedOpen && unplacedTotal > unplaced.length && <p className="form-note">{t("repoCases.unplacedTruncated", { shown: unplaced.length, total: unplacedTotal })}</p>}
      </div>
    </section>}

    {detailCaseId && <CaseDetailDrawer caseId={detailCaseId} onClose={() => setDetailCaseId(undefined)} />}
  </main>;
}
