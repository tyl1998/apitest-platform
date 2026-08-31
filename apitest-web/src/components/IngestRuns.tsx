import { Fragment, useEffect, useState } from "react";
import { Pagination, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, type IngestRun, type IngestRunDetail } from "../api";
import { useProjectStore } from "../stores/projectStore";
import { Empty, Method, Tip } from "../ui";
import { RepoPageHead, RepoTabs } from "./RepoShell";
import { RunStatusTag } from "./RunStatusTag";

/**
 * 上报记录（P4-8，交互 3.11.3）。
 *
 * 每一行要回答的是「这一次上报到底做了什么」，而其中最容易出事的一件是**有没有参与删除
 * 对账**（边界 11）。所以 scope 与 `reconciled` 是这张表的主角，不是附注：
 *
 * - 非全量行显式标「不参与删除对账」——它是安全的那一边，但不写明会让人以为「我跑了
 *   全量却没删」；
 * - 全量行显示对账范围是哪一片——`pytest tests/order/` 删的只有 `tests/order/` 下的
 *   用例，`tests/user/` 一个都不动；
 * - 全量但 `reconciled=false` 是第三种情况（不在跟踪分支上），必须与前两者区分开，否则
 *   「为什么这次没删」查不出来。
 */

const PAGE_SIZES = [20, 50, 100];

/** 对账状态：三种情形各有各自的处置，合成两种就会丢掉「分支不对」这一类。 */
function reconcileState(run: IngestRun): "reconciled" | "notFull" | "branchBlocked" {
  if (run.reconciled) return "reconciled";
  return run.isFullInventory ? "branchBlocked" : "notFull";
}

export function IngestRuns() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();

  const [runs, setRuns] = useState<IngestRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  /* 降噪过滤（2026-08-30）：大多数 run 是逐字相同的全量快照，diff 全 0；勾上后只看
     「用例有变动」或「有未匹配」的 run。两个都勾是**或**——要的是需要关注的都给我。 */
  const [changedOnly, setChangedOnly] = useState(false);
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const [detail, setDetail] = useState<IngestRunDetail>();
  const [detailTotal, setDetailTotal] = useState(0);
  /* run 明细的降噪开关（2026-08-30 用户确认的语义）：只看未匹配 + 本轮新增的覆盖。
     绝大多数记录都是既有关系的重复，扫明细时只值得看变动的。 */
  const [changesOnly, setChangesOnly] = useState(false);

  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    let alive = true;
    setLoading(true);
    void api.ingestRuns(projectId, page, pageSize, { changed: changedOnly, unmatched: unmatchedOnly })
      .then((result) => { if (alive) { setRuns(result.items); setTotal(result.total); } })
      .catch(() => { if (alive) message.error(t("repoCases.runsLoadFailed")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, loadedProjectId, projectLoading, page, pageSize, changedOnly, unmatchedOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 明细按需取：一次上报可能有上千条请求记录，列表页不该顺手把它们全拉回来。 */
  useEffect(() => {
    if (!projectId || !expanded) { setDetail(undefined); setDetailTotal(0); return; }
    let alive = true;
    void api.ingestRun(projectId, expanded, 1, 50, { changes: changesOnly })
      .then((result) => { if (alive) { setDetail(result.detail); setDetailTotal(result.recordsTotal); } })
      .catch(() => { if (alive) message.error(t("repoCases.runsLoadFailed")); });
    return () => { alive = false; };
  }, [projectId, expanded, changesOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  return <main className="content">
    <RepoPageHead title={t("repoCases.runsTitle")} hint={t("repoCases.runsHint")} />
    <RepoTabs active="runs" />

    <div className="filter-bar">
      <label className="check-field">
        <input type="checkbox" checked={changedOnly} onChange={(event) => { setChangedOnly(event.target.checked); setPage(1); }} />
        {t("repoCases.filterChanged")}
      </label>
      <label className="check-field">
        <input type="checkbox" checked={unmatchedOnly} onChange={(event) => { setUnmatchedOnly(event.target.checked); setPage(1); }} />
        {t("repoCases.filterUnmatched")}
      </label>
      <span className="filter-spacer" />
      <span className="muted mono">{t("repoCases.runsTotal", { count: total })}</span>
    </div>

    {loading && <p className="muted">{t("common.loading")}</p>}

    {runs.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("repoCases.commit")}</th>
        <th>{t("repoCases.scope")}</th>
        <th>{t("repoCases.reconcileState")}</th>
        <th className="col-num">{t("repoCases.caseTotal")}</th>
        <th className="col-num">{t("repoCases.diff")}</th>
        <th className="col-num">{t("repoCases.unmatchedCount")}</th>
        <th>{t("status.time")}</th>
      </tr></thead>
      <tbody>
        {runs.map((run) => {
          const open = expanded === run.id;
          const state = reconcileState(run);
          return <Fragment key={run.id}>
            <tr data-clickable onClick={() => setExpanded(open ? undefined : run.id)}>
              <td>
                <span className="cell-name">
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className="mono truncate">{run.commitSha.slice(0, 10)}</span>
                  <span className="chip">{run.branch || t("repoCases.noBranch")}</span>
                </span>
                <span className="resource-type mono truncate">
                  {run.sdkName ? `${run.sdkName} ${run.sdkVersion}` : t("repoCases.unknownSdk")}
                  {run.ciRunId ? ` · ${run.ciRunId}` : ""}
                </span>
              </td>
              {/* 空 scope = 全仓。显示成「整个仓库」而不是空白：空白读不出是「全仓」
                  还是「SDK 没报」。 */}
              <td className="mono muted truncate" title={run.scope.join(" ")}>
                {run.scope.length ? run.scope.join(" ") : t("repoCases.wholeRepo")}
              </td>
              <td>
                {state === "reconciled"
                  ? <span className="chip">{t("repoCases.reconciled")}</span>
                  : <span className="chip chip-warn">{state === "notFull" ? t("repoCases.notFullInventory") : t("repoCases.branchBlocked")}</span>}
              </td>
              <td className="col-num mono">{run.caseTotal}</td>
              {/* 三个数字挤在一格里是刻意的：diff 只有并排看才有意义（+3 −1 ~28）。 */}
              <td className="col-num mono">+{run.addedCount} −{run.removedCount} ~{run.updatedCount}</td>
              <td className="col-num mono">{run.unmatchedCount || "—"}</td>
              <td className="mono muted">{new Date(run.createdAt).toLocaleString()}</td>
            </tr>
            {open && <tr><td colSpan={8} style={{ padding: 0 }}>
              <div className="panel-body">
                <p className="form-note">
                  {state === "reconciled"
                    ? t("repoCases.reconcileNote", { scope: run.scope.length ? run.scope.join(" ") : t("repoCases.wholeRepo") })
                    : state === "notFull" ? t("repoCases.notFullNote") : t("repoCases.branchBlockedNote")}
                </p>
                {run.warnings.map((warning, index) => <p key={index} className="form-note mono">{warning}</p>)}
                {/* 只看有变动：勾住时明细只剩未匹配 + 本轮新增覆盖的记录（「消失」没有
                    记录行——那些请求没发生，由 diff 列的 −N 汇总）。 */}
                <label className="check-field">
                  <input type="checkbox" checked={changesOnly} onChange={(event) => setChangesOnly(event.target.checked)} />
                  {t("repoCases.filterRunChanges")}
                </label>
                {!detail ? <p className="muted">{t("common.loading")}</p> : detail.records.length ? <table className="grid">
                  <thead><tr>
                    <th className="col-num">#</th>
                    <th>{t("repoCases.request")}</th>
                    <th>{t("repoCases.phase")}</th>
                    <th>{t("repoCases.caseName")}</th>
                    <th>{t("repoCases.param")}</th>
                    <th className="col-num">{t("status.code")}</th>
                    <th className="col-num">{t("status.duration")}</th>
                    <th className="col-status">{t("endpoints.status")}</th>
                  </tr></thead>
                  <tbody>
                    {detail.records.map((record) => <tr key={record.id}>
                      <Tip text={new Date(record.createdAt).toLocaleString()}><td className="col-num mono muted">{record.seq}</td></Tip>
                      <td>
                        <span className="cell-name">
                          <Method method={record.method} />
                          <Tip text={record.pathRaw}><span className="mono truncate">{record.pathNormalized ?? record.pathRaw}</span></Tip>
                          {/* 未匹配用 chip 标出来，不用红：它不是一次失败，是「这条路径
                              在本项目没有登记的接口」。 */}
                          {!record.endpointName && <span className="chip chip-warn">{t("repoCases.unmatched")}</span>}
                        </span>
                      </td>
                      <td className="mono muted">{record.phase}</td>
                      <Tip text={record.caseKey}><td className="truncate">{record.caseName ?? "—"}</td></Tip>
                      {/* 参数化的场景维度（2026-08-30 补）：树上的用例名是函数级的，[vip] 这一层
                          只存在于记录里——不展示的话「哪个场景发的请求/挂了」就查不出来。
                          用 pytest 的括号写法，看到 [vip] 就知道它是 param id；非参数化用例
                          与 fixture 阶段的记录显示 —。 */}
                      <Tip text={record.paramId ?? undefined}><td className="mono muted truncate">{record.paramId ? `[${record.paramId}]` : "—"}</td></Tip>
                      <td className="col-num mono">{record.statusCode ?? "—"}</td>
                      <td className="col-num mono">{record.latencyMs ?? "—"}</td>
                      <td className="col-status">
                        {record.passed === undefined ? <span className="muted">—</span> : <RunStatusTag status={record.passed ? "pass" : "fail"} />}
                      </td>
                    </tr>)}
                  </tbody>
                </table> : <p className="form-note">{changesOnly ? t("repoCases.noChangedRecords") : t("repoCases.noRecords")}</p>}
                {detail && detail.records.length < detailTotal && <p className="form-note">
                  {t("repoCases.recordsTruncated", { shown: detail.records.length, total: detailTotal })}
                </p>}
              </div>
            </td></tr>}
          </Fragment>;
        })}
      </tbody>
    </table></div> : !loading && (changedOnly || unmatchedOnly
      ? <Empty title={t("repoCases.runsFilteredEmpty")} hint={t("repoCases.runsFilteredEmptyHint")} />
      : <Empty title={t("repoCases.runsEmpty")} hint={t("repoCases.runsEmptyHint")} />)}

    {total > pageSize && <div className="pager">
      <Pagination
        current={page}
        pageSize={pageSize}
        total={total}
        pageSizeOptions={PAGE_SIZES}
        showSizeChanger
        onChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
      />
    </div>}
  </main>;
}
