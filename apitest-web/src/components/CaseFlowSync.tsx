import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { api, type CaseFlowBinding } from "../api";
import { Empty } from "../ui";

/**
 * 用例 → 已绑定流程的同步（P2-4.5 增补）。
 *
 * 流程请求节点从用例导入时复制了一份完整快照，所以**改用例不会自动改动已存的流程**
 * （交互文档 3.1.3 快照隔离）。那条规则保住了「流程跑的是它自己存下的东西」，代价是
 * 用例修好之后，引用它的每条流程都要手工重新导入一次——这个 tab 把那件事变成一次点击。
 *
 * **可以一次勾选多条流程**：一处改动往往要推给所有复用它的链路，让人重复点五次同步
 * 只是把同一个决定说五遍。破坏性由「勾选 + 确认对话框逐条列出会被覆盖的节点」承担，
 * 服务端在一个事务里全部写完，不会留下「一半新一半旧」。
 *
 * 同步用的是**已保存的用例**，不是屏幕上的草稿：服务端读库里那一份。所以用例有未保存
 * 改动时先提示去保存，而不是同步出一份用户以为是新的、其实是旧的定义。
 */
export function CaseFlowSync({ projectId, caseId, caseName, caseDirty }: {
  projectId: string;
  caseId: string;
  caseName: string;
  /** 用例本身有未保存改动：同步读的是库里那份，先说清楚再让人点。 */
  caseDirty: boolean;
}) {
  const { t } = useTranslation();
  const [bindings, setBindings] = useState<CaseFlowBinding[]>();
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try { setBindings(await api.caseFlowBindings(projectId, caseId)); }
    /* 读失败要说出来：一个空列表会被读成「没有流程引用它」，而那是错的结论。 */
    catch { setFailed(true); }
  }, [projectId, caseId]);

  useEffect(() => { setBindings(undefined); setPicked(new Set()); void load(); }, [load]);

  const targets = useMemo(() => (bindings ?? []).filter((binding) => picked.has(binding.flowId)), [bindings, picked]);
  const nodeTotal = targets.reduce((sum, binding) => sum + binding.nodes.length, 0);
  const allPicked = Boolean(bindings?.length) && targets.length === bindings!.length;

  function toggle(flowId: string, on: boolean) {
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(flowId); else next.delete(flowId);
      return next;
    });
  }

  function confirmSync() {
    if (!targets.length) return;
    Modal.confirm({
      title: t("caseSync.confirmTitle", { count: targets.length }),
      content: <div>
        <p>{t("caseSync.confirmHint", { name: caseName })}</p>
        {/* 逐条列出流程与它下面会被覆盖的节点：一句「将覆盖 5 个节点」说不出改的是哪儿。 */}
        {targets.map((binding) => <div key={binding.flowId}>
          <p className="form-note">{binding.flowName}</p>
          <ul className="usage-list">
            {binding.nodes.map((node) => <li key={node.nodeId}>
              {node.nodeName}{node.inLoop ? ` · ${t("caseSync.inLoop")}` : ""}
            </li>)}
          </ul>
        </div>)}
        <p className="form-note">{t("caseSync.confirmKeeps")}</p>
      </div>,
      okText: t("caseSync.sync"),
      okButtonProps: { danger: true },
      cancelText: t("action.cancel"),
      width: 560,
      onOk: async () => {
        setSyncing(true);
        try {
          const result = await api.syncCaseToFlows(projectId, caseId, targets.map((binding) => binding.flowId));
          const nodes = result.flows.reduce((sum, flow) => sum + flow.updatedNodeIds.length, 0);
          /* 重新读一次清单：同步刚改过这些流程的 updatedAt，列表上的「最近更新」要跟上。 */
          await load();
          setPicked(new Set());
          message.success(t("caseSync.synced", { flows: result.flows.length, count: nodes }));
        } catch (error) {
          message.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t("caseSync.syncFailed"));
        } finally { setSyncing(false); }
      },
    });
  }

  if (failed) return <div>
    <p className="form-error">{t("caseSync.loadFailed")}</p>
    <button className="btn btn-small" onClick={() => void load()}>{t("action.retry")}</button>
  </div>;
  if (!bindings) return <p className="muted">{t("common.loading")}</p>;
  if (!bindings.length) return <Empty title={t("caseSync.emptyTitle")} hint={t("caseSync.emptyHint")} />;

  return <>
    <p className="form-note">{t("caseSync.hint")}</p>
    {/* 用例自己没存就先说：同步读的是库里那一份，同步一份旧定义过去比不同步更糟。 */}
    {caseDirty && <p className="form-error">{t("caseSync.dirtyWarning")}</p>}

    <table className="grid picker-grid">
      <tbody>
        <tr className="picker-group">
          <td className="col-select" onClick={(event) => event.stopPropagation()}>
            <input
              type="checkbox" aria-label={t("caseSync.selectAll")}
              checked={allPicked}
              /* 部分勾选显示成半选，否则「全选」框在勾了 2/5 时看起来像没勾。 */
              ref={(node) => { if (node) node.indeterminate = targets.length > 0 && !allPicked; }}
              onChange={(event) => setPicked(event.target.checked ? new Set(bindings.map((binding) => binding.flowId)) : new Set())}
            />
          </td>
          <td colSpan={3}>{t("caseSync.selectAll")}</td>
        </tr>
        {bindings.map((binding) => {
          const checked = picked.has(binding.flowId);
          return <tr
            key={binding.flowId}
            data-clickable=""
            className={checked ? "is-selected" : undefined}
            onClick={() => toggle(binding.flowId, !checked)}
          >
            <td className="col-select" onClick={(event) => event.stopPropagation()}>
              <input
                type="checkbox" aria-label={binding.flowName}
                checked={checked} onChange={(event) => toggle(binding.flowId, event.target.checked)}
              />
            </td>
            <td><span className="truncate">{binding.flowName}</span></td>
            <td className="mono muted truncate">
              {t("caseSync.nodeCount", { count: binding.nodes.length })}
              {binding.nodes.some((node) => node.inLoop) ? ` · ${t("caseSync.hasLoopNode")}` : ""}
            </td>
            <td className="mono muted">{new Date(binding.updatedAt).toLocaleDateString()}</td>
          </tr>;
        })}
      </tbody>
    </table>

    <div className="filter-bar" style={{ marginTop: 12 }}>
      <span className="mono muted">{targets.length
        ? t("caseSync.willOverwrite", { flows: targets.length, count: nodeTotal })
        : t("caseSync.pickFlow")}</span>
      <span className="filter-spacer" />
      <button className="btn btn-with-icon" disabled={!targets.length || syncing || caseDirty} onClick={confirmSync}>
        <RefreshCw size={14} />{syncing ? "…" : t("caseSync.sync")}
      </button>
    </div>
  </>;
}
