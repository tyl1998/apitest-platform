import { useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { fromPairs, type Pair } from "./KeyValueEditor";
import { VariableRowsEditor } from "./VariableRowsEditor";

/** 变量覆盖键名约束，与服务端 `validateVariableOverrides` 同一条规则。 */
const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 「运行套件」的确认弹窗：手动触发的变量覆盖在这里填（调度/Webhook 各自带自己的）。
 *
 * 三处入口共用（套件配置页、套件列表行）：同一个 API 的触发源不该有两种交互。覆盖是
 * **每次运行的入参**而不是套件配置——不落库；弹窗组件常驻（antd Modal 不销毁内容），
 * 值在页面会话内保留，连续打同一泳道不必重敲。
 *
 * 底部按钮用应用自己的 `.btn` 而不是 antd Modal 默认页脚：主/次按钮同一套尺寸与排版，
 * 与抽屉页脚一致——antd 默认页脚里 primary 与 default 的内边距差异在深色模式下
 * 尤其明显（验收反馈：两个按钮不协调）。
 */
export function SuiteRunModal({ open, suiteName, running, onClose, onRun }: {
  open: boolean;
  /** 弹窗标题里带上套件名：列表页一次能看到多行，弹窗必须说自己要跑谁。 */
  suiteName?: string;
  running?: boolean;
  onClose: () => void;
  onRun: (variables: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const [variables, setVariables] = useState<Pair[]>([]);

  function confirm() {
    const invalidKey = variables.find((pair) => pair.key.trim() && !VARIABLE_NAME_PATTERN.test(pair.key.trim()));
    if (invalidKey) { message.error(t("suites.variableKeyInvalid", { key: invalidKey.key })); return; }
    onRun(fromPairs(variables));
  }

  return <Modal
    title={suiteName ? `${t("suites.run")} · ${suiteName}` : t("suites.run")}
    open={open}
    onCancel={onClose}
    footer={
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn" onClick={onClose}>{t("action.cancel")}</button>
        <button className="btn btn-primary" disabled={running} onClick={confirm}>
          {running ? t("action.running") : t("suites.run")}
        </button>
      </div>
    }
  >
    <VariableRowsEditor
      title={t("suites.runVariables")}
      hint={t("suites.runVariablesHint")}
      pairs={variables}
      onChange={setVariables}
      keyPlaceholder="lane"
    />
  </Modal>;
}
