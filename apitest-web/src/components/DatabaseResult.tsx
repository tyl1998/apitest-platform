import { useTranslation } from "react-i18next";
import type { SqlExecutionResult } from "../api";

export function DatabaseResult({ result, error }: { result?: SqlExecutionResult; error?: string }) {
  const { t } = useTranslation();
  if (error) return <pre className="sql-error mono">{error}</pre>;
  if (!result) return null;
  const columns = Array.from(new Set(result.rows.flatMap((row) => Object.keys(row))));

  return <div className="sql-result">
    <div className="sql-result-meta mono">
      <span>{t("dataSources.rowCount", { count: result.rowCount })}</span>
      <span>{result.durationMs.toFixed(1)} ms</span>
      {result.truncated && <span>{t("dataSources.truncated")}</span>}
    </div>
    {result.rows.length > 0 && <div className="table-scroll">
      <table className="grid sql-result-grid">
        <thead><tr>{columns.map((column) => <th key={column} className="mono">{column}</th>)}</tr></thead>
        <tbody>{result.rows.map((row, index) => <tr key={index}>
          {columns.map((column) => <td key={column} className="mono">{formatCell(row[column])}</td>)}
        </tr>)}</tbody>
      </table>
    </div>}
  </div>;
}

function formatCell(value: unknown) {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
