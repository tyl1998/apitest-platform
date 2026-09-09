import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { Archive, CalendarClock, ChevronDown, ChevronRight, FileDown, Folder, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, type TestPlan, type TestPlanDetail, type TestPlanItem, type TestPlanItemResult } from "../api";
import { useCanWrite } from "../hooks/useMyRole";
import { useDebounced } from "../hooks/useDebounced";
import { saveBlob } from "../lib/download";
import { Empty, Readout, Status, Tip, type RunStatus } from "../ui";
import { IconButton } from "./IconButton";
import { apiMessage } from "./DataSourceList";
import { SpecCaseDrawer } from "./SpecCases";
import { type DetailCrumbContext } from "./ProjectShell";

/**
 * 测试计划（P7-7，计划 11.3）：列表页（名称 / 状态 / 进度 / 负责人 / 截止）。
 * 进度条是手写 runstrip 同族的原语（design-system：.plan-track / .plan-fill，
 * accent 只标「进度」，语义色留给结果列——Quiet Console 的语义色纪律）。
 * 通过率 = passed/total（2026-09-09 第三轮反馈改口径——分母是全部计划项，
 * 「没标完就是没通过完」，与平台执行类 passRate 的「终态分母」不是一个语义）；
 * total 0 显示「—」（「还没有用例」与「0% 通过」是两个事实）。
 */

const PAGE_SIZES = [20, 50, 100];
const ITEM_RESULTS: (TestPlanItemResult | "unmarked")[] = ["unmarked", "passed", "failed", "blocked", "skipped"];

/** 进度（已标记/total）→ 0~1；total 0 = 空计划，进度条不渲染（无意义）。 */
function progressOf(plan: TestPlan): number | null {
  const { total, passed, failed, blocked, skipped } = plan.summary;
  if (!total) return null;
  return Math.min(1, (passed + failed + blocked + skipped) / total);
}

/** 通过率 = passed/total → 0~100 保留一位小数；total 0 → null（页面显示「—」）。 */
function passRateOf(plan: { summary: TestPlan["summary"] }): number | null {
  const { passed, total } = plan.summary;
  if (!total) return null;
  return Math.round((passed / total) * 1000) / 10;
}

/** 结果四值 → Status 色词（未执行是缺席态，走 not_run 的中性色）。 */
function resultView(result: TestPlanItemResult | undefined): RunStatus {
  if (result === "passed") return "pass";
  if (result === "failed") return "fail";
  if (result === "blocked") return "queued";
  if (result === "skipped") return "skip";
  return "not_run";
}

/** 结果五选值（含「未执行」占位）→ Status 色词：下拉选项与已选态共用（着色
 *  与行内只读态同一张表——一个结果在哪读都是同一个颜色）。 */
function resultOptionView(value: TestPlanItemResult | "unmarked"): RunStatus {
  return value === "unmarked" ? "not_run" : resultView(value);
}

/** '/模块A/子模块/' → '模块A/子模块'（去首尾分隔符，窄列少占一档）。 */
function formatPath(path: string | undefined): string {
  if (!path) return "—";
  return path.replace(/^\//, "").replace(/\/$/, "");
}

export function TestPlans() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const canWrite = useCanWrite();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [keyword, setKeyword] = useState(searchParams.get("keyword") ?? "");
  const debouncedKeyword = useDebounced(keyword);
  const [status, setStatus] = useState(searchParams.get("status") ?? "all");
  const [page, setPage] = useState(Number(searchParams.get("page") ?? 1));
  const [pageSize, setPageSize] = useState(Number(searchParams.get("pageSize") ?? 20));
  const [plans, setPlans] = useState<TestPlan[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const result = await api.testPlansPaged(projectId, {
        keyword: debouncedKeyword,
        status: status === "all" ? undefined : status,
        page, pageSize,
      });
      setPlans(result.items);
      setTotal(result.total);
    } catch {
      message.error(t("testPlans.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId, debouncedKeyword, status, page, pageSize, t]);

  useEffect(() => { void load(); }, [load]);

  /* 筛选进地址栏（用例库同款）：刷新与转发后结果一致。 */
  useEffect(() => {
    setSearchParams({
      ...(debouncedKeyword ? { keyword: debouncedKeyword } : {}),
      ...(status !== "all" ? { status } : {}),
      ...(page > 1 ? { page: String(page) } : {}),
      ...(pageSize !== 20 ? { pageSize: String(pageSize) } : {}),
    }, { replace: true });
  }, [debouncedKeyword, status, page, pageSize, setSearchParams]);

  const filtered = Boolean(debouncedKeyword || status !== "all");

  return <main className="content">
    <div className="page-head">
      <div><h1>{t("testPlans.title")}</h1><p>{t("testPlans.hint")}</p></div>
      <div className="topbar-actions">
        {canWrite && <button className="btn btn-primary btn-with-icon" onClick={() => setCreateOpen(true)}><Plus size={14} />{t("testPlans.create")}</button>}
      </div>
    </div>

    <div className="filter-bar">
      <input className="input" placeholder={t("testPlans.searchPlaceholder")} value={keyword} onChange={(event) => { setKeyword(event.target.value); setPage(1); }} />
      <Select
        value={status}
        onChange={(value) => { setStatus(value); setPage(1); }}
        style={{ width: 148 }}
        options={[
          { value: "all", label: t("testPlans.allStatuses") },
          { value: "open", label: t("testPlans.status_open") },
          { value: "closed", label: t("testPlans.status_closed") },
        ]}
      />
    </div>

    {loading ? <p className="muted">{t("common.loading")}…</p> : plans.length ? <div className="table-scroll"><table className="grid plan-grid">
      <thead><tr>
        <th>{t("testPlans.title")}</th>
        <th className="col-status">{t("endpoints.status")}</th>
        <th>{t("testPlans.progress")}</th>
        <th className="col-num">{t("testPlans.passRate")}</th>
        <th>{t("testPlans.owner")}</th>
        <th className="mono">{t("testPlans.dueOn")}</th>
        {canWrite && <th className="col-actions" />}
      </tr></thead>
      <tbody>
        {plans.map((plan) => <tr key={plan.id} data-clickable onClick={() => navigate(`/projects/${projectId}/test-plans/${plan.id}`)}>
          <td>
            <strong className="truncate">{plan.name}</strong>
            {plan.description && <div className="muted truncate">{plan.description}</div>}
          </td>
          <td className="col-status">
            <Status status={plan.status === "open" ? "running" : "canceled"} label={t(`testPlans.status_${plan.status}`)} />
          </td>
          <td>
            {/* 进度条 + 分子分母：图形给扫视、数字给核对（Quiet Console：accent 标
                进度，语义色不进这一格）。空计划（total 0）只显示「还没有用例」。 */}
            <div className="plan-progress">
              {progressOf(plan) !== null
                ? <>
                  <span className="plan-track"><span className="plan-fill" style={{ width: `${Math.round(progressOf(plan)! * 100)}%` }} /></span>
                  <span className="mono muted plan-progress-num">{plan.summary.passed + plan.summary.failed + plan.summary.blocked + plan.summary.skipped}/{plan.summary.total}</span>
                </>
                : <span className="muted">{t("testPlans.noItems")}</span>}
            </div>
          </td>
          <td className="col-num mono">{passRateOf(plan) === null ? "—" : `${passRateOf(plan)}%`}</td>
          <td className="truncate">{plan.ownerName ?? "—"}</td>
          <td className="mono muted">{plan.dueOn ?? "—"}</td>
          {canWrite && <td className="col-actions"><div className="row-actions" onClick={(event) => event.stopPropagation()}>
            <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => confirmDelete(plan, t, projectId, () => void load(), navigate)} />
          </div></td>}
        </tr>)}
      </tbody>
    </table></div> : !loading && <Empty
      title={filtered ? t("testPlans.emptySearchTitle") : t("testPlans.emptyTitle")}
      hint={filtered ? t("testPlans.emptySearchHint") : t("testPlans.emptyHint")}
      action={canWrite && !filtered ? <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>{t("testPlans.create")}</button> : undefined}
    />}

    {plans.length > 0 && <div className="pager"><Pagination current={page} pageSize={pageSize} total={total} pageSizeOptions={PAGE_SIZES} showSizeChanger showQuickJumper={total > pageSize * 5} onChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }} /></div>}

    {projectId && <PlanCreateModal
      projectId={projectId}
      open={createOpen}
      onClose={() => setCreateOpen(false)}
      onCreated={(plan) => {
        setCreateOpen(false);
        /* 建完直接进详情：建计划的下一步就是往里标结果。 */
        navigate(`/projects/${projectId}/test-plans/${plan.id}`);
      }}
    />}
  </main>;
}

/** 删除确认（列表行与详情页共用一个函数：文案含「已标记的结果一并删除」。 */
function confirmDelete(plan: TestPlan, t: (key: string, vars?: Record<string, unknown>) => string, projectId?: string, onDone?: () => void, navigate?: ReturnType<typeof useNavigate>) {
  Modal.confirm({
    title: t("testPlans.deleteTitle", { name: plan.name }),
    content: t("testPlans.deleteHint"),
    okText: t("action.delete"),
    okButtonProps: { danger: true },
    cancelText: t("action.cancel"),
    onOk: async () => {
      if (!projectId) return;
      try {
        await api.deleteTestPlan(projectId, plan.id);
        message.success(t("testPlans.deleted"));
        if (navigate && !onDone) navigate(`/projects/${projectId}/test-plans`);
        onDone?.();
      } catch (error) {
        message.error(apiMessage(error) ?? t("testPlans.deleteFailed"));
      }
    },
  });
}

/* ── 新建 / 编辑计划弹窗（列表与详情共用）────────────────────────────────── */

export function PlanCreateModal({ projectId, open, plan, onClose, onCreated }: {
  projectId: string;
  open: boolean;
  /** 传入 = 编辑既有计划；不传 = 新建。 */
  plan?: TestPlan;
  onClose: () => void;
  onCreated: (plan: TestPlan) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [dueOn, setDueOn] = useState<string>("");
  const [saving, setSaving] = useState(false);

  /* 每次打开重置（编辑态回填当前值）：上次没提交就关掉的内容不留给下一次。 */
  useEffect(() => {
    if (!open) return;
    setName(plan?.name ?? "");
    setDescription(plan?.description ?? "");
    setDueOn(plan?.dueOn ?? "");
  }, [open, plan]);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) { message.error(t("testPlans.nameRequired")); return; }
    setSaving(true);
    try {
      const input = { name: trimmed, description: description.trim(), dueOn: dueOn || null };
      const saved = plan
        ? await api.updateTestPlan(projectId, plan.id, input)
        : await api.createTestPlan(projectId, input);
      message.success(plan ? t("testPlans.planSaved") : t("testPlans.planCreated"));
      onCreated(saved);
    } catch (error) {
      message.error(apiMessage(error) ?? t("testPlans.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return <Modal
    title={plan ? t("testPlans.editTitle") : t("testPlans.createTitle")}
    open={open}
    okText={t("action.save")}
    cancelText={t("action.cancel")}
    okButtonProps={{ disabled: !name.trim() || saving }}
    confirmLoading={saving}
    onOk={() => void save()}
    onCancel={onClose}
  >
    <label className="field"><span>{t("testPlans.name")}</span><input autoFocus className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="field"><span>{t("testPlans.description")}</span><input className="input" placeholder={t("testPlans.descriptionPlaceholder")} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    {/* 原生 date input（自定义 .input 皮肤）：计划周期只有一天粒度，DatePicker 的
        面板与国际化是多余的新增面（antd 组件里挑用的既定纪律）。 */}
    <label className="field"><span>{t("testPlans.dueOn")}</span><input type="date" className="input" value={dueOn} onChange={(event) => setDueOn(event.target.value)} /></label>
  </Modal>;
}

/* ── 详情页：Readout + 按模块分组的项表 ──────────────────────────────────── */

/** 独立路由挂载（`/test-plans/:planId`，照 SuiteReportPage 先例）：可收藏、可转发。 */
export function TestPlanPage() {
  const { t } = useTranslation();
  const { projectId, planId } = useParams();
  const { setDetailTitle } = useOutletContext<DetailCrumbContext>();
  const [plan, setPlan] = useState<TestPlanDetail>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!projectId || !planId) return;
    let alive = true;
    setPlan(undefined); setFailed(false);
    void api.testPlan(projectId, planId)
      .then((result) => { if (alive) setPlan(result); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [projectId, planId]);

  /* 计划名推给外壳面包屑：{项目}/测试计划/{计划名}。 */
  useEffect(() => {
    setDetailTitle(plan?.name);
    return () => setDetailTitle(undefined);
  }, [plan, setDetailTitle]);

  if (failed) return <main className="content"><Empty title={t("testPlans.loadFailed")} hint={t("testPlans.emptyHint")} /></main>;
  if (!plan) return <main className="content"><p className="muted">{t("common.loading")}</p></main>;

  return <TestPlanDetailBody projectId={projectId!} plan={plan} t={t} onPlanChanged={setPlan} />;
}

function TestPlanDetailBody({ projectId, plan, t, onPlanChanged }: {
  projectId: string;
  plan: TestPlanDetail;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onPlanChanged: (plan: TestPlanDetail) => void;
}) {
  const canWrite = useCanWrite();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busyItem, setBusyItem] = useState<string>();
  /* 目录分组收缩集（2026-09-09 反馈：按导入目录折叠，与用例库树同一交互——
     存「已收起」而不是「已展开」：默认全开，通读「哪些没跑」是详情页的主任务；
     收起是临时收纳，不进 URL、不持久化（用例库左树同款，会话内状态）。 */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  /* 点开用例只读（用例行标识格点击）：计划是历史记录，从这里看用例现值，
     要改去用例库——抽屉 readOnly 全灰 + 页脚只剩关闭。 */
  const [viewCaseId, setViewCaseId] = useState<string>();

  function toggleGroup(path: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  const summary = plan.summary;
  const marked = summary.passed + summary.failed + summary.blocked + summary.skipped;
  const unmarked = summary.total - marked;
  const passRate = passRateOf(plan);

  /* 就地标结果：单项 PATCH + 本地合行（不整页重拉——正在编辑的备注/链接不丢，
     ㉑ 同款纪律）；头部的计数与 Readout 同步推进。 */
  async function markItem(item: TestPlanItem, result: TestPlanItemResult | "unmarked") {
    if (busyItem) return;
    setBusyItem(item.id);
    try {
      const updated = await api.updateTestPlanItem(projectId, plan.id, item.id, {
        /* "unmarked" → null（清回未执行，服务端连带清 executed_at）。 */
        result: result === "unmarked" ? null : result,
      });
      onPlanChanged(withItem(plan, updated));
    } catch (error) {
      message.error(apiMessage(error) ?? t("testPlans.markFailed"));
    } finally {
      setBusyItem(undefined);
    }
  }

  async function saveNote(item: TestPlanItem, note: string, defectUrl: string) {
    if (busyItem) return;
    setBusyItem(item.id);
    try {
      const updated = await api.updateTestPlanItem(projectId, plan.id, item.id, { note, defectUrl });
      onPlanChanged(withItem(plan, updated));
      message.success(t("testPlans.noteSaved"));
    } catch (error) {
      message.error(apiMessage(error) ?? t("testPlans.noteSaveFailed"));
    } finally {
      setBusyItem(undefined);
    }
  }

  function removeItem(item: TestPlanItem) {
    Modal.confirm({
      title: t("testPlans.removeItemTitle", { name: item.titleSnapshot }),
      content: t("testPlans.removeItemHint"),
      okText: t("action.delete"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.deleteTestPlanItem(projectId, plan.id, item.id);
          message.success(t("testPlans.itemRemoved"));
          /* 移项同样就地重算 summary（被移走的项可能带着已标记的结果）。 */
          const items = plan.items.filter((row) => row.id !== item.id);
          onPlanChanged({ ...plan, items, summary: summaryOf(items) });
        } catch (error) {
          message.error(apiMessage(error) ?? t("testPlans.removeItemFailed"));
        }
      },
    });
  }

  /* 顶部状态快捷开关（open ↔ closed）：完整编辑（名称/描述/截止）走「编辑」弹窗。 */
  async function toggleStatus() {
    const next = plan.status === "open" ? "closed" : "open";
    try {
      await api.updateTestPlan(projectId, plan.id, { status: next });
      onPlanChanged({ ...plan, status: next });
      message.success(t("testPlans.planStatusUpdated"));
    } catch (error) {
      message.error(apiMessage(error) ?? t("testPlans.saveFailed"));
    }
  }

  async function runExport() {
    if (exporting) return;
    setExporting(true);
    try {
      const blob = await api.exportTestPlan(projectId, plan.id);
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      saveBlob(blob, t("testPlans.exportName", { name: plan.name, date: stamp }));
    } catch (error) {
      message.error(apiMessage(error) ?? t("testPlans.exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  /* 按模块路径快照分组（组间排序即字典序——path 物化的深度优先序，与用例库
     列表同一序）。组头行复用 picker-group 的样式（sticky 头 + 弱字等宽）+
     用例库左树的同款折叠件（caret / Folder / 计数）。 */
  const groups = useMemo(() => {
    const buckets = new Map<string, TestPlanItem[]>();
    for (const item of plan.items) {
      const key = item.modulePathSnapshot || "/";
      const bucket = buckets.get(key) ?? [];
      bucket.push(item);
      buckets.set(key, bucket);
    }
    return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [plan.items]);

  return <main className="content">
    <div className="page-head">
      <div>
        <h1>{plan.name}</h1>
        <p>{plan.description || t("testPlans.title")}</p>
      </div>
      <div className="topbar-actions">
        {/* 导出对 viewer 开放（纯读；后端同款放行）。 */}
        <button className="btn btn-with-icon" disabled={exporting} onClick={() => void runExport()}>
          <FileDown size={14} />{exporting ? `${t("common.loading")}…` : t("action.export")}
        </button>
        {canWrite && <>
          {/* 归档/重开（2026-09-09 第四轮反馈：原先是页脚的一行 linkish 文本，
              没人看得到）：提为 topbar 常驻按钮，图标用归档的视觉惯用形；
              已归档的计划按钮换成「重开」（open↔closed 两向）。 */}
          <Tip text={t(plan.status === "open" ? "testPlans.archiveHint" : "testPlans.reopenHint")}>
            <button className="btn btn-with-icon" onClick={() => void toggleStatus()}>
              <Archive size={14} />{t(plan.status === "open" ? "testPlans.archive" : "testPlans.reopen")}
            </button>
          </Tip>
          <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => setEditOpen(true)} />
          <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => confirmDelete(plan, t, projectId, undefined, navigate)} />
        </>}
      </div>
    </div>

    <div className="readouts">
      <Readout label={t("endpoints.status")} value={<Status status={plan.status === "open" ? "running" : "canceled"} label={t(`testPlans.status_${plan.status}`)} />} />
      {/* 通过率恒绿（2026-09-09 第三轮反馈）：分母是全部项的口径下，一个比率
          读数不需要红绿两态——红会逼着「刚标了 2 条通过」的计划立刻喊失败；
          达标线是人的判断，不是数字的属性。 */}
      <Readout label={t("testPlans.passRate")} value={passRate === null ? "—" : passRate} unit={passRate === null ? undefined : "%"} tone={passRate === null ? undefined : "pass"} />
      <Readout label={t("testPlans.progress")} value={`${marked}/${summary.total}`} />
      {/* 未执行：数在标签里（「N 条未执行」），值位置给四态各自的计数
          （2026-09-09 第三轮反馈：原先放 blocked+skipped 的算式，答非所问且
          会被读成「未执行的另一种写法」）。计数行带文本（第四轮反馈补：
          纯色点+数字要人猜哪个是哪个）——「通过 2 失败 0 …」，词汇与
          行内结果下拉同一套，色点即词。 */}
      <Readout
        label={t("testPlans.unmarkedCount", { count: unmarked })}
        value={<span className="readout-marks">
          {(["passed", "failed", "blocked", "skipped"] as const).map((key) =>
            <Status key={key} status={resultView(key)} label={`${t(`testPlans.result_${key}`)} ${summary[key]}`} />)}
        </span>}
      />
      <Readout label={t("testPlans.owner")} value={plan.ownerName ?? t("testPlans.unassigned")} />
    </div>

    {/* 项表（不分页——通读「哪些没跑」不该翻页，套件成员明细同一纪律）。 */}
    {plan.items.length ? <div className="table-scroll"><table className="grid plan-item-grid">
      <thead><tr>
        <th>{t("testPlans.itemCase")}</th>
        {/* 结果表头悬停给五态计数（2026-09-09 反馈）：标之前先看分布——
            通过/失败/阻塞/跳过/未执行各多少，不用心算 summary。 */}
        <th className="col-status">
          <Tip text={<span className="tip-stack">
            {(["passed", "failed", "blocked", "skipped"] as const).map((value) => (
              <Status key={value} status={resultView(value)} label={`${t(`testPlans.result_${value}`)} ${summary[value]}`} />
            ))}
            <Status status="not_run" label={`${t("testPlans.result_unmarked")} ${unmarked}`} />
          </span>}>
            <span>{t("testPlans.itemResult")}</span>
          </Tip>
        </th>
        <th className="col-status">{t("testPlans.itemExecutedAt")}</th>
        {canWrite && <th className="col-actions" />}
      </tr></thead>
      <tbody>
        {groups.map(([path, items]) => {
          /* 祖先目录被收起的组整组不出（组头也不出——树里收起的子树没有残留头）。 */
          if (!isGroupVisible(path, collapsedGroups)) return null;
          return <ItemGroupRows
            key={path}
            path={path}
            items={items}
            canWrite={canWrite}
            busyItem={busyItem}
            collapsed={collapsedGroups.has(path)}
            onToggle={() => toggleGroup(path)}
            t={t}
            projectId={projectId}
            onViewCase={setViewCaseId}
            onMark={markItem}
            onSaveNote={saveNote}
            onRemove={removeItem}
          />;
        })}
      </tbody>
    </table></div> : <Empty
      title={t("testPlans.noItems")}
      hint={t("testPlans.noItemsHint")}
      action={<button className="btn btn-primary" onClick={() => navigate(`/projects/${projectId}/spec-cases`)}>{t("specCases.title")}</button>}
    />}

    {canWrite && <PlanCreateModal
      projectId={projectId}
      open={editOpen}
      plan={plan}
      onClose={() => setEditOpen(false)}
      /* PATCH 响应不含 items 与真实 summary（UPDATE 不动项，mapper 的计数键
         缺席兜底成 0）——编辑只动头字段，项行与计数都留在手上这份；不钉住
         summary 的话一次改名就把进度清成 0/total。 */
      onCreated={(updated) => { setEditOpen(false); onPlanChanged({ ...plan, ...updated, summary: plan.summary }); }}
    />}

    {/* 用例只读抽屉（2026-09-09 反馈）：抽屉自己按 id 现拉详情，行快照不进抽屉
        （SpecCases 同款纪律）；modules/onSaved 不给——只读视角用不到。 */}
    {viewCaseId && <SpecCaseDrawer
      projectId={projectId}
      caseId={viewCaseId}
      readOnly
      onClose={() => setViewCaseId(undefined)}
    />}
  </main>;
}

/** 组头行可见 = 没有任何祖先目录被收起（树语义：收起「/购物」连带藏掉
 *  「/购物/下单」整个组，与用例库左树一致——组间不嵌套渲染，用前缀判定）。
 *  path 形如 "/a/b"，从第二段起逐级截前缀查收起集。 */
function isGroupVisible(path: string, collapsed: Set<string>): boolean {
  let slash = path.indexOf("/", 1);
  while (slash !== -1) {
    if (collapsed.has(path.slice(0, slash))) return false;
    slash = path.indexOf("/", slash + 1);
  }
  return true;
}

/** 一组计划项的行（组头 + 数据行）。组头 = 模块路径快照（计用例数），整行点击
 *  收起/展开（与用例库左树同款折叠件：caret + Folder + 计数；组间无父子嵌套——
 *  计划按全路径分组，字典序已保证父目录与子目录相邻）。 */
function ItemGroupRows({ path, items, canWrite, busyItem, collapsed, onToggle, t, projectId, onViewCase, onMark, onSaveNote, onRemove }: {
  path: string;
  items: TestPlanItem[];
  canWrite: boolean;
  busyItem?: string;
  collapsed: boolean;
  onToggle: () => void;
  t: (key: string, vars?: Record<string, unknown>) => string;
  projectId: string;
  onViewCase: (caseId: string) => void;
  onMark: (item: TestPlanItem, result: TestPlanItemResult | "unmarked") => void;
  onSaveNote: (item: TestPlanItem, note: string, defectUrl: string) => void;
  onRemove: (item: TestPlanItem) => void;
}) {
  return <>
    <tr className="picker-group plan-group" data-clickable aria-expanded={!collapsed} onClick={onToggle}>
      <td colSpan={canWrite ? 4 : 3}>
        <div className="plan-group-head">
          <span className="tree-caret" aria-hidden>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
          <Folder size={13} style={{ color: "var(--ink-3)", flex: "0 0 auto" }} />
          <span className="truncate picker-name">{formatPath(path) || t("specCases.allCases")}</span>
          <span className="mono muted" style={{ marginLeft: 8 }}>{items.length}</span>
        </div>
      </td>
    </tr>
    {/* 收起时数据行不渲染（不是 display:none——表格外没有别的读数引用它）。 */}
    {!collapsed && items.map((item) => <PlanItemRow
      key={item.id}
      item={item}
      canWrite={canWrite}
      busy={busyItem === item.id}
      t={t}
      projectId={projectId}
      onViewCase={onViewCase}
      onMark={onMark}
      onSaveNote={onSaveNote}
      onRemove={onRemove}
    />)}
  </>;
}

/** 单个计划项行：用例标识（编号 + 标题快照 + 现状态）｜结果下拉就地标｜自动化
 *  参考列（只读）｜标记时间｜行操作（备注、移出）。标识格可点开用例只读抽屉
 *  （用例已删时不可点——库里的行没了，点了也是 404）。 */
function PlanItemRow({ item, canWrite, busy, t, projectId, onViewCase, onMark, onSaveNote, onRemove }: {
  item: TestPlanItem;
  canWrite: boolean;
  busy: boolean;
  t: (key: string, vars?: Record<string, unknown>) => string;
  projectId: string;
  onViewCase: (caseId: string) => void;
  onMark: (item: TestPlanItem, result: TestPlanItemResult | "unmarked") => void;
  onSaveNote: (item: TestPlanItem, note: string, defectUrl: string) => void;
  onRemove: (item: TestPlanItem) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  /* 用例被删（specCaseId 缺席）：快照仍在、标识读「用例已删除」，库链接不渲染。 */
  const caseDeleted = !item.specCaseId;

  return <>
    <tr data-removed={caseDeleted ? "" : undefined}>
      <td className={caseDeleted ? undefined : "cell-clickable"} onClick={() => item.specCaseId && onViewCase(item.specCaseId)}>
        <div className="plan-case">
          <span className="mono muted plan-item-key">{item.specCaseKey ?? "—"}</span>
          <span className="truncate"><strong>{item.titleSnapshot}</strong></span>
          {caseDeleted && <em className="link-stale"> · {t("testPlans.itemCaseDeleted")}</em>}
          {item.note && <Tip text={item.note}><span className="chip">{t("testPlans.itemNote")}</span></Tip>}
          {item.defectUrl && <a href={item.defectUrl} target="_blank" rel="noreferrer" className="linkish" onClick={(event) => event.stopPropagation()}>{t("testPlans.itemDefect")}</a>}
        </div>
      </td>
      <td className="col-status">
        {canWrite
          ? <Select
              size="small"
              value={item.result ?? "unmarked"}
              disabled={busy}
              onChange={(value: TestPlanItemResult | "unmarked") => onMark(item, value)}
              style={{ width: 104 }}
              /* 选项与已选态都用 Status 原语着色（2026-09-09 反馈）：下拉里挑
                 「失败」看到的就是行内只读态的同一个红——状态色是保留词，
                 一个结果在任何落点都是同一个颜色。 */
              options={ITEM_RESULTS.map((value) => ({
                value,
                label: <Status status={resultOptionView(value)} label={t(`testPlans.result_${value}`)} />,
              }))}
            />
          : <Status status={resultView(item.result)} label={t(`testPlans.result_${item.result ?? "unmarked"}`)} />}
      </td>
      <td className="mono muted">{item.executedAt ? new Date(item.executedAt).toLocaleString() : "—"}</td>
      {canWrite && <td className="col-actions"><div className="row-actions">
        <IconButton icon={<Pencil size={14} />} label={t("testPlans.itemNote")} onClick={() => setNoteOpen(true)} />
        <IconButton icon={<X size={14} />} label={t("testPlans.removeItem")} tone="danger" onClick={() => onRemove(item)} />
      </div></td>}
    </tr>
    {/* 备注与缺陷链接弹窗：就地保存（不打断整表）。 */}
    {noteOpen && <NoteModal
      item={item}
      t={t}
      busy={busy}
      onClose={() => setNoteOpen(false)}
      onSave={(note, defectUrl) => { onSaveNote(item, note, defectUrl); setNoteOpen(false); }}
    />}
  </>;
}

function NoteModal({ item, t, busy, onClose, onSave }: {
  item: TestPlanItem;
  t: (key: string, vars?: Record<string, unknown>) => string;
  busy: boolean;
  onClose: () => void;
  onSave: (note: string, defectUrl: string) => void;
}) {
  const [note, setNote] = useState(item.note);
  const [defectUrl, setDefectUrl] = useState(item.defectUrl ?? "");
  return <Modal
    title={t("testPlans.noteTitle")}
    open
    okText={t("action.save")}
    cancelText={t("action.cancel")}
    okButtonProps={{ disabled: busy }}
    confirmLoading={busy}
    onOk={() => onSave(note.trim(), defectUrl.trim())}
    onCancel={onClose}
  >
    <label className="field"><span>{t("testPlans.itemNote")}</span>
      <textarea className="input" rows={3} placeholder={t("testPlans.notePlaceholder")} value={note} onChange={(event) => setNote(event.target.value)} />
    </label>
    <label className="field"><span>{t("testPlans.itemDefect")}</span>
      <input className="input" placeholder={t("testPlans.defectPlaceholder")} value={defectUrl} onChange={(event) => setDefectUrl(event.target.value)} />
    </label>
  </Modal>;
}

/** 项行替换（标结果 / 存备注的就地合行）。头部计数在调用方按 items 重算。 */
function withItem(plan: TestPlanDetail, item: TestPlanItem): TestPlanDetail {
  const items = plan.items.map((row) => (row.id === item.id ? item : row));
  /* summary 跟着合过的项行重算（2026-09-09 反馈：标了结果头部计数不推进——
     服务端口径同一把尺：五计数全出自项行本身，详情又是全量项，就地算即真值）。 */
  return { ...plan, items, summary: summaryOf(items) };
}

/** 五计数从项行算（与后端 PLAN_SUMMARY_SELECT 同一口径）：total = 项数，
 *  四值按 result 计数，未执行 = 差值（调用方现算）。 */
function summaryOf(items: TestPlanItem[]): TestPlan["summary"] {
  const summary = { total: items.length, passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const row of items) {
    if (row.result === "passed") summary.passed += 1;
    else if (row.result === "failed") summary.failed += 1;
    else if (row.result === "blocked") summary.blocked += 1;
    else if (row.result === "skipped") summary.skipped += 1;
  }
  return summary;
}
