import { Fragment, useState } from "react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";
import type { SqlExecutionResult } from "../api";

export function DatabaseResult({ result, error }: { result?: SqlExecutionResult; error?: string }) {
  const { t } = useTranslation();
  /* 展开中的行下标。声明必须在下面两个早退之前——hooks 不能出现在条件之后。 */
  const [openRow, setOpenRow] = useState<number>();
  if (error) return <pre className="sql-error mono">{error}</pre>;
  if (!result) return null;
  const columns = Array.from(new Set(result.rows.flatMap((row) => Object.keys(row))));
  /* 下标越界即视为没有展开：重新跑一次 SQL 后，上次记住的下标可能已经不存在了。 */
  const detail = openRow === undefined ? undefined : result.rows[openRow];

  return <div className="sql-result">
    <div className="sql-result-meta mono">
      <span>{t("dataSources.rowCount", { count: result.rowCount })}</span>
      <span>{result.durationMs.toFixed(1)} ms</span>
      {result.truncated && <span>{t("dataSources.truncated")}</span>}
    </div>
    {result.rows.length > 0 && <div className="table-scroll">
      <table className="grid sql-result-grid">
        <thead><tr>
          {/* 行头列不写列名：它是每行的入口，不是一个字段。 */}
          <th className="sql-row-head" aria-hidden="true" />
          {columns.map((column) => <th key={column} className="mono">{column}</th>)}
        </tr></thead>
        <tbody>{result.rows.map((row, index) => <tr key={index}>
          <th scope="row" className="sql-row-head">
            {/* 只有行头可点，单元格留给划词复制——整行可点会让每次选中值都弹出弹窗。 */}
            <button
              type="button"
              className="sql-row-open mono"
              title={t("dataSources.viewRow")}
              aria-label={t("dataSources.rowDetail", { index: index + 1 })}
              onClick={() => setOpenRow(index)}
            >{index + 1}</button>
          </th>
          {columns.map((column) => <td key={column} className="mono">{formatCell(row[column])}</td>)}
        </tr>)}</tbody>
      </table>
    </div>}

    <Modal
      title={t("dataSources.rowDetail", { index: (openRow ?? 0) + 1 })}
      open={Boolean(detail)}
      onCancel={() => setOpenRow(undefined)}
      footer={null}
      width={640}
    >
      {/* 字段名 / 字段内容用 dl：一个网格容器装所有行，字段名才会左对齐成一列。 */}
      {detail && <dl className="sql-row-detail">
        {columns.map((column) => <Fragment key={column}>
          <dt className="mono">{column}</dt>
          <dd className="mono">{formatDetail(detail[column])}</dd>
        </Fragment>)}
      </dl>}
    </Modal>
  </div>;
}

function formatCell(value: unknown) {
  if (value === null) return "";
  if (value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * 展开视图的取值。
 *
 * 与 `formatCell` 的唯一差别是对象带缩进：这个弹窗存在的意义就是看清被表格
 * 单元格（`max-width: 360px` + ellipsis）截断的长值，压成一行就白开了。
 */
function formatDetail(value: unknown) {
  if (value === null) return "";
  if (value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
