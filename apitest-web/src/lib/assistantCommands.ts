/**
 * 站内助手的本地指令表（P9-5，计划 13.0 边界 6）：`/主题 深色`、`/语言 en`、
 * `/打开 接口管理`、`/项目`、`/设置`、`/改密码`、`/登出`、`/帮助`——前缀匹配命中
 * 即本地执行、回系统气泡，**不经过外部 agent**（agent 平台停机仍可用，门槛 5）；
 * 未命中的 `/` 开头输入按自然语言直发上游（回车直发兜底，13.3）。
 *
 * 本模块只做解析：纯函数、无 React / i18n 依赖。执行（导航 / 改偏好 / 切视图 /
 * 登出）在 AssistantDock——指令表是数据，副作用归调用方。
 *
 * 另含**敏感意图拦截**（边界 6/14）：含密码 / 登出等账号词的消息本地拦截引导到
 * 卡片、不转发上游——密码不进消息流、不发 agent，改密走本人 JWT 的受控表单卡。
 */

export type ThemeValue = "light" | "dark" | "system";
export type LanguageValue = "zh-CN" | "en";

/** `/打开` 的目标页：labelKey 走 i18n（导航同名键；Mock/MCP 导航本身就是字面量，
 *  没有 i18n 键，用 label 直给），别名中英双语都收——切了语言也能用旧语言唤出
 *  页面。global = 全局层路由（不含项目段）。`path` 只在目标路由与 key 不同时写。
 *  P13-1 起个人中心（`me`）与通知（`notifications`）不再是路由——`/打开` 命中这两个
 *  key 时由 AssistantDock 就地切抽屉的 me 视图分区，不走导航（见 runLocalCommand）。 */
export type CommandPage = {
  key: string;
  /** 全局层目标路由；缺省 = `/${key}`。 */
  path?: string;
  global?: boolean;
  labelKey?: string;
  label?: string;
  aliases: string[];
};

/** 项目层 15 页 + 全局 5 页（与 ProjectShell 导航 / 全局路由一一对应）。 */
export const COMMAND_PAGES: CommandPage[] = [
  { key: "spec-cases", labelKey: "nav.specCases", aliases: ["用例", "用例库", "文本用例", "文本用例库", "spec-cases", "cases"] },
  { key: "test-plans", labelKey: "nav.testPlans", aliases: ["测试计划", "计划", "test-plans", "plans"] },
  { key: "endpoints", labelKey: "nav.endpoints", aliases: ["接口", "接口管理", "endpoints", "api"] },
  { key: "flows", labelKey: "nav.flows", aliases: ["流程", "流程编排", "flows"] },
  { key: "suites", labelKey: "nav.suites", aliases: ["套件", "测试套件", "suites"] },
  { key: "repo", labelKey: "nav.repoMode", aliases: ["仓库", "仓库模式", "ci", "repo"] },
  { key: "environments", labelKey: "nav.environments", aliases: ["环境", "环境管理", "环境变量", "environments", "env"] },
  { key: "data-sources", labelKey: "nav.dataSources", aliases: ["数据源", "data-sources", "datasources"] },
  { key: "mocks", label: "Mock", aliases: ["mock", "mocks", "mock服务"] },
  { key: "reports", labelKey: "nav.reports", aliases: ["报告", "执行记录", "reports", "executions"] },
  { key: "suite-reports", labelKey: "nav.suiteReports", aliases: ["套件报告", "报告列表", "suite-reports", "suite reports"] },
  { key: "trends", labelKey: "nav.trends", aliases: ["统计", "数据统计", "趋势", "trends"] },
  { key: "alerts", labelKey: "nav.alerts", aliases: ["告警", "告警通知", "告警规则", "alerts"] },
  { key: "members", labelKey: "nav.members", aliases: ["成员", "成员管理", "成员与权限", "members"] },
  { key: "mcp", label: "MCP", aliases: ["mcp"] },
  { key: "dashboard", global: true, labelKey: "nav.dashboard", aliases: ["看板", "数据看板", "dashboard"] },
  { key: "projects", global: true, labelKey: "nav.projects", aliases: ["项目", "项目管理", "projects"] },
  { key: "system", global: true, labelKey: "nav.system", aliases: ["系统", "系统管理", "system"] },
  /* P13-1：me / notifications 不再有路由（并入抽屉 me 视图），global 仅表「全局层
     可用」——命中后 AssistantDock 就地切分区，不拼 path。 */
  { key: "me", global: true, labelKey: "me.title", aliases: ["个人中心", "我的", "账号", "me", "profile", "account"] },
  { key: "notifications", global: true, labelKey: "notifications.title", aliases: ["通知", "通知中心", "notifications"] },
];

/** 指令名（中英双语）。解析按前缀：`/主` 命中 主题；`/p` 同时是 project/password
 *  的前缀 → 歧义回执让用户补全，不猜。 */
const COMMANDS = [
  { type: "theme", names: ["主题", "theme"] },
  { type: "language", names: ["语言", "lang", "language"] },
  { type: "open", names: ["打开", "open", "goto"] },
  { type: "project", names: ["项目", "project"] },
  { type: "settings", names: ["设置", "settings"] },
  { type: "password", names: ["改密码", "password", "passwd"] },
  { type: "logout", names: ["登出", "logout"] },
  { type: "help", names: ["帮助", "help", "?"] },
] as const;

export type CommandType = (typeof COMMANDS)[number]["type"];

/** 每个变体的 type 都是单一字面量（判别式收窄的前提：联合判别式成员的 `===`
 *  负分支拆不掉成员，TS 收窄会失效—— AssistantDock 的 fall-through 推导不了
 *  open 变体）。 */
export type ParsedCommand =
  | { type: "theme"; value?: ThemeValue; rawValue: string }
  | { type: "language"; value?: LanguageValue; rawValue: string }
  | { type: "open"; page?: CommandPage; candidates: CommandPage[]; rawValue: string }
  | { type: "project" }
  | { type: "settings" }
  | { type: "password" }
  | { type: "logout" }
  | { type: "help" };

export type CommandParseResult =
  | { status: "matched"; command: ParsedCommand }
  /** 指令名前缀命中多条：回执列出候选，不执行。 */
  | { status: "ambiguous"; token: string; candidates: string[] }
  /** 不是已知指令：按自然语言直发上游。 */
  | { status: "unmatched" };

const THEME_ALIASES: [ThemeValue, string[]][] = [
  ["dark", ["深色", "暗色", "夜间", "dark", "d"]],
  ["light", ["浅色", "亮色", "白天", "light", "l"]],
  ["system", ["系统", "跟随系统", "自动", "system", "auto", "s"]],
];

const LANGUAGE_ALIASES: [LanguageValue, string[]][] = [
  ["zh-CN", ["中文", "汉语", "zh", "zh-cn", "zh_cn", "cn", "chinese"]],
  ["en", ["英文", "英语", "en", "english"]],
];

function aliasValue<T extends string>(table: [T, string[]][], raw: string): T | undefined {
  const value = raw.trim().toLowerCase();
  return table.find(([, aliases]) => aliases.includes(value))?.[0];
}

/** 页面匹配：先精确（别名或路由段），再前缀；多命中交回候选让用户选，不猜。 */
function matchPage(raw: string): { page?: CommandPage; candidates: CommandPage[] } {
  const value = raw.trim().toLowerCase();
  if (!value) return { candidates: [] };
  const exact = COMMAND_PAGES.filter((page) => page.aliases.includes(value) || page.key === value);
  if (exact.length === 1) return { page: exact[0], candidates: [] };
  if (exact.length > 1) return { candidates: exact };
  const prefixed = COMMAND_PAGES.filter((page) => page.aliases.some((alias) => alias.startsWith(value)) || page.key.startsWith(value));
  if (prefixed.length === 1) return { page: prefixed[0], candidates: [] };
  return { candidates: prefixed };
}

/**
 * 解析一条输入是否本地指令。不抛错、不发请求；`/` 单独一个字符视为 `/帮助`
 * （新用户的第一个 `/` 应该看到指令表，而不是「未命中」直发上游）。
 */
export function parseCommand(text: string): CommandParseResult {
  if (!text.startsWith("/")) return { status: "unmatched" };
  const [token = "", ...rest] = text.slice(1).split(/\s+/);
  const argument = rest.join(" ").trim();
  const normalized = token.toLowerCase();
  if (!normalized) return { status: "matched", command: { type: "help" } };
  const hits = COMMANDS.filter((command) => command.names.some((name) => name === normalized || name.startsWith(normalized)));
  if (hits.length === 0) return { status: "unmatched" };
  if (hits.length > 1) {
    return {
      status: "ambiguous",
      token: normalized,
      candidates: hits.flatMap((command) => command.names),
    };
  }
  const type = hits[0].type;
  if (type === "theme") return { status: "matched", command: { type, value: aliasValue(THEME_ALIASES, argument), rawValue: argument } };
  if (type === "language") return { status: "matched", command: { type, value: aliasValue(LANGUAGE_ALIASES, argument), rawValue: argument } };
  if (type === "open") {
    const { page, candidates } = matchPage(argument);
    return { status: "matched", command: { type, page, candidates, rawValue: argument } };
  }
  return { status: "matched", command: { type } };
}

/* ── 输入即识别（P9-5 增补，2026-09-16 用户要求）────────────────────────────
 * 发送时才解析（parseCommand）对老手够用，对新用户等于「指令不可见」：得先知道
 * 指令名才打得出来。这里给出**输入过程中**的补全候选——输入框上方浮层，指令名与
 * 参数（主题值 / 语言值 / 页面名）都能边打边挑。
 *
 * 与 parseCommand 共用同一套匹配谓词（`name === token || name.startsWith(token)`），
 * 这是刻意的：浮层里出现的候选**就是**回车时会命中的那几条，两边永不打架。
 * 补全结果的语言跟界面走（中文界面补 `/主题`，英文界面补 `/theme`）。
 */

/** 补全候选：`insert` 是写进输入框的文本，展示列说「这是什么」。labelKey/label 是
 *  CommandPage 同款二元——Mock / MCP 这类导航名本身就是字面量，没有 i18n 键。 */
export type CommandCandidate = {
  insert: string;
  labelKey?: string;
  label?: string;
  /** 参数形状提示（`/主题` 后面能填什么）；无参数指令没有这一列。 */
  hintKey?: string;
  hint?: string;
};

export type CommandCompletion =
  /** 指令位：insert 带尾空格，补全后自然落到参数位（下一层候选顺理成章）。 */
  | { position: "name"; candidates: CommandCandidate[] }
  /** 参数位：prefix 是保留的「/主题 」前缀，补全只换参数段。 */
  | { position: "argument"; prefix: string; candidates: CommandCandidate[] };

export type CompletionContext = {
  /** 界面语言（i18n.language）：决定补全结果用中文名还是 ASCII 名。 */
  locale: string;
  /** 有没有项目上下文：没有时 `/打开` 只报全局页（与回执同口径，不推打不开的页）。 */
  hasProject: boolean;
};

/** 候选上限（VariableField 的 MAX_SUGGESTIONS 同款取舍）：浮层是提示不是菜单，
 *  输入继续收敛几笔就到位；一次铺 19 个页面只会挡住消息流。 */
const MAX_CANDIDATES = 8;

const COMMAND_LABEL_KEY: Record<CommandType, string> = {
  theme: "assistantCmd.cmdTheme",
  language: "assistantCmd.cmdLanguage",
  open: "assistantCmd.cmdOpen",
  project: "assistantCmd.cmdProject",
  settings: "assistantCmd.cmdSettings",
  password: "assistantCmd.cmdPassword",
  logout: "assistantCmd.cmdLogout",
  help: "assistantCmd.cmdHelp",
};

const COMMAND_HINT_KEY: Partial<Record<CommandType, string>> = {
  theme: "assistantCmd.hintTheme",
  language: "assistantCmd.hintLanguage",
  open: "assistantCmd.hintOpen",
};

/** 别名里挑一个用于补全：中文界面给中文名，其余给 ASCII 名（`/主题` 与 `/theme`
 *  等价，但界面是英文时补出 `/主题` 会突兀）。**已经打对了就别改**——用户打了
 *  `/接口管理`，Tab 之后被改写成 `/接口` 是把他的输入偷偷换掉。 */
function preferredName(names: readonly string[], locale: string): string {
  if (locale.toLowerCase().startsWith("zh")) return names[0];
  return names.find((name) => /^[a-z0-9?]/i.test(name)) ?? names[0];
}

function bestName(names: readonly string[], typed: string, locale: string): string {
  const value = typed.trim().toLowerCase();
  return names.find((name) => name.toLowerCase() === value) ?? preferredName(names, locale);
}

/** 值型参数（主题 / 语言）的候选：按已输入片段过滤别名，展示标签走 i18n 键。 */
function valueCandidates(
  term: string,
  table: [string, string[]][],
  labelKeyOf: (value: string) => string,
  locale: string,
): CommandCandidate[] {
  const value = term.trim().toLowerCase();
  return table
    .filter(([, aliases]) => !value || aliases.some((alias) => {
      const candidate = alias.toLowerCase();
      return candidate.startsWith(value) || candidate.includes(value);
    }))
    .slice(0, MAX_CANDIDATES)
    .map(([key, aliases]) => ({ insert: bestName(aliases, term, locale), labelKey: labelKeyOf(key) }));
}

/**
 * 按当前输入算补全候选。不抛错、不发请求；返回 undefined = 不在命令语境
 * （不以 `/` 开头，或 Shift+Enter 换行之后——指令是单行事物）。
 * 候选为空数组时调用方收起浮层：未命中的 `/xxx` 仍按自然语言直发上游（13.3）。
 */
export function completeCommand(text: string, context: CompletionContext): CommandCompletion | undefined {
  if (!text.startsWith("/")) return undefined;
  const rest = text.slice(1);
  if (rest.includes("\n")) return undefined;
  /* 空格是指令名与参数的分界（与 parseCommand 的 split 同源）。 */
  const separator = rest.search(/\s/);
  const token = (separator < 0 ? rest : rest.slice(0, separator)).toLowerCase();
  const argument = separator < 0 ? undefined : rest.slice(separator).trim();

  const hits = COMMANDS.filter((command) => command.names.some((name) => name === token || name.startsWith(token)));
  /* 命中多条（含空前缀的全表）或一条都没命中：停在指令位——多候选让用户挑，
     没候选由调用方收起。只有**恰好一条且已经进入参数段**才换到参数候选。 */
  if (hits.length !== 1 || argument === undefined) {
    return {
      position: "name",
      candidates: hits.slice(0, MAX_CANDIDATES).map((command) => {
        const hintKey = COMMAND_HINT_KEY[command.type];
        return {
          insert: `/${bestName(command.names, token, context.locale)} `,
          labelKey: COMMAND_LABEL_KEY[command.type],
          ...(hintKey ? { hintKey } : {}),
        };
      }),
    };
  }

  const prefix = `/${token} `;
  const type = hits[0].type;
  if (type === "theme") {
    return { position: "argument", prefix, candidates: valueCandidates(argument, THEME_ALIASES, (value) => `assistantCmd.themeValue_${value}`, context.locale) };
  }
  if (type === "language") {
    return {
      position: "argument",
      prefix,
      candidates: valueCandidates(argument, LANGUAGE_ALIASES, (value) => `assistantCmd.langValue_${value === "zh-CN" ? "zh" : "en"}`, context.locale),
    };
  }
  if (type === "open") {
    const value = argument.toLowerCase();
    const candidates = COMMAND_PAGES
      .filter((page) => context.hasProject || page.global)
      .filter((page) => !value || page.key.toLowerCase().startsWith(value)
        || page.aliases.some((alias) => {
          const candidate = alias.toLowerCase();
          return candidate.startsWith(value) || candidate.includes(value);
        }))
      .slice(0, MAX_CANDIDATES)
      .map((page) => ({
        insert: bestName(page.aliases, argument, context.locale),
        ...(page.labelKey ? { labelKey: page.labelKey } : { label: page.label ?? page.key }),
      }));
    return { position: "argument", prefix, candidates };
  }
  /* 无参数指令（项目 / 设置 / 改密码 / 登出 / 帮助）：参数位没有可补的东西。 */
  return { position: "argument", prefix, candidates: [] };
}

/* ── 敏感意图拦截（边界 6/14）───────────────────────────────────────────────
 * 含账号词（密码 / 登出等）的消息不转发上游：账号操作全走本地通道，密码不进
 * 消息流。判定分三档——明确的改密意图（开卡）、明确的登出意图（确认卡）、
 * 仅含账号词（拦截 + 指引，改措辞后可继续与 AI 聊其他内容）。
 * 正则全部不带 g 标志（.test 无 lastIndex 状态问题）。 */

const ACCOUNT_WORDS = /密码|口令|passwd|password|登出|退出登录|注销|logout|log\s?out|sign\s?out/i;
const PASSWORD_INTENT = /(?:改|修改|更换|换|重置|更新|设置).{0,8}(?:密码|口令|passwd|password)|(?:密码|口令).{0,8}(?:改|换|不对|忘了|忘记)|(?:password|passwd)[\w\s]{0,16}(?:change|reset|update)/i;
const LOGOUT_INTENT = /登出|退出登录|注销|logout|log\s?out|sign\s?out/i;

export type AccountInterception = { kind: "password" } | { kind: "logout" } | { kind: "generic" };

/** 非指令消息的账号词拦截：命中返回分档，未命中返回 undefined（正常发上游）。 */
export function interceptAccountMessage(text: string): AccountInterception | undefined {
  if (!ACCOUNT_WORDS.test(text)) return undefined;
  if (PASSWORD_INTENT.test(text)) return { kind: "password" };
  if (LOGOUT_INTENT.test(text)) return { kind: "logout" };
  return { kind: "generic" };
}
