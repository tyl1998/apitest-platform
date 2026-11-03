import { useCallback, useEffect, useState } from "react";
import { Form, Input, Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { api, type FailureCategory } from "../api";
import { Empty, Status } from "../ui";
import { IconButton } from "./IconButton";

/**
 * 归因类型管理（P8-2 增补：系统设置「归因类型」tab；系统管理员）。
 *
 * 管理的是**平台那一分**归因分类字典（边界 5：项目不可改口径，跨项目可比才有意义）。
 * 这不是给项目开自定义——改的是措辞与启停，所有项目共享同一份。
 *
 * 三条边界落到交互上：
 * - **code 建后不可改**：它是统计与 MCP 的稳定标识，改了等于把存量归因悄悄挪分类。
 * - **停用 ≠ 删除**：停用后打标抽屉不再出现该选项，历史归因与统计照常显示。
 * - **删除有引用时先 409**：用户看过「N 条归因会消失」才允许 force——那些归因行回
 *   未归因（覆盖率下降是删除一个分类的诚实代价，不偷偷挂去别的分类）。
 */

/** code 的约束与服务端同款（小写字母开头，字母/数字/下划线，≤40）。 */
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export function FailureCategoriesPanel() {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<FailureCategory[]>();
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    try {
      setCategories(await api.systemFailureCategories());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    const values = await form.validateFields();
    setCreating(true);
    try {
      await api.createSystemFailureCategory({ code: values.code.trim(), name: values.name.trim() });
      message.success(t("failureCategories.created"));
      form.resetFields();
      await load();
    } catch (error) {
      /* 409 = code 已存在（资源级冲突码），给指向性文案。 */
      const code = (error as { response?: { data?: { code?: number } } })?.response?.data?.code;
      if (code === 2003) message.error(t("failureCategories.codeExists"));
      else message.error(t("failureCategories.createFailed"));
    } finally { setCreating(false); }
  }

  /** 启停是就地开关：不弹确认——停用可逆（重新启用即可），不是删除。 */
  async function toggleActive(category: FailureCategory, active: boolean) {
    try {
      await api.updateSystemFailureCategory(category.code, { active });
      await load();
    } catch { message.error(t("failureCategories.updateFailed")); }
  }

  function rename(category: FailureCategory) {
    let name = category.name;
    Modal.confirm({
      title: t("failureCategories.renameTitle", { name: category.name }),
      content: <Input defaultValue={category.name} onChange={(event) => { name = event.target.value; }} />,
      okText: t("action.save"),
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.updateSystemFailureCategory(category.code, { name: name.trim() });
          await load();
          message.success(t("failureCategories.renamed"));
        } catch { message.error(t("failureCategories.updateFailed")); }
      },
    });
  }

  function remove(category: FailureCategory) {
    Modal.confirm({
      title: t("failureCategories.deleteTitle", { name: category.name }),
      content: t("failureCategories.deleteHint"),
      okText: t("action.delete"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.deleteSystemFailureCategory(category.code);
          await load();
          message.success(t("failureCategories.deleted"));
        } catch (error) {
          /* 409 = 有归因行引用（服务端带计数）。第二次确认才带 force——用户必须先
             看过「N 条归因会消失」，再决定是否连带清掉。 */
          const status = (error as { response?: { status?: number; data?: { data?: { attributions?: number } } } })?.response;
          if (status?.status === 409) {
            const count = status.data?.data?.attributions ?? 0;
            Modal.confirm({
              title: t("failureCategories.forceTitle", { name: category.name }),
              content: t("failureCategories.forceHint", { count }),
              okText: t("failureCategories.forceDelete"),
              okButtonProps: { danger: true },
              cancelText: t("action.cancel"),
              onOk: async () => {
                try {
                  const result = await api.deleteSystemFailureCategory(category.code, true);
                  await load();
                  message.success(t("failureCategories.forceDeleted", { count: result.removedAttributions }));
                } catch { message.error(t("failureCategories.deleteFailed")); }
              },
            });
            return;
          }
          message.error(t("failureCategories.deleteFailed"));
        }
      },
    });
  }

  if (failed) return <Empty title={t("failureCategories.loadFailedTitle")} hint={t("failureCategories.loadFailedHint")} />;
  if (!categories) return <p className="muted">{t("common.loading")}</p>;

  return <>
    {/* 按钮在右、描述在按钮下面。 */}
    <div className="filter-bar">
      <span className="filter-spacer" />
      <button className="btn btn-primary btn-with-icon" disabled={creating} onClick={() => { form.resetFields(); setCreating(true); }}>
        <Plus size={14} />{t("failureCategories.create")}
      </button>
    </div>

    {/* 与项目侧「归因抽屉」的关系：这里管分类本身，打标发生在报告/执行记录的失败行上。 */}
    <p className="form-note">{t("failureCategories.hint")}</p>

    {creating && <div className="panel" style={{ marginBottom: "var(--s4)" }}>
      <div className="panel-body">
        <Form form={form} layout="vertical" onFinish={() => void create()}>
          <div className="filter-bar" style={{ marginBottom: 0 }}>
            {/* code 建后不可改：这里写下的词会进统计与 MCP 工具，给 mono 提示这层语义。 */}
            <Form.Item name="code" label={t("failureCategories.code")} rules={[
              { required: true, message: t("failureCategories.codeRequired") },
              { pattern: CODE_PATTERN, message: t("failureCategories.codePattern") },
            ]} style={{ marginBottom: 0 }}>
              <Input className="mono" placeholder="env_issue" style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="name" label={t("failureCategories.name")} rules={[{ required: true, message: t("failureCategories.nameRequired") }]} style={{ marginBottom: 0 }}>
              <Input placeholder={t("failureCategories.namePlaceholder")} style={{ width: 220 }} />
            </Form.Item>
            <button className="btn" type="submit" style={{ marginTop: 22 }}>{t("action.save")}</button>
            <button className="btn" style={{ marginTop: 22 }} onClick={() => setCreating(false)}>{t("action.cancel")}</button>
          </div>
        </Form>
      </div>
    </div>}

    {categories.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("failureCategories.name")}</th>
        <th className="mono">{t("failureCategories.code")}</th>
        <th className="col-num">{t("failureCategories.position")}</th>
        <th className="col-status">{t("failureCategories.status")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {categories.map((category) => <tr key={category.code}>
          <td><strong className="truncate">{category.name}</strong></td>
          <td className="mono muted">{category.code}</td>
          <td className="col-num mono">{category.position}</td>
          <td className="col-status">
            {/* 停用 ≠ 删除：历史归因与统计照常显示，只是打标抽屉不再出现这个选项。 */}
            {category.active
              ? <Status status="pass" label={t("failureCategories.active")} />
              : <Status status="skip" label={t("failureCategories.inactive")} />}
          </td>
          <td className="col-actions">
            <div className="row-actions">
              <button className="btn" onClick={() => void toggleActive(category, !category.active)}>
                {t(category.active ? "failureCategories.deactivate" : "failureCategories.activate")}
              </button>
              <button className="btn" onClick={() => rename(category)}>{t("action.edit")}</button>
              <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => remove(category)} />
            </div>
          </td>
        </tr>)}
      </tbody>
    </table></div> : <Empty title={t("failureCategories.emptyTitle")} hint={t("failureCategories.emptyHint")} />}

    <p className="form-note">{t("failureCategories.codeImmutableHint")}</p>
  </>;
}
