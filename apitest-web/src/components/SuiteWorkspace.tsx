import { useEffect, useMemo, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { api, type SuiteExecutionConfig, type SuiteMemberSnapshot, type SuitePreview, type SuiteSelection, type TestSuite } from "../api";
import { useNavGuardStore } from "../stores/navGuardStore";
import { useLimitsStore } from "../stores/limitsStore";
import { useProjectStore } from "../stores/projectStore";
import { IconButton } from "./IconButton";
import { SuiteMemberPicker } from "./SuiteMemberPicker";

/**
 * 套件配置页 (P2-4)。
 *
 * 三块：选谁（选择方式）、怎么跑（并发 / 失败即停 / 环境）、会跑到谁（预览）。
 * 预览是这一页的关键：标签与全部是**动态选择**，成员随项目里的用例和流程变化，
 * 不给一个「现在会跑这些」的答案，用户只能靠运行一次来试。
 *
 * 运行入口与运行记录侧栏随 P2-4.3 加上。
 */

/**
 * 手动成员在页面上带着快照走：加进来就能显示名字，不必为一个列表再回查一次。
 *
 * `missing` 是被删掉的用例/流程留下的引用。它必须**留在列表里**（而不是解析不到就
 * 悄悄消失）：列表是重建 `selection.members` 的依据，一旦少了一行，用户下次随便加一个
 * 成员就会把那条引用一起删掉，而他从未同意过。
 */
type DraftMember = SuiteMemberSnapshot & { missing?: boolean };

type Draft = {
  name: string;
  description: string;
  tags: string[];
  selection: SuiteSelection;
  execution: SuiteExecutionConfig;
  /** manual 选择时的成员快照，与 selection.members 严格一一对应、同序。 */
  members: DraftMember[];
};

/**
 * 比较用的稳定序列化。
 *
 * 直接 `JSON.stringify` 比不出「有没有改」：键的书写顺序不同就会得到不同的字符串，
 * 于是页面上什么都没动、或者刚存完，也会一直挂着「未保存」。名字两端空格同样按无差异
 * 处理——保存时是 trim 过的，比较时不 trim 就永远对不上。
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return typeof value === "string" ? value.trim() : value;
}

export function SuiteWorkspace() {
  const { t } = useTranslation();
  const { projectId, suiteId } = useParams();
  const { environments } = useProjectStore();
  const setGuard = useNavGuardStore((state) => state.setGuard);
  /**
   * 成员并发的上限 = 服务端两条约束里更严的那个：保护性硬上限 `SUITE_MAX_CONCURRENCY`
   * 与共享令牌预算 `SUITE_LEAF_BUDGET`（后者是环境变量）。`C ≤ 池容量` 是「每个在跑的
   * 成员至少拿得到一枚令牌、一定有进展」的依据，所以两者都不能越过。
   */
  const concurrencyMax = useLimitsStore((state) => Math.min(state.limits.suiteMaxConcurrency, state.limits.suiteLeafBudget));

  const [suite, setSuite] = useState<TestSuite>();
  const [draft, setDraft] = useState<Draft>();
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [preview, setPreview] = useState<SuitePreview>();
  const [previewing, setPreviewing] = useState(false);
  /** 项目里已用过的标签，给两处标签框做建议。服务端 DISTINCT，不从分页数据里凑。 */
  const [memberTags, setMemberTags] = useState<string[]>([]);
  const [suiteTags, setSuiteTags] = useState<string[]>([]);

  useEffect(() => {
    if (!projectId) return;
    void api.projectTags(projectId, "members").then(setMemberTags).catch(() => setMemberTags([]));
    void api.projectTags(projectId, "suites").then(setSuiteTags).catch(() => setSuiteTags([]));
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !suiteId) return;
    void api.testSuite(projectId, suiteId)
      .then(async (loaded) => {
        setSuite(loaded);
        /* manual 成员只存了引用，名字要靠一次解析补齐——preview 正是干这个的，
           所以打开页面就用它，而不是再写一条「只取名字」的接口。解析不到的引用按
           声明顺序留成 missing 行，列表与 selection.members 因此始终等长同序。 */
        let members: DraftMember[] = [];
        if (loaded.selection.type === "manual" && loaded.selection.members.length) {
          const refs = loaded.selection.members;
          try {
            const resolved = await api.previewSuite(projectId, suiteId);
            const found = new Map(resolved.members.map((member) => [`${member.type}:${member.id}`, member]));
            members = refs.map((ref) => found.get(`${ref.type}:${ref.id}`) ?? { ...ref, name: ref.id, missing: true });
          } catch {
            /* 解析失败时不假装成员不存在：先显示引用本身，用户仍能看到有几个成员。 */
            members = refs.map((ref) => ({ ...ref, name: ref.id, missing: true }));
          }
        }
        setDraft({
          name: loaded.name, description: loaded.description, tags: loaded.tags,
          selection: loaded.selection, execution: loaded.execution, members,
        });
      })
      .catch(() => message.error(t("suites.loadFailed")));
  }, [projectId, suiteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => {
    if (!suite || !draft) return false;
    const compare = (source: { name: string; description: string; tags: string[]; selection: SuiteSelection; execution: SuiteExecutionConfig }) =>
      JSON.stringify(canonical({ name: source.name, description: source.description, tags: source.tags, selection: source.selection, execution: source.execution }));
    return compare(suite) !== compare(draft);
  }, [suite, draft]);

  /* 侧栏对这一页一无所知，所以离开提示在这里注册——与流程/接口编辑器同一套安排。 */
  useEffect(() => {
    if (!dirty) { setGuard(null); return; }
    setGuard(() => new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: t("editor.discardTitle"), content: t("editor.discardHint"),
        okText: t("editor.discard"), cancelText: t("action.cancel"),
        onOk: () => resolve(true), onCancel: () => resolve(false),
      });
    }));
    return () => setGuard(null);
  }, [dirty, setGuard, t]);

  if (!draft) return <main className="content"><p className="muted">{t("filter.searching")}</p></main>;

  function patch(next: Partial<Draft>) { setDraft((current) => (current ? { ...current, ...next } : current)); }

  /** 切换选择方式时整块换掉配置：把旧的 tags 留在里面，保存后读出来形状对不上。 */
  function changeSelectionType(type: SuiteSelection["type"]) {
    const previous = draft!.selection;
    if (previous.type === type) return;
    /* 预览描述的是上一种选择方式，换了就必须收起，否则它会看起来像新方式的答案。 */
    setPreview(undefined);
    const includeCases = previous.type === "manual" ? true : previous.includeCases;
    const includeFlows = previous.type === "manual" ? true : previous.includeFlows;
    if (type === "manual") { patch({ selection: { type: "manual", members: draft!.members.map((member) => ({ type: member.type, id: member.id })) } }); return; }
    if (type === "tag") { patch({ selection: { type: "tag", tags: previous.type === "tag" ? previous.tags : [], match: "any", includeCases, includeFlows } }); return; }
    patch({ selection: { type: "all", includeCases, includeFlows } });
  }

  function addMembers(added: SuiteMemberSnapshot[]) {
    const members = [...draft!.members, ...added];
    patch({ members, selection: { type: "manual", members: members.map((member) => ({ type: member.type, id: member.id })) } });
  }

  function removeMember(index: number) {
    const members = draft!.members.filter((_, position) => position !== index);
    patch({ members, selection: { type: "manual", members: members.map((member) => ({ type: member.type, id: member.id })) } });
  }

  /**
   * 成员范围开关。
   *
   * 每个分支显式重建整个 selection，而不是 `{ ...selection, includeCases }`：
   * 在被收窄成联合类型的值上做展开，得到的是「联合的展开」，与判别联合的赋值目标经常
   * 对不上；写全字面量反而更短也更稳。
   */
  function setInclude(next: { includeCases?: boolean; includeFlows?: boolean }) {
    const current = draft!.selection;
    if (current.type === "manual") return;
    setPreview(undefined);
    const includeCases = next.includeCases ?? current.includeCases;
    const includeFlows = next.includeFlows ?? current.includeFlows;
    patch({
      selection: current.type === "tag"
        ? { type: "tag", tags: current.tags, match: current.match, includeCases, includeFlows }
        : { type: "all", includeCases, includeFlows },
    });
  }

  async function save() {
    if (!projectId || !suiteId || !draft.name.trim()) return;
    setSaving(true);
    try {
      const saved = await api.updateTestSuite(projectId, suiteId, {
        name: draft.name.trim(), description: draft.description, tags: draft.tags,
        selection: draft.selection, execution: draft.execution,
      });
      setSuite(saved);
      /* 用服务端存下来的那份回填草稿：它才是「现在库里是什么」。少了这一步，任何一处
         规范化（trim、标签去空、environmentId 被清掉）都会让页面继续显示「未保存」，
         而用户明明刚看到保存成功。 */
      setDraft((current) => (current ? {
        ...current,
        name: saved.name, description: saved.description, tags: saved.tags,
        selection: saved.selection, execution: saved.execution,
      } : current));
      message.success(t("suites.saved"));
    } catch (error) {
      message.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t("suites.saveFailed"));
    } finally { setSaving(false); }
  }

  /* 预览未保存的这份配置：改一下就看一眼，不必先保存才知道会跑到谁。 */
  async function runPreview() {
    if (!projectId || !suiteId) return;
    setPreviewing(true);
    try { setPreview(await api.previewSuite(projectId, suiteId, draft.selection)); }
    catch (error) {
      message.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t("suites.previewFailed"));
    } finally { setPreviewing(false); }
  }

  const selection = draft.selection;
  const includeInvalid = selection.type !== "manual" && !selection.includeCases && !selection.includeFlows;

  return <main className="content">
    <div className="page-head">
      <div>
        <h1>{draft.name || t("suites.title")}</h1>
        <p>{selection.type === "manual" ? t("suites.selectionHintManual") : selection.type === "tag" ? t("suites.selectionHintTag") : t("suites.selectionHintAll")}</p>
      </div>
      <div className="topbar-actions">
        {dirty && <span className="mono muted">{t("editor.unsaved")}</span>}
        {/* 「解析成员」放在选择条件旁边，不放这里：它回答的是那几个条件命中了谁，
            离开条件就没有语境。手动选择根本不需要它——成员清单就在下面。 */}
        <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !draft.name.trim() || includeInvalid}>{t("action.save")}</button>
      </div>
    </div>

    <section className="panel">
      <div className="panel-head"><strong>{t("suites.basics")}</strong></div>
      <div className="panel-body">
        <label className="field">
          <span>{t("suites.name")}</span>
          <input className="input" value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder={t("suites.namePlaceholder")} />
        </label>
        <label className="field">
          <span>{t("suites.description")}</span>
          <input className="input" value={draft.description} onChange={(event) => patch({ description: event.target.value })} />
        </label>
        <label className="field">
          <span>{t("suites.tags")}</span>
          <Select
            mode="tags" value={draft.tags} onChange={(tags: string[]) => patch({ tags })}
            /* 已有标签作为建议，同时仍然允许输入新的（mode="tags" 的语义）。 */
            options={suiteTags.map((tag) => ({ value: tag, label: tag }))}
            placeholder={t("suites.tagsPlaceholder")} style={{ width: "100%" }} tokenSeparators={[","]}
          />
        </label>
      </div>
    </section>

    <section className="panel">
      <div className="panel-head">
        <strong>{t("suites.selection")}</strong>
        <div className="segmented">
          {(["manual", "tag", "all"] as const).map((type) => <button
            key={type}
            className={`segmented-item${selection.type === type ? " is-active" : ""}`}
            onClick={() => changeSelectionType(type)}
          >
            {type === "manual" ? t("suites.selectionManual") : type === "tag" ? t("suites.selectionTag") : t("suites.selectionAll")}
          </button>)}
        </div>
      </div>
      <div className="panel-body">
        {selection.type === "manual" ? <>
          <div className="filter-bar">
            <span className="mono muted">{t("suites.memberCount", { count: draft.members.length })}</span>
            <span className="filter-spacer" />
            <button className="btn btn-small btn-with-icon" onClick={() => setPicking(true)}><Plus size={14} />{t("suites.addMembers")}</button>
          </div>
          {draft.members.length ? <table className="grid picker-grid">
            <tbody>
              {draft.members.map((member, index) => <tr key={`${member.type}:${member.id}`}>
                <td className="suite-col-kind mono muted">{member.type === "case" ? t("suites.memberTypeCase") : t("suites.memberTypeFlow")}</td>
                <td><span className="truncate">{member.name}</span></td>
                <td className="mono muted truncate">{member.missing ? t("suites.memberMissing") : member.endpointName ?? member.environmentName ?? ""}</td>
                <td className="col-actions">
                  <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => removeMember(index)} />
                </td>
              </tr>)}
            </tbody>
          </table> : <p className="muted">{t("suites.membersEmpty")}</p>}
        </> : <>
          {selection.type === "tag" && <>
            <label className="field">
              <span>{t("suites.tags")}</span>
              <Select
                mode="tags" value={selection.tags}
                onChange={(tags: string[]) => { setPreview(undefined); patch({ selection: { type: "tag", tags, match: selection.match, includeCases: selection.includeCases, includeFlows: selection.includeFlows } }); }}
                /* 建议来自用例与流程已用过的标签——「按标签」匹配的正是这两者。 */
                options={memberTags.map((tag) => ({ value: tag, label: tag }))}
                placeholder={t("suites.tagsPlaceholder")} style={{ width: "100%" }} tokenSeparators={[","]}
              />
            </label>
            <label className="field">
              <span>{t("suites.tagMatch")}</span>
              <Select
                value={selection.match}
                onChange={(match: "any" | "all") => { setPreview(undefined); patch({ selection: { type: "tag", tags: selection.tags, match, includeCases: selection.includeCases, includeFlows: selection.includeFlows } }); }}
                options={[{ value: "any", label: t("suites.matchAny") }, { value: "all", label: t("suites.matchAll") }]}
                style={{ width: 220 }}
              />
            </label>
          </>}
          <div className="field">
            <span>{t("suites.include")}</span>
            <div className="check-row">
              <label className="check-field">
                <input type="checkbox" checked={selection.includeCases} onChange={(event) => setInclude({ includeCases: event.target.checked })} />
                {t("suites.includeCases")}
              </label>
              <label className="check-field">
                <input type="checkbox" checked={selection.includeFlows} onChange={(event) => setInclude({ includeFlows: event.target.checked })} />
                {t("suites.includeFlows")}
              </label>
            </div>
          </div>
          {includeInvalid && <p className="form-error">{t("suites.includeRequired")}</p>}
          {/*
            解析结果就地展开在条件下面。
            它回答的是「上面这几个条件命中了谁」——隔着别的面板放在页面末尾，用户点完按钮
            只看到一个数字，清单在两屏之外，等于没给出答案。
          */}
          <div className="filter-bar">
            <span className="mono muted">{preview ? t("suites.previewTotal", { total: preview.total }) : t("suites.previewIdle")}</span>
            <span className="filter-spacer" />
            <button className="btn btn-small" onClick={() => void runPreview()} disabled={previewing || includeInvalid}>{t("suites.preview")}</button>
          </div>
          <p className="form-note">{t("suites.previewHint")}</p>
          {preview && <>
            {/* 超上限、引用悬空都摊开说：运行会被拒绝，而不是静默截断到 200 个。 */}
            {preview.total > preview.memberLimit && <p className="form-error">{t("suites.overLimit", { total: preview.total, limit: preview.memberLimit })}</p>}
            {preview.missing.length > 0 && <p className="form-error">{t("suites.previewMissing", { count: preview.missing.length })}</p>}
            {preview.members.length ? <table className="grid picker-grid">
              <tbody>
                {preview.members.map((member) => <tr key={`${member.type}:${member.id}`}>
                  <td className="suite-col-kind mono muted">{member.type === "case" ? t("suites.memberTypeCase") : t("suites.memberTypeFlow")}</td>
                  <td><span className="truncate">{member.name}</span></td>
                  <td className="mono muted truncate">{member.endpointName ?? member.environmentName ?? ""}</td>
                </tr>)}
              </tbody>
            </table> : <p className="muted">{t("suites.previewEmpty")}</p>}
          </>}
        </>}
      </div>
    </section>

    <section className="panel">
      <div className="panel-head"><strong>{t("suites.execution")}</strong></div>
      <div className="panel-body">
        <label className="field">
          <span>{t("suites.concurrency")}</span>
          <input
            className="input mono" type="number" min={1} max={concurrencyMax} value={draft.execution.concurrency}
            onChange={(event) => patch({ execution: { ...draft.execution, concurrency: Math.min(concurrencyMax, Math.max(1, Number(event.target.value) || 1)) } })}
            style={{ width: 110 }}
          />
        </label>
        {/* 说清这里不是「几个请求同时在飞」：那个数由平台预算封顶，写大了也不会突破。 */}
        <p className="form-note">{t("suites.concurrencyHint", { max: concurrencyMax })}</p>
        <label className="check-field">
          <input type="checkbox" checked={draft.execution.failFast} onChange={(event) => patch({ execution: { ...draft.execution, failFast: event.target.checked } })} />
          {t("suites.failFast")}
        </label>
        <p className="form-note">{t("suites.failFastHint")}</p>
        <label className="field">
          <span>{t("suites.environmentStrategy")}</span>
          <Select
            value={draft.execution.environmentStrategy}
            onChange={(environmentStrategy: SuiteExecutionConfig["environmentStrategy"]) => patch({
              execution: { ...draft.execution, environmentStrategy, environmentId: environmentStrategy === "override" ? draft.execution.environmentId : undefined },
            })}
            options={[{ value: "member_default", label: t("suites.envMemberDefault") }, { value: "override", label: t("suites.envOverride") }]}
            style={{ width: 220 }}
          />
        </label>
        {draft.execution.environmentStrategy === "override" && <label className="field">
          <span>{t("suites.pickEnvironment")}</span>
          <Select
            value={draft.execution.environmentId}
            onChange={(environmentId: string) => patch({ execution: { ...draft.execution, environmentId } })}
            options={environments.map((item) => ({ value: item.id, label: item.name }))}
            placeholder={t("suites.pickEnvironment")}
            style={{ width: 260 }}
          />
        </label>}
      </div>
    </section>

    <SuiteMemberPicker
      projectId={projectId!}
      open={picking}
      existing={draft.members.map((member) => ({ type: member.type, id: member.id }))}
      onClose={() => setPicking(false)}
      onAdd={addMembers}
    />
  </main>;
}
