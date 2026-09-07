import { useCallback, useEffect, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { UserPlus } from "lucide-react";
import { api, type AuditLog, type MemberCandidate, type ProjectMember, type ProjectRole } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useCanManageProject } from "../hooks/useMyRole";
import { useProjectStore } from "../stores/projectStore";
import { Empty, Status, Tip } from "../ui";
import { AuditDetail } from "./AuditLogsPanel";

/**
 * 成员与权限（P6-4，计划 10.3）：成员表（角色下拉就地改）+ 添加成员（搜索平台用户 →
 * 选角色）+ 最近审计 50 条。
 *
 * 页面对 viewer/developer 也可读（`GET /members` 是项目读权限——「知道找谁要权限」
 * 是这张表的产品理由），但**管理面**（添加 / 改角色 / 移除 / 审计）只对
 * project_admin 渲染（边界 6「只藏入口不做禁用态」；后端守卫才是权限的单一事实）。
 *
 * 最后一个 project_admin 在 UI 层就锁死（不渲染下拉与移除，给 Tip 说明）——那两个
 * 操作必然 409，「一个必然失败的按钮比没有按钮更糟」（与 UsersPanel 的自锁闸同款
 * 取舍）；后端 409 仍是兜底，防的是并发下的客户端计数过期。
 */

/** 角色词汇与后端 DB CHECK 同一套（P6-1 的词汇决策：不做 admin ↔ project_admin 映射）。 */
const ROLE_OPTIONS: { value: ProjectRole; label: string }[] = [
  { value: "project_admin", label: "project_admin" },
  { value: "developer", label: "developer" },
  { value: "viewer", label: "viewer" },
];

export function Members() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();
  const canManage = useCanManageProject();

  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  /* 初始 true：项目 store 未就位前 load 不发请求，false 会让空态闪一下「还没有成员」。 */
  const [loading, setLoading] = useState(true);

  /* ── 添加成员（搜索平台用户 → 选角色）───────────────────────────────────── */
  const [candidateKeyword, setCandidateKeyword] = useState("");
  const debouncedKeyword = useDebounced(candidateKeyword);
  const [candidates, setCandidates] = useState<MemberCandidate[]>([]);
  const [candidateId, setCandidateId] = useState<string>();
  const [addRole, setAddRole] = useState<ProjectRole>("developer");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    setLoading(true);
    try {
      /* 审计是 requireProjectAdmin：viewer/developer 连请求都不发（403 不是错误处理，
          是这条路径不该存在）。 */
      const requests: Promise<void>[] = [api.members(projectId).then(setMembers)];
      if (canManage) requests.push(api.projectAuditLogs(projectId).then(setAuditLogs));
      await Promise.all(requests);
    } catch {
      message.error(t("members.loadFailed"));
    } finally { setLoading(false); }
  }, [projectId, loadedProjectId, projectLoading, canManage, t]);

  useEffect(() => { void load(); }, [load]);

  /* 候选搜索：防抖后进 SQL（服务端 keyword 过滤），空关键字 = 最新的 20 个可加的人。 */
  useEffect(() => {
    if (!projectId || !canManage) return;
    let aborted = false;
    api.memberCandidates(projectId, debouncedKeyword)
      .then((list) => { if (!aborted) setCandidates(list); })
      .catch(() => { if (!aborted) setCandidates([]); });
    return () => { aborted = true; };
  }, [projectId, debouncedKeyword, canManage]);

  async function addMember() {
    if (!projectId || !candidateId) return;
    setAdding(true);
    try {
      await api.upsertMember(projectId, { userId: candidateId, role: addRole });
      setCandidateId(undefined);
      setCandidateKeyword("");
      await load();
      message.success(t("members.added"));
    } catch {
      message.error(t("members.addFailed"));
    } finally { setAdding(false); }
  }

  /** 409（资源级 code 2003）= 最后一个 project_admin 闸；其余是普通失败。 */
  function memberError(error: unknown, fallback: string) {
    const code = (error as { response?: { data?: { code?: number } } })?.response?.data?.code;
    return message.error(code === 2003 ? t("members.lastAdminGuard") : fallback);
  }

  async function changeRole(member: ProjectMember, role: ProjectRole) {
    if (!projectId || role === member.role) return;
    try {
      await api.updateMemberRole(projectId, member.userId, role);
      await load();
      message.success(t("members.updated"));
    } catch (error) {
      memberError(error, t("members.updateFailed"));
    }
  }

  function removeMember(member: ProjectMember) {
    if (!projectId) return;
    Modal.confirm({
      title: t("members.removeTitle", { name: member.name }),
      /* 移除即时生效（判定端每请求查库）：该成员下一次请求即 403/404。 */
      content: t("members.removeHint"),
      okText: t("members.remove"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.removeMember(projectId, member.userId);
          await load();
          message.success(t("members.removed"));
        } catch (error) {
          memberError(error, t("members.updateFailed"));
        }
      },
    });
  }

  /* 唯一的 project_admin：改角色/移除必然 409，UI 直接不给这两个入口（文件头注释）。 */
  const adminCount = members.filter((member) => member.role === "project_admin").length;

  return <main className="content">
    <div className="page-head">
      <div><h1>{t("members.title")}</h1><p>{t("members.hint")}</p></div>
    </div>

    {canManage && <div className="filter-bar">
      <Select
        showSearch
        filterOption={false}
        value={candidateId}
        onSearch={setCandidateKeyword}
        onChange={(value) => setCandidateId(value)}
        onClear={() => { setCandidateId(undefined); setCandidateKeyword(""); }}
        notFoundContent={candidateKeyword ? t("members.noCandidates") : t("members.candidatesHint")}
        options={candidates.map((candidate) => ({ value: candidate.id, label: `${candidate.name} · ${candidate.email}` }))}
        placeholder={t("members.searchPlaceholder")}
        style={{ width: 320 }}
        allowClear
      />
      <Select
        value={addRole}
        onChange={setAddRole}
        options={ROLE_OPTIONS}
        style={{ width: 160 }}
      />
      <button className="btn btn-primary btn-with-icon" disabled={!candidateId || adding} onClick={() => void addMember()}>
        <UserPlus size={14} />{t("members.add")}
      </button>
    </div>}

    {members.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("members.member")}</th>
        <th className="col-status">{t("members.status")}</th>
        <th>{t("members.role")}</th>
        <th>{t("members.grantedBy")}</th>
        <th>{t("members.grantedAt")}</th>
        {canManage && <th className="col-actions" />}
      </tr></thead>
      <tbody>
        {members.map((member) => {
          const lastAdmin = member.role === "project_admin" && adminCount === 1;
          return <tr key={member.userId} data-removed={member.status === "disabled" ? "" : undefined}>
            <td>
              <strong className="truncate">{member.name}</strong>
              <div className="mono muted">{member.email}</div>
            </td>
            <td className="col-status">
              {member.status === "active"
                ? <Status status="pass" label={t("users.statusActive")} />
                : <Status status="canceled" label={t("users.statusDisabled")} />}
            </td>
            <td>
              {canManage
                ? (lastAdmin
                  ? <Tip text={t("members.lastAdminRow")}>
                    <span className="mono">{member.role}</span>
                  </Tip>
                  : <Select
                    size="small"
                    value={member.role}
                    onChange={(role: ProjectRole) => void changeRole(member, role)}
                    options={ROLE_OPTIONS}
                    style={{ width: 160 }}
                  />)
                : <span className="mono">{member.role}</span>}
            </td>
            <td className="mono muted">{member.grantedByEmail ?? "—"}</td>
            <td className="mono muted">{new Date(member.grantedAt).toLocaleDateString()}</td>
            {canManage && <td className="col-actions">
              {!lastAdmin && <div className="row-actions">
                <button className="btn danger" onClick={() => removeMember(member)}>{t("members.remove")}</button>
              </div>}
            </td>}
          </tr>;
        })}
      </tbody>
    </table></div> : !loading && <Empty title={t("members.emptyTitle")} hint={t("members.emptyHint")} />}

    {/* ── 最近审计（requireProjectAdmin 的读端，P6-2 建好等这里消费）──────────
        只读最近 50 条、无筛选无分页——成员页要回答的是「刚才谁动了谁」，翻历史去
        系统管理的审计日志页。 */}
    {canManage && <>
      <h3 className="subhead" style={{ marginTop: "var(--s6)" }}>{t("members.auditTitle")}</h3>
      {auditLogs.length ? <div className="table-scroll"><table className="grid">
        <thead><tr>
          <th>{t("audit.action")}</th>
          <th>{t("audit.operator")}</th>
          <th>{t("audit.detailColumn")}</th>
          <th>{t("audit.time")}</th>
        </tr></thead>
        <tbody>
          {auditLogs.map((log) => <tr key={log.id}>
            <td><span className="mono">{log.action}</span></td>
            <td className="mono muted">{log.userEmail ?? t("audit.nonUser")}</td>
            <td><AuditDetail detail={log.detail} /></td>
            <td className="mono muted">{new Date(log.createdAt).toLocaleString()}</td>
          </tr>)}
        </tbody>
      </table></div> : <p className="muted">{t("members.auditEmpty")}</p>}
    </>}
  </main>;
}
