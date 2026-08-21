import { Drawer } from "antd";
import { useTranslation } from "react-i18next";
import type { Execution } from "../api";
import { Readout, Waterfall, toRunStatus } from "../ui";
import { AssertionResults } from "./AssertionEditor";
import { HookOutcome } from "./PreRequestHookEditor";
import { RunStatusTag } from "./RunStatusTag";
import { CopyButton } from "./CopyButton";
import { ResponseScriptResults } from "./ResponseScriptEditor";

/**
 * The evidence itself, without a container.
 *
 * Split out so a run can also be read in place — the batch result list expands
 * a row rather than stacking a second drawer over the first.
 */
export function ExecutionDetail({ result, onRerun, onLoadRequest, busy }: {
  result: Execution;
  onRerun?: () => void;
  onLoadRequest?: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();

  return <div className="snapshot">
    <div className="readouts" style={{ marginBottom: 0 }}>
      <Readout label={t("status.code")} value={result.statusCode ?? "—"} />
      <Readout label={t("status.duration")} value={result.durationMs} unit="ms" />
      <Readout label={t("status.size")} value={result.responseSizeBytes} unit="B" />
    </div>

    {/* The breakdown is estimated from total time. When the request never
        completed there are no phases to apportion, and showing invented
        DNS/TCP/TLS numbers would misrepresent what happened. */}
    {result.status === "success" && <Waterfall total={result.durationMs} />}

    <div className="code-block">
      <div className="code-block-head">
        <span className="label">{t("snapshot.request")}</span>
        <CopyButton value={() => `${result.request.method} ${result.request.url}`} />
      </div>
      <code className="code">{result.request.method} {result.request.url}</code>
    </div>

    {/* A case run's verdict comes from its assertions, so they are read next to
        the evidence rather than inferred from the status code. */}
    <AssertionResults results={result.assertionResults} />
    <ResponseScriptResults results={result.responseScriptResults} />

    {/* A flow step's extracts, each with its own verdict. One combined "could
        not extract" line would hide which value failed, and the three causes —
        wrong path, body is not JSON, the field really is null — need different
        fixes. */}
    {result.extractResults.length > 0 && <div className="assertion-list">
      {result.extractResults.map((extract, index) => <div key={index} className="assertion-result">
        <RunStatusTag status={extract.ok ? "pass" : "fail"} />
        <code className="assertion-expr mono">
          {extract.name} ← {extract.from === "status" ? t("flows.extractFrom.status") : extract.path}
        </code>
        <span className={extract.ok ? "assertion-actual mono" : "assertion-actual mono text-fail"}>
          {extract.ok ? extract.value : extract.reason}
        </span>
      </div>)}
    </div>}

    {/* What each 前置钩子 did, above the request it produced.
        The canonical string a signature was built from lives here — when a
        signature is rejected, that string is the only thing worth comparing,
        and the request snapshot below already shows the signed result. */}
    {result.hookResults?.length > 0 && <div className="hook-results">
      {result.hookResults.map((hook, index) => <HookOutcome key={index} outcome={hook} />)}
    </div>}

    {/* Snapshotted at run time, so it still reads correctly after the
        environment is renamed or deleted. */}
    {result.environmentName && <div className="code-block">
      <span className="label">{t("snapshot.environment")}</span>
      <code className="code">{result.environmentName}</code>
    </div>}

    {result.request.headers && Object.keys(result.request.headers).length > 0 && <div className="code-block">
      <div className="code-block-head">
        <span className="label">{t("snapshot.requestHeaders")}</span>
        <CopyButton value={() => JSON.stringify(result.request.headers, null, 2)} />
      </div>
      <pre className="code">{JSON.stringify(result.request.headers, null, 2)}</pre>
    </div>}

    {result.request.body !== undefined && result.request.body !== null && <div className="code-block">
      <div className="code-block-head">
        <span className="label">{t("snapshot.requestBody")}</span>
        <CopyButton value={() => requestBodyText(result)} />
      </div>
      <pre className="code">{requestBodyText(result)}</pre>
    </div>}

    {result.error && <div className="code-block">
      <span className="label">{t("snapshot.error")}</span>
      <pre className="code" data-tone="fail">{result.error}</pre>
    </div>}

    <div className="code-block">
      <div className="code-block-head">
        <span className="label">{t("snapshot.responseHeaders")}</span>
        <CopyButton value={() => JSON.stringify(result.responseHeaders, null, 2)} />
      </div>
      <pre className="code">{JSON.stringify(result.responseHeaders, null, 2)}</pre>
    </div>

    <div className="code-block">
      <div className="code-block-head">
        {/* The truncation notice stays on the label: what is copied is what was
            stored, and the tail is genuinely not here to copy. */}
        <span className="label">{t("snapshot.responseBody")}{result.responseTruncated ? ` · ${t("status.truncated")}` : ""}</span>
        <CopyButton value={() => result.responseBody ?? ""} />
      </div>
      <pre className="code">{result.responseBody ?? ""}</pre>
    </div>

    {(onRerun || onLoadRequest) && <div className="snapshot-actions">
      {onRerun && <button className="btn btn-primary" disabled={busy} onClick={onRerun}>{t("action.rerun")}</button>}
      {/* Backfills this run's request into the editor for a quick re-send. */}
      {onLoadRequest && <button className="btn" disabled={busy} onClick={onLoadRequest}>{t("history.loadRequest")}</button>}
    </div>}
  </div>;
}

/** Shared by the rendered block and its copy button so the two cannot diverge. */
function requestBodyText(result: Execution) {
  return typeof result.request.body === "string" ? result.request.body : JSON.stringify(result.request.body, null, 2);
}

/** Full request/response evidence for one run. Shared by every page that shows results. */
export function ExecutionSnapshot({ result, onClose, onRerun, onLoadRequest, busy }: {
  result?: Execution;
  onClose: () => void;
  onRerun?: () => void;
  /** Only the endpoint workspace can receive a request back, so this is optional. */
  onLoadRequest?: () => void;
  busy?: boolean;
}) {
  return <Drawer
    width={640}
    open={Boolean(result)}
    onClose={onClose}
    /* A case run is named by its case; a debug send by its endpoint. */
    title={result?.caseName ?? result?.endpointName}
    extra={result && <RunStatusTag status={toRunStatus(result.status)} />}
  >
    {result && <ExecutionDetail result={result} onRerun={onRerun} onLoadRequest={onLoadRequest} busy={busy} />}
  </Drawer>;
}
