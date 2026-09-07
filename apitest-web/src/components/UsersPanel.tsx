import { useCallback, useEffect, useState } from "react";
import { Form, Input, Modal, Pagination, Select, Switch, message } from "antd";
import { useTranslation } from "react-i18next";
import { MailPlus, Plus } from "lucide-react";
import { api, type Invitation, type ManagedUser, type ProjectMetric } from "../api";
import { useAuthStore } from "../stores/authStore";
import { Empty, Status } from "../ui";
import { CopyButton } from "./CopyButton";

/**
 * 用户管理（P6-2，计划 10.3「系统管理两 tab」之一；系统管理员）。
 *
 * P6-3 起有**两条进人通道**（计划 10.0 边界 1）：管理员建号（初始密码只出现一次、
 * 首登强制改密）与邀请码签发（`apiinv_` 一次性码带外转交，受邀人开 `/register` 自设
 * 密码）。两条通道都在这个面板里，邀请码区块在用户表下方——签发人画像是同一个人。
 *
 * **只禁用、不删除**（边界 9）：禁用即时生效（后端每请求查库），角色行保留——执行
 * 历史与审计的「谁做的」要活过账号被禁。
 */

const PAGE_SIZES = [20, 50, 100];
/** 角色词汇与后端 DB CHECK 同一套（P6-1 的词汇决策：不做 admin ↔ project_admin 映射）。 */
const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "developer", label: "developer" },
  { value: "viewer", label: "viewer" },
  { value: "project_admin", label: "project_admin" },
];

export function UsersPanel() {
  const { t } = useTranslation();
  const me = useAuthStore((state) => state.user);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();
  /**
   * 刚发出的初始密码（建号或重置）。**只在内存里活到离开这一页**：服务端没有第二次
   * 下发，这一点必须在界面上说清，否则丢了会被当成 bug。
   */
  const [issued, setIssued] = useState<{ email: string; password: string }>();

  /* ── 邀请码（P6-3，边界 1 的①）────────────────────────────────────────── */
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  /** 项目下拉数据源：预分配「进哪个项目」用（全量——下拉里缺一个真实项目比多列几个更糟）。 */
  const [projects, setProjects] = useState<ProjectMetric[]>([]);
  const [inviteNote, setInviteNote] = useState("");
  const [inviteProjectId, setInviteProjectId] = useState<string | undefined>();
  const [inviteRole, setInviteRole] = useState<string | undefined>();
  const [issuing, setIssuing] = useState(false);
  /** 刚签发的明文码 + 注册链接：只出现一次（与初始密码同一条纪律）。 */
  const [issuedInvite, setIssuedInvite] = useState<{ token: string }>();

  const loadInvitations = useCallback(async () => {
    try {
      const result = await api.invitations();
      setInvitations(result);
    } catch {
      message.error(t("invites.loadFailed"));
    }
  }, []);

  useEffect(() => {
    void loadInvitations();
    /* 项目下拉只喂一次：进人面板打开的瞬间项目清单不会变化，翻页也不该重拉。 */
    void api.projects().then(setProjects).catch(() => {});
  }, [loadInvitations]);

  const load = useCallback(async (next: { page: number; pageSize: number; keyword: string }) => {
    setLoading(true);
    try {
      const result = await api.systemUsers(next);
      setUsers(result.items);
      setTotal(result.total);
    } catch {
      message.error(t("users.loadFailed"));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load({ page, pageSize, keyword });
  }, [load, page, pageSize, keyword]);

  async function create() {
    const values = await form.validateFields();
    setCreating(true);
    try {
      const created = await api.createSystemUser(values);
      setIssued({ email: created.email, password: created.initialPassword });
      setCreating(false);
      form.resetFields();
      /* 新账号排在最上面（列表按 created_at 倒序），回第一页即见。 */
      setPage(1);
      await load({ page: 1, pageSize, keyword });
    } catch (error) {
      setCreating(false);
      /* 409 = email 已存在（服务端资源级冲突码），给指向性的文案而不是笼统失败。 */
      const code = (error as { response?: { data?: { code?: number } } })?.response?.data?.code;
      if (code === 2003) message.error(t("users.emailExists"));
      else message.error(t("users.createFailed"));
    }
  }

  /**
   * 禁用/启用是**就地确认**而不是静默切换：禁用即时生效（下一个请求 401），误点没有
   * 撤销提示会让人以为只是改了个标签。自己的账号不可禁用（后端 409，前端干脆不给按钮）。
   */
  function toggleStatus(user: ManagedUser) {
    const disabling = user.status === "active";
    Modal.confirm({
      title: disabling ? t("users.disableTitle", { name: user.name }) : t("users.enableTitle", { name: user.name }),
      content: disabling ? t("users.disableHint") : t("users.enableHint"),
      okText: t(disabling ? "users.disable" : "users.enable"),
      okButtonProps: disabling ? { danger: true } : undefined,
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.updateSystemUser(user.id, { status: disabling ? "disabled" : "active" });
          await load({ page, pageSize, keyword });
          message.success(t(disabling ? "users.disabled" : "users.enabled"));
        } catch { message.error(t("users.updateFailed")); }
      },
    });
  }

  /** 系统管理员旗：就地开关。最后一个启用的管理员后端会 409，这里只透传错误。 */
  async function toggleAdmin(user: ManagedUser, isSystemAdmin: boolean) {
    try {
      await api.updateSystemUser(user.id, { isSystemAdmin });
      await load({ page, pageSize, keyword });
      message.success(t("users.updated"));
    } catch { message.error(t("users.lastAdminGuard")); }
  }

  function resetPassword(user: ManagedUser) {
    Modal.confirm({
      title: t("users.resetTitle", { name: user.name }),
      content: t("users.resetHint"),
      okText: t("users.reset"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          const result = await api.resetSystemUserPassword(user.id);
          setIssued({ email: result.email, password: result.initialPassword });
          await load({ page, pageSize, keyword });
        } catch { message.error(t("users.resetFailed")); }
      },
    });
  }

  /** 签发邀请码：明文只在这一次响应里；注册链接当场拼好（带 ?invite=），复制按钮给整条。 */
  async function createInvite() {
    setIssuing(true);
    try {
      const created = await api.createInvitation({
        note: inviteNote.trim() || undefined,
        projectId: inviteProjectId,
        role: inviteRole as Invitation["role"],
      });
      setIssuedInvite({ token: created.token });
      setInviteNote("");
      await loadInvitations();
    } catch {
      message.error(t("invites.createFailed"));
    } finally { setIssuing(false); }
  }

  /** 注册链接：签发人复制的是整条（带 ?invite=），不是光秃秃的码——「打开链接填密码」比「把码粘到注册页」少一步错。 */
  function registerLink(token: string): string {
    return `${window.location.origin}/register?invite=${encodeURIComponent(token)}`;
  }

  function revokeInvite(invitation: Invitation) {
    Modal.confirm({
      title: t("invites.revokeTitle", { prefix: invitation.tokenPrefix }),
      /* 吊销即时生效（注册的候选查询排除吊销行）；未消费/未过期的码当场作废。 */
      content: t("invites.revokeHint"),
      okText: t("invites.revoke"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.revokeInvitation(invitation.id); await loadInvitations(); message.success(t("invites.revoked")); }
        catch { message.error(t("invites.revokeFailed")); }
      },
    });
  }

  return <>
    <p className="form-note">{t("users.hint")}</p>

    <div className="filter-bar">
      {/* 换关键字回第一页：旧页码对新结果集多半越界（项目列表同款约定）。 */}
      <input className="input" value={keyword} onChange={(event) => { setKeyword(event.target.value); setPage(1); }} placeholder={t("users.searchPlaceholder")} style={{ width: 260 }} />
      <span className="filter-spacer" />
      <button className="btn btn-primary btn-with-icon" disabled={creating} onClick={() => { form.resetFields(); setCreating(true); }}>
        <Plus size={14} />{t("users.create")}
      </button>
    </div>

    {issued && <div className="code-block" style={{ marginBottom: "var(--s4)" }}>
      <div className="code-block-head">
        <span className="label">{t("users.initialPassword", { email: issued.email })}</span>
        <CopyButton value={() => issued.password} />
      </div>
      <pre className="code">{issued.password}</pre>
      <small className="form-note">{t("users.plaintextOnce")}</small>
    </div>}

    {users.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("users.user")}</th>
        <th className="col-status">{t("users.status")}</th>
        <th>{t("users.adminRole")}</th>
        <th>{t("users.lastLogin")}</th>
        <th>{t("users.createdAt")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {users.map((user) => <tr key={user.id} data-removed={user.status === "disabled" ? "" : undefined}>
          <td>
            <strong className="truncate">{user.name}</strong>
            <div className="mono muted">{user.email}</div>
          </td>
          <td className="col-status">
            {user.status === "active"
              ? <Status status="pass" label={t("users.statusActive")} />
              : <Status status="canceled" label={t("users.statusDisabled")} />}
            {/* 初始密码还没改：管理员要知道谁的账号处于「密码是别人给的」状态。 */}
            {user.mustChangePassword && user.status === "active" && <div className="mono muted">{t("users.pendingChange")}</div>}
          </td>
          <td>
            {/* 自己的开关不给动：后端 409 的两个自锁闸（最后一个管理员/自己）在 UI 层
                就不该成为可点目标——一个必然失败的开关比没有开关更糟。 */}
            {me?.id === user.id
              ? <span className="chip">{t("users.you")}</span>
              : <Switch checked={user.isSystemAdmin} onChange={(checked) => void toggleAdmin(user, checked)} />}
          </td>
          <td className="mono muted">{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "—"}</td>
          <td className="mono muted">{new Date(user.createdAt).toLocaleDateString()}</td>
          <td className="col-actions">
            <div className="row-actions">
              {me?.id !== user.id && (user.status === "active"
                ? <button className="btn danger" onClick={() => toggleStatus(user)}>{t("users.disable")}</button>
                : <button className="btn" onClick={() => toggleStatus(user)}>{t("users.enable")}</button>)}
              <button className="btn" onClick={() => resetPassword(user)}>{t("users.reset")}</button>
            </div>
          </td>
        </tr>)}
      </tbody>
    </table></div> : !loading && <Empty title={keyword ? t("users.emptySearchTitle") : t("users.emptyTitle")} hint={keyword ? t("users.emptySearchHint") : t("users.emptyHint")} />}

    {total > pageSize && <div className="pager">
      <Pagination
        current={page}
        pageSize={pageSize}
        total={total}
        pageSizeOptions={PAGE_SIZES}
        showSizeChanger
        onChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
      />
    </div>}

    {/* ── 邀请码（P6-3）────────────────────────────────────────────────────
        两条进人通道并列：上面建号（当场拿初始密码），这里签码（带外转交、本人自设密码）。
        签发表单一行：备注 → 预分配项目 → 预分配角色 → 签发。role 选了就必须有项目
        （角色行要有落点，后端 400 兜底，前端直接不给「有角色无项目」的提交形态）。 */}
    <h3 className="subhead" style={{ marginTop: "var(--s6)" }}>{t("invites.title")}</h3>
    <p className="form-note">{t("invites.hint")}</p>
    <div className="filter-bar">
      <input
        className="input"
        value={inviteNote}
        onChange={(event) => setInviteNote(event.target.value)}
        placeholder={t("invites.notePlaceholder")}
        style={{ width: 220 }}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        value={inviteProjectId}
        onChange={(value) => { setInviteProjectId(value); if (!value) setInviteRole(undefined); }}
        options={projects.map((project) => ({ value: project.id, label: project.name }))}
        placeholder={t("invites.projectPlaceholder")}
        style={{ width: 220 }}
      />
      <Select
        allowClear
        value={inviteRole}
        onChange={setInviteRole}
        options={ROLE_OPTIONS}
        placeholder={t("invites.rolePlaceholder")}
        disabled={!inviteProjectId}
        style={{ width: 160 }}
      />
      <button className="btn btn-primary btn-with-icon" disabled={issuing || (Boolean(inviteRole) && !inviteProjectId)} onClick={() => void createInvite()}>
        <MailPlus size={14} />{t("invites.create")}
      </button>
    </div>

    {issuedInvite && <div className="code-block" style={{ marginBottom: "var(--s4)" }}>
      <div className="code-block-head">
        <span className="label">{t("invites.issued")}</span>
        <CopyButton value={() => registerLink(issuedInvite.token)} />
      </div>
      <pre className="code">{registerLink(issuedInvite.token)}</pre>
      <small className="form-note">{t("invites.plaintextOnce")}</small>
    </div>}

    {invitations.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th className="mono">{t("invites.tokenPrefix")}</th>
        <th>{t("invites.note")}</th>
        <th>{t("invites.preset")}</th>
        <th className="col-status">{t("invites.status")}</th>
        <th>{t("invites.expiry")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {invitations.map((invitation) => <tr key={invitation.id} data-removed={invitation.consumedAt || invitation.revokedAt ? "" : undefined}>
          <td className="mono muted">{invitation.tokenPrefix}…</td>
          <td className="truncate">{invitation.note || <span className="muted">—</span>}</td>
          <td className="mono">
            {invitation.projectId
              ? `${projects.find((project) => project.id === invitation.projectId)?.name ?? invitation.projectId.slice(0, 8)} · ${invitation.role ?? "—"}`
              : <span className="muted">{t("invites.noPreset")}</span>}
          </td>
          <td className="col-status">
            {invitation.revokedAt
              ? <span className="chip chip-warn">{t("invites.statusRevoked")}</span>
              : invitation.consumedAt
                ? <Status status="pass" label={t("invites.statusConsumed")} />
                : new Date(invitation.expiresAt).getTime() <= Date.now()
                  ? <span className="chip">{t("invites.statusExpired")}</span>
                  : <span className="status" data-status="pass"><span className="status-mark" />{t("invites.statusActive")}</span>}
            {invitation.consumedAt && <div className="mono muted">{invitation.consumedByEmail ?? t("invites.unknownUser")}</div>}
          </td>
          <td className="mono muted">{new Date(invitation.expiresAt).toLocaleString()}</td>
          <td className="col-actions">
            {!invitation.consumedAt && !invitation.revokedAt && <div className="row-actions">
              <button className="btn" onClick={() => revokeInvite(invitation)}>{t("invites.revoke")}</button>
            </div>}
          </td>
        </tr>)}
      </tbody>
    </table></div> : !loading && <Empty title={t("invites.emptyTitle")} hint={t("invites.emptyHint")} />}

    <Modal
      title={t("users.createTitle")}
      open={creating}
      onCancel={() => setCreating(false)}
      onOk={() => void create()}
      okText={t("action.create")}
      cancelText={t("action.cancel")}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="email" label={t("users.email")} rules={[{ required: true, message: t("users.emailRequired") }, { type: "email", message: t("users.emailInvalid") }]}>
          <Input placeholder="qa@example.internal" />
        </Form.Item>
        <Form.Item name="name" label={t("users.name")} rules={[{ required: true, message: t("users.nameRequired") }]}>
          <Input />
        </Form.Item>
        <Form.Item name="isSystemAdmin" label={t("users.adminRole")} valuePropName="checked" extra={t("users.adminRoleHint")} initialValue={false}>
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  </>;
}
