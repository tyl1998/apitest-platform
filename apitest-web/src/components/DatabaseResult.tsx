import { Fragment, useState } from "react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";
import type { SqlExecutionResult } from "../api";

/* 慢查询阈值：执行耗时到达此值即在结果区标一个「慢查询」提示。库查询过 1s 值得回看
   是否走了索引/该不该加条件，取整秒是易记的默认门槛，而非精确的性能判据。 */
const SLOW_QUERY_MS = 1000;

export function DatabaseResult({ result, error }: { result?: SqlExecutionResult; error?: string }) {
  const { t } = useTranslation();
  /* 展开中的行下标。声明必须在下面两个早退之前——hooks 不能出现在条件之后。 */
  const [openRow, setOpenRow] = useState<number>();
  if (error) return <pre className="sql-error mono">{error}</pre>;
  if (!result) return null;
  const columns = Array.from(new Set(result.rows.flatMap((row) => Object.keys(row))));
  /* 下标越界即视为没有展开：重新跑一次 SQL 后，上次记住的下标可能已经不存在了。 */
  const detail = openRow === undefined ? undefined : result.rows[openRow];
  const slow = result.durationMs >= SLOW_QUERY_MS;

  return <div className="sql-result">
    <div className="sql-result-meta mono">
      <span>{t("dataSources.rowCount", { count: result.rowCount })}</span>
      <span className={slow ? "sql-result-warn" : undefined}>{result.durationMs.toFixed(1)} ms</span>
      {result.truncated && <span className="sql-result-warn">{t("dataSources.truncated")}</span>}
      {/* 全表扫描：SQL 自身没写 LIMIT/TOP/FETCH，服务端已默认按 200 行封顶。 */}
      {result.fullScan && <span className="sql-result-warn" title={t("dataSources.fullScanHint")}>{t("dataSources.fullScan")}</span>}
      {slow && <span className="sql-result-warn" title={t("dataSources.slowQueryHint", { ms: SLOW_QUERY_MS })}>{t("dataSources.slowQuery")}</span>}
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
