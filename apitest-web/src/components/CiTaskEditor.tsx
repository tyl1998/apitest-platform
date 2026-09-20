import { useCallback, useEffect, useMemo, useState } from "react";
import { AutoComplete, Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { History, Plus } from "lucide-react";
import { api, type CiTask, type CiTaskInput, type GitCredential, type NotificationChannel, type RunnerPool, type SuiteNotifyConfig } from "../api";
import { KeyValueEditor, fromPairs, toPairs, type Pair } from "./KeyValueEditor";
import { ShellCodeEditor } from "./ShellCodeEditor";
import { ResourceSchedules } from "./ResourceSchedules";
import { GitCredentialModal } from "./GitCredentialModal";
import { VersionHistoryDrawer } from "./VersionHistoryDrawer";
import { apiMessage } from "./DataSourceList";
import { RepoPageHead, RepoTabs } from "./RepoShell";
import { PageToolbar } from "../ui";
import { useThemeMode } from "../theme";
import { useCanWrite } from "../hooks/useMyRole";
import { usePageContext } from "../hooks/usePageContext";
import { useNavGuardStore } from "../stores/navGuardStore";
import { useProjectStore } from "../stores/projectStore";

/**
 * CI 任务独立编辑页（P4.5-15，8.12 ①；P4.5-11/14 的抽屉形态在此撤销）。
 *
 * 抽屉改独立页的三个前提塌了（8.12）：8 个分区 + 220px 的 Monaco 在 760px 抽屉里一屏
 * 看不到两屏的事；调度面板有自己的列表态、通知面板有渠道选择，「没有子状态」不再成立；
 * 项目里已有整页编辑器先例（`EndpointWorkspace` / `DataSourceDetail` / `SuiteWorkspace`）。
 *
 * 分区顺序（用户验收第 1 点）：名称 → 代码来源 → **环境变量**（写 shell 的前置输入，
 * 先配再写才顺）→ 执行步骤（Monaco）→ 高级折叠区（默认收起，开箱即跑）→ 调度面板 →
 * 通知面板。调度与通知面板是 P4.5-12 落地时就在等待这次搬家的两块——组件不重写，
 * `ResourceSchedules` 与套件详情页共用同一个。
 */

/** 分区标签格式，与服务端 `RUNNER_LABEL_PATTERN` 逐字一致。前端只为当场提示，权威在服务端。 */
const RUNNER_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 超时的界面单位是分钟（交互 3.12.2），协议单位是秒。24 小时对齐服务端上限。 */
const MAX_TIMEOUT_MINUTES = 1440;

/** 平台对应的保存快捷键文案，与套件/流程工作台同一份判断。 */
const SAVE_KEY = navigator.platform.toLowerCase().includes("mac") ? "⌘S" : "Ctrl+S";

/**
 * 报告目录的前端解析，**与服务端 `lib/allureDir.ts` 是同一组模式**。
 *
 * 两份实现刻意并存：服务端那份是权威（它决定 JobSpec 里发什么），这一份只为在用户还在
 * 敲命令时就把结论显示出来——等保存后由服务端回一个 `allureDir` 再显示，提示就迟了一步。
 * 改一处必须改另一处，所以两边的注释互相点名。
 */
const ALLURE_DIR_PATTERNS = [
  /--alluredir[=\s]+("[^"]+"|'[^']+'|[^\s;&|]+)/,
  /\bALLURE_RESULTS_DIR=("[^"]+"|'[^']+'|[^\s;&|]+)/,
];

function parseAllureDir(steps: string): string | null {
  for (const pattern of ALLURE_DIR_PATTERNS) {
    const matched = steps.match(pattern);
    if (!matched) continue;
    let dir = (matched[1] ?? "").trim();
    if (dir.length >= 2 && ((dir.startsWith('"') && dir.endsWith('"')) || (dir.startsWith("'") && dir.endsWith("'")))) {
      dir = dir.slice(1, -1);
    }
    if (!dir || dir.startsWith("/") || dir.startsWith("\\") || dir.split(/[/\\]/).includes("..")) continue;
    return dir;
  }
  return null;
}

/** 路径清单用「一行一条」的文本框：粘一段 CI 配置里的路径列表是最常见的输入方式。 */
function toLines(list: string[]): string {
  return list.join("\n");
}

function fromLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * 模版两栏都空 = 不覆盖（`template` 发 undefined，服务端落默认模版）。
 * 与 `SuiteWorkspace.tsx` 的同名函数逐字相同：清空输入框必须回到「用默认」，而不是写一个
 * 空字符串标题下去——那会让通知的标题真的变成空。
 */
function templateOf(notify: SuiteNotifyConfig, next: { title?: string; body?: string }): SuiteNotifyConfig["template"] {
  const title = next.title ?? notify.template?.title ?? "";
  const body = next.body ?? notify.template?.body ?? "";
  if (!title.trim() && !body.trim()) return undefined;
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
}

export function CiTaskEditor() {
  const { t } = useTranslation();
  const { projectId, taskId } = useParams();
  const navigate = useNavigate();
  const mode = useThemeMode();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();
  /* `/repo/tasks/new` 是静态路由段，`useParams()` 不给 `taskId`（它不是参数）——undefined
     就是「新建」。动态路由 `:taskId` 永远有值（React Router 不匹配空段）。 */
  const isNew = taskId === undefined || taskId === "new";
  /* viewer：保存/保存并触发不渲染（P6-4）——URL 直达编辑页只能看，后端照拒。 */
  const canWrite = useCanWrite();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitCredentialId, setGitCredentialId] = useState<string>();
  const [gitRef, setGitRef] = useState("main");
  const [envPairs, setEnvPairs] = useState<Pair[]>([]);
  const [steps, setSteps] = useState("");
  /* 高级折叠区默认收起（8.12 ①）：默认值开箱即跑，收起时不填也能保存。 */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [runnerLabel, setRunnerLabel] = useState("default");
  const [sandboxMode, setSandboxMode] = useState<"process" | "container">("container");
  const [image, setImage] = useState("");
  const [cachePaths, setCachePaths] = useState("");
  const [cacheKeyFiles, setCacheKeyFiles] = useState("");
  const [sdkIngestEnabled, setSdkIngestEnabled] = useState(true);
  const [singleConcurrency, setSingleConcurrency] = useState(true);
  const [timeoutMinutes, setTimeoutMinutes] = useState(30);
  const [enabled, setEnabled] = useState(true);
  const [notify, setNotify] = useState<SuiteNotifyConfig>({ onSuccess: false, onFailure: false, channelIds: [] });

  const [task, setTask] = useState<CiTask>();
  const [credentials, setCredentials] = useState<GitCredential[]>([]);

  /* 助手页面上下文（P9-4c）：URL 已带 taskId，这里补任务名（title 正在编辑的值优先
     ——用户嘴里说的名字多半是输入框里那个）。 */
  usePageContext(!isNew && taskId ? {
    page: "ci-task-editor",
    entities: {
      taskId,
      ...(name ? { taskName: name } : {}),
    },
  } : undefined);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [pool, setPool] = useState<RunnerPool>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /**
   * 「已保存的表单值」快照，dirty 的对照基准。字段一列列并排比而不是 JSON.stringify
   * 整个对象：env 是对象、notify.template 是嵌套结构，序列化对比会在键序上误报——
   * 基准与草稿都走同一个 canonical 函数才是同类比较（与 SuiteWorkspace 的 compare 同款纪律）。
   */
  const [snapshot, setSnapshot] = useState<string>();
  /** 就地创建 Git 凭据（P4.5-15 验收补充）：空池时不开新页面、不丢任务草稿。 */
  const [credentialEditing, setCredentialEditing] = useState<"new">();
  /**
   * 新建页点「新建调度」的接力棒：任务被静默保存、路由原地切成编辑页之后，调度面板
   * 挂载时读它一次并自动打开新建抽屉（挂载后即被清掉，见下方的 effect）。
   */
  const [armScheduleCreate, setArmScheduleCreate] = useState(false);
  /* 版本历史抽屉（P10-6）：仓库任务的建/改快照，选中两版看改动、可回滚。新建页还没有 taskId。 */
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);

  /* 既有任务：加载后铺表单。列表页 `location.state.task` 不带也行——路由要能刷新、能被
     分享，真实数据源永远是接口。 */
  const load = useCallback(async () => {
    if (!projectId || isNew) { setLoading(false); return; }
    setLoading(true);
    try {
      const source = await api.ciTask(projectId, taskId!);
      setTask(source);
      setName(source.name);
      setDescription(source.description);
      setGitUrl(source.gitUrl);
      setGitCredentialId(source.gitCredentialId);
      setGitRef(source.gitRef);
      setEnvPairs(toPairs(source.env));
      setSteps(source.steps);
      setRunnerLabel(source.runnerLabel);
      setSandboxMode(source.sandboxMode);
      setImage(source.image);
      setCachePaths(toLines(source.cachePaths));
      setCacheKeyFiles(toLines(source.cacheKeyFiles));
      setSdkIngestEnabled(source.sdkIngestEnabled);
      setSingleConcurrency(source.singleConcurrency);
      setTimeoutMinutes(Math.max(1, Math.round(source.timeoutSeconds / 60)));
      setEnabled(source.enabled);
      setNotify(source.notify);
      /* dirty 基准在铺完表单后签：字段 setState 是异步的，直接在这里算会读到旧 state。
         用 source 的值按 formCanonical 的同一组字段组一份，保证同类比较。 */
      setSnapshot(JSON.stringify({
        name: source.name.trim(), description: source.description.trim(),
        gitUrl: source.gitUrl.trim(), gitCredentialId: source.gitCredentialId ?? null,
        gitRef: (source.gitRef || "main").trim(), runnerLabel: (source.runnerLabel || "default").trim(),
        sandboxMode: source.sandboxMode, image: source.image.trim(), steps: source.steps,
        env: source.env, cachePaths: source.cachePaths, cacheKeyFiles: source.cacheKeyFiles,
        sdkIngestEnabled: source.sdkIngestEnabled, singleConcurrency: source.singleConcurrency,
        timeoutMinutes: Math.max(1, Math.round(source.timeoutSeconds / 60)), enabled: source.enabled, notify: source.notify,
      }));
    } catch {
      message.error(t("ciTasks.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId, taskId, isNew, t]);

  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    void load();
  }, [projectId, loadedProjectId, projectLoading, load]);

  /* 凭据池 / 渠道 / Runner 池是本页三块面板的数据源。拉失败读成空：各自面板里那句
     「还没有凭据 / 通知发不出去」在真的为空时也成立，不会误导。池状态同列表页一刷
     （10s）：编辑页停留时间长，标签无在线 Runner 的提示不能停留在十分钟前。 */
  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    void api.gitCredentials(projectId).then(setCredentials).catch(() => setCredentials([]));
    void api.notificationChannels(projectId).then(setChannels).catch(() => setChannels([]));
  }, [projectId, loadedProjectId, projectLoading]);

  useEffect(() => {
    let alive = true;
    const tick = () => api.runnerPool().then((next) => { if (alive) setPool(next); }).catch(() => {});
    void tick();
    const timer = setInterval(() => void tick(), 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  /* 分区候选来自 Runner 池（不是 worker 分区目录——CI 触发只看 runners 表）。允许自由
     输入：标签可以先于 Runner 存在，输入框不能只让选已注册的。 */
  const labelChoices = (pool?.labels ?? []).map((each) => ({
    value: each.label,
    label: <span className="mono">{each.label}{each.online > 0
      ? <span className="muted"> · {t("ciTasks.poolOnlineCount", { count: each.online, total: each.total })}</span>
      : <span className="muted"> · {t("ciTasks.poolNone")}</span>}</span>,
  }));
  const labelHasNoRunner = Boolean(pool && runnerLabel.trim()
    && pool.labels.some((each) => each.label === runnerLabel.trim() && each.online === 0));

  /**
   * 当前表单的 canonical 形态——与 `snapshot` 同一个函数序列化，同类比较才不会在
   * 键序 / undefined vs 缺键上误报。新建页（无快照）**不算脏**：还没有「未保存的修改」
   * 这个概念，离开提示对新建页只会在填了一半时出现——那正是要提示的时刻，但基准是
   * 空表单而不是 undefined。
   */
  const formCanonical = useCallback(() => JSON.stringify({
    name: name.trim(), description: description.trim(),
    gitUrl: gitUrl.trim(), gitCredentialId: gitCredentialId ?? null,
    gitRef: gitRef.trim() || "main", runnerLabel: runnerLabel.trim() || "default",
    sandboxMode, image: image.trim(), steps,
    env: fromPairs(envPairs), cachePaths: fromLines(cachePaths), cacheKeyFiles: fromLines(cacheKeyFiles),
    sdkIngestEnabled, singleConcurrency, timeoutMinutes, enabled, notify,
  }), [name, description, gitUrl, gitCredentialId, gitRef, runnerLabel, sandboxMode, image, steps,
    envPairs, cachePaths, cacheKeyFiles, sdkIngestEnabled, singleConcurrency, timeoutMinutes, enabled, notify]);

  const dirty = useMemo(() => snapshot !== undefined && snapshot !== formCanonical(), [snapshot, formCanonical]);

  const setGuard = useNavGuardStore((state) => state.setGuard);

  /* 离开提示（与套件编辑同一套安排）：侧栏对这一页一无所知，guard 在这里注册。保存成功
     会 navigate 走人（guard 随卸载清掉）；「新建调度」的原地路由切换在 armSchedules 里
     显式清 guard——那一次是静默保存后的合法跳转，不该再弹确认。 */
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

  function buildInput(): CiTaskInput | undefined {
    const trimmedName = name.trim();
    if (!trimmedName) { message.error(t("ciTasks.nameRequired")); return undefined; }
    if (!gitUrl.trim()) { message.error(t("ciTasks.gitUrlRequired")); return undefined; }
    if (!steps.trim()) { message.error(t("ciTasks.stepsRequired")); return undefined; }
    const label = runnerLabel.trim() || "default";
    if (!RUNNER_LABEL_PATTERN.test(label)) { message.error(t("ciTasks.labelInvalid")); return undefined; }
    if (sandboxMode === "container" && !image.trim()) { message.error(t("ciTasks.imageRequired")); return undefined; }
    if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > MAX_TIMEOUT_MINUTES) {
      message.error(t("ciTasks.timeoutInvalid", { max: MAX_TIMEOUT_MINUTES })); return undefined;
    }

    return {
      name: trimmedName,
      description: description.trim(),
      gitUrl: gitUrl.trim(),
      /* `null` 是显式的「公开仓库、不用凭据」；服务端把 undefined 读成「不动」，所以
         清空选择必须发 null 而不是省略。 */
      gitCredentialId: gitCredentialId ?? null,
      gitRef: gitRef.trim() || "main",
      runnerLabel: label,
      sandboxMode,
      image: image.trim(),
      steps,
      env: fromPairs(envPairs),
      cachePaths: fromLines(cachePaths),
      cacheKeyFiles: fromLines(cacheKeyFiles),
      sdkIngestEnabled,
      notify,
      singleConcurrency,
      timeoutSeconds: timeoutMinutes * 60,
      enabled,
    };
  }

  async function save(thenRun: boolean) {
    if (!projectId) return;
    const input = buildInput();
    if (!input) return;
    setSaving(true);
    try {
      const saved = isNew
        ? await api.createCiTask(projectId, input)
        : await api.updateCiTask(projectId, taskId!, input);
      message.success(t(isNew ? "ciTasks.created" : "ciTasks.updated"));
      /* 保存即落定：dirty 失效，navigate 走人（guard 随卸载清掉，不会再弹确认）。 */
      setSnapshot(formCanonical());
      if (thenRun) {
        /* 「保存并执行」直达 run 详情页（P4.5-11 起的语义，随路由化原样保留）。 */
        const created = await api.triggerCiTask(projectId, saved.id, { idempotencyKey: crypto.randomUUID() });
        message.success(t("ciTasks.triggered", { number: created.runNumber }));
        navigate(`/projects/${projectId}/pipeline-runs/${created.id}`);
        return;
      }
      navigate(`/projects/${projectId}/repo`);
    } catch (error) {
      const label = thenRun ? noRunnerLabelOf(error) : undefined;
      message.error(label !== undefined ? t("ciTasks.noRunner", { label }) : apiMessage(error) ?? t("ciTasks.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function noRunnerLabelOf(error: unknown): string | undefined {
    const body = (error as { response?: { data?: { code?: number; data?: { label?: string } } } })?.response?.data;
    return body?.code === 2004 ? body.data?.label : undefined;
  }

  /**
   * 新建页的「新建调度」（2026-09-02 验收补充）：调度行需要一个已存在的任务 id 作目标，
   * 所以先把当前表单**静默保存**（必填校验与「保存」完全同一条——缺什么就提示什么），
   * 再把路由原地切成编辑页（同组件同位置，表单状态不丢），调度面板随真实 targetId
   * 挂载并自动打开新建抽屉。
   */
  async function armSchedules() {
    if (!projectId) return;
    const input = buildInput();
    if (!input) return;
    setSaving(true);
    try {
      const saved = await api.createCiTask(projectId, input);
      message.success(t("ciTasks.created"));
      /* 静默保存已完成：dirty 失效 + guard 清掉——原地路由切换是合法跳转，不该弹确认。 */
      setSnapshot(formCanonical());
      setGuard(null);
      setArmScheduleCreate(true);
      navigate(`/projects/${projectId}/repo/tasks/${saved.id}`, { replace: true });
    } catch (error) {
      message.error(apiMessage(error) ?? t("ciTasks.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  /* armed 只驱动调度面板挂载的那一次：面板挂载（task 就绪）即清，之后的重渲染不会
     再开抽屉。effect 在子组件挂载 effect 之后跑，ref 里已固定初值，无竞态。 */
  useEffect(() => { if (armScheduleCreate && task) setArmScheduleCreate(false); }, [armScheduleCreate, task]);

  /* Cmd/Ctrl+S（与套件/流程工作台同一份纪律）：拦掉浏览器自己的保存对话框；dirty 才
     触发，避免「没改动按保存」白跑一次校验报错。 */
  useEffect(() => {
    function handleSaveKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (canWrite && dirty && !saving) void save(false);
    }
    window.addEventListener("keydown", handleSaveKey);
    return () => window.removeEventListener("keydown", handleSaveKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWrite, dirty, saving, projectId, taskId, isNew, name, description, gitUrl, gitCredentialId, gitRef,
    runnerLabel, sandboxMode, image, steps, envPairs, cachePaths, cacheKeyFiles, sdkIngestEnabled,
    singleConcurrency, timeoutMinutes, enabled, notify]);

  if (loading && !isNew) return <main className="content"><p className="muted">{t("common.loading")}</p></main>;

  return <main className="content content-split">
    <PageToolbar>
    <RepoPageHead
      title={<span className="title-row">
        {isNew ? t("ciTasks.create") : (name || t("ciTasks.editTitle"))}
        {/* 与套件工作台同款提示：警告色 chip 并带上保存快捷键——「按什么能存」出现在
            「有改动」的同一眼位置。 */}
        {dirty && <span className="chip chip-warn">{t("editor.unsavedShortcut", { key: SAVE_KEY })}</span>}
      </span>}
      hint={t("ciTasks.hint")}
      actions={<>
        <button className="btn" onClick={() => navigate(`/projects/${projectId}/repo`)}>{t("action.cancel")}</button>
        {!isNew && taskId && <button className="btn btn-with-icon" onClick={() => setVersionHistoryOpen(true)}><History size={14} />{t("version.history")}</button>}
        {canWrite && <button className="btn" disabled={saving} onClick={() => void save(true)}>{t("ciTasks.saveAndRun")}</button>}
        {canWrite && <button className="btn btn-primary" disabled={saving} onClick={() => void save(false)}>{saving ? "…" : t("action.save")}</button>}
      </>}
    />
    <RepoTabs active="tasks" />
    </PageToolbar>

    <div className="list-card">
    <div className="list-scroll">
    <div>
      <section className="panel" style={{ marginTop: 0 }}>
        <div className="panel-head"><strong>{t("ciTasks.basics")}</strong></div>
        <div className="panel-body form-grid">
          <label className="field"><span>{t("ciTasks.name")}</span>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("ciTasks.namePlaceholder")} autoFocus />
          </label>
          <label className="field"><span>{t("ciTasks.description")}</span>
            <input className="input" value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
        </div>
      </section>

      {/* 代码来源（P4.5-14）：地址在任务上、凭据从项目级池子里选。 */}
      <section className="panel">
        <div className="panel-head"><strong>{t("ciTasks.codeSource")}</strong></div>
        <div className="panel-body">
          <div className="form-grid">
            <label className="field field-wide"><span>{t("ciTasks.gitUrl")}</span>
              <input className="input mono" value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} placeholder="https://gitlab.example.com/team/api-tests.git" spellCheck={false} />
            </label>
            <label className="field"><span>{t("ciTasks.gitCredential")}</span>
              <Select
                value={gitCredentialId ?? ""}
                onChange={(value) => setGitCredentialId(value || undefined)}
                options={[
                  /* 空选项是「公开仓库」，不是「还没选」：不带凭据 clone 是一个合法且常见的
                     答案，把它做成一个可选项比做成一个必填项的例外要诚实。 */
                  { value: "", label: t("ciTasks.gitCredentialNone") },
                  ...credentials.map((each) => ({
                    value: each.id,
                    label: `${each.name} · ${t(`repoCases.credentialMethodValue.${each.method}`)}`,
                  })),
                ]}
                style={{ width: "100%" }}
              />
            </label>
            <label className="field"><span>{t("ciTasks.gitRef")}</span>
              <input className="input mono" value={gitRef} onChange={(event) => setGitRef(event.target.value)} placeholder="main" />
            </label>
          </div>
          {!credentials.length && <p className="form-note">
            {t("ciTasks.noCredentialPool")}
            {canWrite && <button className="btn btn-small" style={{ marginLeft: "var(--s3)" }} onClick={() => setCredentialEditing("new")}>
              {t("repoCases.credentialCreate")}
            </button>}
          </p>}
        </div>
      </section>

      {/* 环境变量上移到步骤之前（8.12 ①，用户第 1 点）：写 shell 的前置输入，先配再写才顺。 */}
      <div style={{ marginTop: "var(--s5)" }}>
        <KeyValueEditor
          title={t("ciTasks.env")}
          hint={t("ciTasks.envHint")}
          pairs={envPairs}
          onChange={setEnvPairs}
          keyPlaceholder="BASE_URL"
        />
      </div>

      <section className="panel">
        <div className="panel-head"><strong>{t("ciTasks.steps")}</strong></div>
        <div className="panel-body">
          <p className="form-note">{t("ciTasks.stepsHint")}</p>
          {/* Monaco + shell 高亮（P4.5-14 反馈 3），**不做补全**：脚本节点那边补的是平台自己的
              `ctx` 契约，shell 命令没有等价物，硬做只能补一堆猜的 pytest 参数。 */}
          <ShellCodeEditor value={steps} onChange={setSteps} height="220px" theme={mode === "dark" ? "vs-dark" : "light"} />
          {/* 报告目录是从上面这段命令里解析出来的，不是一个独立输入框（P4.5-14 反馈 7）。 */}
          <p className={parseAllureDir(steps) ? "form-note" : "form-error"}>
            {(() => { const dir = parseAllureDir(steps); return dir ? t("ciTasks.allureDirFound", { dir }) : t("ciTasks.allureDirMissing"); })()}
          </p>
        </div>
      </section>
    </div>

    {/* 高级折叠区（8.12 ①）：默认收起、默认值开箱即跑——收起时不填也能保存。
        运行时档位 / Runner 标签 / 镜像 / 串行 / 缓存 / 报告上报 / 超时与启用全在这里。 */}
    <details className="panel advanced-panel" open={advancedOpen} onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}>
      <summary className="advanced-summary">
        <strong>{t("ciTasks.advanced")}</strong>
        <span className="muted">{t("ciTasks.advCollapsedHint")}</span>
      </summary>
      <div className="panel-body">
        <div className="form-grid">
          <label className="field"><span>{t("ciTasks.sandboxMode")}</span>
            <Select
              value={sandboxMode}
              onChange={(value) => setSandboxMode(value)}
              options={[
                { value: "container", label: t("ciTasks.sandboxContainer") },
                { value: "process", label: t("ciTasks.sandboxProcess") },
              ]}
              style={{ width: "100%" }}
            />
          </label>
          <label className="field"><span>{t("ciTasks.runnerLabel")}</span>
            <AutoComplete value={runnerLabel} onChange={setRunnerLabel} options={labelChoices} style={{ width: "100%" }} placeholder="default" />
          </label>
          {sandboxMode === "container" && <label className="field field-wide"><span>{t("ciTasks.image")}</span>
            <input className="input mono" value={image} onChange={(event) => setImage(event.target.value)} placeholder="python:3.11-slim" />
          </label>}
        </div>
        {/* 进程档是一个**信任声明**而不是「轻量模式」（边界 15）：选它等于声明信任这个仓库
            里的任意脚本，因为没有文件系统与网络隔离，而那台机器上有平台下发的 clone 凭据。 */}
        <p className={sandboxMode === "process" ? "form-error" : "form-note"}>
          {sandboxMode === "process" ? t("ciTasks.sandboxProcessWarning") : t("ciTasks.sandboxContainerHint")}
        </p>
        <p className="form-note">{t("ciTasks.workspaceNote")}</p>
        {labelHasNoRunner && <p className="form-error">{t("ciTasks.labelNoRunner", { label: runnerLabel.trim() })}</p>}

        <div className="form-grid">
          <label className="field"><span>{t("ciTasks.cachePaths")}</span>
            <textarea className="input kv-text" style={{ minHeight: 80 }} value={cachePaths} onChange={(event) => setCachePaths(event.target.value)} spellCheck={false} placeholder={".venv\n.cache/pip"} />
          </label>
          <label className="field"><span>{t("ciTasks.cacheKeyFiles")}</span>
            <textarea className="input kv-text" style={{ minHeight: 80 }} value={cacheKeyFiles} onChange={(event) => setCacheKeyFiles(event.target.value)} spellCheck={false} placeholder="requirements.txt" />
          </label>
        </div>
        <p className="form-note">{t("ciTasks.cacheHint")}</p>

        <label className="check-field">
          <input type="checkbox" checked={sdkIngestEnabled} onChange={(event) => setSdkIngestEnabled(event.target.checked)} />
          {t("ciTasks.sdkIngest")}
        </label>
        <p className="form-note">{t("ciTasks.sdkIngestHint")}</p>

        <label className="field"><span>{t("ciTasks.timeout")}</span>
          <input className="input mono" type="number" min={1} max={MAX_TIMEOUT_MINUTES} value={timeoutMinutes} onChange={(event) => setTimeoutMinutes(Number(event.target.value))} />
        </label>

        {/* 串行执行（P4.5-12）：默认开。语义是排队不是拒绝——触发照常受理，只是要等前一条
            跑完。关掉它意味着声明「这个仓库的用例并发跑两遍互不干扰」。 */}
        <label className="check-field">
          <input type="checkbox" checked={singleConcurrency} onChange={(event) => setSingleConcurrency(event.target.checked)} />
          {t("ciTasks.singleConcurrency")}
        </label>
        <p className="form-note">{t(singleConcurrency ? "ciTasks.singleConcurrencyHint" : "ciTasks.singleConcurrencyOffHint")}</p>

        {/* 停用是「保留执行历史的封存」（删除会级联掉全部 run；停用只是拒绝新触发，
            通知与历史都还在）。删除确认框里那句「要留历史就停用」指的就是这个勾。 */}
        <label className="check-field">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          {t("ciTasks.enabled")}
        </label>
        <p className="form-note">{t("ciTasks.enabledHint")}</p>
      </div>
    </details>

    {/* 调度面板：编辑页挂真面板；新建页挂同形状的占位（点「新建调度」先静默保存再接力）。
        调度行需要已存在的任务 id 作目标——占位面板把这条限制说成一句话，而不是让按钮
        无解释地消失。 */}
    {isNew && projectId && <section className="panel">
      <div className="panel-head">
        <strong>{t("schedules.title")}</strong>
        <div className="topbar-actions">
          {canWrite && <button className="btn btn-small btn-with-icon" disabled={saving} onClick={() => void armSchedules()}>
            <Plus size={14} />{t("schedules.createTitle")}
          </button>}
        </div>
      </div>
      <div className="panel-body">
        <p className="form-note">{t("ciTasks.schedulesNewHint")}</p>
      </div>
    </section>}

    {!isNew && task && projectId && <ResourceSchedules
      projectId={projectId}
      targetType="ci_task"
      targetId={task.id}
      autoOpenCreate={armScheduleCreate}
    />}

    {/* 通知面板（P4.5-12 随抽屉落地，随本页搬家，组件内的表单控件原样）：与套件详情页
        同一套配置形状（开关 + 渠道 + 可覆盖模版），只有占位符词表是 CI 语境的。 */}
    <section className="panel">
      <div className="panel-head"><strong>{t("ciTasks.notify.title")}</strong></div>
      <div className="panel-body">
        <div className="check-row">
          <label className="check-field">
            <input type="checkbox" checked={notify.onSuccess} onChange={(event) => setNotify({ ...notify, onSuccess: event.target.checked })} />
            {t("ciTasks.notify.onSuccess")}
          </label>
          <label className="check-field">
            <input type="checkbox" checked={notify.onFailure} onChange={(event) => setNotify({ ...notify, onFailure: event.target.checked })} />
            {t("ciTasks.notify.onFailure")}
          </label>
        </div>
        <p className="form-note">{t("ciTasks.notify.hint")}</p>
        <label className="field">
          <span>{t("ciTasks.notify.channels")}</span>
          <Select
            mode="multiple"
            value={notify.channelIds}
            onChange={(channelIds: string[]) => setNotify({ ...notify, channelIds })}
            options={channels.map((channel) => ({ value: channel.id, label: channel.name }))}
            placeholder={t("ciTasks.notify.channelsPlaceholder")}
            style={{ width: "100%" }}
          />
          {!channels.length && <p className="form-note">{t("ciTasks.notify.noChannels")}</p>}
        </label>
        <label className="field">
          <span>{t("ciTasks.notify.templateTitle")}</span>
          <input
            className="input"
            value={notify.template?.title ?? ""}
            onChange={(event) => setNotify({ ...notify, template: templateOf(notify, { title: event.target.value }) })}
            placeholder={t("ciTasks.notify.templateTitlePlaceholder")}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>{t("ciTasks.notify.templateBody")}</span>
          <textarea
            className="input mono"
            rows={5}
            value={notify.template?.body ?? ""}
            onChange={(event) => setNotify({ ...notify, template: templateOf(notify, { body: event.target.value }) })}
            placeholder={t("ciTasks.notify.templateBodyPlaceholder")}
            spellCheck={false}
          />
          <p className="form-note">{t("ciTasks.notify.templateHint")}</p>
        </label>
      </div>
    </section>
    </div>
    </div>

    {projectId && <GitCredentialModal
      projectId={projectId}
      editing={credentialEditing}
      onClose={() => setCredentialEditing(undefined)}
      onSaved={async (saved) => {
        /* 刷池 + 自动选中刚建的那把：点「创建凭据」的人下一步就是选它，让他再点一次
           下拉是在把刚回答过的问题再问一遍。 */
        setCredentials((current) => [...current, saved]);
        setGitCredentialId(saved.id);
      }}
    />}

    {/* 版本历史（P10-6）：仓库任务快照，选中两版看改动内容、可回滚；回滚后重拉任务重铺表单。 */}
    {projectId && !isNew && taskId && <VersionHistoryDrawer
      projectId={projectId}
      assetType="ci_task"
      assetId={taskId}
      name={name || task?.name}
      open={versionHistoryOpen}
      onClose={() => setVersionHistoryOpen(false)}
      onRolledBack={() => void load()}
    />}
  </main>;
}
