import { useEffect, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { api, type GitCredential } from "../api";
import { apiMessage } from "./DataSourceList";

/**
 * Git 凭据创建 / 编辑弹窗（从 `RepoCredentials` 抽出，P4.5-15 起共用）。
 *
 * 抽成共享组件的理由：任务编辑页在凭据池为空时要能**就地创建**（跳去凭据页会丢掉已填的
 * 任务草稿），而两处的表单是同一张——名称 / 方式 / 明文，约束也同一条（创建必须填明文，
 * 编辑留空 = 只改名）。与 `ResourceSchedules` 的共用形状一致：状态留在组件内，父级只管
 * 「开给谁」与「存完之后」。
 *
 * 编辑时明文留空 = 只改名（服务端不动密文）：凭据明文只进不出（边界 17），父级拿到的
 * `GitCredential` 永远不含密文。
 */
export function GitCredentialModal({ projectId, editing, onClose, onSaved }: {
  projectId: string;
  /** `"new"` 是创建哨兵（与抽屉组件同款约定）；`undefined` = 关闭。 */
  editing?: GitCredential | "new";
  onClose: () => void;
  onSaved: (saved: GitCredential) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [method, setMethod] = useState<GitCredential["method"]>("https_token");
  const [credential, setCredential] = useState("");
  const [saving, setSaving] = useState(false);

  /* 表单状态跟着 `editing` 重置（而不是父级 remount）：同一页连续编辑两条凭据时，
     上一条的名称不能留在框里。 */
  useEffect(() => {
    if (!editing) return;
    const source = editing === "new" ? undefined : editing;
    setName(source?.name ?? "");
    setMethod(source?.method ?? "https_token");
    setCredential("");
  }, [editing]);

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) { message.error(t("repoCases.credentialNameRequired")); return; }
    const isEdit = editing !== "new" && editing !== undefined;
    if (!isEdit && !credential.trim()) { message.error(t("repoCases.credentialValueRequired")); return; }
    setSaving(true);
    try {
      const input = { name: trimmedName, method, credential: credential.trim() || undefined };
      const saved = isEdit
        ? await api.updateGitCredential(projectId, (editing as GitCredential).id, input)
        : await api.createGitCredential(projectId, input);
      message.success(t(isEdit ? "repoCases.credentialUpdated" : "repoCases.credentialCreated"));
      await onSaved(saved);
      onClose();
    } catch (error) {
      message.error(apiMessage(error) ?? t("repoCases.credentialSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const isEdit = editing !== "new" && editing !== undefined;

  return <Modal
    title={t(isEdit ? "repoCases.credentialEdit" : "repoCases.credentialCreate")}
    open={Boolean(editing)}
    onCancel={onClose}
    okText={t("action.save")}
    cancelText={t("action.cancel")}
    confirmLoading={saving}
    onOk={() => void save()}
  >
    <div className="form-grid">
      <label className="field field-wide"><span>{t("repoCases.credentialName")}</span>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("repoCases.credentialNamePlaceholder")}
          autoFocus
        />
      </label>
      <label className="field field-wide"><span>{t("repoCases.credentialMethod")}</span>
        <Select
          value={method}
          onChange={(value) => setMethod(value)}
          options={[
            { value: "https_token", label: t("repoCases.credentialMethodValue.https_token") },
            { value: "ssh_key", label: t("repoCases.credentialMethodValue.ssh_key") },
          ]}
          style={{ width: "100%" }}
        />
      </label>
    </div>
    {/* HTTPS token 是更该推荐的那一种（边界 11）：可以精确到单仓库只读、可以随时
        吊销、不需要在 Runner 机器上配 SSH。平台**无法**验证凭据是不是只读，所以
        这句要求必须写出来，而不是假设用户知道。 */}
    <p className="form-note">{t(method === "https_token" ? "repoCases.credentialHttpsHint" : "repoCases.credentialSshHint")}</p>
    <label className="field field-wide"><span>{t("repoCases.credentialValue")}</span>
      <textarea
        className="input kv-text"
        style={{ minHeight: method === "ssh_key" ? 160 : 60 }}
        value={credential}
        onChange={(event) => setCredential(event.target.value)}
        spellCheck={false}
        placeholder={isEdit
          ? t("repoCases.credentialKeep")
          : method === "ssh_key" ? "-----BEGIN OPENSSH PRIVATE KEY-----" : "glpat-…"}
      />
    </label>
    <p className="form-note">{t("repoCases.credentialWriteOnly")}</p>
  </Modal>;
}
