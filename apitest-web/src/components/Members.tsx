import { useCallback, useEffect, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { UserPlus } from "lucide-react";
import { api, type AccessRequest, type MemberCandidate, type ProjectMember, type ProjectRole } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useCanManageProject } from "../hooks/useMyRole";
import { useProjectStore } from "../stores/projectStore";
import { Empty, PageToolbar, Status, Tip } from "../ui";

/**
 * 成员与权限（P6-4，计划 10.3）：成员表（角色下拉就地改）+ 添加成员（搜索平台用户 →
 * 选角色）。
 *
 * 页面对 viewer/developer 也可读（`GET /members` 是项目读权限——「知道找谁要权限」
 * 是这张表的产品理由），但**管理面**（添加 / 改角色 / 移除）只对 project_admin 渲染
 * （边界 6「只藏入口不做禁用态」；后端守卫才是权限的单一事实）。
 *
 * 审计摘要曾嵌在表尾（P6-2/P11-10），2026-09-19 删除：它的内容与项目配置 → 审计日志页
 * 完全重合（同一接口、同一批行），成员页留着只是把一份可下钻的清单复述成不可下钻的
 * 50 行；「刚才谁动了谁」由那一个入口回答，这一页只管成员。
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

/**
 * 成员与权限（P6-4 + P14-2）：成员表 + 权限申请审批。
 *
 * 两个 tab 由地址栏驱动（`?tab=requests`）——权限申请通知的深链要能直接指过来
 * （站内信 link 写的就是 `?tab=requests`）。申请 tab 只对 project_admin 渲染
 * （审批是管理动作，边界 6 的藏入口纪律）；非管理员只看到成员 tab，不出现空 tab。
 */
export function Members() {
  const { t } = useTranslation();
  const canManage = useCanManageProject();
  const [searchParams, setSearchParams] = useSearchParams();
  /* 未授权者强制回成员 tab：`?tab=requests` 对 viewer/developer 无意义，也不该让它
     停在一个渲染不出内容的 tab 上。 */
  const tab = canManage && searchParams.get("tab") === "requests" ? "requests" : "members";

  return <main className="content content-split">
    <PageToolbar>
      <div className="page-head">
        <div><h1>{t("members.title")}</h1><p>{t("members.hint")}</p></div>
      </div>
      {canManage && <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "members"} className={`tab${tab === "members" ? " is-active" : ""}`} onClick={() => setSearchParams({}, { replace: true })}>{t("members.tabMembers")}</button>
        <button role="tab" aria-selected={tab === "requests"} className={`tab${tab === "requests" ? " is-active" : ""}`} onClick={() => setSearchParams({ tab: "requests" }, { replace: true })}>{t("members.tabRequests")}</button>
      </div>}
    </PageToolbar>
    {tab === "requests" ? <AccessRequestsTab /> : <MembersTab />}
  </main>;
}

function MembersTab() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();
  const canManage = useCanManageProject();

  const [members, setMembers] = useState<ProjectMember[]>([]);
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
      setMembers(await api.members(projectId));
    } catch {
      message.error(t("members.loadFailed"));
    } finally { setLoading(false); }
  }, [projectId, loadedProjectId, projectLoading, t]);

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

  return <>
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

    {/* 审计摘要删掉后卡内只剩这一张表，`list-scroll` 那层包装一并去掉：滚动要落在
        `.table-scroll` 自己身上（它是 `overflow-x:auto` 的滚动包含块，表头吸附的祖先
        必须是它），套在外层会让 `.table-scroll` 失去定高、吸附表头形同虚设。 */}
    <div className="list-card">
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
    </div>
  </>;
}

/**
 * 权限申请审批 tab（P14-2，project_admin）：本项目的申请列表（pending 置顶），
 * 每行可批准 / 拒绝。批准 = 既有成员 upsert（角色默认用申请的建议角色，可在批准前
 * 改定，边界 3/7）；拒绝可带一条 note（回给申请人）。审批即时生效——批准后申请人
 * 下一次请求就进得来。
 */
const ROLE_VALUES: ProjectRole[] = ["viewer", "developer", "project_admin"];

function AccessRequestsTab() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();

  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  /* 每行选定的授予角色（默认 = 申请建议，未带建议则 developer）；批准前可改。 */
  const [grantRole, setGrantRole] = useState<Record<string, ProjectRole>>({});
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    setLoading(true);
    try {
      const list = await api.accessRequests(projectId);
      setRequests(list);
      /* 初始化每条 pending 的授予角色（建议角色优先，否则 developer 兜底）。 */
      setGrantRole(Object.fromEntries(list.filter((request) => request.status === "pending").map((request) => [request.id, request.suggestedRole ?? "developer"])));
    } catch {
      message.error(t("access.reqLoadFailed"));
    } finally { setLoading(false); }
  }, [projectId, loadedProjectId, projectLoading, t]);

  useEffect(() => { void load(); }, [load]);

  async function approve(request: AccessRequest) {
    setBusy(request.id);
    try {
      await api.approveAccessRequest(request.id, grantRole[request.id] ?? request.suggestedRole ?? "developer");
      message.success(t("access.reqApproved", { email: request.applicantEmail ?? "" }));
      await load();
    } catch (error) {
      const code = (error as { response?: { data?: { code?: number } } })?.response?.data?.code;
      /* 409 = 已被别的管理员处理（并发）：刷新看最新态，不报错。 */
      if (code === 2003) { message.info(t("access.reqAlreadyHandled")); await load(); }
      else message.error(t("access.reqApproveFailed"));
    } finally { setBusy(undefined); }
  }

  function reject(request: AccessRequest) {
    let note = "";
    Modal.confirm({
      title: t("access.reqRejectTitle", { email: request.applicantEmail ?? "" }),
      content: <label className="field" style={{ marginTop: "var(--s3)" }}>
        <span>{t("access.reqRejectNote")}</span>
        <input className="input" onChange={(event) => { note = event.target.value; }} placeholder={t("access.reqRejectNotePlaceholder")} />
      </label>,
      okText: t("access.reqReject"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.rejectAccessRequest(request.id, note.trim() || undefined);
          message.success(t("access.reqRejected"));
          await load();
        } catch (error) {
          const code = (error as { response?: { data?: { code?: number } } })?.response?.data?.code;
          if (code === 2003) { message.info(t("access.reqAlreadyHandled")); await load(); }
          else message.error(t("access.reqRejectFailed"));
        }
      },
    });
  }

  return <div className="list-card">
    {requests.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("access.reqApplicant")}</th>
        <th>{t("access.reqSuggestedRole")}</th>
        <th className="col-status">{t("access.reqStatus")}</th>
        <th>{t("access.reqHandledBy")}</th>
        <th>{t("access.reqWhen")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {requests.map((request) => <tr key={request.id}>
          <td>
            <strong className="truncate">{request.applicantName ?? request.applicantEmail ?? "—"}</strong>
            <div className="mono muted">{request.applicantEmail}</div>
          </td>
          <td>
            {request.status === "pending"
              ? <Select
                  size="small"
                  value={grantRole[request.id] ?? request.suggestedRole ?? "developer"}
                  onChange={(role: ProjectRole) => setGrantRole((current) => ({ ...current, [request.id]: role }))}
                  options={ROLE_VALUES.map((role) => ({ value: role, label: role }))}
                  style={{ width: 160 }}
                />
              : <span className="mono">{request.suggestedRole ?? "—"}</span>}
          </td>
          <td className="col-status">
            {request.status === "pending" ? <Status status="queued" label={t("access.statusPending")} />
              : request.status === "approved" ? <Status status="pass" label={t("access.statusApproved")} />
              : <Status status="fail" label={t("access.statusRejected")} />}
          </td>
          <td className="mono muted">{request.handledByEmail ?? "—"}</td>
          <td className="mono muted">{new Date(request.createdAt).toLocaleDateString()}</td>
          <td className="col-actions">
            {request.status === "pending" && <div className="row-actions">
              <button className="btn btn-primary" disabled={busy === request.id} onClick={() => void approve(request)}>{t("access.reqApprove")}</button>
              <button className="btn danger" disabled={busy === request.id} onClick={() => reject(request)}>{t("access.reqReject")}</button>
            </div>}
          </td>
        </tr>)}
      </tbody>
    </table></div> : !loading && <Empty title={t("access.reqEmptyTitle")} hint={t("access.reqEmptyHint")} />}
  </div>;
}
