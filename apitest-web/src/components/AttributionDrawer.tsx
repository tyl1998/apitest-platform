import { useEffect, useState } from "react";
import { Drawer, Input, message } from "antd";
import { useTranslation } from "react-i18next";
import { Bug } from "lucide-react";
import { api, type AttributionTargetType, type FailureAttributionLite, type FailureCategory } from "../api";
import { Tip } from "../ui";

/**
 * 失败归因的行内入口与打标抽屉（P8-3；REST 在 P8-2，计划 12.0 边界 9）。
 *
 * 一个可见的失败行 = 一个归因目标（边界 4：只在叶子失败上打标，父级 run/suite 不收）。
 * 目标三要素由调用方推导——套件成员行按「有 httpExecutionId → executions 行，否则 →
 * 步骤行自身」、CI 用例行就是 pipeline_run_cases 行——与服务端随行 JOIN 的口径一句对齐。
 *
 * 抽屉同时服务单条与批量（边界 4：一次 CI 挂一片同因失败太常见，批量是一等交互）：
 * 同一分类 + note 应用到一批目标。单条带现有归因时预填并允许清除；批量不预填
 * （一批里各条现有归因可能不同，预填哪一条都是误导）。
 */

/** 一条待归因的失败行：目标三要素 + 显示名 + **当前归因**（清单展示与预填推导用）。 */
export type AttributionTarget = {
  targetType: AttributionTargetType;
  targetId: string;
  label: string;
  /** 该失败行当前的归因；undefined = 未归因。 */
  attribution?: FailureAttributionLite;
};

/** 抽屉的挂载参数：单条额外带证据消息节选（批量不预填，见抽屉内的预填规则）。 */
export type AttributionRequest = {
  targets: AttributionTarget[];
  evidenceMessage?: string;
};

/** 归因证据里随摘要展示的消息上限：抽屉是打标决策的地方，不是读完整堆栈的地方。 */
const EVIDENCE_MESSAGE_LIMIT = 800;
/** note 的 UI 上限（服务端 TEXT 不设限；这里只是输入框的软约束）。 */
const NOTE_MAX_LENGTH = 500;
/** 服务端单批归因上限（P8-2 的 100）；抽屉端按它分块提交。 */
const BATCH_LIMIT = 100;

/**
 * 行内归因 chip：未归因 → 「未归因」；已归因 → 分类名（title 带备注/来源/时间）。
 * 绑定了 bug 链接时旁边带一个 bug 小图标（套件/仓库共用同一实现——图标只取决于
 * 「这条归因绑没绑链接」，不取决于报告类型）。chip 是按钮（actionable 时），链接
 * 必须是它的兄弟节点而不是子节点（交互元素不能嵌套），点击 stopPropagation 不触发
 * 打标；hover 由 `Tip` 提示「跳转 Bug：地址」（验收反馈五轮）。`actionable`
 * （developer 以上且站内视图）时 chip 即按钮——点开打标抽屉；否则只是读数
 * （viewer 与分享页：看得见结论，改不了结论）。
 */
export function AttributionTag({ attribution, actionable, onClick }: {
  attribution?: FailureAttributionLite;
  actionable: boolean;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  if (!attribution) {
    return actionable
      ? <button type="button" className="chip chip-action" onClick={onClick}>{t("attribution.unattributed")}</button>
      : <span className="muted">{t("attribution.unattributed")}</span>;
  }
  const title = [
    attribution.note || undefined,
    attribution.bugUrl || undefined,
    t(attribution.source === "mcp" ? "attribution.sourceMcp" : "attribution.sourceHuman"),
    new Date(attribution.updatedAt).toLocaleString(),
  ].filter(Boolean).join(" · ");
  const chip = actionable
    ? <button type="button" className="chip chip-action" title={title} onClick={onClick}>{attribution.categoryName}</button>
    : <span className="chip" title={title}>{attribution.categoryName}</span>;
  return <span className="attribution-tag">
    {chip}
    {attribution.bugUrl && (
      <Tip text={t("attribution.bugLinkHint", { url: attribution.bugUrl })}>
        <a
          className="attribution-bug-link"
          href={attribution.bugUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
        ><Bug size={12} /></a>
      </Tip>
    )}
  </span>;
}

export function AttributionDrawer({ projectId, targets, evidenceMessage, onClose, onDone }: {
  projectId: string;
  targets: AttributionTarget[];
  /** 单条的证据消息节选（错误/断言原文前几百字，只读展示）。 */
  evidenceMessage?: string;
  onClose: () => void;
  /** 保存/清除成功后的回调（调用方刷新数据），随后抽屉自行关闭。 */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<FailureCategory[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const single = targets.length === 1;
  /* 预填（验收反馈四轮①③：单条与批量形态统一）：全部目标归因**同一分类**才预选——
     单条恒成立、清一色的批量（如 50/50 全是数据问题）也成立；note/bugUrl 进一步
     要求逐字一致。混合批次（部分未归因 / 分类不一）不预填——预填哪一种都是误导，
     想逐条调整的入口在报告详情的失败行上。 */
  const head = targets[0].attribution;
  const shared = head && targets.every((each) => each.attribution?.category === head.category)
    ? head
    : undefined;
  const [category, setCategory] = useState(shared?.category ?? "");
  const [note, setNote] = useState(shared && targets.every((each) => each.attribution?.note === shared.note) ? shared.note : "");
  const [bugUrl, setBugUrl] = useState(shared && targets.every((each) => each.attribution?.bugUrl === shared.bugUrl) ? shared.bugUrl : "");
  /* bug 链接的客户端校验与服务端同一条规则（http(s) 才放行）：非法时禁掉保存并就地
     说明，比提交后收 400 再读 message 少一跳。 */
  const trimmedBugUrl = bugUrl.trim();
  const bugUrlValid = !trimmedBugUrl || /^https?:\/\//i.test(trimmedBugUrl);
  /* 调用方条件渲染（{drawer && <AttributionDrawer/>}），挂载即打开：分类在这里取一次，
     表单状态随挂载重置——上一次打开留下的选中不该悄悄带进下一条失败。 */
  useEffect(() => {
    let alive = true;
    setCategories(undefined);
    setLoadFailed(false);
    void api.failureCategories(projectId)
      .then((rows) => { if (alive) setCategories(rows); })
      .catch(() => { if (alive) setLoadFailed(true); });
    return () => { alive = false; };
  }, [projectId]);

  /* 停用的分类不再是合法的打标选项（服务端拒绝），但预填的现有归因可能正挂着它——
     补一个禁用项让「当前归因是什么」可读，保存前必须换成启用项。 */
  const inactiveCurrent = shared && categories !== undefined && !categories.some((each) => each.code === shared.category)
    ? { code: shared.category, name: shared.categoryName }
    : undefined;
  const canSave = !busy && bugUrlValid && categories !== undefined && categories.some((each) => each.code === category);

  async function save() {
    setBusy(true);
    try {
      const payload = { category, note: note.trim(), bugUrl: trimmedBugUrl };
      if (single) {
        await api.setFailureAttribution(projectId, { targetType: targets[0].targetType, targetId: targets[0].targetId, ...payload });
      } else {
        /* 服务端单批上限 100（P8-2）：全选一片失败时在客户端按 100 分块顺序提交——
           一次提交 = 全部生效，用户不需要知道这个上限的存在。 */
        const bare = targets.map(({ targetType, targetId }) => ({ targetType, targetId }));
        for (let offset = 0; offset < bare.length; offset += BATCH_LIMIT) {
          await api.batchFailureAttribution(projectId, { targets: bare.slice(offset, offset + BATCH_LIMIT), ...payload });
        }
      }
      message.success(t(single ? "attribution.saved" : "attribution.batchSaved", { count: targets.length }));
      onDone();
      onClose();
    } catch {
      message.error(t("attribution.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function clearOne() {
    if (!single) return;
    setBusy(true);
    try {
      await api.clearFailureAttribution(projectId, targets[0].targetType, targets[0].targetId);
      message.success(t("attribution.cleared"));
      onDone();
      onClose();
    } catch {
      message.error(t("attribution.clearFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <Drawer
    title={single ? t("attribution.titleSingle") : t("attribution.titleBatch", { count: targets.length })}
    open
    onClose={onClose}
    width={520}
    footer={<div className="drawer-actions">
      {single && targets[0].attribution && <button type="button" className="btn" disabled={busy} onClick={() => void clearOne()}>{t("attribution.clear")}</button>}
      <span className="filter-spacer" />
      <button type="button" className="btn" onClick={onClose}>{t("action.cancel")}</button>
      <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => void save()}>
        {busy ? "…" : single ? t("action.save") : t("attribution.applyBatch", { count: targets.length })}
      </button>
    </div>}
  >
    {/* 归因对象（验收反馈四轮①③ + 六轮）：单条与批量**同一行渲染**——名称 + 当前
        归因 chip + bug 图标。此前单条只显示裸名字，「当前归因长什么样」要靠下方表单
        的预填反推，看起来像功能没做（用户误判为套件侧缺失，实际是单目标形态缺行）。
        批量额外给条数与滚动；单条在其下补证据摘要。 */}
    <div className="detail-block">
      <h4>{t("attribution.targets")}</h4>
      {targets.length > 1 && <p className="muted" style={{ margin: 0 }}>{t("attribution.targetCount", { count: targets.length })}</p>}
      <ul className="attribution-target-list">
        {targets.map((each) => <li key={`${each.targetType}-${each.targetId}`} className="attribution-target-row">
          <span className="mono truncate" title={each.label}>{each.label}</span>
          {each.attribution
            ? <span className="attribution-target-state">
                <span
                  className="chip"
                  title={[
                    each.attribution.note || undefined,
                    t(each.attribution.source === "mcp" ? "attribution.sourceMcp" : "attribution.sourceHuman"),
                    new Date(each.attribution.updatedAt).toLocaleString(),
                  ].filter(Boolean).join(" · ")}
                >{each.attribution.categoryName}</span>
                {each.attribution.bugUrl && (
                  <Tip text={t("attribution.bugLinkHint", { url: each.attribution.bugUrl })}>
                    <a
                      className="attribution-bug-link"
                      href={each.attribution.bugUrl}
                      target="_blank"
                      rel="noreferrer"
                    ><Bug size={11} /></a>
                  </Tip>
                )}
              </span>
            : <span className="muted">{t("attribution.unattributed")}</span>}
        </li>)}
      </ul>
      {single && evidenceMessage && <>
        <h4 style={{ marginTop: "var(--s4)" }}>{t("attribution.evidence")}</h4>
        <pre className="attribution-evidence mono">{evidenceMessage.slice(0, EVIDENCE_MESSAGE_LIMIT)}</pre>
      </>}
    </div>

    <div className="detail-block">
      <h4>{t("attribution.category")}</h4>
      {categories === undefined && !loadFailed && <p className="muted">{t("common.loading")}</p>}
      {loadFailed && <p className="text-fail">{t("attribution.loadFailed")}</p>}
      {categories !== undefined && categories.length === 0 && <p className="muted">{t("attribution.noCategories")}</p>}
      <div className="attribution-options" role="radiogroup" aria-label={t("attribution.category")}>
        {inactiveCurrent && <label key={inactiveCurrent.code} className="attribution-option" data-checked={category === inactiveCurrent.code || undefined}>
          <input type="radio" name="attribution-category" checked={category === inactiveCurrent.code} onChange={() => setCategory(inactiveCurrent.code)} />
          <span>{inactiveCurrent.name}</span>
          <span className="muted">{t("attribution.inactiveCategory")}</span>
        </label>}
        {categories?.map((each) => (
          <label key={each.code} className="attribution-option" data-checked={category === each.code || undefined}>
            <input type="radio" name="attribution-category" checked={category === each.code} onChange={() => setCategory(each.code)} />
            <span>{each.name}</span>
          </label>
        ))}
      </div>
      {inactiveCurrent && category === inactiveCurrent.code && <p className="form-note">{t("attribution.inactiveHint")}</p>}
    </div>

    <div className="detail-block">
      <h4>{t("attribution.note")}</h4>
      <Input.TextArea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={3}
        maxLength={NOTE_MAX_LENGTH}
        placeholder={t("attribution.notePlaceholder")}
      />
    </div>

    <div className="detail-block">
      <h4>{t("attribution.bugUrl")}</h4>
      <Input
        value={bugUrl}
        onChange={(event) => setBugUrl(event.target.value)}
        maxLength={2000}
        placeholder={t("attribution.bugUrlPlaceholder")}
      />
      {!bugUrlValid && <p className="form-note text-fail">{t("attribution.bugUrlInvalid")}</p>}
      {/* 批量提示只说一次（验收反馈四轮①：原先在备注与 Bug 链接下各一份）：它说明的是
          整个表单作用于清单里的每一行，不是某个字段的私有说明。 */}
      {!single && <p className="form-note">{t("attribution.batchNoteHint")}</p>}
    </div>
  </Drawer>;
}
