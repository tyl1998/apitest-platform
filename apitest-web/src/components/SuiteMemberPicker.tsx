import { Fragment, useEffect, useMemo, useState } from "react";
import { Modal, Pagination, message } from "antd";
import { useTranslation } from "react-i18next";
import { api, type FlowSummary, type SuiteMemberRef, type SuiteMemberSnapshot, type TestCaseSummary } from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { Empty } from "../ui";

/**
 * 跨接口成员选择器 (P2-4)。
 *
 * 两类成员共用一个弹窗：用例按接口分组（同名用例只能靠接口区分），流程平铺。
 * 搜索走服务端——用例列表是分页的，在「已加载的这一页」里筛只会让人以为用例不见了。
 *
 * 刻意**没有标签筛选**：标签的可选值无法在服务端枚举（没有标签清单接口），一个选项
 * 只来自当前页的筛选器比没有筛选器更容易误导。按标签跑一批用例的真实需求由套件的
 * 「按标签」选择方式承担，这个弹窗只服务手动挑选。
 */

const PAGE_SIZE = 20;

export function SuiteMemberPicker({ projectId, open, existing, onClose, onAdd }: {
  projectId: string;
  open: boolean;
  /** 已在套件里的成员：勾选框置灰，因为同一成员出现两次没有语义（后端也会拒绝）。 */
  existing: SuiteMemberRef[];
  onClose: () => void;
  onAdd: (members: SuiteMemberSnapshot[]) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"case" | "flow">("case");
  const [keyword, setKeyword] = useState("");
  const debouncedKeyword = useDebounced(keyword);
  const [cases, setCases] = useState<TestCaseSummary[]>([]);
  const [caseTotal, setCaseTotal] = useState(0);
  const [casePage, setCasePage] = useState(1);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [loading, setLoading] = useState(false);
  /** 勾选中的成员，带快照：加进套件后要能直接显示名字，不再回查一次。 */
  const [picked, setPicked] = useState<Map<string, SuiteMemberSnapshot>>(new Map());

  const alreadyIn = useMemo(() => new Set(existing.map((member) => `${member.type}:${member.id}`)), [existing]);

  /* 每次打开都从干净状态开始：留着上次的勾选会让人以为已经添加过了。 */
  useEffect(() => {
    if (!open) return;
    setPicked(new Map());
    setKeyword("");
    setCasePage(1);
    setTab("case");
  }, [open]);

  useEffect(() => { setCasePage(1); }, [debouncedKeyword, tab]);

  useEffect(() => {
    if (!open || !projectId) return;
    setLoading(true);
    const request = tab === "case"
      ? api.projectCases(projectId, { keyword: debouncedKeyword, page: casePage, pageSize: PAGE_SIZE })
        .then((page) => { setCases(page.items); setCaseTotal(page.total); })
      /* 流程列表本身不分页（它返回 nodeCount 而不是节点，量级小得多）。 */
      : api.flows(projectId, { keyword: debouncedKeyword }).then(setFlows);
    void request
      .catch(() => message.error(t("suites.pickerLoadFailed")))
      .finally(() => setLoading(false));
  }, [open, projectId, tab, debouncedKeyword, casePage]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(member: SuiteMemberSnapshot, on: boolean) {
    setPicked((current) => {
      const next = new Map(current);
      const key = `${member.type}:${member.id}`;
      if (on) next.set(key, member); else next.delete(key);
      return next;
    });
  }

  /** 用例按接口分组，组内保持服务端给的顺序（接口名 → 用例名）。 */
  const grouped = useMemo(() => {
    const groups: { endpointId: string; endpointName: string; items: TestCaseSummary[] }[] = [];
    for (const item of cases) {
      const last = groups[groups.length - 1];
      if (last && last.endpointId === item.endpointId) last.items.push(item);
      else groups.push({ endpointId: item.endpointId, endpointName: item.endpointName, items: [item] });
    }
    return groups;
  }, [cases]);

  function row(member: SuiteMemberSnapshot, meta: string) {
    const key = `${member.type}:${member.id}`;
    const disabled = alreadyIn.has(key);
    const checked = picked.has(key);
    return <tr key={key} data-clickable="" className={checked ? "is-selected" : undefined} onClick={() => { if (!disabled) toggle(member, !checked); }}>
      <td className="col-select" onClick={(event) => event.stopPropagation()}>
        <input type="checkbox" aria-label={member.name} checked={checked} disabled={disabled} onChange={(event) => toggle(member, event.target.checked)} />
      </td>
      <td><span className="truncate">{member.name}</span></td>
      <td className="mono muted truncate">{disabled ? t("suites.pickerAlreadyAdded") : meta}</td>
    </tr>;
  }

  const empty = tab === "case" ? !cases.length : !flows.length;

  return <Modal
    title={t("suites.pickerTitle")}
    open={open}
    width={640}
    onCancel={onClose}
    onOk={() => { onAdd([...picked.values()]); onClose(); }}
    okText={t("suites.addMembers")}
    cancelText={t("action.cancel")}
    okButtonProps={{ disabled: !picked.size }}
  >
    <div className="filter-bar">
      <div className="segmented">
        <button className={`segmented-item${tab === "case" ? " is-active" : ""}`} onClick={() => setTab("case")}>{t("suites.pickerCases")}</button>
        <button className={`segmented-item${tab === "flow" ? " is-active" : ""}`} onClick={() => setTab("flow")}>{t("suites.pickerFlows")}</button>
      </div>
      <input
        className="input"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder={tab === "case" ? t("suites.pickerSearchCases") : t("suites.pickerSearchFlows")}
      />
      <span className="filter-spacer" />
      <span className="mono muted">{t("suites.pickerSelected", { count: picked.size })}</span>
    </div>

    {loading && <p className="muted">{t("filter.searching")}</p>}

    {empty ? !loading && <Empty title={t("suites.pickerEmpty")} /> : <div className="picker-scroll">
      <table className="grid picker-grid">
        <tbody>
          {tab === "case"
            ? grouped.map((group) => <Fragment key={group.endpointId}>
                <tr className="picker-group"><td colSpan={3}>{group.endpointName}</td></tr>
                {group.items.map((item) => row(
                  { type: "case", id: item.id, name: item.name, endpointId: item.endpointId, endpointName: item.endpointName, environmentId: item.environmentId, environmentName: item.environmentName },
                  t("suites.assertionCount", { count: item.assertionCount }),
                ))}
              </Fragment>)
            : flows.map((flow) => row(
                { type: "flow", id: flow.id, name: flow.name, environmentId: flow.environmentId, environmentName: flow.environmentName },
                t("flows.stepCount", { count: flow.nodeCount }),
              ))}
        </tbody>
      </table>
    </div>}

    {tab === "case" && caseTotal > PAGE_SIZE && <div className="pager">
      <Pagination current={casePage} pageSize={PAGE_SIZE} total={caseTotal} showSizeChanger={false} onChange={setCasePage} />
    </div>}
  </Modal>;
}
