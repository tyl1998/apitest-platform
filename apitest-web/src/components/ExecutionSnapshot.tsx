import { Drawer, message } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type Execution } from "../api";
import { Readout, Waterfall, toRunStatus } from "../ui";
import { AssertionResults } from "./AssertionEditor";
import { HookOutcome } from "./PreRequestHookEditor";
import { RunStatusTag } from "./RunStatusTag";
import { CopyButton } from "./CopyButton";
import { ResponseScriptResults } from "./ResponseScriptEditor";

/**
 * 「下载完整响应」（P10-1）：仅当这次执行的全量正文确实转存过时才出现。
 *
 * 拆成独立组件是因为两处渲染器都要用它——证据抽屉（ExecutionDetail）与接口工作台的
 * 实时响应面板（EndpointWorkspace 的 ResponsePanel）。两份实现会让「什么时候有入口」
 * 漂移，而这正是用户判断「有没有全量」的唯一线索。
 *
 * 完整正文不随执行详情下发（key 是存储细节，直链短活且会泄进分享载荷），所以一次点
 * 一次换：拿到短活 URL 后由浏览器直打对象存储 / fs 直链端点，平台不经手字节。用隐藏
 * <a> 触发而不是 window.open——下载是导航而不是新开页，也躲开弹窗拦截。
 *
 * `publicView`（公开分享页）不渲染：那条通路要登录态的项目端点，分享页两者都没有。
 */
export function DownloadFullResponseButton({ execution, publicView }: {
  execution: Execution;
  publicView?: boolean;
}) {
  const { t } = useTranslation();
  const [fetching, setFetching] = useState(false);
  if (!execution.responseBodyStored || publicView) return null;

  async function download() {
    setFetching(true);
    try {
      const { downloadUrl } = await api.executionResponseBodyUrl(execution.projectId, execution.id);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      /* 直链换不到最常见的两个原因：对象已不在（换过驱动 / 被清理）、行上没有全量。
         两者都不是页面崩溃，说一句就够。 */
      message.error(t("history.fullResponseFailed"));
    } finally { setFetching(false); }
  }

  return <button className="btn btn-small" disabled={fetching} onClick={() => void download()}>
    {t("history.downloadFullResponse")}
  </button>;
}

/**
 * The evidence itself, without a container.
 *
 * Split out so a run can also be read in place — the batch result list expands
 * a row rather than stacking a second drawer over the first.
 *
 * `publicView`（P10-1）：公开分享页复用同一个渲染器，但下载完整响应要走登录态的项目
 * 端点（`/projects/:id/executions/:id/response-body`），分享页没有登录态也没有项目上下文
 * ——那里不渲染下载入口，公开证据闭包保持只读。
 */
export function ExecutionDetail({ result, onRerun, onLoadRequest, busy, publicView }: {
  result: Execution;
  onRerun?: () => void;
  onLoadRequest?: () => void;
  busy?: boolean;
  publicView?: boolean;
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
        <div className="code-block-tools">
          {/* 全量已转存时才给入口（P10-1）：预览仍是那 10KB，下载拿到的是完整正文。 */}
          <DownloadFullResponseButton execution={result} publicView={publicView} />
          <CopyButton value={() => result.responseBody ?? ""} />
        </div>
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
