import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { IconButton } from "./IconButton";
import type { Pair } from "./KeyValueEditor";

/**
 * 变量覆盖的行编辑器：环境抽屉里普通变量行的同款排版（列头 + 键 / 值 / 复制 / 删除）。
 *
 * 不复用 `KeyValueEditor`（表 / 文本双模式 + 启用勾选）：那是给请求头与参数用的——
 * 调试时要临时停用一行、要从 curl 批量粘贴。变量覆盖没有这两个动作，模式切换与
 * 勾选列在这里只是噪音。也没有 Text / Secret 切换：触发参数里不许放密钥（边界 17），
 * 留一个 Secret 按钮只会诱导人去用。
 *
 * 与环境变量行一样，末尾常驻一个空行，敲进第一个字符它才成为真实的一行；复制按钮
 * 给出的是 `{{key}}`——把 lane 复制进默认头的值里，正是这套泳道用法的前半步。
 */
export function VariableRowsEditor({ title, hint, pairs, onChange, keyPlaceholder, copyTemplate = true }: {
  title: string;
  hint?: string;
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
  keyPlaceholder?: string;
  /**
   * 复制按钮给什么：`true`（变量覆盖，默认）复制 `{{key}}`；`false`（环境默认头）复制
   * 头名本身——把 X-Env-Tag 复制进接口定义里，比复制 `{{X-Env-Tag}}` 有用。
   */
  copyTemplate?: boolean;
}) {
  const { t } = useTranslation();
  const columns = "minmax(0, 1fr) minmax(0, 1.4fr) 28px 28px";
  const headerStyle = { fontSize: 11, color: "var(--ink-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" } as const;

  /** 与 KeyValueEditor 同一条规则：`index === pairs.length` 是末尾空行，编辑它即追加。 */
  function update(index: number, patch: Partial<Pair>) {
    if (index === pairs.length) {
      onChange([...pairs, { key: "", value: "", enabled: true, ...patch }]);
      return;
    }
    onChange(pairs.map((pair, i) => i === index ? { ...pair, ...patch } : pair));
  }

  const count = pairs.filter((pair) => pair.enabled && pair.key.trim()).length;

  return <div className="kv">
    <h3 className="subhead">{title}{count > 0 && <span className="tab-count mono">{count}</span>}</h3>
    {hint && <p className="form-note">{hint}</p>}

    <div className="kv-row" style={{ gridTemplateColumns: columns, marginTop: 8 }}>
      <span style={headerStyle}>{t("common.variableName")}</span>
      <span style={headerStyle}>{t("common.variableValue")}</span>
      <span />
      <span />
    </div>

    {[...pairs, { key: "", value: "", enabled: true }].map((pair, index) => {
      const blank = index === pairs.length;
      return <div className={`kv-row${blank ? " is-blank" : ""}`} key={index} style={{ gridTemplateColumns: columns }}>
        <input
          className="input mono"
          value={pair.key}
          placeholder={keyPlaceholder ?? "KEY"}
          onChange={(event) => update(index, { key: event.target.value })}
          spellCheck={false}
        />
        <input
          className="input mono"
          value={pair.value}
          placeholder="value"
          onChange={(event) => update(index, { value: event.target.value })}
          spellCheck={false}
        />
        {pair.key.trim() && !blank
          ? <CopyButton value={() => (copyTemplate ? `{{${pair.key.trim()}}}` : pair.key.trim())} />
          : <span />}
        {blank
          ? <span />
          : <IconButton icon={<Trash2 size={13} />} label={t("action.delete")} tone="danger" onClick={() => onChange(pairs.filter((_, i) => i !== index))} />}
      </div>;
    })}
  </div>;
}
