import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Drawer, Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Bell, BookOpen, Dices, KeyRound, Languages, LogOut, MapPin, Moon, Plus, Send, Settings, Square, Sun, SunMoon, Trash2, UserRound } from "lucide-react";
import {
  api,
  classifyAssistantError,
  isRateLimited,
  probeAssistantAvailability,
  streamAssistantMessage,
  type AssistantConversation,
  type AssistantErrorCode,
  type AssistantEvent,
  type AssistantUserAgent,
  type AssistantUserParam,
  type AssistantUserProvider,
  type Preferences,
  type UserNotification,
} from "../api";
import { useCanWrite } from "../hooks/useMyRole";
import {
  COMMAND_PAGES,
  completeCommand,
  interceptAccountMessage,
  parseCommand,
  type CommandCandidate,
  type CommandPage,
  type LanguageValue,
  type ParsedCommand,
  type ThemeValue,
} from "../lib/assistantCommands";
import { useAuthStore } from "../stores/authStore";
import { useNavGuardStore } from "../stores/navGuardStore";
import { useNotificationsStore } from "../stores/notificationsStore";
import { usePageContextStore, type PageContext, type SentPageContext } from "../stores/pageContextStore";
import { useProjectStore } from "../stores/projectStore";
import { requestThemePreference } from "../theme";
import { Tip } from "../ui";
import i18nSingleton from "../i18n";
import { Avatar, type AvatarPulseKind } from "./Avatar";
import { AssistantElicitationCard, type ElicitSettled } from "./AssistantElicitationCard";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { AssistantProposalCard, splitProposalSegments, type ProposalSettled } from "./AssistantProposalCard";
import { IconButton } from "./IconButton";
import { MeCenter, type MeTab } from "./MePage";
import { newAvatarSeed } from "../lib/avatar";

/**
 * 站内助手抽屉（P9-4 起家、P9-4b 用户级凭据、P9-5 本地指令与 proposal 卡）：顶栏
 * 入口（原通知铃铛位，2026-09-16 第二轮反馈改位）→ 抽屉（会话切换 + 消息流 +
 * 快捷 chips + 输入），外加四个页内视图——「设置」（个性化 + 我的 agent）、「改密码」
 * （受控表单卡）、「最近通知」（2026-09-16 通知入口随铃铛移入助手）与「个人中心」
 * （P13-1：原 `/me` 页并入）。链路是哑管道：
 * 发消息走 `streamAssistantMessage`（引擎按 provider 的通用协议配置调上游），历史走
 * 上游代理——对话正文不落库，本组件的消息桶只是「这一次打开期间的显示态」。
 *
 * - **入口在两个壳的顶栏（2026-09-16）**：按钮 portal 进 topbar-actions 的
 *   #assistant-topbar-slot（壳互斥渲染，槽位唯一）；组件本体在 DockedShell 单挂载
 *   ——切壳/切页不断流、状态不清空；
 * - **对话用户级化（2026-09-16 用户定位修订）**：会话是「人」的不挂项目——路由
 *   `/api/v1/assistant/conversations*` + `assistant_conversations` 去掉 project_id
 *   （迁移 062）；项目上下文按消息随发随带（P9-4c 围栏），与会话归属无关；
 *   项目资产卡（proposal/确认）在无项目上下文时降级只读；
 * - 抽屉宽度（2026-09-15 用户反馈）：默认占视口 70%（封顶 1440），左缘拖拽条可调
 *   420–1600（localStorage 持久），双击回默认；设置卡收窄 640 居中（表单不要宽）；
 * - 消息流的 assistant 文本块走 Markdown 渲染（P9-4c-2：react-markdown + remark-gfm，
 *   8.13 边界 19 的聊天场景改写；用户气泡/错误气泡/工具行维持纯文本）；
 * - 本地指令表 + 账号拦截（P9-5 边界 6/14）：`/主题` `/语言` `/打开` `/项目` `/设置`
 *   `/改密码` `/登出` `/帮助` 前缀匹配命中即本地执行、回**系统气泡**，不经过 agent
 *   （上游停机仍可用，门槛 5）；未命中直发上游。含密码/登出等账号词的消息本地拦截
 *   引导到卡片、不转发——密码不进消息流、不发上游；
 * - proposal 预览卡（P9-5 边界 3）：assistant 文本里的 `apitest-proposal` 围栏渲染成
 *   草稿卡，「确认应用」用本人 JWT 调既有 REST 落库（审计 created_by 是本人，门槛 4）；
 * - 工具行（`tool` 事件）如实显示 name · status（门槛 3——用户能看见 AI 在调什么）；
 * - 页面上下文（P9-4c-1）：发送时把「当前页面 + 正在看什么」随消息带上（chip 可见、
 *   可关），服务端封 `apitest-page-context` 围栏前缀转发给 agent——「当前接口」类
 *   指代靠它解析；历史回放时服务端剥掉围栏，气泡永远只显示用户打的字；
 * - 停止按钮按会话 provider 的协议形状显隐（门槛 13：没定义 stop 端点不出现）；
 * - 快捷 chips 四枚（边界 6）：新会话 / 设置 / 改密码（P9-5 起为抽屉内表单卡，不再
 *   跳页面）/ 登出（确认卡）；
 * - 未配置引导分两味（P9-4b）：平台没有上游 → 找系统管理员；有上游但我没配 → 直接
 *   进「设置」卡（这就是 503/2005 在用户级的落点）；
 * - **最近通知（2026-09-16；2026-09-21 收口）**：顶栏铃铛（P9-1）撤掉，通知的常驻
 *   入口 = 顶栏助手钮的未读徽标 + 抽屉头 Bell 钮 + 抽屉内通知视图（点行标已读深链 /
 *   全部已读）——P13-1 曾把它借道个人中心的「通知」分区，2026-09-21 用户反馈收回为
 *   抽屉自己的视图（个人中心不再有通知格，也没有「查看全部」整页）；antd 弹窗
 *   （即时感）与 Root 轮询照旧；
 * - 人物头像（P9-6 已落地）：`Avatar` 按种子确定性画人物——顶栏入口 30px 半身、
 *   抽屉头 96px 全身；种子 = preferences.avatarSeed 覆盖 > users.id（头像不
 *   落库，前端每次画），「换一个形象」写新 avatarSeed；眨眼只在抽屉打开且无
 *   在飞请求时运行（Quiet Console 单环境动画约束）；**人物反应**（2026-09-16）：
 *   开抽屉打招呼 / 发消息低头看 / 流式中「想」姿态 / 回复完成欢呼 / 出错委屈 /
 *   登录与新通知到达时入口小跳——全是状态变化驱动的离散表演，不是循环动画。
 */

/** 消息流的一个块。助手回复是块序列（工具行/文本/错误/确认表单），归一事件按到达顺序落块。 */
type ChatBlock =
  | { kind: "tool"; name: string; status: string }
  | { kind: "text"; text: string }
  /** 错误气泡：`code`（P9-8）是平台判定的失败类别，渲染时换成本地化文案；上游
   *  自己报的错不带码，`text` 原样显示。 */
  | { kind: "error"; text: string; code?: AssistantErrorCode }
  /** MRTR 确认表单（2026-09-15）：agent 的删除类工具被 /mcp 闸门拦下、上游转述的
   *  确认请求——渲染成 ElicitationCard（确认走本人 JWT 的既有 REST）。 */
  | { kind: "elicit"; text: string; tool: string; input?: Record<string, unknown>; schema?: unknown };

type ChatEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; blocks: ChatBlock[]; streaming: boolean }
  /** 本地系统回执（P9-5）：指令执行结果 / 账号拦截提示 / 改密完成——只活在显示态，
   *  不建会话、不进上游、历史回放整桶替换时随之消失（本来就没发过）。 */
  | { role: "system"; text: string };

/** 一条归一事件落进当前流式回合（线程里最后一个仍在流式的助手条目）。 */
function applyEvent(thread: ChatEntry[], event: AssistantEvent): ChatEntry[] {
  /* 找最后一个 streaming 的助手条目，而不是要求它是最后一条（P9-5 起本地指令回执 /
     拦截气泡可以插在流式条目后面——流式中跑 /主题 深色 不该打断 token 落块）。 */
  let index = thread.length - 1;
  while (index >= 0) {
    const candidate = thread[index];
    if (candidate.role === "assistant" && candidate.streaming) break;
    index -= 1;
  }
  /* 没有在飞的回合（终态已落/线程为空）= 协议噪音，丢弃（引擎契约已拦一道）。 */
  if (index < 0) return thread;
  const last = thread[index] as { role: "assistant"; blocks: ChatBlock[]; streaming: boolean };
  const blocks = [...last.blocks];
  if (event.type === "token") {
    /* token 追加进最后一个文本块；工具行把文本隔断时另起一块。 */
    const tail = blocks[blocks.length - 1];
    if (tail && tail.kind === "text") blocks[blocks.length - 1] = { kind: "text", text: tail.text + event.text };
    else blocks.push({ kind: "text", text: event.text });
  } else if (event.type === "tool") {
    blocks.push({ kind: "tool", name: event.name, status: event.status });
  } else if (event.type === "elicit") {
    /* MRTR 确认表单：落独立块（不进文本——token 流里不掺结构化卡）。 */
    blocks.push({ kind: "elicit", text: event.text, tool: event.tool, ...(event.input ? { input: event.input } : {}), ...(event.schema !== undefined ? { schema: event.schema } : {}) });
  } else if (event.type === "done") {
    /* fullText 是权威全文（引擎在 done 映射的 text 缺失时已退回 token 累计值）：
       以它为准替换累计值，不让拼接漂移留在气泡里。 */
    const textIndex = blocks.map((block) => block.kind).lastIndexOf("text");
    if (textIndex >= 0) blocks[textIndex] = { kind: "text", text: event.fullText };
    else if (event.fullText) blocks.push({ kind: "text", text: event.fullText });
  } else {
    blocks.push({ kind: "error", text: event.message, ...(event.code ? { code: event.code } : {}) });
  }
  const updated = { ...last, blocks, streaming: event.type !== "done" && event.type !== "error" };
  return [...thread.slice(0, index), updated, ...thread.slice(index + 1)];
}

/** 会话在切换器里的名字：topic 优先（首条消息自动摘要），缺省退时间。 */
function conversationLabel(conversation: AssistantConversation): string {
  const topic = conversation.topic.trim();
  if (topic) return topic;
  const date = new Date(conversation.lastActiveAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 服务端 fail 的 message 是给人读的指向性文案（与 provider 面板同款透出）。 */
function apiMessage(error: unknown): string | undefined {
  const message = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof message === "string" && message ? message : undefined;
}

/** 平台判定的失败类别 → 本地化文案（P9-8）：限流要说「稍后重试」（等一等就好），
    上游静默/断流要说「这条回复断了」（重发一次）——都比上游那句英文更好使。
    不带码的错误是上游自己说的话，原样显示（平台不替它改写）。 */
const ASSISTANT_ERROR_KEYS: Record<AssistantErrorCode, string> = {
  rate_limited: "assistantDrawer.rateLimited",
  upstream_silent: "assistantDrawer.upstreamSilent",
  stream_incomplete: "assistantDrawer.streamIncomplete",
  upstream_stream_failed: "assistantDrawer.streamAborted",
};

/** 上下文 chip 的面包屑摘要（P9-4c）：优先 method+url（接口语境一眼可读），其次
    各实体名；焦点对象（用例/节点）拼在后。空串时调用方回落页面名。 */
function contextSummary(context: PageContext | undefined): string {
  if (!context) return "";
  const entities = context.entities ?? {};
  const primary = [entities.method, entities.url].filter(Boolean).join(" ")
    || entities.endpointName || entities.flowName || entities.suiteName || entities.taskName
    || entities.environmentName || entities.alertName || entities.reportName || entities.path
    || "";
  const secondary = entities.caseName || entities.nodeName || "";
  return [primary, secondary].filter(Boolean).join(" · ");
}

/** 稳定的空线程（`?? []` 每次渲染都是新数组，会让跟随滚动效应空转）。 */
const EMPTY_THREAD: ChatEntry[] = [];

/** 无会话时的本地消息桶（P9-5）：指令回执 / 拦截提示在还没建会话时也要有地方显示；
 *  建了会话后这个桶不再展示（本地回执是即时的，不值得为它占一个常驻位置）。 */
const LOCAL_THREAD_KEY = "__local__";

/** 指令回执里主题/语言的展示名（复用系统管理页的既有键/字面量）。 */
const THEME_LABEL_KEY: Record<ThemeValue, string> = { light: "system.themeLight", dark: "system.themeDark", system: "system.themeSystem" };
const LANGUAGE_LABEL: Record<LanguageValue, string> = { "zh-CN": "简体中文", en: "English" };

/** MRTR 确认卡的内容键（工具名+入参）：终态按它索引，同一确认在重渲染间不换键。 */
function elicitKey(block: { tool: string; input?: Record<string, unknown> }): string {
  return `${block.tool}:${JSON.stringify(block.input ?? {})}`;
}

/** 回放/落记录共用的确认结果文案（i18n 单例取——历史回放渲染时语言可能是切换后的）。 */
function elicitRecordText(elicit?: { tool: string; outcome: "confirmed" | "declined"; input?: Record<string, unknown> }): string {
  if (!elicit) return "";
  return i18nSingleton.t(elicit.outcome === "confirmed" ? "assistantElicit.recordConfirmed" : "assistantElicit.recordDeclined", { tool: elicit.tool });
}

/** 通知行的相对时间（列表页同款）：今天给「HH:mm」，更早给日期——速览里精确到
    秒没有读者（原 BellMenu 的实现随组件一起搬进助手）。 */
function formatNotificationWhen(iso: string, t: (key: string, vars?: Record<string, unknown>) => string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  if (sameDay) return t("notifications.todayAt", { time: `${pad(date.getHours())}:${pad(date.getMinutes())}` });
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* ── 抽屉宽度（2026-09-15 用户反馈：420px 太小）─────────────────────────────────
 * 默认占视口 70%（封顶 1440——大屏上聊天正文行宽不无限拉长）；左缘拖拽条可调
 * 420–1600，拖过即存 localStorage（apitest.assistantWidth），双击拖拽条清偏好回
 * 默认 70%。窄屏 ≤520px 仍吃满整宽（design-system 的 100vw !important 压过内联宽）。 */
const DRAWER_MIN_WIDTH = 420;
const DRAWER_MAX_WIDTH = 1600;
const DRAWER_DEFAULT_CAP = 1440;

function defaultDrawerWidth(): number {
  return Math.min(Math.round(window.innerWidth * 0.7), DRAWER_DEFAULT_CAP);
}

/** 上限随视口让一格（拖到贴边连顶栏入口都盖住就不是「放大」了），但不低于最小宽。 */
function clampDrawerWidth(width: number): number {
  const max = Math.max(DRAWER_MIN_WIDTH, Math.min(DRAWER_MAX_WIDTH, window.innerWidth - 80));
  return Math.min(Math.max(width, DRAWER_MIN_WIDTH), max);
}

/** 「刚登录」的入口小跳一次/会话：模块级标记——路由切壳/重挂不重演。 */
let greetedThisSession = false;

export function AssistantDock() {
  const { t, i18n } = useTranslation();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const confirmLeave = useNavGuardStore((state) => state.confirmLeave);
  const logout = useAuthStore((state) => state.logout);
  /** 改密成功后服务端换发 token（pwd_epoch）：renewSession 落地，当前会话续命。 */
  const renewSession = useAuthStore((state) => state.renewSession);
  const isSystemAdmin = useAuthStore((state) => state.user?.isSystemAdmin) ?? false;
  /** 身份种子兜底（P9-6）：preferences.avatarSeed 未覆盖时用它——同一账号永远
      同一张脸，改名≠换人（种子是 id 不是名字）。 */
  const userId = useAuthStore((state) => state.user?.id);
  /** 卡片空态问候 `HI, {{用户名}}`（P13-2）：取当前登录用户 name，缺失回退 email 前缀。 */
  const userName = useAuthStore((state) => state.user?.name);
  const userEmail = useAuthStore((state) => state.user?.email);
  const greetingName = (userName?.trim() || userEmail?.split("@")[0] || "").trim();
  /* 项目资产卡（proposal / MRTR 确认）的写资格：对话用户级化（2026-09-16）后聊天
     面不再看项目角色（会话是「人」的），但卡片落库走项目 REST——viewer 照旧只读、
     全局页（无项目上下文）一律只读（后端守卫仍是单一事实）。 */
  const canWrite = useCanWrite();
  const { project } = useProjectStore();

  const [open, setOpen] = useState(false);
  /** 抽屉内容视图（P9-4b 设置在抽屉里；P9-5 增改密码表单卡；P13-1 通知视图并入
   *  「个人中心」me 视图，原「近 10 条」缩略视图删除）：chat / settings / password /
   *  me（个人中心五分区：基本信息 / 我的申请 / MCP 凭证 / API Key 凭证 / agent 凭证，
   *  2026-09-26 拆「个人凭证」后）。 */
  const [view, setView] = useState<"chat" | "settings" | "password" | "notifications" | "me">("chat");
  /** 个人中心当前分区（P13-1）：抽屉头「个人中心」钮落 profile；me 视图内的 tab 条
   *  也切它。视图切走再切回停在上次的分区。通知不是分区（2026-09-21 用户反馈：
   *  通知留在助手自己的 `notifications` 视图，个人中心不再有第二个入口）。 */
  const [meTab, setMeTab] = useState<MeTab>("profile");
  /** 打开个人中心到指定分区（抽屉头「个人中心」钮、/打开 指令共用）。 */
  function openMe(tab: MeTab) { setMeTab(tab); setView("me"); }
  /** 个人中心 agent 凭证 tab 的「去配置」（2026-09-26）：跳「设置」卡并预选该上游。
   *  预选经 ref 传给设置卡的取数效应——那次加载完成后只预选一次，之后照旧
   *  「我的默认 → 系统推荐 → 第一个」。 */
  const requestedSettingsProviderRef = useRef<string>();
  function openAgentSettings(providerId: string) {
    requestedSettingsProviderRef.current = providerId;
    setSettingsProviderId(providerId);
    setView("settings");
  }
  /** 闸门语义快照（probeAssistantAvailability）：unconfigured 时入口降级、抽屉给引导。 */
  const [availability, setAvailability] = useState<"ready" | "unconfigured" | "disabled" | undefined>();
  /** 未配置引导的判别（P9-4b）：503 只说明「我的 agent 没配好」，还得知道平台有没有
   *  上游——有上游 → 直接「配置我的 agent」；一个都没有 → 找系统管理员。 */
  const [catalogState, setCatalogState] = useState<"unknown" | "has" | "empty">("unknown");
  const [conversations, setConversations] = useState<AssistantConversation[]>();
  const [activeId, setActiveId] = useState<string>();
  /** 上游名索引 + 我的默认上游（2026-09-26 用户反馈：聊天窗没展示当前选的是哪个
   *  agent 上游）。会话在创建时就绑定上游（行上 provider_id），之后不跟随「默认
   *  agent」切换——标签按绑定显示。名字取 `GET /assistant/my-agents` 的
   *  providerName（与「设置」卡同一份数据）；加载失败静默，标签缺席不挡对话。 */
  const [upstreamNames, setUpstreamNames] = useState<Record<string, string>>({});
  const [defaultUpstream, setDefaultUpstream] = useState<{ id: string; name: string } | null>();
  /** 消息按会话分桶：切走再切回不丢内容；流式回合写自己的桶，不打扰当前显示。 */
  const [threads, setThreads] = useState<Record<string, ChatEntry[]>>({});
  const [historyState, setHistoryState] = useState<"idle" | "loading" | "failed" | "unavailable">("idle");
  const [historyNonce, setHistoryNonce] = useState(0);
  const [input, setInput] = useState("");
  /* ── 输入即识别的指令浮层（P9-5 增补）────────────────────────────────────── */
  /** Escape 收起后不再弹（打到下一个字符才重新武装）——收起是用户意图，不是状态。 */
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const [cmdHighlight, setCmdHighlight] = useState(0);
  /** 在飞流式回合（渲染态；归属会话的权威在 streamingRef）。一次只允许一条在飞。 */
  const [streaming, setStreaming] = useState(false);
  const [streamingId, setStreamingId] = useState<string>();
  const [creating, setCreating] = useState(false);
  /* ── 页面上下文（P9-4c）────────────────────────────────────────────────────── */
  /** 本条消息不带上下文：一次性开关，发送后复位。 */
  const [skipContext, setSkipContext] = useState(false);
  /** chip 展开看全量 JSON（透明度：用户看得见 agent 会拿到什么）。 */
  const [contextOpen, setContextOpen] = useState(false);
  const pageContext = usePageContextStore((state) => state.context);
  const location = useLocation();

  /* ── 抽屉宽度（用户反馈）──────────────────────────────────────────────────── */
  /** 用户拖出来的宽度（localStorage 持久）；undefined = 还没拖过，每次取默认 70%
   *  ——换屏幕/换窗口后默认值跟着视口走，拖过的偏好才被尊重。 */
  const [userWidth, setUserWidth] = useState<number | undefined>(() => {
    const saved = Number(localStorage.getItem("apitest.assistantWidth"));
    return Number.isFinite(saved) && saved > 0 ? clampDrawerWidth(saved) : undefined;
  });
  const [resizing, setResizing] = useState(false);
  const resizeState = useRef<{ startX: number; startWidth: number }>();
  const drawerWidth = userWidth ?? defaultDrawerWidth();

  /* ── 设置视图的数据（P9-4b）────────────────────────────────────────────────── */
  /** 上游目录（用户视角）：启用的 provider + 各自的参数模式。 */
  const [userProviders, setUserProviders] = useState<AssistantUserProvider[]>();
  const [myAgents, setMyAgents] = useState<AssistantUserAgent[]>();
  /** 正在编辑哪个上游的 agent 表单。 */
  const [settingsProviderId, setSettingsProviderId] = useState<string>();
  /** 明文参数的表单值（agentId 等）。 */
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  /** secret 参数的表单值（只在保存的这一趟请求里旅行）。 */
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  /** secret 的「清除」腿（已配置的项才有）。 */
  const [clearSecrets, setClearSecrets] = useState<Record<string, boolean>>({});
  const [savingAgent, setSavingAgent] = useState(false);
  const [testingAgent, setTestingAgent] = useState(false);
  const [agentTestResult, setAgentTestResult] = useState<{ ok: boolean; detail: string }>();

  /* ── 设置卡的个性化分区 + 改密表单卡（P9-5）────────────────────────────────── */
  /** 账号偏好（主题/语言）：与系统管理页同一份服务端偏好，两边互改互见。 */
  const [prefs, setPrefs] = useState<Preferences>();
  /** 改密表单的三格值（密码只在受控表单里旅行，不进消息流、不发上游——边界 14）。 */
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNext, setPwNext] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string>();
  /** proposal 卡终态（applied/dismissed），按草稿内容键索引：同一段草稿在流式与
   *  重渲染间不丢终态；历史回放换桶后自然复位（草稿重新出现重新确认）。 */
  const [proposalStates, setProposalStates] = useState<Record<string, ProposalSettled>>({});
  /** MRTR 确认卡终态（confirmed/declined），按「工具名+入参」键索引（同 proposal 卡）。 */
  const [elicitStates, setElicitStates] = useState<Record<string, ElicitSettled>>({});

  /* ── 人物头像（P9-6）────────────────────────────────────────────────────────── */
  /** 头像种子：avatarSeed 覆盖 > users.id > 兜底。preferences 是直通存储（PUT 不
      校验），非字符串/空白脏值按无覆盖处理，别让脏 key 进 hashSeed。 */
  const avatarSeed = typeof prefs?.avatarSeed === "string" && prefs.avatarSeed.trim() ? prefs.avatarSeed : userId ?? "anonymous";

  /* ── 最近通知（2026-09-16 通知入口移入助手）──────────────────────────────────── */
  /* 顶栏铃铛撤掉后这里是通知的唯一常驻入口：轮询在 Root 跑（hooks/useNotifications），
     这里只读同一份 store——顶栏入口徽标（存量感）+ 抽屉通知视图 + antd 弹窗（即时感）
     三者并存。 */
  const notificationsUnread = useNotificationsStore((state) => state.unread);
  const notificationsLoaded = useNotificationsStore((state) => state.loaded);
  const notificationsRecent = useNotificationsStore((state) => state.recent);
  const setNotificationsUnread = useNotificationsStore((state) => state.setUnread);

  /* ── 人物反应（2026-09-16 用户要求）──────────────────────────────────────────── */
  /** 抽屉头 96px 走聊天生命周期（greet/sent/done/error），顶栏入口 30px 走通知/登录
      （bounce）；nonce 递增触发（Avatar 只认变化）。 */
  const [headerPulse, setHeaderPulse] = useState<{ kind: AvatarPulseKind; nonce: number }>();
  const [dockPulse, setDockPulse] = useState<{ kind: AvatarPulseKind; nonce: number }>();
  const pulseNonceRef = useRef(0);
  function fireHeaderPulse(kind: AvatarPulseKind) {
    pulseNonceRef.current += 1;
    setHeaderPulse({ kind, nonce: pulseNonceRef.current });
  }
  function fireDockPulse(kind: AvatarPulseKind) {
    pulseNonceRef.current += 1;
    setDockPulse({ kind, nonce: pulseNonceRef.current });
  }

  /** 流式回合归属的会话（ref 不是 state：历史效应读它决定跳过，不该触发重渲染）。 */
  const streamingRef = useRef<string>();
  const stopStreamRef = useRef<(() => void) | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 跟随滚动：用户上翻历史时不再拽底，回到接近底部自动恢复。 */
  const followRef = useRef(true);

  /* 没有选中会话时显示本地桶（P9-5）：指令回执 / 拦截提示在没有会话时也有落点。 */
  const entries = (activeId ? threads[activeId] : threads[LOCAL_THREAD_KEY]) ?? EMPTY_THREAD;
  /* 停止按钮跟着在飞的回合（不是当前显示的会话——中途切走时按钮仍要停对地方）。 */
  const streamingConversation = conversations?.find((conversation) => conversation.id === streamingId);
  const stopCapable = Boolean(streamingConversation?.providerCapabilities.stop);
  /* 当前显示的会话（上游标签用）：与 streamingConversation 同一取法。 */
  const activeConversation = conversations?.find((conversation) => conversation.id === activeId);

  /* 发送时刻的页面上下文（P9-4c）：页面注册内容 + 当刻 route（在此合成，页面不填）。
     未注册页面也带 route——路径里的实体 id 仍在；全局层页面没有抽屉，不采不注。 */
  const sentContext: SentPageContext = {
    page: pageContext?.page ?? "unknown",
    route: `${location.pathname}${location.search}`,
    ...(pageContext?.entities ? { entities: pageContext.entities } : {}),
    ...(pageContext?.focus ? { focus: pageContext.focus } : {}),
    ...(pageContext?.filters ? { filters: pageContext.filters } : {}),
    ...(pageContext?.selection?.length ? { selection: pageContext.selection } : {}),
  };

  const settingsProvider = userProviders?.find((provider) => provider.id === settingsProviderId);
  const myAgentForSettings = myAgents?.find((agent) => agent.providerId === settingsProviderId);

  /* ── 输入即识别（P9-5 增补）：候选浮层的数据面 ──────────────────────────────
     纯解析在 lib（与 parseCommand 同一套谓词），这里只把语言与项目上下文喂进去：
     浮层里的候选就是回车时会命中的那几条。Escape 收起后不再弹，打到下一个字符才
     重新武装（setInput 的调用点统一复位）。 */
  const completion = useMemo(
    () => (cmdDismissed ? undefined : completeCommand(input, { locale: i18n.language, hasProject: Boolean(projectId) })),
    [cmdDismissed, input, projectId, i18n.language],
  );
  const commandPalette = completion && completion.candidates.length ? completion : undefined;
  /** 候选集指纹：换一组候选就把高亮收回首项（回车选中不会落在已经换掉的行上）。 */
  const paletteKey = commandPalette ? `${commandPalette.position}:${commandPalette.candidates.map((candidate) => candidate.insert).join("|")}` : "";
  useEffect(() => { setCmdHighlight(0); }, [paletteKey]);

  /* 闸门探测：助手默认开启（迁移 058——无项目开关），探测只回答「我的 agent 配好
     没有」；一次探测读即时状态，不轮询。回 unconfigured 时顺带查上游目录——引导块
     要区分「平台没上游」与「有上游你没配」两种成因（文案与按钮都不同）。 */
  useEffect(() => {
    let alive = true;
    void probeAssistantAvailability().then((state) => {
      if (!alive) return;
      setAvailability(state);
      if (state === "unconfigured") {
        void api.assistantUserProviders()
          .then((providers) => { if (alive) setCatalogState(providers.length ? "has" : "empty"); })
          .catch(() => { if (alive) setCatalogState("unknown"); });
      }
    });
    return () => { alive = false; };
  }, []);

  /* 卸载时掐掉在飞的流（2026-09-16 用户级化：会话不再随项目切换清空——全局常驻
     抽屉里，切页面/切项目对话照旧）。 */
  useEffect(() => () => {
    stopStreamRef.current?.();
    stopStreamRef.current = undefined;
    streamingRef.current = undefined;
  }, []);

  /* 打开抽屉：拉「我的会话」（读映射表，不调上游），默认落在最近活跃的那条（粘性：
     重开后停留在上次选择的会话——上次的上下文还在脑子里）。 */
  useEffect(() => {
    if (!open || (availability !== "ready" && availability !== undefined)) return;
    let alive = true;
    setConversations(undefined);
    followRef.current = true;
    void api.assistantConversations().then((rows) => {
      if (!alive) return;
      /* 服务端契约是「成功即数组」；真拿到空体/非数组（历史缺陷：守卫少回一个 fail，
         200 空体）时按加载失败处理——undefined 直接进 setActiveId 的 .some 会抛错，
         把闸门语义误报成「加载失败」。 */
      if (!Array.isArray(rows)) throw new Error("assistant conversations payload is not a list");
      setConversations(rows);
      /* 粘性选择要验真：被删过的会话不在新列表里，回落到最近活跃的一条
         （antd Select 的 value 不在 options 里会把裸 UUID 显示出来）。 */
      setActiveId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id);
    }).catch((error) => {
      if (!alive) return;
      /* 状态可能比探测时新（agent 刚被清掉）：就地归一，让抽屉转设置引导。闸门语义
         （未配置 503/2005 / 已关 404）是**引导不是错误**——别对「你还没配 agent」弹
         一句「会话列表加载失败」，用户的下一个动作在引导块里，不在重试里。 */
      const state = classifyAssistantError(error);
      setConversations([]);
      if (state) { setAvailability(state); return; }
      message.error(t("assistantDrawer.conversationsFailed"));
    });
    return () => { alive = false; };
  }, [open, availability, t]);

  /* 上游名索引（聊天窗的上游标签）：抽屉打开拉一次「我的 agent」，会话的 provider_id
     映射成名字；我的默认 = 新会话会用的上游。与设置卡同源（同一接口），失败静默。 */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api.myAssistantAgents().then((agents) => {
      if (!alive) return;
      setUpstreamNames(Object.fromEntries(agents.map((agent): [string, string] => [agent.providerId, agent.providerName])));
      const mine = agents.find((agent) => agent.isDefault && agent.providerEnabled);
      setDefaultUpstream(mine ? { id: mine.providerId, name: mine.providerName } : null);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [open]);

  /* 历史回放（transcript 在上游，边界 2）：切会话/重开抽屉时拉一次，整桶替换（上游
     是权威——别处/别的设备聊过的内容在这里自愈）。正在流式的会话跳过：回放会把
     在飞的回合冲掉。协议没定义 history 端点时直接标记不可用，不撞 400。 */
  /* 历史回放（transcript 在上游，边界 2）：切会话/重开抽屉时拉一次，整桶替换（上游
     是权威——别处/别的设备聊过的内容在这里自愈）。正在流式的会话跳过：回放会把
     在飞的回合冲掉。协议没定义 history 端点时直接标记不可用，不撞 400。
     依赖只认 open/activeId/historyNonce——conversations 不进依赖（它只贡献「能力
     面」一个事实，经 conversationsRef 读）：首条消息后 topic 刷新会换列表数组身份，
     列表进依赖会让回放重跑、把刚流式出来的气泡整桶冲掉（2026-09-15 用户实测）。 */
  const conversationsRef = useRef<AssistantConversation[] | undefined>();
  conversationsRef.current = conversations;
  useEffect(() => {
    if (!open || !activeId) { setHistoryState("idle"); return; }
    if (streamingRef.current === activeId) return;
    const conversation = conversationsRef.current?.find((row) => row.id === activeId);
    if (conversation && !conversation.providerCapabilities.history) { setHistoryState("unavailable"); return; }
    let alive = true;
    setHistoryState("loading");
    void api.assistantHistory(activeId).then((rows) => {
      if (!alive) return;
      setThreads((current) => ({
        ...current,
        [activeId]: rows.map((row): ChatEntry => row.role === "user"
          ? { role: "user", text: row.text }
          /* system 行 = 平台自己的记录（MRTR 确认结果并回，2026-09-15）：结构化
             载荷按 i18n 渲染成系统气泡——回放后确认记录仍在。 */
          : row.role === "system"
            ? { role: "system", text: elicitRecordText(row.elicit) }
            : { role: "assistant", blocks: row.text ? [{ kind: "text", text: row.text }] : [], streaming: false }),
      }));
      setHistoryState("idle");
    }).catch(() => { if (alive) setHistoryState("failed"); });
    return () => { alive = false; };
  }, [open, activeId, historyNonce]);

  /* 抽屉打开后聚焦输入（对话用户级化后人人可发——不看项目角色）。 */
  useEffect(() => {
    if (open && view === "chat") inputRef.current?.focus();
  }, [open, view]);

  /* 新内容跟随滚动：只在用户本来就在底部时拽底（上翻历史不被打扰）。 */
  useEffect(() => {
    const node = scrollRef.current;
    if (node && followRef.current) node.scrollTop = node.scrollHeight;
  }, [entries, open]);

  /* 设置视图的数据：上游目录 + 我的 agent；预选「我的默认 → 系统推荐 → 第一个」。 */
  useEffect(() => {
    if (!open || view !== "settings") return;
    let alive = true;
    setUserProviders(undefined);
    setMyAgents(undefined);
    setAgentTestResult(undefined);
    void Promise.all([api.assistantUserProviders(), api.myAssistantAgents()]).then(([providers, agents]) => {
      if (!alive) return;
      setUserProviders(providers);
      setMyAgents(agents);
      /* 「去配置」跳来的预选一次有效，用完即弃；否则照旧「我的默认 → 系统推荐 →
         第一个」（个人中心 agent 凭证 tab 的入口，2026-09-26）。 */
      const requested = requestedSettingsProviderRef.current;
      requestedSettingsProviderRef.current = undefined;
      const preferred = (requested && providers.some((provider) => provider.id === requested)) ? requested
        : agents.find((agent) => agent.isDefault)?.providerId
          ?? providers.find((provider) => provider.isDefault)?.id
          ?? providers[0]?.id;
      setSettingsProviderId(preferred);
    }).catch(() => {
      if (!alive) return;
      setUserProviders([]);
      setMyAgents([]);
      message.error(t("assistantSettings.loadFailed"));
    });
    return () => { alive = false; };
  }, [open, view, t]);

  /* 选中上游 → 表单值从我的 agent 预填（secret 只回「已配置」，值不回）。 */
  useEffect(() => {
    if (!settingsProviderId) return;
    const agent = myAgents?.find((row) => row.providerId === settingsProviderId);
    setParamValues(agent ? { ...agent.params } : {});
    setSecretValues({});
    setClearSecrets({});
    setAgentTestResult(undefined);
  }, [settingsProviderId, myAgents]);

  /* 头部快捷切换（2026-09-15 外置）与本地指令的数据：preferences 在抽屉**打开时**
      拉一次（挂 mount 会给每个从不点开助手的人白发请求）；失败静默——钮保持置灰，
      不挡对话主流程。原先是设置卡「个性化」分区的取数（挂 view === "settings"），
      分区删除后头部按钮也要它——条件跟着收掉，抽屉一开就拉（2026-09-15 用户实测：
      直接进对话视图时按钮永远不可点，缺陷记 issue_fix/）。P9-6 起头像种子同源：
      首次打开前入口用 users.id 兜底画像，属同一取舍（不为头像把请求提前到 mount）。 */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api.preferences().then((value) => { if (alive) setPrefs(value); }).catch(() => undefined);
    return () => { alive = false; };
  }, [open]);

  /* 人物反应的触发点（2026-09-16）：
   * - 开抽屉 = 打招呼（greet：举手跳一下）；
   * - 刚登录（本会话首次挂载）入口小跳一下——「我在这」；
   * - 未读数上升（新通知到达，非首轮存量）入口再跳——通知入口就在这枚按钮上，跳是
   *   徽标出现的动效版。 */
  /* 开抽屉打招呼（greet：举手跳一下）；合抽屉挥手告别（wave）——Drawer 不销毁子树，
     退场滑出的这一帧里 96px 全身像仍在，挥手看得见。首帧挂载（open 初值 false）不算
     「合上」，用 ref 跳过。 */
  const drawerMounted = useRef(false);
  useEffect(() => {
    if (open) fireHeaderPulse("greet");
    else if (drawerMounted.current) fireHeaderPulse("wave");
    drawerMounted.current = true;
  }, [open]);
  useEffect(() => {
    if (greetedThisSession) return;
    greetedThisSession = true;
    fireDockPulse("bounce");
  }, []);
  const prevUnreadRef = useRef<number>();
  useEffect(() => {
    const previous = prevUnreadRef.current;
    prevUnreadRef.current = notificationsUnread;
    if (previous === undefined || notificationsUnread <= previous) return;
    fireDockPulse("bounce");
  }, [notificationsUnread]);

  /* 顶栏槽位（2026-09-16 入口移进顶栏）：两个壳的 topbar-actions 各渲染一个
     #assistant-topbar-slot（互斥渲染，DOM 里同一时刻只存在一个），入口按钮
     portal 进去。路由切换时槽位节点换新（壳互换/页面重挂），按 pathname 重找。
     ⚠ 槽位**不一定**在这次 commit 里（2026-09-21 缺陷「项目内助手入口消失」）：
     P14-1 的访问闸在身份问出前返回 `<div class="console-gate" />`（壳与顶栏都不渲染），
     而 pathname 已经变了——effect 这一次找不到槽位，之后路径没变也不会再找，入口就一直
     不出现（在项目里再点一次导航才回来）。补一段「槽位后到」的短重试：找到即停；
     离开壳的页面（登录 / 非成员落地页）空转到上限就结束，不常驻轮询。 */
  const [entrySlot, setEntrySlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    let tries = 0;
    const find = () => {
      const node = document.getElementById("assistant-topbar-slot");
      setEntrySlot((previous) => (previous === node ? previous : node));
      if (!node && ++tries < 20) timer = window.setTimeout(find, 200);
    };
    find();
    return () => { if (timer !== undefined) window.clearTimeout(timer); };
  }, [location.pathname]);

  function onScroll() {
    const node = scrollRef.current;
    if (!node) return;
    followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  }

  /** textarea 自适应高（封顶 ~6 行），发送后归位。 */
  function autoresize(node: HTMLTextAreaElement) {
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
  }

  /* ── 左缘拖拽调宽：pointer capture 让 move/up 全落回热区，不挂 window 监听。
     合成事件派发走最新渲染的 handler，onResizeEnd 闭包里的 userWidth 就是拖完值。 */
  function onResizeStart(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeState.current = { startX: event.clientX, startWidth: drawerWidth };
    setResizing(true);
    /* 拖拽期间禁选——指针划过消息文本会带出一串选区。 */
    document.body.style.userSelect = "none";
  }

  function onResizeMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = resizeState.current;
    if (!state) return;
    setUserWidth(clampDrawerWidth(state.startWidth + (state.startX - event.clientX)));
  }

  function onResizeEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizeState.current) return;
    resizeState.current = undefined;
    setResizing(false);
    document.body.style.userSelect = "";
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    /* 拖过即存偏好；存时再钳一次（视口可能比拖的时候小了）。 */
    if (userWidth !== undefined) localStorage.setItem("apitest.assistantWidth", String(clampDrawerWidth(userWidth)));
  }

  /** 双击拖拽条：清掉存的偏好，回到默认 70%。 */
  function onResizeReset() {
    resizeState.current = undefined;
    setResizing(false);
    document.body.style.userSelect = "";
    localStorage.removeItem("apitest.assistantWidth");
    setUserWidth(undefined);
  }

  /** 动作失败的弹窗（P9-8）：上游限流走专门口径（「稍后重试」——等一等就好），其余
      透出服务端的指向性文案，兜底各自的动作名。 */
  function errorToast(error: unknown, fallback: string) {
    message.error(isRateLimited(error) ? t("assistantDrawer.rateLimited") : apiMessage(error) ?? fallback);
  }

  /** 建会话（显式 chip 与首条消息的隐式入口共用）：成功返回 id 并落进列表与切换器。 */
  async function createConversation(): Promise<string | undefined> {
    setCreating(true);
    try {
      const created = await api.createAssistantConversation();
      /* 契约是「成功就有一行」。历史缺陷：未配置时守卫回 200 空体，undefined 被塞进
         列表后渲染读 conversation.id 当场白屏——这里按失败收口，绝不让空行进状态。 */
      if (!created?.id) throw new Error("assistant conversation payload is missing an id");
      setConversations((current) => [created, ...(current ?? [])]);
      setActiveId(created.id);
      return created.id;
    } catch (error) {
      errorToast(error, t("assistantDrawer.createFailed"));
      return undefined;
    } finally {
      setCreating(false);
    }
  }

  /** 本地条目（系统回执 / 被拦截的用户气泡）落进当前显示的桶：有会话落会话桶，
      没有落 LOCAL 桶——不建会话、不碰上游。历史回放整桶替换时这些本地条目随之
      消失（它们本来就没进上游，回放后不见 = 「没发过」的如实呈现）。 */
  function appendLocalEntries(newEntries: ChatEntry[]) {
    const target = activeId ?? LOCAL_THREAD_KEY;
    followRef.current = true;
    setThreads((current) => ({ ...current, [target]: [...(current[target] ?? []), ...newEntries] }));
  }

  /** 清输入并归位自适应高度（发送 / 指令执行 / 拦截共用）。 */
  function resetInput() {
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
  }

  /** MRTR 确认卡落定（2026-09-15）：终态记本地 + **平台侧持久化**（上游 transcript
      不知道确认动作，elicit_log 并回历史回放——「确认删除后聊天记录里要有这条」）
      + 即时系统气泡。记录失败静默：业务事实以删除本身的审计为准，回放少一行不撒谎。 */
  function settleElicit(block: { text: string; tool: string; input?: Record<string, unknown>; schema?: unknown }, state: ElicitSettled, conversationId?: string) {
    setElicitStates((current) => ({ ...current, [elicitKey(block)]: state }));
    if (!conversationId) return;
    appendLocalEntries([{ role: "system", text: elicitRecordText({ tool: block.tool, outcome: state, input: block.input }) }]);
    void api.recordElicitOutcome(conversationId, { tool: block.tool, outcome: state, ...(block.input ? { input: block.input } : {}) }).catch(() => undefined);
  }

  async function send() {
    const text = input.trim();
    if (!text) return;
    /* ── 本地通道（P9-5 边界 6）：指令与账号拦截都不经过上游——agent 平台停机
       仍可用（门槛 5）；流式进行中也放行（applyEvent 认「最后一个 streaming 助手
       条目」，本地气泡插在它后面不打断 token 落块）。 */
    if (text.startsWith("/")) {
      const parsed = parseCommand(text);
      if (parsed.status === "matched") {
        resetInput();
        await runLocalCommand(parsed.command);
        return;
      }
      if (parsed.status === "ambiguous") {
        /* 指令名前缀命中多条：不清输入，回执列候选让用户补全（CLI 惯例）。 */
        appendLocalEntries([{
          role: "system",
          text: t("assistantCmd.ambiguous", { token: parsed.token, commands: parsed.candidates.map((name) => `/${name}`).join("  ") }),
        }]);
        return;
      }
      /* unmatched：未知 /指令按自然语言直发上游（回车直发兜底）。 */
    }
    const interception = interceptAccountMessage(text);
    if (interception) {
      /* 账号词拦截（边界 6/14）：不转发上游。用户气泡只在本地显示——上游历史里
         永远没有这条，重开抽屉回放后消失，正是「没发过」的诚实形态。 */
      resetInput();
      appendLocalEntries([
        { role: "user", text },
        { role: "system", text: t(interception.kind === "password" ? "assistantCmd.interceptedPassword" : interception.kind === "logout" ? "assistantCmd.interceptedLogout" : "assistantCmd.interceptedGeneric") },
      ]);
      if (interception.kind === "password") setView("password");
      if (interception.kind === "logout") confirmLogout();
      return;
    }
    /* 上游通道一次只允许一条在飞（本地通道不受此限）。 */
    if (streaming) return;
    let conversationId = activeId;
    if (!conversationId) {
      /* 没有会话也能直接开聊：首条消息隐式建会话——chip 上的「新会话」是显式入口，
         这里是顺手入口，两条路落同一张映射表。 */
      conversationId = await createConversation();
      if (!conversationId) return;
    }
    const target = conversationId;
    /* 首条消息会触发服务端落 topic（P9-4 修订之四）：流结束后拉一次列表换掉时间戳
       标签。捕获发送时刻的 topic 状态——刚隐式建出来的会话不在列表里，同样算「没有」。 */
    const hadTopic = Boolean(conversations?.find((row) => row.id === target)?.topic);
    resetInput();
    followRef.current = true;
    /* 上下文注入（P9-4c）：服务端封 apitest-page-context 围栏前缀转发给 agent；
       「本条不带」是一次性的——发完复位，下一条默认恢复携带。 */
    const context = skipContext ? undefined : sentContext;
    setSkipContext(false);
    setContextOpen(false);
    /* 先记账再开流：setActiveId 触发的历史效应会因 streamingRef 命中而跳过。 */
    streamingRef.current = target;
    setStreaming(true);
    setStreamingId(target);
    setThreads((current) => ({
      ...current,
      [target]: [...(current[target] ?? []), { role: "user", text }, { role: "assistant", blocks: [], streaming: true }],
    }));
    let sawTerminal = false;
    let sawError = false;
    const { done, stop } = streamAssistantMessage(target, text, (event) => {
      if (event.type === "done" || event.type === "error") { sawTerminal = true; if (event.type === "error") sawError = true; }
      setThreads((current) => ({ ...current, [target]: applyEvent(current[target] ?? [], event) }));
    }, context);
    stopStreamRef.current = stop;
    /* 人物反应（2026-09-16）：发出时低头看一眼（视线落向输入框），终态欢呼/委屈。 */
    fireHeaderPulse("sent");
    void done.then(() => {
      stopStreamRef.current = undefined;
      streamingRef.current = undefined;
      setStreaming(false);
      setStreamingId(undefined);
      fireHeaderPulse(sawTerminal && !sawError ? "done" : "error");
      /* 流悄悄断了（网络/关页）没有终态帧：补一条错误气泡，不让「正在思考」悬空。 */
      if (!sawTerminal) {
        setThreads((current) => ({ ...current, [target]: applyEvent(current[target] ?? [], { type: "error", message: t("assistantDrawer.streamAborted") }) }));
      }
      /* 首条消息的服务端 topic 已落库：拉一次列表把下拉标签从时间戳换成摘要
         （fire-and-forget——标题是锦上添花，失败不重试，下次开抽屉自愈）。 */
      if (!hadTopic) {
        void api.assistantConversations().then(setConversations).catch(() => {});
      }
    });
  }

  async function stopGeneration() {
    /* 停的是在飞的回合（streamingId），不是当前显示的会话——中途切走也不停错地方。 */
    if (!streamingId) return;
    try {
      await api.stopAssistantConversation(streamingId);
      /* 上游停了之后流会自然收尾（终态帧）；这里不本地断流——半截回复留在气泡里
         比悄悄消失诚实。人物反应（2026-09-22）：用户主动叫停 = 摊手（shrug）。 */
      fireHeaderPulse("shrug");
    } catch (error) {
      errorToast(error, t("assistantDrawer.stopFailed"));
    }
  }

  /** 改偏好（本地指令 / 设置卡 / 头部快捷钮共用，P9-5）：服务端落库成功后本地生效
      ——主题走事件桥（useMode 仍是唯一持有者），语言走 i18n + localStorage（与系统
      管理页同一套持久化，两边互改互见）。 */
  async function applyPreference(input: Partial<Preferences>): Promise<boolean> {
    try {
      const next = await api.updatePreferences(input);
      setPrefs(next);
      if (input.theme) requestThemePreference(next.theme);
      if (input.language && next.language !== i18n.language) {
        localStorage.setItem("apitest.language", next.language);
        await i18n.changeLanguage(next.language);
      }
      return true;
    } catch (error) {
      message.error(apiMessage(error) ?? t("system.saveFailed"));
      return false;
    }
  }

  /* 头部快捷切换（2026-09-15 用户反馈：主题/语言不要藏在设置里）：循环三态/两态，
     落库走 applyPreference（与本地指令、设置卡同一条路——不因入口不同长出第二套
     持久化）。prefs 未加载时按钮置灰而不是猜当前值。 */
  const THEME_CYCLE: Preferences["theme"][] = ["light", "dark", "system"];
  function cycleTheme() {
    const current = prefs?.theme;
    if (!current) return;
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
    void applyPreference({ theme: next });
  }

  function toggleLanguage() {
    const next = (prefs?.language ?? i18n.language) === "en" ? "zh-CN" : "en";
    void applyPreference({ language: next });
  }

  /** 换一个形象（P9-6 边界 5）：写一个新 avatarSeed 到 preferences——不动
      users.id 语义（改名≠换人，本人主动换脸走偏好）；顶栏入口/抽屉头两档同步换。 */
  function rerollAvatar() {
    void applyPreference({ avatarSeed: newAvatarSeed() });
  }

  /** /打开 候选页的展示名（labelKey 走 i18n；Mock/MCP 是导航字面量）。 */
  function pageLabel(page: CommandPage): string {
    return page.labelKey ? i18n.t(page.labelKey) : page.label ?? page.key;
  }

  /** 本地指令执行（P9-5 边界 6）：命中即执行 + 回系统气泡，全程不碰上游。回执用
      i18n.t 而非渲染闭包的 t——语言指令切换后，回执要用新语言写。 */
  async function runLocalCommand(command: ParsedCommand) {
    if (command.type === "help") {
      appendLocalEntries([{
        role: "system",
        text: [
          i18n.t("assistantCmd.helpTitle"),
          i18n.t("assistantCmd.helpTheme"),
          i18n.t("assistantCmd.helpLanguage"),
          i18n.t("assistantCmd.helpOpen"),
          i18n.t("assistantCmd.helpProject"),
          i18n.t("assistantCmd.helpSettings"),
          i18n.t("assistantCmd.helpPassword"),
          i18n.t("assistantCmd.helpLogout"),
          i18n.t("assistantCmd.helpHelp"),
          i18n.t("assistantCmd.helpFooter"),
        ].join("\n"),
      }]);
      return;
    }
    if (command.type === "project") {
      appendLocalEntries([{ role: "system", text: projectId
        ? i18n.t("assistantCmd.projectInfo", { name: project?.name ?? projectId })
        : i18n.t("assistantCmd.projectNone") }]);
      return;
    }
    if (command.type === "settings") { setView("settings"); return; }
    if (command.type === "password") { setView("password"); return; }
    if (command.type === "logout") { confirmLogout(); return; }
    if (command.type === "theme") {
      if (!command.value) {
        appendLocalEntries([{ role: "system", text: i18n.t(command.rawValue ? "assistantCmd.themeInvalid" : "assistantCmd.themeUsage", { value: command.rawValue }) }]);
        return;
      }
      if (await applyPreference({ theme: command.value })) {
        appendLocalEntries([{ role: "system", text: i18n.t("assistantCmd.themeDone", { value: i18n.t(THEME_LABEL_KEY[command.value]) }) }]);
      }
      return;
    }
    if (command.type === "language") {
      if (!command.value) {
        appendLocalEntries([{ role: "system", text: i18n.t(command.rawValue ? "assistantCmd.languageInvalid" : "assistantCmd.languageUsage", { value: command.rawValue }) }]);
        return;
      }
      if (await applyPreference({ language: command.value })) {
        appendLocalEntries([{ role: "system", text: i18n.t("assistantCmd.languageDone", { value: LANGUAGE_LABEL[command.value] }) }]);
      }
      return;
    }
    /* /打开 <页面>：导航走 navGuard（未保存编辑先拦）；取消时留在原地给回执。
       对话用户级化后抽屉常驻全局页——项目页目标在没有项目上下文时给回执不猜
       （候选列表也只报全局页），回到项目内指令照常。 */
    if (!command.page) {
      const visiblePages = projectId ? COMMAND_PAGES : COMMAND_PAGES.filter((page) => page.global);
      const pages = (command.candidates.length ? command.candidates.filter((page) => projectId || page.global) : visiblePages).map(pageLabel).join("、");
      appendLocalEntries([{
        role: "system",
        text: i18n.t(command.rawValue ? (command.candidates.length ? "assistantCmd.openAmbiguous" : "assistantCmd.openUnknown") : "assistantCmd.openUsage", { value: command.rawValue, pages }),
      }]);
      return;
    }
    if (!command.page.global && !projectId) {
      appendLocalEntries([{ role: "system", text: i18n.t("assistantCmd.openNeedsProject") }]);
      return;
    }
    /* 个人中心不再是独立路由（P13-1：`/me` 删除，分区并入抽屉）：`/打开 个人中心`
       就地切 me 视图，不导航、不关抽屉——「打开个人中心」= 抽屉里翻到那一页。
       通知同理（2026-09-21）：`/打开 通知` 落抽屉自己的通知视图。 */
    if (command.page.key === "me") { openMe("profile"); return; }
    if (command.page.key === "notifications") { setView("notifications"); return; }
    /* 其余全局页目标是 `/${path}`（缺省 = key）；项目页带项目段。 */
    const to = command.page.global
      ? `/${command.page.path ?? command.page.key}`
      : `/projects/${projectId}/${command.page.key}`;
    if (await confirmLeave()) {
      setOpen(false);
      navigate(to);
    } else {
      appendLocalEntries([{ role: "system", text: i18n.t("assistantCmd.openCancelled") }]);
    }
  }

  /** 改密卡提交（P9-5 账号指令卡）：受控表单 → 既有 POST /auth/change-password，
      本人 JWT；pwd_epoch 语义与页面改密一致（服务端换发 token，renewSession 续命，
      其他设备下线）。密码只在这一次请求里旅行，不进消息流、不发上游（边界 14）。 */
  async function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    if (pwNext !== pwConfirm) { setPwError(i18n.t("changePassword.mismatch")); return; }
    setPwBusy(true);
    setPwError(undefined);
    try {
      const result = await api.changePassword(pwCurrent, pwNext);
      renewSession(result);
      setPwCurrent(""); setPwNext(""); setPwConfirm("");
      setView("chat");
      appendLocalEntries([{ role: "system", text: i18n.t("assistantPassword.done") }]);
      message.success(i18n.t("assistantPassword.done"));
    } catch (cause) {
      setPwError(apiMessage(cause) ?? i18n.t("changePassword.error"));
    } finally {
      setPwBusy(false);
    }
  }

  /** 删除会话（清理脏数据，2026-09-15 用户反馈）：删本地映射行 + 上游本体（协议
   *  配了 delete 端点时）。删当前显示的会话要顺带清消息桶与选择，回落到下一条。 */
  function removeConversation(conversation: AssistantConversation) {
    Modal.confirm({
      title: t("assistantDrawer.deleteTitle", { name: conversationLabel(conversation) }),
      content: t("assistantDrawer.deleteHint"),
      okText: t("action.delete"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.deleteAssistantConversation(conversation.id);
          setConversations((current) => current?.filter((row) => row.id !== conversation.id));
          setThreads((current) => {
            const next = { ...current };
            delete next[conversation.id];
            return next;
          });
          /* 删的是当前显示的会话：选择回落到列表里最近活跃的一条（没有则空态）。 */
          if (activeId === conversation.id) {
            const remaining = (conversations ?? []).filter((row) => row.id !== conversation.id);
            setActiveId(remaining[0]?.id);
          }
        } catch (error) {
          errorToast(error, t("assistantDrawer.deleteFailed"));
        }
      },
    });
  }

  /* ── 最近通知（2026-09-16 通知入口移入助手；2026-09-21 收回为唯一落点）─────────
     用户反馈「个人信息内删除通知跳转」：通知不再借道个人中心的分区，就在抽屉自己的
     `notifications` 视图里，行为与更早的铃铛下拉一致。 */

  /** 点通知 = 标已读 + 深链跳转（边界 10）：跳转走 navGuard 的 confirmLeave——从
      编辑页经通知深链离开时，未保存守卫照常拦截；标记失败不拦跳转（已读态是
      锦上添花，深链才是用户点它的原因）。 */
  async function openDrawerNotification(row: UserNotification) {
    setOpen(false);
    if (!(await confirmLeave())) return;
    if (!row.readAt) {
      void api.markNotificationRead(row.id).catch(() => {});
      useNotificationsStore.setState({ recent: notificationsRecent.map((item) => (item.id === row.id ? { ...item, readAt: new Date().toISOString() } : item)) });
      setNotificationsUnread(Math.max(0, notificationsUnread - 1));
    }
    if (row.link) navigate(row.link);
  }

  /** 全部已读：点了就清空，不等跳转；recent 行同步落已读态——计数清零但行还亮着
      未读点是自相矛盾的。 */
  function markAllDrawerRead() {
    const now = new Date().toISOString();
    useNotificationsStore.setState({ recent: notificationsRecent.map((row) => (row.readAt ? row : { ...row, readAt: now })) });
    void api.markAllNotificationsRead().then(() => setNotificationsUnread(0)).catch(() => {});
  }

  /** 保存我的 agent：明文参数整份替换，secret 三态（留空保持 / 填值设置 / 勾选清除）。 */
  async function saveAgent() {
    if (!settingsProviderId) return;
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(paramValues)) {
      if (value.trim()) params[key] = value.trim();
    }
    const secrets: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(secretValues)) {
      if (value) secrets[key] = value;
    }
    for (const [key, cleared] of Object.entries(clearSecrets)) {
      if (cleared) secrets[key] = null;
    }
    setSavingAgent(true);
    try {
      const saved = await api.putMyAssistantAgent(settingsProviderId, { params, secrets });
      setMyAgents((current) => [...(current ?? []).filter((agent) => agent.providerId !== saved.providerId), saved]);
      setSecretValues({});
      setClearSecrets({});
      message.success(t("assistantSettings.saved"));
      /* 配置变了，闸门状态可能从「未配置」翻到「就绪」：重探一次，回对话即用。 */
      void probeAssistantAvailability().then((state) => setAvailability(state));
    } catch (error) {
      message.error(apiMessage(error) ?? t("assistantSettings.saveFailed"));
    } finally {
      setSavingAgent(false);
    }
  }

  async function makeDefaultAgent() {
    if (!settingsProviderId) return;
    try {
      const saved = await api.setMyDefaultAssistantAgent(settingsProviderId);
      setMyAgents((current) => (current ?? []).map((agent) => ({ ...agent, isDefault: agent.providerId === saved.providerId })));
      message.success(t("assistantSettings.defaultSet"));
      void probeAssistantAvailability().then((state) => setAvailability(state));
    } catch (error) {
      message.error(apiMessage(error) ?? t("assistantSettings.saveFailed"));
    }
  }

  /** 测试我的 agent：用已保存的参数走真链路（建会话 + ping），结果内联回显。 */
  async function testAgent() {
    if (!settingsProviderId) return;
    setTestingAgent(true);
    setAgentTestResult(undefined);
    try {
      setAgentTestResult(await api.testMyAssistantAgent(settingsProviderId));
    } catch (error) {
      setAgentTestResult({ ok: false, detail: apiMessage(error) ?? t("assistantSettings.testFailed") });
    } finally {
      setTestingAgent(false);
    }
  }

  /** 登出确认卡（边界 6）：纯前端清 token 回登录页，零新路由；本地操作不经过 AI。 */
  function confirmLogout() {
    Modal.confirm({
      title: t("assistantDrawer.logoutConfirmTitle"),
      content: t("assistantDrawer.logoutConfirmHint"),
      okText: t("action.logout"),
      cancelText: t("action.cancel"),
      onOk: () => { logout(); navigate("/login"); },
    });
  }

  /** 采纳一个补全候选（点选与 Tab 共用）：指令位整段替换（insert 自带尾空格，补全
      完自然落到参数位、下一层候选直接出现）；参数位只换参数段、并收起浮层——参数
      挑完这一步就结束了。焦点回输入框：点选时焦点在候选按钮上。 */
  function acceptCommandCandidate(candidate: CommandCandidate) {
    if (!commandPalette) return;
    const next = commandPalette.position === "name" ? candidate.insert : `${commandPalette.prefix}${candidate.insert}`;
    setInput(next);
    setCmdDismissed(commandPalette.position === "argument");
    setCmdHighlight(0);
    inputRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    /* IME 组合中的按键属于输入法（Enter 选字、方向键翻页）：浮层一律让路，否则
       中文输入法里的上下键会去改高亮。 */
    if (event.nativeEvent.isComposing) return;
    if (commandPalette) {
      const count = commandPalette.candidates.length;
      if (event.key === "ArrowDown") { event.preventDefault(); setCmdHighlight((current) => (current + 1) % count); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setCmdHighlight((current) => (current - 1 + count) % count); return; }
      if (event.key === "Tab") { event.preventDefault(); acceptCommandCandidate(commandPalette.candidates[cmdHighlight]); return; }
      if (event.key === "Escape") { event.preventDefault(); setCmdDismissed(true); return; }
    }
    /* Enter 仍是「发送」而不是「采纳高亮」（13.3 回车直发兜底）：前缀命中的指令本来
       就按 parseCommand 执行，未命中的 `/xxx` 照旧作为消息发给 AI——浮层不抢占发送键，
       补全走 Tab。 */
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  /* 探测回「已关」（404）时收起入口——用户级路由正常不回 404，留着兜底网络竞态。 */
  if (availability === "disabled") return null;

  const chatReady = availability === "ready" || availability === undefined;

  return <>
    {/* 顶栏入口（2026-09-16 第二轮用户反馈：右下角圆钮改放原通知铃铛位）：
        portal 进两个壳 topbar-actions 各自的 #assistant-topbar-slot——壳互斥渲染，
        槽位同一时刻只存在一个；组件本体仍在 DockedShell 单挂载（切壳不断流、
        状态不清空）。按钮里是 30px 半身头像（静态眨眼只在抽屉打开时跑；登录/
        新通知到达时小跳一下）；未配置态 dashed 边照常表达状态。 */}
    {entrySlot && createPortal(
      <>
        {/* 功能说明文档入口（P13-3）：头像旁一枚，`_blank` 打开 `/docs`——文档是
            「离开当前活儿去查」的读物，新标签开才不打断手头的操作。用 <a> 而非
            按钮：中键 / ⌘+点击能另开标签是 `_blank` 该有的原生行为。 */}
        <Tip text={t("docs.openTip")}>
          <a
            className="assistant-entry docs-entry"
            href="/docs"
            target="_blank"
            rel="noreferrer"
            aria-label={t("docs.open")}
          >
            <BookOpen size={16} />
          </a>
        </Tip>
        <Tip text={availability === "unconfigured" ? t("assistantDrawer.unconfiguredTip") : undefined}>
          <button
            type="button"
            className={`assistant-entry${availability === "unconfigured" ? " is-unconfigured" : ""}`}
            aria-label={t("assistantDrawer.open")}
            onClick={() => setOpen(true)}
          >
            <Avatar seed={avatarSeed} size={30} framing="bust" pulse={dockPulse} nightmare={prefs?.avatarNightmare === true} />
            {/* 未读徽标（2026-09-16 通知入口移入助手）：顶栏铃铛撤掉后的存量未读
                入口；99+ 封顶——「很多」与「99+」读起来没有差别。 */}
            {notificationsLoaded && notificationsUnread > 0 && (
              <span className="assistant-entry-badge">{notificationsUnread > 99 ? "99+" : notificationsUnread}</span>
            )}
          </button>
        </Tip>
      </>,
      entrySlot,
    )}

    <Drawer
      rootClassName={`assistant-drawer${resizing ? " is-resizing" : ""}`}
      open={open}
      onClose={() => setOpen(false)}
      width={drawerWidth}
      title={<div className="assistant-identity">
        {/* P9-6：96px 全身像。眨眼仅在抽屉打开且无在飞请求时运行——Quiet Console
            全应用只允许一个环境动画，与在飞呼吸点不同时出现；人物反应（2026-09-16）：
            开抽屉打招呼 / 发消息低头看 / 回复完成欢呼 / 出错委屈，流式中是「想」的
            持续姿态（视线抬起）。 */}
        <Avatar
          className="assistant-avatar"
          seed={avatarSeed}
          size={96}
          framing="full"
          animate={open && !streaming}
          mood={streaming ? "thinking" : "idle"}
          pulse={headerPulse}
          nightmare={prefs?.avatarNightmare === true}
        />
        <div className="assistant-identity-main">
          <strong>{t(view === "settings" ? "assistantSettings.title" : view === "notifications" ? "notifications.title" : view === "me" ? "me.title" : "assistantDrawer.title")}</strong>
          {!chatReady && view === "chat" && <span className="muted" style={{ fontSize: 12 }}>{t("assistant.stateUnconfigured")}</span>}
        </div>
        {/* 个人中心 / 通知 / 换形象 / 主题 / 语言 / 登出（2026-09-16 通知入口随铃铛
            移入；P12-2 修订：顶栏右上角的「个人中心 + 退出」整对撤掉，改挂这里——
            账号级动作与通知/换形象/主题同属「我自己」的操作，收在头像这一排；抽屉
            全视图常驻，未配置 agent 时也在，登出不会因为没配 agent 就找不到）。
            P13-1：个人中心不再是独立 `/me` 页——「个人中心」钮就地翻到抽屉的 me 视图。
            2026-09-21 用户反馈：铃铛回到抽屉自己的通知视图（不再翻 me 的通知分区，
            个人中心里已没有通知这一格）。 */}
        <span className="assistant-quick-toggle">
          <IconButton
            icon={<UserRound size={14} />}
            label={t("me.title")}
            active={view === "me"}
            onClick={() => (view === "me" ? setView("chat") : openMe("profile"))}
          />
          <span className="assistant-bell">
            <IconButton
              icon={<Bell size={14} />}
              label={t("notifications.title")}
              active={view === "notifications"}
              onClick={() => setView(view === "notifications" ? "chat" : "notifications")}
            />
            {notificationsLoaded && notificationsUnread > 0 && <span className="assistant-bell-dot" aria-hidden />}
          </span>
          <IconButton
            icon={<Dices size={14} />}
            label={t("assistantDrawer.rerollAvatar")}
            onClick={rerollAvatar}
          />
          <IconButton
            icon={prefs?.theme === "light" ? <Sun size={14} /> : prefs?.theme === "dark" ? <Moon size={14} /> : <SunMoon size={14} />}
            label={`${t("assistantDrawer.theme")}：${prefs ? t(`assistantCmd.themeValue_${prefs.theme}`) : "—"}`}
            disabled={!prefs}
            onClick={cycleTheme}
          />
          <IconButton
            icon={<Languages size={14} />}
            label={`${t("assistantDrawer.language")}：${prefs?.language === "en" ? "English" : "中文"}`}
            disabled={!prefs}
            onClick={toggleLanguage}
          />
          {/* 登出：常红标记（`.btn.danger` 同款语义色用法——破坏性/离开动作），
              点开仍是确认卡（纯前端清 token，零新路由）。 */}
          <IconButton
            icon={<LogOut size={14} />}
            label={t("assistantDrawer.logout")}
            className="is-danger-mark"
            onClick={confirmLogout}
          />
        </span>
      </div>}
      styles={{ body: { padding: 0, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" } }}
    >
      {/* 左缘拖拽调宽（2026-09-15 用户反馈）：默认 70%，拖过存偏好，双击回默认。
          absolute 挂在 body 上（body 已 position:relative），盖在内容之上。 */}
      <div
        className={`assistant-resizer${resizing ? " is-active" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("assistantDrawer.resize")}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onLostPointerCapture={onResizeEnd}
        onDoubleClick={onResizeReset}
      />
      {view === "settings" ? <div className="assistant-settings">
        <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setView("chat")}>
          <ArrowLeft size={14} />{t("assistantSettings.back")}
        </button>

        {/* 个性化区已外置（2026-09-15 用户反馈）：主题/语言快捷钮在抽屉头右缘，
            与本地指令共用 applyPreference——设置卡不再放第二份入口。设置卡只剩
            「我的 agent」。 */}
        <p className="form-note">{t("assistantSettings.hint")}</p>

        {userProviders === undefined ? <p className="muted">{t("common.loading")}</p>
          : userProviders.length === 0 ? <p className="form-note">
            {isSystemAdmin ? t("assistant.unconfiguredAdminHint") : t("assistant.unconfiguredMemberHint")}
          </p>
          : <>
            <label className="field">
              <span>{t("assistantSettings.provider")}</span>
              <Select
                value={settingsProviderId}
                onChange={(id) => setSettingsProviderId(id)}
                options={userProviders.map((provider) => ({
                  value: provider.id,
                  label: `${provider.name}${myAgents?.some((agent) => agent.providerId === provider.id && agent.isDefault) ? " ★" : ""}`,
                }))}
                style={{ width: "100%" }}
              />
            </label>

            {settingsProvider && <>
              {settingsProvider.userParams.map((param) => renderParamField(param))}
              <div className="assistant-settings-actions">
                <button className="btn btn-primary" disabled={savingAgent} onClick={() => void saveAgent()}>
                  {savingAgent ? "…" : t("assistantSettings.save")}
                </button>
                {myAgentForSettings && !myAgentForSettings.isDefault && <button className="btn" onClick={() => void makeDefaultAgent()}>
                  {t("assistantSettings.setDefault")}
                </button>}
                {myAgentForSettings && <button className="btn" disabled={testingAgent} onClick={() => void testAgent()}>
                  {testingAgent ? "…" : t("assistantSettings.test")}
                </button>}
              </div>
              {agentTestResult && <p className={agentTestResult.ok ? "form-note" : "form-error"} style={{ whiteSpace: "pre-wrap" }}>
                {t(agentTestResult.ok ? "assistantSettings.testOk" : "assistantSettings.testFailed")}{agentTestResult.detail ? `：${agentTestResult.detail}` : ""}
              </p>}
            </>}
          </>}
      </div> : view === "password" ? <div className="assistant-settings">
        {/* 改密表单卡（P9-5 账号指令卡的卡片形态，边界 6/14）：抽屉内受控表单，
            既有 POST /auth/change-password + 本人 JWT，不再跳 /change-password 页。 */}
        <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setView("chat")}>
          <ArrowLeft size={14} />{t("assistantSettings.back")}
        </button>
        <p className="form-note">{t("assistantPassword.hint")}</p>
        <form className="assistant-password-form" onSubmit={submitPassword}>
          <label className="field">
            <span>{t("changePassword.current")}</span>
            <input className="input" type="password" autoComplete="current-password" required value={pwCurrent} onChange={(event) => setPwCurrent(event.target.value)} />
          </label>
          <label className="field">
            <span>{t("changePassword.next")}</span>
            <input className="input" type="password" autoComplete="new-password" required minLength={8} value={pwNext} onChange={(event) => setPwNext(event.target.value)} />
          </label>
          <label className="field">
            <span>{t("changePassword.confirm")}</span>
            <input className="input" type="password" autoComplete="new-password" required minLength={8} value={pwConfirm} onChange={(event) => setPwConfirm(event.target.value)} />
          </label>
          {pwError && <p className="form-error" role="alert">{pwError}</p>}
          <button className="btn btn-primary" type="submit" disabled={pwBusy} style={{ alignSelf: "flex-start" }}>
            {pwBusy ? "…" : t("changePassword.submit")}
          </button>
          <p className="form-note">{t("changePassword.note")}</p>
        </form>
      </div> : view === "notifications" ? <div className="assistant-notifications">
        {/* 最近通知（2026-09-16 通知入口移入助手；2026-09-21 用户反馈：个人中心不再
            有通知跳转，这里就是通知的唯一落点）。布局与 2026-09-16 的走查结论一致：
            头行 = 返回箭头带标题（面包屑式）+ 全部已读轻链接；列表吃满剩余高度自滚；
            行样式复用 bell-item 家族，行为与原铃铛一致——点行 = 标已读 + 深链。 */}
        <div className="assistant-notifications-head">
          <button type="button" className="assistant-notifications-back" onClick={() => setView("chat")}>
            <ArrowLeft size={14} />
            <strong>{t("notifications.title")}</strong>
          </button>
          {notificationsUnread > 0 && <button className="linkish" onClick={markAllDrawerRead}>{t("notifications.readAll")}</button>}
        </div>
        {!notificationsLoaded
          ? <div className="assistant-notifications-state"><p className="muted">{t("common.loading")}</p></div>
          : notificationsRecent.length
            ? <ul className="bell-list">
              {notificationsRecent.map((row) => (
                <li key={row.id}>
                  <button type="button" className={`bell-item${row.readAt ? "" : " is-unread"}`} onClick={() => void openDrawerNotification(row)}>
                    <span className="bell-item-dot" aria-hidden />
                    <span className="bell-item-main">
                      {/* 标题不省略、允许折行：长计划名/任务名截断后读不出「是什么」。 */}
                      <span className="bell-item-title">{row.title}</span>
                      <span className="mono muted bell-item-time">{formatNotificationWhen(row.createdAt, t)}</span>
                    </span>
                    {row.projectName && <span className="chip">{row.projectName}</span>}
                  </button>
                </li>
              ))}
            </ul>
            : <div className="assistant-notifications-state"><p className="muted">{t("notifications.empty")}</p></div>}
      </div> : view === "me" ? <div className="assistant-me">
        {/* 个人中心（P13-1：原独立 `/me` 页整体并入抽屉）：基本信息 / 我的申请 /
            MCP 凭证 / API Key 凭证 / agent 凭证（2026-09-26 拆「个人凭证」）。头部
            返回键与 MeCenter 的 tab 条都在滚动体之外——长内容（MCP Token）滚到底也
            不会把切 tab 的钮带走（2026-09-21 反馈）。 */}
        <div className="assistant-me-head">
          <button className="btn" onClick={() => setView("chat")}>
            <ArrowLeft size={14} />{t("assistantSettings.back")}
          </button>
        </div>
        <MeCenter tab={meTab} onTab={setMeTab} onConfigureAgent={openAgentSettings} />
      </div> : chatReady ? <>
        <div className="assistant-switcher">
          <Select
            value={activeId}
            onChange={(id) => { followRef.current = true; setActiveId(id); }}
            options={(conversations ?? []).map((conversation) => ({
              value: conversation.id,
              /* 选项带上游名（2026-09-26）：两个上游各有会话时，光看话题分不清谁绑的
                 是哪个上游。 */
              label: upstreamNames[conversation.providerId]
                ? `${conversationLabel(conversation)} · ${upstreamNames[conversation.providerId]}`
                : conversationLabel(conversation),
            }))}
            placeholder={t("assistantDrawer.switcherPlaceholder")}
            loading={conversations === undefined}
            disabled={!conversations?.length}
            style={{ flex: "1 1 auto", minWidth: 0 }}
          />
          {/* 当前会话绑定的上游（2026-09-26 用户反馈：聊天窗没展示当前选的 agent 上游）：
              会话创建时绑定、之后一直走它——hover 说清「换默认只影响新会话」。没选
              会话时显示「新会话」会用的默认上游。 */}
          {activeConversation ? (
            <span className="chip mono truncate" title={t("assistantDrawer.upstreamHint")} style={{ maxWidth: 180 }}>
              {t("assistantDrawer.upstream")}：{upstreamNames[activeConversation.providerId] ?? t("assistantDrawer.upstreamUnknown")}
            </span>
          ) : !activeId && defaultUpstream ? (
            <span className="chip mono truncate" title={t("assistantDrawer.upstreamNewHint")} style={{ maxWidth: 180 }}>
              {t("assistantDrawer.upstreamNew", { name: defaultUpstream.name })}
            </span>
          ) : null}
          {/* 删除当前会话（清脏数据）：图标钮随选择器，空列表不渲染。对话用户级化
              （2026-09-16）后会话是本人的，不看项目角色。 */}
          {activeId && conversations?.some((row) => row.id === activeId) && (
            <IconButton
              icon={<Trash2 size={14} />}
              label={t("assistantDrawer.deleteConversation")}
              tone="danger"
              onClick={() => {
                const target = conversations!.find((row) => row.id === activeId);
                if (target) removeConversation(target);
              }}
            />
          )}
        </div>

        <div ref={scrollRef} className="assistant-messages" onScroll={onScroll}>
          {historyState === "unavailable" && <p className="assistant-note muted">{t("assistantDrawer.historyUnavailable")}</p>}
          {entries.length ? entries.map((entry, index) => {
            /* 本地系统回执（P9-5）：指令执行结果 / 拦截提示——界面自己在说话，
               不是对话方，样式与用户/助手气泡都拉开。 */
            if (entry.role === "system") {
              return <div key={index} className="chat-entry chat-entry-system">
                <div className="chat-system">{entry.text}</div>
              </div>;
            }
            if (entry.role === "user") {
              return <div key={index} className="chat-entry chat-entry-user">
                <div className="chat-bubble chat-bubble-user">{entry.text}</div>
              </div>;
            }
            return (
              <div key={index} className="chat-entry chat-entry-assistant">
                {entry.blocks.map((block, blockIndex) => block.kind === "tool" ? (
                  /* 工具行如实显示 name · status（门槛 3），与 provider 测试回显同一套
                     图标语汇（⟐ + mono）。 */
                  <div key={blockIndex} className="chat-tool mono">⟐ {block.name} · {block.status}</div>
                ) : block.kind === "error" ? (
                  <div key={blockIndex} className="chat-error">{block.code ? t(ASSISTANT_ERROR_KEYS[block.code]) : block.text}</div>
                ) : block.kind === "elicit" ? (
                  /* MRTR 确认表单卡（2026-09-15）：删除类工具的「二次确认」——原文 +
                     后果 + 确认/放弃；确认走本人 JWT 的既有 REST，落定后平台侧留
                     记录（settleElicit）。conversationId 取渲染时的 activeId——卡
                     片只在正显示的会话里可点。 */
                  <AssistantElicitationCard
                    key={blockIndex}
                    projectId={projectId}
                    block={block}
                    settled={elicitStates[elicitKey(block)]}
                    canWrite={Boolean(projectId) && canWrite}
                    onSettled={(state) => settleElicit(block, state, activeId)}
                  />
                ) : (
                  renderAssistantText(block.text, blockIndex)
                ))}
              {/* 等待首 token：在飞请求的呼吸点（busy 家族，在飞请求的唯一环境动画）。 */}
              {entry.streaming && !entry.blocks.some((block) => block.kind === "text") && (
                <span className="chat-waiting"><span className="chat-waiting-dot" aria-hidden />{t("assistantDrawer.waiting")}</span>
              )}
            </div>
            );
          }) : historyState === "loading" ? (
            <div className="assistant-empty"><p className="muted">{t("assistantDrawer.loadingHistory")}</p></div>
          ) : historyState === "failed" ? (
            <div className="assistant-empty">
              <p className="form-error">{t("assistantDrawer.historyFailed")}</p>
              <button className="btn" onClick={() => setHistoryNonce((nonce) => nonce + 1)}>{t("assistantDrawer.historyRetry")}</button>
            </div>
          ) : (
            <div className="assistant-empty">
              <strong>{t("assistantDrawer.emptyTitle", { name: greetingName })}</strong>
              <p className="muted">{t("assistantDrawer.emptyHint")}</p>
              {/* 本地指令的显式入口（2026-09-15 用户反馈：别让人打字发现指令）——
                  点按钮 = 执行 /帮助，指令表落系统气泡。 */}
              <button type="button" className="btn" onClick={() => void runLocalCommand({ type: "help" })}>
                {t("assistantDrawer.commandHint")}
              </button>
              <button className="btn btn-primary" disabled={creating} onClick={() => void createConversation()}>{t("assistantDrawer.newConversation")}</button>
            </div>
          )}
        </div>

        {/* 上下文 chip（P9-4c）：随消息带上「当前页面 + 正在看什么」——摘要常驻可见，
            点开看全量 JSON，「本条不带」临时关掉。用户看得见 agent 会拿到什么。
            全局页没有页面上下文（pageContext 由项目页喂），无物可带就不渲染。 */}
        {pageContext && <div className={`assistant-context${skipContext ? " is-off" : ""}`}>
          <button type="button" className="assistant-context-main" onClick={() => setContextOpen((open) => !open)}>
            <MapPin size={12} />
            <span>{t("assistantDrawer.context")}</span>
            <span className="mono">{contextSummary(pageContext) || sentContext.page}</span>
          </button>
          <button
            type="button"
            className="assistant-context-toggle"
            aria-pressed={skipContext}
            title={t("assistantDrawer.contextSkipped")}
            onClick={() => setSkipContext((off) => !off)}
          >
            {t("assistantDrawer.contextOff")}
          </button>
          {contextOpen && <pre className="assistant-context-json mono">{JSON.stringify(sentContext, null, 2)}</pre>}
        </div>}

        {/* 快捷 chips（边界 6）：显式入口不靠猜意图。对话用户级化（2026-09-16）后
            新会话不看项目角色；设置 = 个性化 + 我的 agent 配置卡（P9-4b 起在抽屉
            内）；改密码 P9-5 起为抽屉内受控表单卡（不再跳页面）。登出 = 与抽屉头
            那枚同名同动作（头行常驻、这枚在对话视图里顺手；标记常红）。 */}
        <div className="assistant-chips">
          <button type="button" className="assistant-chip" disabled={creating} onClick={() => void createConversation()}>
            <Plus size={12} />{t("assistantDrawer.newConversation")}
          </button>
          <button type="button" className="assistant-chip" onClick={() => setView("settings")}>
            <Settings size={12} />{t("assistantDrawer.settings")}
          </button>
          <button type="button" className="assistant-chip" onClick={() => setView("password")}>
            <KeyRound size={12} />{t("assistantDrawer.changePassword")}
          </button>
          <button type="button" className="assistant-chip is-danger" onClick={confirmLogout}>
            <LogOut size={12} />{t("assistantDrawer.logout")}
          </button>
        </div>

        <div className="assistant-input-area">
          {/* 输入即识别（P9-5 增补）：候选浮层贴在输入框上方——抽屉底部是稳定容器，
              不需要 VariableField 那套视口坐标与上下翻转。候选行两列（mono 补全文本 +
              说明），键盘 ↑↓ 选、Tab 补全、点选等价于 Tab；Enter 仍是发送（见 onKeyDown）。 */}
          {commandPalette && <div className="assistant-cmd-pop" role="listbox" aria-label={t("assistantCmd.paletteTitle")}>
            {commandPalette.candidates.map((candidate, index) => (
              <button
                key={`${index}:${candidate.insert}`}
                type="button"
                role="option"
                aria-selected={index === cmdHighlight}
                className={`assistant-cmd-item${index === cmdHighlight ? " is-active" : ""}`}
                /* mousedown 而不是 click：失焦会先把浮层收掉，click 永远落不上。 */
                onMouseDown={(event) => { event.preventDefault(); acceptCommandCandidate(candidate); }}
                onMouseEnter={() => setCmdHighlight(index)}
              >
                <span className="mono assistant-cmd-insert">{candidate.insert.trim()}</span>
                <span className="assistant-cmd-label">{candidate.labelKey ? t(candidate.labelKey) : candidate.label}</span>
                {(candidate.hintKey || candidate.hint) && <span className="mono muted truncate">{candidate.hintKey ? t(candidate.hintKey) : candidate.hint}</span>}
              </button>
            ))}
            <p className="assistant-cmd-foot">{t("assistantCmd.paletteHint")}</p>
          </div>}
          <div className="assistant-inputrow">
            <textarea
              ref={inputRef}
              className="input assistant-input"
              rows={1}
              value={input}
              placeholder={t("assistantDrawer.placeholder")}
              /* 打字即重新武装浮层（Escape 收起后不再弹）。 */
              onChange={(event) => { setInput(event.target.value); setCmdDismissed(false); }}
              onInput={(event) => autoresize(event.currentTarget)}
              onKeyDown={onKeyDown}
            />
            {/* 停止按钮按协议形状显隐（门槛 13）；没定义 stop 端点的 provider 只有发送置灰。 */}
            {streaming && stopCapable && <IconButton icon={<Square size={14} />} label={t("assistantDrawer.stop")} onClick={() => void stopGeneration()} />}
            <IconButton icon={<Send size={14} />} label={t("assistantDrawer.send")} tone="primary" disabled={streaming || !input.trim()} onClick={() => void send()} />
          </div>
        </div>
      </> : <div className="assistant-guidance">
        {/* 未配置引导（503/2005 的用户级落点，P9-4b）：成因两味——平台有上游而我没配
            （常态：直接进设置卡，别把人指去系统管理）；平台一个上游都没有（找系统
            管理员，系统管理员给直达入口）。目录还没查回来时按钮先行（设置卡自己
            会给空态文案），不让引导块闪「找管理员」再翻脸。 */}
        {catalogState === "empty" ? <>
          <p className="form-note">{isSystemAdmin ? t("assistant.unconfiguredAdminHint") : t("assistant.unconfiguredMemberHint")}</p>
          {isSystemAdmin && <button className="btn" onClick={() => { setOpen(false); void (async () => { if (await confirmLeave()) navigate("/system"); })(); }}>{t("assistant.goProviders")}</button>}
        </> : <>
          <p className="form-note">{t("assistantDrawer.setupHint")}</p>
          <button className="btn btn-primary" onClick={() => setView("settings")}>{t("assistantDrawer.setupAction")}</button>
        </>}
      </div>}
    </Drawer>
  </>;

  /** assistant 文本块渲染（P9-5）：完整 `apitest-proposal` 围栏切成预览卡，围栏外
      仍是 markdown；无围栏走原路径（不付切分开销）。未闭合围栏（流式到一半）留在
      文本里按代码块渲染，token 到齐自然收敛成卡。 */
  function renderAssistantText(text: string, key: number) {
    const segments = splitProposalSegments(text);
    if (!segments.some((segment) => segment.type === "proposal")) {
      return <div key={key} className="chat-bubble chat-bubble-assistant"><AssistantMarkdown text={text} /></div>;
    }
    return <div key={key} className="chat-proposal-group">
      {segments.map((segment, index) => segment.type === "text"
        ? (segment.text
          ? <div key={index} className="chat-bubble chat-bubble-assistant"><AssistantMarkdown text={segment.text} /></div>
          : null)
        : <AssistantProposalCard
          key={segment.key}
          projectId={projectId}
          proposal={segment.proposal}
          settled={proposalStates[segment.key]}
          canWrite={Boolean(projectId) && canWrite}
          onSettled={(state) => setProposalStates((current) => ({ ...current, [segment.key]: state }))}
        />)}
    </div>;
  }

  /** 参数字段：明文参数普通输入；secret 三态（已配置提示留空保持 / 填值覆盖 / 清除）。 */
  function renderParamField(param: AssistantUserParam) {
    const configured = myAgentForSettings?.secretKeys.includes(param.key);
    if (!param.secret) {
      return <label key={param.key} className="field">
        <span>{param.label}{param.required ? " *" : ""}</span>
        <input
          className="input mono"
          value={paramValues[param.key] ?? ""}
          onChange={(event) => setParamValues((current) => ({ ...current, [param.key]: event.target.value }))}
          placeholder={param.placeholder ?? ""}
        />
      </label>;
    }
    return <div key={param.key}>
      <label className="field">
        <span>{param.label}{param.required ? " *" : ""}</span>
        <input
          className="input mono"
          type="password"
          value={secretValues[param.key] ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            setSecretValues((current) => ({ ...current, [param.key]: value }));
            if (value) setClearSecrets((current) => ({ ...current, [param.key]: false }));
          }}
          placeholder={configured ? t("assistantSettings.secretKeepPlaceholder") : (param.placeholder ?? "")}
        />
      </label>
      {configured && <label className="check-field" style={{ marginBottom: "var(--s2)" }}>
        <input
          type="checkbox"
          checked={clearSecrets[param.key] === true}
          onChange={(event) => {
            const checked = event.target.checked;
            setClearSecrets((current) => ({ ...current, [param.key]: checked }));
            if (checked) setSecretValues((current) => ({ ...current, [param.key]: "" }));
          }}
        />
        {t("assistantSettings.secretClear")}
      </label>}
    </div>;
  }
}
