import { create } from "zustand";

/**
 * 页面上下文（P9-4c）：「用户发消息时正站在哪」的元数据，助手抽屉发送时随消息
 * 带上（服务端封 `apitest-page-context` 围栏前缀转发给 agent——「当前接口」类指代
 * 靠它解析）。
 *
 * - 只放**标识符与面包屑**（name / method / url / 筛选词），secret 值绝不进——
 *   环境密钥等敏感值在采集侧就不该出现，服务端还有长度封顶兜底；
 * - `route` 不在这里：抽屉发送时从当前 location 合成（单一事实源，页面不用填）；
 * - 未注册的页面照样有上下文（route 里的实体 id 仍在），注册只是把不在 URL 里的
 *   组件态（activeCase / selectedNode / 抽屉 executionId）补上。
 */
export type PageContext = {
  /** 稳定页面名（如 "endpoint-workspace"）——agent 解析指代的锚。 */
  page: string;
  entities?: Record<string, string>;
  /** 焦点子区域（如 "case-editor"）——「当前断言」指向谁的关键。 */
  focus?: string;
  filters?: Record<string, string>;
  /** 勾选行 id（批量场景：「把筛选出来的这几个跑一遍」）。 */
  selection?: string[];
};

/** 发送时由抽屉合成的完整上下文：页面注册内容 + 当刻 route。 */
export type SentPageContext = PageContext & { route: string };

type PageContextState = {
  context: PageContext | undefined;
  set: (context: PageContext | undefined) => void;
};

export const usePageContextStore = create<PageContextState>((set) => ({
  context: undefined,
  set: (context) => set({ context }),
}));
