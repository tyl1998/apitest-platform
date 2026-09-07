import type { ReactNode } from "react";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useIsWideViewport, useSidebarCollapsed, useSidebarStore } from "../stores/sidebarStore";

/** 侧栏导航的图标按钮（收起态专用）。
 *
 * 与 `IconButton` 的差别在造型：导航是「一列条目」而不是「一排动作」，带 30px
 * 边框的 icon-btn 在 rail 里读成一堵按钮墙。这里沿用 `.nav-item` 本身的底色与
 * hover（收起态 CSS 已把它居中成方块），只借 Tooltip 补回被藏起来的文字标签。
 * 可达性别双轨：aria-label 与视觉标签同源。
 */
export function IconNavButton({ icon, label, onClick, className, ariaCurrent }: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  className?: string;
  ariaCurrent?: "page";
}) {
  return (
    <Tooltip title={label} mouseEnterDelay={0.1} placement="right">
      <button
        type="button"
        className={className}
        onClick={onClick}
        aria-label={label}
        aria-current={ariaCurrent}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

/**
 * 收起/展开开关（2026-09-07），住在 sidebar-foot：
 *
 * - 展开态在退出按钮旁边；收起态与退出按钮一起居中竖排。两态不挪窝——
   收起后展开键换位置，用户就得重新找它。
 * - 只在 ≥940px 的桌面 rail 上存在（`useSidebarCollapsed` 已把宽度并进
   结果）；940px 以下是自动换行的顶栏模式，没有可收起的栏。
 *
 * 偏好进 localStorage 而不是账号偏好接口：这是「这块屏幕怎么摆」，
   不是「我是谁」——同一人在 27 寸屏和 13 寸笔记本上想要不同的默认值。
 */
export function SidebarToggle() {
  const { t } = useTranslation();
  const collapsed = useSidebarCollapsed();
  const toggle = useSidebarStore((state) => state.toggle);
  /* 窄屏（顶栏模式）没有可收起的栏：开关不渲染，而不是渲染一个点了
     没有可见效果的死按钮。 */
  const wide = useIsWideViewport();
  if (!wide) return null;

  return (
    <Tooltip title={collapsed ? t("nav.expand") : t("nav.collapse")} mouseEnterDelay={0.1} placement="right">
      <button
        type="button"
        className="icon-btn is-ghost sidebar-toggle"
        onClick={toggle}
        aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
        aria-expanded={!collapsed}
      >
        {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </button>
    </Tooltip>
  );
}
