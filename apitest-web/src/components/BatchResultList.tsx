import { useState } from "react";
import { Pagination } from "antd";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { BatchDebugResult } from "../api";
import { toRunStatus } from "../ui";
import { ExecutionDetail } from "./ExecutionSnapshot";
import { RunStatusTag } from "./RunStatusTag";

const PAGE_SIZE = 10;

/**
 * One batch, read as a list of endpoints.
 *
 * A row expands in place instead of opening a second drawer: the run being
 * inspected belongs to the batch already on screen, and stacking drawers hides
 * the list you are working through.
 */
export function BatchResultList({ batch }: { batch: BatchDebugResult }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string>();

  /* Paging is for long batches only; a handful of rows needs no control. */
  const paged = batch.items.length > PAGE_SIZE;
  const visible = paged ? batch.items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : batch.items;

  return <>
    <div className="batch-items">
      {visible.map((item) => {
        const open = expanded === item.endpointId;
        return <div className="batch-row" key={item.endpointId}>
          <button
            className="batch-item batch-item-button"
            aria-expanded={open}
            onClick={() => setExpanded(open ? undefined : item.endpointId)}
          >
            <span className="batch-caret">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
            <span className="truncate">{item.endpointName}</span>
            {item.execution
              ? <>
                <RunStatusTag status={toRunStatus(item.execution.status)} />
                <span className="mono muted">{item.execution.statusCode ?? "—"} · {item.execution.durationMs}ms</span>
              </>
              : <>
                <RunStatusTag status="fail" />
                <span className="mono muted">—</span>
              </>}
          </button>
          {open && <div className="batch-detail">
            {item.execution
              ? <ExecutionDetail result={item.execution} />
              : <div className="code-block">
                <span className="label">{t("snapshot.error")}</span>
                <pre className="code" data-tone="fail">{item.error}</pre>
              </div>}
          </div>}
        </div>;
      })}
    </div>

    {paged && <div className="pager">
      <Pagination current={page} pageSize={PAGE_SIZE} total={batch.items.length} showSizeChanger={false} onChange={setPage} />
    </div>}
  </>;
}
