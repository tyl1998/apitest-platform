import { useProjectStore } from "../stores/projectStore";
import type { MyRole } from "../api";

/**
 * 我在当前项目里是谁（P6-4，计划 10.3）：读 `projectStore` 的 `myRole`——它随项目
 * 列表/详情由 P6-1 的下发免费到位，组件零额外请求。
 *
 * 只藏入口、不做禁用态（计划 10.0 边界 6，沿用「一个你永远打不开的 tab 只是杂物」）；
 * 只藏入口不藏路由——后端守卫才是权限的单一事实，URL 直达时后端照拒。
 *
 * 三个判定 helper 而不是一个布尔：viewer / developer / project_admin 的界面分叉是
 * 三档不是两档（developer 能建接口但看不到成员管理）。角色未加载（null）一律按
 * 没有权限处理——按钮「晚一点出现」好过「亮出来再被收回去」。
 */
export function useMyRole(): MyRole | null {
  return useProjectStore((state) => state.myRole);
}

/** 资源 CRUD（接口/用例/流程/套件/仓库……）的写入口：developer 及以上。 */
export function useCanWrite(): boolean {
  const role = useMyRole();
  return role === "developer" || role === "project_admin" || role === "system_admin";
}

/** 管人 / 管项目级配置（成员、默认环境、明文记录、MCP 开关、删项目）：project_admin 及以上。 */
export function useCanManageProject(): boolean {
  const role = useMyRole();
  return role === "project_admin" || role === "system_admin";
}
