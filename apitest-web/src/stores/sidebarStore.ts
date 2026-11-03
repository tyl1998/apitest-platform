import { useEffect, useState } from "react";
import { create } from "zustand";

/**
 * 侧栏收起态（2026-09-07）。桌面 rail 的 210px ⇄ 56px 图标栏切换。
 *
 * - localStorage 而非账号偏好：这是屏幕摆放偏好，不是身份偏好——同一人在
 *   大屏与小屏笔记本上想要不同的默认值，且登录前（理论上）没有侧栏可收。
 * - `data-collapsed` 挂在 `.console` 上而不是给 sidebar 加 class：grid 轨道
   与内容排版都由它驱动，属性选择器一处声明、两处生效，避免「轨道换了
   内容没换」的半收起态。
 * - 940px 以下没有侧栏可收（导航自动换行成顶栏），`useSidebarCollapsed`
   把宽度并进结果——否则窗口缩到顶栏模式时 nav 只剩光秃秃的图标。
 */
const KEY = "apitest.sidebar.collapsed";
const WIDE_QUERY = "(min-width: 940px)";

function readInitial(): boolean {
  return localStorage.getItem(KEY) === "1";
}

type SidebarState = {
  collapsed: boolean;
  toggle: () => void;
};

export const useSidebarStore = create<SidebarState>((set) => ({
  collapsed: readInitial(),
  toggle: () => set((state) => {
    const collapsed = !state.collapsed;
    if (collapsed) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
    return { collapsed };
  }),
}));

/** 渲染用的收起态：偏好 × 屏幕宽度。940px 以下恒为 false（顶栏模式）。
 * 两个 hook 必须无条件调用：写成 `collapsed && useIsWideViewport()` 时
 * false 分支短路跳过 hook，点击收缩翻转布尔后 hook 数量变化，React
 * 直接卸载整棵树（白屏）。 */
export function useSidebarCollapsed(): boolean {
  const collapsed = useSidebarStore((state) => state.collapsed);
  const wide = useIsWideViewport();
  return collapsed && wide;
}

/** 桌面宽度（≥940px，rail 模式）。开关类控件用它决定自己该不该存在。 */
export function useIsWideViewport(): boolean {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches);

  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return wide;
}
