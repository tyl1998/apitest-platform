import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

/**
 * 仓库模式的五个页面共用的标签条（P4-8/P4-9，交互 3.11；P4.5-14 合并 CI 任务与凭据）。
 *
 * **五块共享同一个前提**——「测试代码在用户的仓库里，平台不拥有它」。P4.5-11 曾把它们
 * 劈成两个导航项（仓库用例 / CI 任务），结果「为什么 CI 任务要先绑仓库、另外几页不用」
 * 变成每次都要重新解释的问题；P4.5-14 把 Git 来源搬到任务上之后那个前置条件也消失了，
 * 于是一并收成一个入口（计划 8.11 的 C 类）。
 *
 * 用**真实路由**而不是 `?tab=`：凭据页会被贴进别人的 CI 说明里、上报记录会被贴进排查群
 * 里，两者都要是一条能直接打开的地址。
 *
 * 未匹配诊断在这里是**一个平级标签，没有计数徽标**（边界 20）：它是诊断视图而不是待办
 * 清单，挂一个数字上去就等于催人把它清空——而清空的动作是把别的系统的接口拉进本项目的
 * 分母。风险全部来自那个待办形状，不来自数据本身。
 *
 * 任务放在第一位：它是唯一一个「做事」的标签，其余四个是「看结果」与「配一次就不动」。
 */
export const REPO_TABS = ["tasks", "tree", "runs", "unmatched", "credentials"] as const;
export type RepoTab = (typeof REPO_TABS)[number];

/**
 * 任务是**索引路由**（`/repo` 本身），不是 `/repo/tasks`：它排在第一个，而「导航点进来
 * 落在第二个标签」是一种每次都要解释的错位。其余四个各带一段路径。
 */
const PATHS: Record<RepoTab, string> = {
  tasks: "",
  tree: "/tree",
  runs: "/runs",
  unmatched: "/unmatched",
  credentials: "/credentials",
};

export function RepoTabs({ active }: { active: RepoTab }) {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const navigate = useNavigate();
  return <div className="tabs" role="tablist" style={{ paddingInline: 0, marginBottom: "var(--s4)" }}>
    {REPO_TABS.map((tab) => <button
      key={tab}
      role="tab"
      aria-selected={active === tab}
      className={`tab${active === tab ? " is-active" : ""}`}
      onClick={() => navigate(`/projects/${projectId}/repo${PATHS[tab]}`)}
    >{t(`repoCases.tab${tab.charAt(0).toUpperCase()}${tab.slice(1)}`)}</button>)}
  </div>;
}

/** 五个页面同一个页头，标题与说明各自不同。`title` 允许 ReactNode：编辑页要在标题旁
    放「未保存」chip（CiTaskEditor），字符串调用方不受影响。 */
export function RepoPageHead({ title, hint, actions }: { title: ReactNode; hint: string; actions?: ReactNode }) {
  return <div className="page-head">
    <div><h1>{title}</h1><p>{hint}</p></div>
    {actions && <div className="topbar-actions">{actions}</div>}
  </div>;
}
