import { randomUUID } from "node:crypto";
import { ZipWriter } from "./zipWriter.js";

/**
 * XMind 工作簿**导出**（2026-09-08 用户要求，11.6 后置项的「导出」半边——
 * 不做回写合并：导出的是平台真值的快照，「平台改了、源文件也改了」的合并
 * 冲突不在本批）。
 *
 * **格式按最新版（2026-09-08 实测语料解剖定案）**：首版导出缺 `manifest.json`
 * 与 `structureClass`，真实 XMind（Vana 26.x）打开即报「文件已损坏」。解剖
 * `~/Desktop/work/case` 最新六份语料（全部 2025-06 后保存）得到的确切形态：
 *
 * - zip：**全部条目 STORE**（新版 XMind 不做 zip 级压缩）；条目 = `content.json`
 *   + `metadata.json` + `manifest.json`（`Thumbnails/` 与兼容用 `content.xml`
 *   可选——后者不在 manifest 里，是给 XMind 8 回读的赠品，不写）。
 * - `manifest.json`：`{"file-entries":{"content.json":{},"metadata.json":{}}}`
 *   ——只列实际存在的文件，缺 manifest 是打开失败的主因。
 * - `metadata.json`：`{"dataStructureVersion":"2","creator":{…},
 *   "layoutEngineVersion":"4"}`（新版没有 activeSheetId，缺省第一张）。
 * - `content.json`：sheet `{id, revisionId?, class:"sheet", title, rootTopic}`；
 *   rootTopic 带 `class:"topic"` + `structureClass:"org.xmind.ui.logic.right"`；
 *   **子主题只有 `{id, title, children}`**（不带 class——照语料逐字段对齐）；
 *   `markers` / `labels` / `notes` 只在非空时写。theme / extensions / style
 *   是样式赠品，不写（XMind 套默认主题）。
 *
 * **回导闭环是硬约束**：导出的文件喂给 P7-4 的 `parseXmindWorkbook` +
 * `normalizeXmindCases`，必须还原出同一批用例（模块路径 / 标题 / 前置 / 步
 * 骤 / 预期 / 优先级 / 标签逐字段相等，判重落「已存在未变」）。字段映射因
 * 此与导入侧的解析约定**成对**：
 *
 * | 平台字段     | XMind 形态                                  | 导入侧还原（xmind.ts）          |
 * | ------------ | ------------------------------------------- | -------------------------------- |
 * | 顶层模块     | 每个 top 模块一个 sheet，root.title = 模块名 | rootSegment = root.title         |
 * | 子模块       | 非 tc 节点的祖先链                          | moduleSegment 逐段拼接           |
 * | 用例         | `tc：` 前缀的节点                           | CASE_PREFIX_RE 剥前缀            |
 * | 优先级       | marker `priority-1..4`（P0..P3）            | markerPriority（marker 优先）    |
 * | 标签         | labels                                      | labels → tags                    |
 * | 前置条件     | `pc：` 子节点（多行拆多个）                 | pc 子节点正文 join("\n")         |
 * | 步骤         | tc 的其余子节点                             | 子节点 → 步骤                    |
 * | 预期结果     | 步骤节点的子节点（按行拆开）                | 孙节点标题 join("\n")            |
 *
 * 前置条件**写 `pc：` 子节点而不是 notes**（2026-09-08 用户反馈：notes 在图上
 * 只是一个角标，点开才看得见；子节点才是脑图的形状，与语料里 QA 手写的约定
 * 一致）。notes 只保留在模板里作导入约定演示（导入侧仍会把 notes 并入前置，
 * 兼容既有手写文件），导出侧不再产出 notes。
 *
 * 编号（item_key）**不导出**：XMind 两代格式都没有编号位，硬塞会污染某个
 * 字段；编号是平台身份（TC- 序列），导出 XMind 的定位是评审 / 分享用的脑图
 * 快照，回导按 (路径, 标题) 判重——与语料工作流一致（真实 XMind 从无编号）。
 * 要带编号的往返用 Excel 导出。
 *
 * zip 写入走 `lib/zipWriter.ts`（零依赖，Runner 写入器的服务端副本）。
 */

export type XmindExportCase = {
  /** DB 形态的模块路径（'/模块A/子模块/'）。 */
  modulePath: string;
  title: string;
  preconditions: string;
  steps: { step: string; expected: string }[];
  priority: "P0" | "P1" | "P2" | "P3";
  tags: string[];
};

/** 子主题：只有 id / title / children（照语料——class 只出现在 rootTopic 上）。 */
type ExportTopic = {
  id: string;
  title: string;
  markers?: { markerId: string }[];
  labels?: string[];
  notes?: { plain: { content: string } };
  children: { attached: ExportTopic[] };
};

type ModuleNode = {
  name: string;
  /** 子模块按 path 字典序稳定输出（与用例库行序同一口径）。 */
  modules: Map<string, ModuleNode>;
  cases: ExportTopic[];
};

/** P0→priority-1 … P3→priority-4（与 markerPriority 的逆映射，往返逐档相等）。 */
const PRIORITY_MARKER: Record<XmindExportCase["priority"], string> = {
  P0: "priority-1",
  P1: "priority-2",
  P2: "priority-3",
  P3: "priority-4",
};

function topic(title: string): ExportTopic {
  return { id: randomUUID(), title, children: { attached: [] } };
}

/** rootTopic：比子主题多 class + structureClass（logic.right = 思维导图右向）。 */
function rootTopic(title: string): ExportTopic & { class: "topic"; structureClass: string } {
  return { ...topic(title), class: "topic", structureClass: "org.xmind.ui.logic.right" };
}

/** 一条用例 → tc 节点（字段映射见表格注释）。 */
function caseTopic(each: XmindExportCase): ExportTopic {
  const node = topic(`tc：${each.title}`);
  node.markers = [{ markerId: PRIORITY_MARKER[each.priority] }];
  if (each.tags.length) node.labels = [...each.tags];
  /* 前置条件 = pc： 子节点（2026-09-08 用户反馈：notes 是角标不是内容，子节点
     才是脑图的形状）；多行拆多个 pc 子节点，导入侧 join("\n") 精确还原。
     pc 子节点排在步骤之前——读图顺序「先决条件 → 操作 → 预期」自然。 */
  node.children.attached = [
    ...each.preconditions
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => topic(`pc：${line}`)),
    ...each.steps.map((step) => {
      const stepNode = topic(step.step);
      /* 预期按行拆成子节点：导入侧 join("\n") 还原；单节点多行在 XMind 里会被
         当成一个可编辑的多行主题，拆开才是脑图的形状。空文本的行丢弃。 */
      stepNode.children.attached = step.expected
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => topic(line));
      return stepNode;
    }),
  ];
  return node;
}

/**
 * 组工作簿并打成 zip。空模块树不产 sheet（无可导内容时 zip 里仍有
 * content.json = `[]`，XMind 能开空工作簿，导入侧解析为 0 条）。
 */
export function buildXmindWorkbook(cases: XmindExportCase[]): Buffer {
  /* 1. 模块树：path 前缀逐段挂接（specImport commit 补建模块的同款走法）。 */
  const root = new Map<string, ModuleNode>();
  for (const each of cases) {
    const segments = each.modulePath.split("/").filter(Boolean);
    let level = root;
    let node: ModuleNode | undefined;
    for (const segment of segments) {
      node = level.get(segment);
      if (!node) {
        node = { name: segment, modules: new Map(), cases: [] };
        level.set(segment, node);
      }
      level = node.modules;
    }
    node!.cases.push(caseTopic(each));
  }

  /* 2. 每个 top 模块一个 sheet：root.title = 模块名，import 侧 rootSegment
        直读它——模块路径原样往返，不多一层也不少一层。 */
  const sheets = [...root.values()].map((top) => ({
    id: randomUUID(),
    revisionId: randomUUID(),
    class: "sheet" as const,
    title: top.name,
    rootTopic: { ...rootTopic(top.name), children: { attached: moduleChildren(top) } },
  }));

  return zipWorkbook(sheets);
}

/** 模块节点 → 子树（子模块在前、直属用例在后——目录结构先于内容，读图顺序自然）。 */
function moduleChildren(node: ModuleNode): ExportTopic[] {
  return [
    ...[...node.modules.values()].map((child) => ({ ...topic(child.name), children: { attached: moduleChildren(child) } })),
    ...node.cases,
  ];
}

/** 打包：三件套 content / metadata / manifest，全 STORE（照最新版语料形态）。 */
function zipWorkbook(sheets: { id: string; revisionId: string; class: "sheet"; title: string; rootTopic: ExportTopic }[]): Buffer {
  const content = Buffer.from(JSON.stringify(sheets), "utf8");
  const metadata = Buffer.from(
    JSON.stringify({
      dataStructureVersion: "2",
      creator: { name: "apitest", version: "1.0" },
      layoutEngineVersion: "4",
    }),
    "utf8",
  );
  /* manifest 只列实际存在的文件（语料里 Thumbnails 也是因为它真的存在才列）。 */
  const manifest = Buffer.from(
    JSON.stringify({ "file-entries": { "content.json": {}, "metadata.json": {} } }),
    "utf8",
  );

  const zip = new ZipWriter();
  zip.addFile("content.json", content, { deflate: false });
  zip.addFile("metadata.json", metadata, { deflate: false });
  zip.addFile("manifest.json", manifest, { deflate: false });
  return zip.build();
}

/**
 * XMind 模板下载（2026-09-08 用户要求，对齐 Excel 模板）：一份把**全部导入约定
 * 各演示一遍**的示例工作簿——下载后在 XMind 里照着改比读文档快。
 *
 * 约定 → 模板落点（与 parseXmindWorkbook/normalizeXmindCases 成对验证过）：
 * - `tc：` 前缀 = 用例（`用例：` 别名、`tc-pN：` 优先级分段各演示一次）；
 * - `pc：` 子节点 → 前置；**备注（notes）也并入前置**（演示一次，避免用户以为
 *   备注是描述字段被丢弃）；
 * - 其余子节点 → 步骤（**无预期 / 多行预期**各演示一次：预期按行拆子节点，
 *   导入 join("\n") 还原）；
 * - priority 标记 → 优先级、标签 labels → 标签（marker 优先于前缀）；
 * - 非 tc 节点 = 目录（模块路径 = 祖先链，root 标题是顶层模块）。
 *
 * 根节点备注写一段约定速查——导入侧只读 tc 节点的 notes，根备注是给人看的，
 * 不参与解析。模板整份导入会产出「示例项目/…」下的示例用例（标题冠「示例」
 * 语义词），与 Excel 模板同一定位：演示而非空白。
 */
export function buildXmindTemplate(): Buffer {
  const stepWithExpected = (step: string, expectedLines: string[]): ExportTopic => {
    const stepNode = topic(step);
    stepNode.children.attached = expectedLines.map((line) => topic(line));
    return stepNode;
  };

  /* 用例一：tc： 前缀 + priority 标记 + 标签 + pc： 前置 + 带预期步骤 + 无预期步骤。 */
  const first = topic("tc：示例：正确密码登录成功");
  first.markers = [{ markerId: "priority-1" }];
  first.labels = ["冒烟", "回归"];
  first.children.attached = [
    topic("pc：示例账号已存在且未锁定"),
    stepWithExpected("打开登录页，输入正确账号与密码", ["登录成功，跳转首页"]),
    topic("检查首页展示当前用户名"), /* 步骤可以没有预期 */
  ];

  /* 用例二：tc-pN： 优先级分段前缀 + 备注→前置 + 多行预期（多个预期子节点）。 */
  const second = topic("tc-p1：示例：连续输错密码后账号锁定");
  second.notes = { plain: { content: "备注文本会并入前置条件（与 pc： 子节点换行拼接）——不是被丢弃的描述。" } };
  second.children.attached = [
    topic("pc：示例账号已存在且未被锁定"),
    stepWithExpected("连续输错密码 5 次", ["账号锁定 30 分钟", "提示剩余解锁时间"]),
    stepWithExpected("锁定期间用正确密码登录", ["登录被拒绝，提示账号已锁定"]),
  ];

  /* 用例三：用例： 别名前缀 + 纯前置无步骤形态。 */
  const third = topic("用例：示例：只有前置的说明性用例");
  third.children.attached = [topic("pc：这是一条说明性用例，演示「用例：」前缀与纯前置形态")];

  const login = topic("登录模块");
  login.children.attached = [first, second];
  const sample = topic("示例模块");
  sample.children.attached = [third];

  const root = rootTopic("示例项目");
  root.children.attached = [login, sample];
  root.notes = {
    plain: {
      content: "导入约定：tc：/用例： 开头的节点是用例（tc-pN： 前缀写优先级）；pc：/前置： 子节点是前置条件，备注同样并入前置；其余子节点是步骤，步骤的子节点是预期结果；priority 标记与标签对应平台的优先级与标签；非 tc 节点是目录（模块路径 = 祖先链）。",
    },
  };

  return zipWorkbook([{ id: randomUUID(), revisionId: randomUUID(), class: "sheet", title: "示例项目", rootTopic: root }]);
}
