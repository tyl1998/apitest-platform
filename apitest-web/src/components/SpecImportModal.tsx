import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { Modal, TreeSelect, message } from "antd";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, FileSpreadsheet, Folder, Network, Upload } from "lucide-react";
import { api, type SpecImportCase, type SpecImportCommitResult, type SpecImportPreview, type SpecImportPreviewCase } from "../api";
import { Empty } from "../ui";
import { apiMessage } from "./DataSourceList";
import { saveBlob } from "../lib/download";

/**
 * 文本用例导入向导（P7-4/P7-5，计划 11.3「导入向导 Modal 三步」）：上传 → 预览 → 提交。
 *
 * - 预览是**两阶段导入的前半段**：文件上传给服务端解析判重（不落库），归一化
 *   JSON 由本组件持有，提交时只发用户勾选的行——不落暂存表，页面刷新即作废，
 *   重新预览一次就是了。
 * - 两种来源（P7-5 起）：`.xmind`（层级映射只认 `tc:` 标记，2026-09-08 用户
 *   收窄；没约定的文件解析为 0 条，预览页说明原因）与 `.xlsx`（平台固定模板，
 *   上传步可下载）。提示文案按已选文件的类型切换。
 * - **导入根目录（2026-09-08 用户要求）**：上传步可选一个既有模块，整份文件
 *   挂到它下面（`/选中目录/文件根/…/`）；不选 = 按文件自身结构（文件根为顶层
 *   模块）。预览树里看到的就是最终落库路径，所见即所得。
 * - 勾选默认只勾「新增 / 有变」——「未变」行重导没有意义，「重复」行不该二次
 *   落库；判定与冲突摘要在顶部一次看全。
 *
 * 样式全部走 design-system 既有令牌（.import-* 一节），不引入第二个视觉体系。
 */

const STEP_ROW_GRID: CSSProperties = { gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr)" };

/** antd TreeSelect 节点（与 SpecCases 的 ModuleNode 同构，value = 模块 id）。 */
type ModuleTreeOption = { value: string; title: string; children?: ModuleTreeOption[] };

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** '/A/B/' → 'A/B'：与用例库列表的模块路径列同一展示口径。 */
function formatPath(path: string): string {
  return path.replace(/^\//, "").replace(/\/$/, "");
}

type CaseGroup = { path: string; items: { index: number; item: SpecImportPreviewCase }[] };

function groupCases(cases: SpecImportPreviewCase[]): CaseGroup[] {
  const groups = new Map<string, { index: number; item: SpecImportPreviewCase }[]>();
  cases.forEach((item, index) => {
    const list = groups.get(item.modulePath);
    if (list) list.push({ index, item });
    else groups.set(item.modulePath, [{ index, item }]);
  });
  return [...groups.entries()].map(([path, items]) => ({ path, items }));
}

export function SpecImportModal({ projectId, modules, open, onClose, onImported }: {
  projectId: string;
  modules: ModuleTreeOption[];
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"upload" | "preview" | "done">("upload");
  const [file, setFile] = useState<File>();
  const [rootModuleId, setRootModuleId] = useState<string>();
  const [preview, setPreview] = useState<SpecImportPreview>();
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  /* 勾选与展开都按下标存：预览行没有稳定身份，重新预览整组重算。 */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedCases, setExpandedCases] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<SpecImportCommitResult>();
  const [dragging, setDragging] = useState(false);
  const [templateLoading, setTemplateLoading] = useState<"excel" | "xmind" | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);

  /* 每次打开整组重置：上一次没提交的文件、目录与勾选不该悄悄留给下一次。 */
  useEffect(() => {
    if (!open) return;
    setStep("upload");
    setFile(undefined);
    setRootModuleId(undefined);
    setPreview(undefined);
    setSelected(new Set());
    setExpandedGroups(new Set());
    setExpandedCases(new Set());
    setResult(undefined);
    setDragging(false);
    setTemplateLoading(undefined);
  }, [open]);

  function pickFile(candidate: File | undefined) {
    if (!candidate) return;
    if (!/\.(xmind|xlsx)$/i.test(candidate.name)) {
      message.error(t("specCases.importFileOnly"));
      return;
    }
    setFile(candidate);
    setPreview(undefined);
  }

  async function downloadTemplate(format: "excel" | "xmind") {
    setTemplateLoading(format);
    try {
      const name = format === "xmind" ? t("specCases.importXmindTemplateName") : t("specCases.importTemplateName");
      saveBlob(await api.downloadSpecImportTemplate(projectId, format), name);
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.importTemplateFailed"));
    } finally {
      setTemplateLoading(undefined);
    }
  }

  async function runPreview(chosen: File, chosenRoot: string | undefined) {
    setLoading(true);
    try {
      const outcome = await api.previewSpecImport(projectId, chosen, chosenRoot);
      setPreview(outcome);
      /* 默认勾「会落库」的两态；「未变 / 重复」留给用户显式改选。 */
      setSelected(new Set(outcome.cases.flatMap((each, index) => each.judgment === "new" || each.judgment === "changed" ? [index] : [])));
      const groups = groupCases(outcome.cases);
      /* 默认展开前三个模块组：空平的树没有「预览」的说服力，全展开又会铺出几千行。 */
      setExpandedGroups(new Set(groups.slice(0, 3).map((group) => group.path)));
      setExpandedCases(new Set());
      setStep("preview");
    } catch (error) {
      /* 1001 的服务端话术（非 zip / 缺 content.json / 超限 / 炸弹闸）直接透传。 */
      message.error(apiMessage(error) ?? t("specCases.importPreviewFailed"));
    } finally {
      setLoading(false);
    }
  }

  function togglePath(set: Set<string>, path: string): Set<string> {
    const next = new Set(set);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  }

  async function commit() {
    if (!preview || !selected.size || !file) return;
    setCommitting(true);
    try {
      /* 只发归一化字段——判定（judgment）是预览态的展示信息，提交体不带。
         source 按文件扩展名定：Excel 模板路径才带编号位。 */
      const cases: SpecImportCase[] = [...selected].sort((a, b) => a - b).map((index) => {
        const each = preview.cases[index];
        return { modulePath: each.modulePath, title: each.title, preconditions: each.preconditions, steps: each.steps, priority: each.priority, tags: each.tags, itemKey: each.itemKey ?? null };
      });
      const outcome = await api.commitSpecImport(projectId, { source: /\.xlsx$/i.test(file.name) ? "excel" : "xmind", cases });
      setResult(outcome);
      setStep("done");
      onImported();
    } catch (error) {
      message.error(apiMessage(error) ?? t("specCases.importCommitFailed"));
    } finally {
      setCommitting(false);
    }
  }

  const groups = useMemo(() => (preview ? groupCases(preview.cases) : []), [preview]);
  /* 超限时禁提交但不禁预览：用户需要先看到计数，再拆分文件分批导。 */
  const blockedByLimit = Boolean(preview?.summary.exceededLimit);

  /* ── 第一步：上传（文件 + 可选导入根目录 + 模板下载） ─────────────────────── */
  const uploadStep = <>
    <div
      className={`import-drop${dragging ? " is-dragging" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={t("specCases.importPickFile")}
      onClick={() => fileInput.current?.click()}
      onKeyDown={(event: DragEvent) => { if (event.key === "Enter" || event.key === " ") fileInput.current?.click(); }}
      onDragOver={(event: DragEvent) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event: DragEvent) => { event.preventDefault(); setDragging(false); pickFile(event.dataTransfer.files[0]); }}
    >
      <Upload size={18} />
      <span>{file ? file.name : t("specCases.importDropHint")}</span>
      {file && <span className="import-file-meta mono">{formatSize(file.size)}{preview ? "" : ` · ${t("specCases.importRepick")}`}</span>}
    </div>
    <input
      ref={fileInput}
      type="file"
      accept=".xmind,.xlsx"
      className="visually-hidden"
      onChange={(event) => { pickFile(event.target.files?.[0]); event.target.value = ""; }}
    />
    <label className="field" style={{ marginTop: 12 }}>
      <span>{t("specCases.importRoot")}</span>
      <TreeSelect
        value={rootModuleId}
        onChange={(value: string | undefined) => { setRootModuleId(value); setPreview(undefined); }}
        onClear={() => { setRootModuleId(undefined); setPreview(undefined); }}
        treeData={modules}
        treeDefaultExpandAll
        allowClear
        placeholder={t("specCases.importRootPlaceholder")}
        style={{ width: "100%" }}
      />
    </label>
    {/* 模板下载（P7-5；XMind 模板 2026-09-08 增补）：贴着上传区放——「没模板」是
        填文件的第一道门槛；两种格式各一枚按钮，用哪种下哪种。 */}
    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
      <button type="button" className="btn btn-with-icon" disabled={templateLoading !== undefined} onClick={() => void downloadTemplate("excel")}>
        <FileSpreadsheet size={14} />{templateLoading === "excel" ? `${t("common.loading")}…` : t("specCases.importDownloadTemplate")}
      </button>
      <button type="button" className="btn btn-with-icon" disabled={templateLoading !== undefined} onClick={() => void downloadTemplate("xmind")}>
        <Network size={14} />{templateLoading === "xmind" ? `${t("common.loading")}…` : t("specCases.importDownloadXmindTemplate")}
      </button>
    </div>
    <p className="form-note">{file && /\.xlsx$/i.test(file.name) ? t("specCases.importExcelHint") : t("specCases.importFormatsHint")}</p>
  </>;

  /* ── 第二步：预览 ─────────────────────────────────────────────────────────── */
  const previewStep = !preview ? null : <>
    <div className="import-toolbar">
      <span className="chip mono">{t("specCases.importTotal", { count: preview.summary.total })}</span>
      <span className="chip mono">{t("specCases.judgmentNew", { count: preview.summary.new })}</span>
      <span className="chip mono">{t("specCases.judgmentChanged", { count: preview.summary.changed })}</span>
      <span className="chip mono">{t("specCases.judgmentUnchanged", { count: preview.summary.unchanged })}</span>
      <span className="chip mono">{t("specCases.judgmentDuplicate", { count: preview.summary.duplicate })}</span>
    </div>
    {preview.format === "xml" && <p className="form-note">{t("specCases.importLegacyFormat")}</p>}
    {blockedByLimit && <p className="form-note import-warning">{t("specCases.importOverLimit", { count: preview.summary.total })}</p>}

    {loading ? <p className="muted">{t("common.loading")}…</p> : preview.cases.length === 0 ? <Empty
      title={t("specCases.importEmptyTitle")}
      hint={preview.format === "excel" ? t("specCases.importEmptyExcelHint") : t("specCases.importEmptyHint")}
    /> : <div className="import-tree">
      {groups.map((group) => {
        const open = expandedGroups.has(group.path);
        const selectedInGroup = group.items.filter((entry) => selected.has(entry.index));
        const allSelected = selectedInGroup.length === group.items.length;
        return <div key={group.path} className="import-group">
          <div className="import-group-head">
            <button type="button" className="tree-caret" aria-expanded={open} aria-label={t("specCases.toggleModule", { name: formatPath(group.path) })}
              onClick={() => setExpandedGroups(togglePath(expandedGroups, group.path))}>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <input
              type="checkbox"
              aria-label={t("specCases.importSelectGroup", { path: formatPath(group.path) })}
              checked={allSelected}
              ref={(node) => { if (node) node.indeterminate = selectedInGroup.length > 0 && !allSelected; }}
              onChange={(event) => setSelected((current) => {
                const next = new Set(current);
                for (const entry of group.items) { if (event.target.checked) next.add(entry.index); else next.delete(entry.index); }
                return next;
              })}
            />
            <Folder size={13} style={{ color: "var(--ink-3)", flex: "0 0 auto" }} />
            <span className="mono truncate" title={group.path}>{formatPath(group.path)}</span>
            <span className="mono tree-count">{group.items.length}</span>
          </div>
          {open && group.items.map(({ index, item }) => {
            const expanded = expandedCases.has(index);
            return <div key={index} className="import-case">
              <div className="import-case-row" data-expanded={expanded ? "" : undefined}>
                <input
                  type="checkbox"
                  aria-label={t("specCases.selectCase", { name: item.title })}
                  checked={selected.has(index)}
                  onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(index); else next.delete(index); return next; })}
                />
                <span className="chip mono">{t(`specCases.importJudgment_${item.judgment}`)}</span>
                <button type="button" className="import-case-title truncate" title={item.title} onClick={() => setExpandedCases((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}>
                  {item.title}
                </button>
                <span className="chip mono">{item.priority}</span>
                {item.steps.length > 0 && <span className="mono tree-count">{t("specCases.importStepCount", { count: item.steps.length })}</span>}
                {item.pathClamped && <span className="chip mono" title={t("specCases.importClampedHint")}>{t("specCases.importClamped")}</span>}
              </div>
              {expanded && <div className="import-case-detail">
                {item.preconditions && <div className="import-field"><span className="import-field-label">{t("specCases.preconditions")}</span><p>{item.preconditions}</p></div>}
                {item.tags.length > 0 && <div className="import-field"><span className="import-field-label">{t("specCases.tags")}</span><p>{item.tags.join(" · ")}</p></div>}
                {item.steps.length > 0 ? <div className="steps-table">
                  {/* 列名不带 .steps-col-label 的缩进：那是对齐 textarea 内边距的，
                      这里步骤文字是纯 span，对齐 kv-row 自身的内边距即可。 */}
                  <div className="kv-row steps-head" style={STEP_ROW_GRID}>
                    <span>{t("specCases.stepPlaceholder")}</span>
                    <span>{t("specCases.expectedPlaceholder")}</span>
                  </div>
                  {item.steps.map((row, stepIndex) => <div className="kv-row import-step-row" style={STEP_ROW_GRID} key={stepIndex}>
                    <span className="import-step-text"><span className="mono muted" style={{ marginRight: 6 }}>{stepIndex + 1}</span>{row.step}</span>
                    <span className="import-step-text">{row.expected}</span>
                  </div>)}
                </div> : <p className="form-note">{t("specCases.importNoSteps")}</p>}
              </div>}
            </div>;
          })}
        </div>;
      })}
    </div>}
  </>;

  /* ── 第三步：结果 ─────────────────────────────────────────────────────────── */
  const doneStep = !result ? null : <div className="import-result">
    <p>{t("specCases.importDone", { created: result.created, updated: result.updated, skipped: result.skipped })}</p>
    <p className="form-note">
      {t("specCases.importDoneModules", { count: result.modulesCreated })}
      {result.duplicate > 0 ? ` ${t("specCases.importDoneDuplicates", { count: result.duplicate })}` : ""}
    </p>
  </div>;

  const footer = <div className="drawer-actions">
    {step === "preview" && <button className="btn" disabled={loading || committing} onClick={() => setStep("upload")}>{t("specCases.importBack")}</button>}
    {step === "upload" && <button className="btn" onClick={onClose}>{t("action.cancel")}</button>}
    {step === "upload" && <button className="btn btn-primary" disabled={!file || loading} onClick={() => file && void runPreview(file, rootModuleId)}>{loading ? `${t("common.loading")}…` : t("specCases.importPreviewAction")}</button>}
    {step === "preview" && <button className="btn" onClick={onClose}>{t("action.cancel")}</button>}
    {step === "preview" && <button className="btn btn-primary" disabled={!selected.size || committing || blockedByLimit} onClick={() => void commit()}>
      {committing ? `${t("common.loading")}…` : t("specCases.importCommitAction", { count: selected.size })}
    </button>}
    {step === "done" && <button className="btn btn-primary" onClick={onClose}>{t("specCases.importFinish")}</button>}
  </div>;

  return <Modal
    title={t("specCases.importTitle")}
    open={open}
    width={780}
    zIndex={1100}
    destroyOnHidden
    footer={footer}
    onCancel={onClose}
  >
    {step === "upload" ? uploadStep : step === "preview" ? previewStep : doneStep}
  </Modal>;
}
