import { useCallback, useEffect, useState } from "react";
import { Modal, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { Copy, Plus, Trash2 } from "lucide-react";
import { api, type Runner, type RunnerFleet, type RunnerToken } from "../api";
import { Empty, Readout, Status } from "../ui";
import { CopyButton, writeClipboard } from "./CopyButton";
import { IconButton } from "./IconButton";

/**
 * Runner 池（P4.5-11，交互 3.12.4；系统管理员）。
 *
 * 放在系统设置里、**紧挨着执行器面板**，因为那是最容易被当成重复功能的一对（8.6）：
 * - **执行器**：平台内部的 BullMQ worker，跑平台自己的接口/流程/套件，直连 Redis 与
 *   Postgres，掉线只影响调度；
 * - **Runner**：自托管机器，跑用户仓库里的代码，只需出站 443，掉线要判 `aborted` 并
 *   回收租约。
 *
 * 两张表两个概念，所以两个面板并列且各自写明区别——合并成一个会让「离线」这个词在同一
 * 列上有两种含义。
 *
 * 「新增 Runner」不是在这里装一台机器，而是**签发一张注册 Token** 并给出部署命令：
 * Runner 主动外连注册，平台永不反向连接它（那是自托管能待在 NAT 后面的全部前提）。
 */

/**
 * 部署命令模板（照 `apitest-runner/README.md` 的部署一节）。
 *
 * **不写 `npx apitest-runner`**：那个包没有发布，Runner 是仓库里的第四个工程，部署方式
 * 是在目标机器上 build 再起。`APITRACK_RUNNER_*` 变量是它启动必读的；`start.sh`
 * 会从 `.env` 补齐其余的。
 *
 * `APITRACK_RUNNER_DOCKER_TRANSPORT`（2026-09-03）：容器档通道在部署时选定——cli 是
 * 命令模式（`docker run`，默认），api 是 Socket 模式（Engine API over unix socket，
 * OOMKilled 判定有确定答案）。通道是**这台机器怎么连它本地 daemon** 的属性，所以选择
 * 发生在这里而不是任务配置里。
 */
function deployCommand(baseUrl: string, token: string, labels: string[], transport: "cli" | "api"): string {
  return [
    "cd apitest-runner && pnpm install && pnpm build",
    `export APITRACK_RUNNER_URL=${baseUrl}`,
    `export APITRACK_RUNNER_TOKEN=${token}`,
    `export APITRACK_RUNNER_LABELS=${labels.join(",")}`,
    `export APITRACK_RUNNER_DOCKER_TRANSPORT=${transport}`,
    "./start.sh",
  ].join("\n");
}

/** 平台对外根地址：Runner 拨的是根地址而不是 `/api/v1`（协议路由挂在根上）。 */
function runnerBaseUrl(): string {
  const base = import.meta.env.VITE_API_BASE_URL ?? `${window.location.origin.replace(/:\d+$/, ":3000")}/api/v1`;
  return String(base).replace(/\/api\/v1\/?$/, "");
}

export function RunnerPoolPanel() {
  const { t } = useTranslation();
  const [fleet, setFleet] = useState<RunnerFleet>();
  const [tokens, setTokens] = useState<RunnerToken[]>([]);
  const [failed, setFailed] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [tokenLabels, setTokenLabels] = useState<string[]>(["default"]);
  /* 部署命令里的容器档通道（2026-09-03）：命令模式（docker run，默认）/ Socket 模式
     （Engine API）。选择写进 export 行，运维复制粘贴即得一台走选定通道的机器。 */
  const [tokenTransport, setTokenTransport] = useState<"cli" | "api">("cli");
  const [creating, setCreating] = useState(false);
  /**
   * 刚签发出来的明文。**只在那一次响应里存在**，所以它留在内存里直到离开这一页——刷新
   * 之后再也拿不到，这一点必须在界面上说清，否则丢了会被当成 bug。
   */
  const [issued, setIssued] = useState<{ id: string; token: string; labels: string[]; transport: "cli" | "api" }>();

  const load = useCallback(async (quiet = false) => {
    try {
      const [nextFleet, nextTokens] = await Promise.all([api.runnerFleet(), api.runnerTokens()]);
      setFleet(nextFleet);
      setTokens(nextTokens);
      setFailed(false);
    } catch {
      if (!quiet) setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    /* 心跳是 30 秒一次、90 秒判离线，10 秒轮询已经比它细。静默重试：一次网络抖动不该把
       整个面板换成错误态。 */
    const timer = setInterval(() => void load(true), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  async function createToken() {
    if (!tokenName.trim()) { message.error(t("runners.tokenNameRequired")); return; }
    setCreating(true);
    try {
      const labels = tokenLabels.length ? tokenLabels : ["default"];
      const created = await api.createRunnerToken({ name: tokenName.trim(), labels });
      setIssued({ id: created.id, token: created.token, labels, transport: tokenTransport });
      setTokenName("");
      await load();
    } catch { message.error(t("runners.tokenCreateFailed")); }
    finally { setCreating(false); }
  }

  async function copySecret(token: RunnerToken) {
    try {
      /* Token 现改为可逆加密存储，明文可重新取回：拉一次明文直接复制，丢了不必吊销重发。 */
      const { token: secret } = await api.runnerTokenSecret(token.id);
      await writeClipboard(secret);
      message.success(t("runners.tokenCopied"));
    } catch { message.error(t("runners.tokenCopyFailed")); }
  }

  function revokeToken(token: RunnerToken) {
    Modal.confirm({
      title: t("runners.tokenRevokeTitle", { name: token.name }),
      /* 吊销**即时生效**（鉴权走部分索引，被吊销的行不在索引里）：那张 token 名下的机器
         下一次心跳就会被拒，在跑的任务因此会被判 aborted。影响面要说清。 */
      content: t("runners.tokenRevokeHint", { count: token.runnerCount ?? 0 }),
      okText: t("runners.tokenRevoke"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try { await api.revokeRunnerToken(token.id); await load(); message.success(t("runners.tokenRevoked")); }
        catch { message.error(t("runners.tokenRevokeFailed")); }
      },
    });
  }

  async function setStatus(runner: Runner, status: "online" | "draining") {
    try {
      await api.updateRunner(runner.id, status);
      await load();
      message.success(t(status === "draining" ? "runners.draining" : "runners.resumed"));
    } catch { message.error(t("runners.statusFailed")); }
  }

  if (failed) return <Empty title={t("runners.loadFailedTitle")} hint={t("runners.loadFailedHint")} />;
  if (!fleet) return <p className="muted">{t("common.loading")}</p>;

  /* 标签候选：已签发 token 声明过的标签 ∪ default。签发时只能从这里挑或自己写——子集
     校验在注册那一步做，这里不做约束，只做提示。 */
  const labelOptions = [...new Set(["default", ...tokens.flatMap((token) => token.labels)])].sort()
    .map((label) => ({ value: label, label }));

  return <>
    {/* 与执行器面板的区别（8.6）：不写明会被当成重复功能报上来。 */}
    <p className="form-note">{t("runners.hint")}</p>

    <div className="readouts">
      <Readout label={t("runners.online")} value={`${fleet.online}/${fleet.total}`} />
      <Readout label={t("runners.capacity")} value={fleet.capacity} />
      <Readout label={t("runners.offlineAfter")} value={fleet.offlineAfterSeconds} unit="s" />
    </div>

    <h3 className="subhead">{t("runners.fleetTitle")}</h3>
    {fleet.runners.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("runners.runner")}</th>
        <th>{t("runners.labels")}</th>
        <th>{t("runners.sandboxModes")}</th>
        <th className="col-num">{t("runners.capacityColumn")}</th>
        <th>{t("runners.lastSeen")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {fleet.runners.map((runner) => <tr key={runner.id}>
          <td>
            {/* 三态而不是两态：draining 的机器仍在线（它要跑完手上的活），只是不再领新
                任务——把它显示成「在线」会让人以为下线没生效。 */}
            <Status
              status={!runner.online ? "canceled" : runner.status === "draining" ? "skip" : "running"}
              label={!runner.online ? t("runners.statusOffline") : runner.status === "draining" ? t("runners.statusDraining") : t("runners.statusOnline")}
            />
            <div className="mono muted">{runner.name} · {runner.runnerTokenName ?? "—"}{runner.version ? ` · ${runner.version}` : ""}</div>
          </td>
          <td className="mono">{runner.labels.join(", ")}</td>
          <td className="mono">
            {runner.sandboxModes.join(", ")}
            {/* 通道只在容器档有意义（进程档不连 daemon）；没有自报的旧版 Runner 显示原文
                而不是猜。 */}
            {runner.sandboxModes.includes("container") && (runner.dockerTransport
              ? ` · ${t(runner.dockerTransport === "cli" ? "runners.transportCli" : runner.dockerTransport === "api" ? "runners.transportApi" : "runners.transportUnknown")}`
              : "")}
          </td>
          <td className="col-num mono">{runner.capacity}</td>
          <td className="mono muted">{new Date(runner.lastSeenAt).toLocaleString()}</td>
          <td className="col-actions">
            <div className="row-actions">
              {runner.status === "draining"
                ? <button className="btn" onClick={() => void setStatus(runner, "online")}>{t("runners.resume")}</button>
                : <button className="btn" onClick={() => void setStatus(runner, "draining")}>{t("runners.drain")}</button>}
            </div>
          </td>
        </tr>)}
      </tbody>
    </table></div> : <Empty title={t("runners.emptyTitle")} hint={t("runners.emptyHint")} />}
    <p className="form-note">{t("runners.drainHint")}</p>

    <h3 className="subhead">{t("runners.tokensTitle")}</h3>
    <p className="form-note">{t("runners.tokensHint")}</p>
    <div className="filter-bar">
      <input
        className="input"
        value={tokenName}
        onChange={(event) => setTokenName(event.target.value)}
        placeholder={t("runners.tokenNamePlaceholder")}
        style={{ width: 220 }}
      />
      {/* 标签是**这张 token 允许声明的分区**：注册时校验子集，否则任何拿到 token 的机器
          都能自称在生产网段。所以它是签发时的一个决定，不是机器自己说了算。 */}
      <Select
        mode="tags"
        value={tokenLabels}
        onChange={setTokenLabels}
        options={labelOptions}
        placeholder="default"
        style={{ minWidth: 220 }}
      />
      {/* 通道跟着部署命令走（见 deployCommand 的注释）：这里选了什么，贴出去的命令就
          export 什么，面板上那台机器注册回来也自报同一个词。 */}
      <Select
        value={tokenTransport}
        onChange={setTokenTransport}
        options={[
          { value: "cli", label: t("runners.transportCli") },
          { value: "api", label: t("runners.transportApi") },
        ]}
        style={{ width: 200 }}
      />
      <button className="btn btn-primary btn-with-icon" disabled={creating} onClick={() => void createToken()}>
        <Plus size={14} />{t("runners.createToken")}
      </button>
    </div>
    <p className="form-note">{t("runners.transportHint")}</p>

    {issued && <div className="code-block" style={{ marginBottom: "var(--s4)" }}>
      <div className="code-block-head">
        <span className="label">{t("runners.deployCommand")}</span>
        <CopyButton value={() => deployCommand(runnerBaseUrl(), issued.token, issued.labels, issued.transport)} />
      </div>
      <pre className="code">{deployCommand(runnerBaseUrl(), issued.token, issued.labels, issued.transport)}</pre>
      <small className="form-note">{t("runners.tokenPlaintextOnce")}</small>
    </div>}

    {tokens.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("runners.tokenName")}</th>
        <th className="mono">{t("runners.tokenPrefix")}</th>
        <th>{t("runners.labels")}</th>
        <th className="col-num">{t("runners.tokenRunnerCount")}</th>
        <th>{t("runners.tokenLastUsed")}</th>
        <th className="col-status">{t("runners.tokenStatus")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {tokens.map((token) => <tr key={token.id} data-removed={token.revokedAt ? "" : undefined}>
          <td><strong className="truncate">{token.name}</strong></td>
          <td className="mono muted">{token.tokenPrefix}…</td>
          <td className="mono">{token.labels.join(", ")}</td>
          <td className="col-num mono">{token.runnerCount ?? 0}</td>
          <td className="mono muted">{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : t("runners.tokenNeverUsed")}</td>
          <td className="col-status">
            {token.revokedAt
              ? <span className="chip chip-warn">{t("runners.tokenRevoked")}</span>
              : <span className="status" data-status="pass"><span className="status-mark" />{t("runners.tokenActive")}</span>}
          </td>
          <td className="col-actions">
            {!token.revokedAt && <div className="row-actions">
              <IconButton icon={<Copy size={14} />} label={t("runners.tokenCopy")} onClick={() => void copySecret(token)} />
              <IconButton icon={<Trash2 size={14} />} label={t("runners.tokenRevoke")} tone="danger" onClick={() => revokeToken(token)} />
            </div>}
          </td>
        </tr>)}
      </tbody>
    </table></div> : <Empty title={t("runners.tokensEmptyTitle")} hint={t("runners.tokensEmptyHint")} />}
  </>;
}
