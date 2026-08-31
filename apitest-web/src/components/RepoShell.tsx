import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

/**
 * 仓库模式的四个页面共用的标签条（P4-8/P4-9，交互 3.11）。
 *
 * 用**真实路由**而不是 `?tab=`：接入指引会被贴进别人的 CI 说明里、上报记录会被贴进
 * 排查群里，两者都要是一条能直接打开的地址。
 *
 * 未匹配诊断在这里是**一个平级标签，没有计数徽标**（边界 20）：它是诊断视图而不是待办
 * 清单，挂一个数字上去就等于催人把它清空——而清空的动作是把别的系统的接口拉进本项目的
 * 分母。风险全部来自那个待办形状，不来自数据本身。
 */
export const REPO_TABS = ["tree", "onboarding", "runs", "unmatched"] as const;
export type RepoTab = (typeof REPO_TABS)[number];

const PATHS: Record<RepoTab, string> = {
  tree: "",
  onboarding: "/onboarding",
  runs: "/runs",
  unmatched: "/unmatched",
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
      onClick={() => navigate(`/projects/${projectId}/repo-cases${PATHS[tab]}`)}
    >{t(`repoCases.tab${tab.charAt(0).toUpperCase()}${tab.slice(1)}`)}</button>)}
  </div>;
}

/** 四个页面同一个页头，标题与说明各自不同。 */
export function RepoPageHead({ title, hint, actions }: { title: string; hint: string; actions?: ReactNode }) {
  return <div className="page-head">
    <div><h1>{title}</h1><p>{hint}</p></div>
    {actions && <div className="topbar-actions">{actions}</div>}
  </div>;
}
