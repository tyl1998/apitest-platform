import { Fragment, useEffect, useState } from "react";
import { Drawer, Modal, Pagination, Select, message } from "antd";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { Pencil, Plus, Send, Trash2 } from "lucide-react";
import { api, type AlertComparator, type AlertMetric, type AlertRule, type NotificationChannel, type NotificationChannelType } from "../api";
import { useCanWrite } from "../hooks/useMyRole";
import { usePageContext } from "../hooks/usePageContext";
import { useProjectStore } from "../stores/projectStore";
import { Empty, PageToolbar } from "../ui";
import { IconButton } from "./IconButton";
import { OwnerCell } from "./OwnerCell";

/**
 * 告警通知（P3-9，边界 8~10）。一个页面三段：渠道 → 规则 → 派发记录。
 *
 * 三段是同一条链路的三个位置：渠道说「往哪发」，规则说「什么时候发」，派发记录说
 * 「到底发了没有」。「没收到告警」的三种原因（规则没命中 / 渠道配错 / 对方 5xx）各在
 * 一段里查，这也是它们要在同一页的原因。
 */

const PAGE_SIZES = [20, 50, 100];
const CHANNEL_TYPES: NotificationChannelType[] = ["webhook", "wecom", "dingtalk", "slack"];
const METRICS: AlertMetric[] = ["execution_failed", "consecutive_failures", "success_rate", "avg_duration"];
const COMPARATORS: AlertComparator[] = ["gt", "gte", "lt", "lte"];
/** 事件型指标：失败事件一到就评估，没有窗口（迁移 031 的语义）。 */
const EVENT_METRICS: AlertMetric[] = ["execution_failed"];

type ChannelForm = {
  name: string;
  type: NotificationChannelType;
  url: string;
  secret: string;
  clearSecret: boolean;
  templatePrefix: string;
  enabled: boolean;
};

type RuleForm = {
  name: string;
  metric: AlertMetric;
  comparator: AlertComparator;
  threshold: string;
  windowMinutes: string;
  cooldownSeconds: string;
  channelIds: string[];
  enabled: boolean;
};

function emptyChannelForm(): ChannelForm {
  return { name: "", type: "webhook", url: "", secret: "", clearSecret: false, templatePrefix: "", enabled: true };
}

function emptyRuleForm(): RuleForm {
  return { name: "", metric: "execution_failed", comparator: "gte", threshold: "1", windowMinutes: "", cooldownSeconds: "600", channelIds: [], enabled: true };
}

export function Alerts() {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const { projectId: loadedProjectId, loading: projectLoading } = useProjectStore();
  /* viewer：渠道/规则的创建、测试、编辑、删除入口全藏（P6-4）；派发记录照读。 */
  const canWrite = useCanWrite();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "rules" ? "rules" : searchParams.get("tab") === "deliveries" ? "deliveries" : "channels";

  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  /* 初值 true：项目 store 就位前不发请求，false 会让有数据的列表先闪一帧空态（P10-7）。 */
  const [loading, setLoading] = useState(true);

  /* 渠道编辑。secret 三态：留空 = 不动（编辑）/ 不配（新建），勾选清除 = 删。 */
  const [channelEditing, setChannelEditing] = useState<NotificationChannel | "new">();
  const [channelForm, setChannelForm] = useState<ChannelForm>(emptyChannelForm());
  const [channelSaving, setChannelSaving] = useState(false);
  const [testing, setTesting] = useState<string>();

  /* 规则编辑。threshold/window 存字符串：输入框里清空重填是常态，数字态会拦住删完
     最后一位的那次按键。 */
  const [ruleEditing, setRuleEditing] = useState<AlertRule | "new">();
  const [ruleForm, setRuleForm] = useState<RuleForm>(emptyRuleForm());
  const [ruleSaving, setRuleSaving] = useState(false);

  /* 助手页面上下文（P9-4c）：「把这条告警阈值调到 90%」指向正在编辑的规则。 */
  usePageContext({
    page: "alerts",
    ...(ruleEditing && ruleEditing !== "new" ? { entities: { alertId: ruleEditing.id, alertName: ruleEditing.name }, focus: "alert-editor" } : {}),
  });

  /* 派发记录。 */
  const [deliveries, setDeliveries] = useState<Awaited<ReturnType<typeof api.notificationDeliveries>>["items"]>([]);
  const [deliveryTotal, setDeliveryTotal] = useState(0);
  const [deliveryPage, setDeliveryPage] = useState(1);
  const [deliveryChannel, setDeliveryChannel] = useState<string>("all");
  const [deliveryStatus, setDeliveryStatus] = useState<string>("all");
  const [expandedDelivery, setExpandedDelivery] = useState<string>();

  async function load() {
    if (!projectId || loadedProjectId !== projectId || projectLoading) return;
    setLoading(true);
    try {
      const [channelList, ruleList] = await Promise.all([api.notificationChannels(projectId), api.alertRules(projectId)]);
      setChannels(channelList);
      setRules(ruleList);
    } catch {
      message.error(t("alerts.channelLoadFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [projectId, loadedProjectId, projectLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId || tab !== "deliveries") return;
    let alive = true;
    void api.notificationDeliveries(projectId, {
      channelId: deliveryChannel === "all" ? undefined : deliveryChannel,
      status: deliveryStatus,
      page: deliveryPage, pageSize: 20,
    }).then((result) => {
      if (!alive) return;
      setDeliveries(result.items);
      setDeliveryTotal(result.total);
    }).catch(() => { if (alive) message.error(t("alerts.deliveriesLoadFailed")); });
    return () => { alive = false; };
  }, [projectId, loadedProjectId, tab, deliveryChannel, deliveryStatus, deliveryPage]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 渠道 ─────────────────────────────────────────────────────── */

  function openChannel(target: NotificationChannel | "new") {
    setChannelEditing(target);
    if (target === "new") { setChannelForm(emptyChannelForm()); return; }
    setChannelForm({
      name: target.name,
      type: target.type,
      url: target.url,
      secret: "",
      clearSecret: false,
      templatePrefix: target.templatePrefix ?? "",
      enabled: target.enabled,
    });
  }

  async function saveChannel() {
    if (!projectId || !channelEditing) return;
    setChannelSaving(true);
    try {
      const input = {
        name: channelForm.name.trim(),
        type: channelForm.type,
        url: channelForm.url.trim(),
        /* 三态 secret：清除勾选优先于新值——同时出现是输入残留，按「用户想删」处理。 */
        secret: channelForm.clearSecret ? null : channelForm.secret.trim() ? channelForm.secret : undefined,
        templatePrefix: channelForm.templatePrefix.trim() ? channelForm.templatePrefix.trim() : null,
        enabled: channelForm.enabled,
      };
      if (channelEditing === "new") await api.createNotificationChannel(projectId, input);
      else await api.updateNotificationChannel(projectId, channelEditing.id, input);
      message.success(t("alerts.channelSaved"));
      setChannelEditing(undefined);
      await load();
    } catch (error) {
      message.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t("alerts.channelSaveFailed"));
    } finally {
      setChannelSaving(false);
    }
  }

  async function testChannel(channel: NotificationChannel) {
    if (!projectId) return;
    setTesting(channel.id);
    try {
      const result = await api.testNotificationChannel(projectId, channel.id);
      if (result.sent > 0) message.success(t("alerts.channelTestOk", { sent: result.sent, failed: result.failed }));
      else message.error(t("alerts.channelTestFailed"));
    } catch {
      message.error(t("alerts.channelTestFailed"));
    } finally {
      setTesting(undefined);
    }
  }

  /** 渠道删除：被规则引用时 409，清单给出来，确认后 force 并自动摘除规则里的引用。 */
  function removeChannel(channel: NotificationChannel) {
    if (!projectId) return;
    Modal.confirm({
      title: t("alerts.channelDeleteTitle", { name: channel.name }),
      content: t("alerts.channelDeleteHint", { count: rules.filter((rule) => rule.channelIds.includes(channel.id)).length }),
      okText: t("action.delete"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.deleteNotificationChannel(projectId, channel.id, true);
          await load();
          message.success(t("alerts.channelDeleted"));
        } catch {
          message.error(t("alerts.channelDeleteFailed"));
        }
      },
    });
  }

  /* ── 规则 ─────────────────────────────────────────────────────── */

  function openRule(target: AlertRule | "new") {
    setRuleEditing(target);
    if (target === "new") { setRuleForm(emptyRuleForm()); return; }
    setRuleForm({
      name: target.name,
      metric: target.metric,
      comparator: target.comparator,
      threshold: String(target.threshold),
      windowMinutes: target.windowMinutes === undefined ? "" : String(target.windowMinutes),
      cooldownSeconds: String(target.cooldownSeconds),
      channelIds: target.channelIds,
      enabled: target.enabled,
    });
  }

  async function saveRule() {
    if (!projectId || !ruleEditing) return;
    const threshold = Number(ruleForm.threshold);
    const windowMinutes = ruleForm.windowMinutes.trim() ? Number(ruleForm.windowMinutes) : null;
    const cooldownSeconds = Number(ruleForm.cooldownSeconds || 600);
    const input = {
      name: ruleForm.name.trim(),
      metric: ruleForm.metric,
      comparator: ruleForm.comparator,
      threshold,
      /* 窗口型必带窗口、事件型必不带——校验在客户端先挡一道，服务端那道是权威。 */
      windowMinutes: EVENT_METRICS.includes(ruleForm.metric) ? null : windowMinutes,
      cooldownSeconds,
      channelIds: ruleForm.channelIds,
      enabled: ruleForm.enabled,
    };
    if (!input.name) { message.error(t("alerts.ruleName")); return; }
    if (!EVENT_METRICS.includes(input.metric) && (windowMinutes === null || !Number.isFinite(windowMinutes))) {
      message.error(t("alerts.ruleWindow")); return;
    }
    if (!input.channelIds.length) { message.error(t("alerts.ruleChannelsRequired")); return; }
    setRuleSaving(true);
    try {
      if (ruleEditing === "new") await api.createAlertRule(projectId, input);
      else await api.updateAlertRule(projectId, ruleEditing.id, input);
      message.success(t("alerts.ruleSaved"));
      setRuleEditing(undefined);
      await load();
    } catch (error) {
      message.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t("alerts.ruleSaveFailed"));
    } finally {
      setRuleSaving(false);
    }
  }

  function removeRule(rule: AlertRule) {
    if (!projectId) return;
    Modal.confirm({
      title: t("alerts.ruleDeleteTitle", { name: rule.name }),
      content: t("alerts.ruleDeleteHint"),
      okText: t("action.delete"), okButtonProps: { danger: true }, cancelText: t("action.cancel"),
      onOk: async () => {
        try {
          await api.deleteAlertRule(projectId, rule.id);
          await load();
          message.success(t("alerts.ruleDeleted"));
        } catch { message.error(t("alerts.ruleDeleteFailed")); }
      },
    });
  }

  const thresholdUnit = (metric: AlertMetric) => metric === "success_rate"
    ? t("alerts.thresholdUnitPercent")
    : metric === "avg_duration" ? t("alerts.thresholdUnitMs") : t("alerts.thresholdUnitCount");

  return <main className="content content-split">
    <PageToolbar>
    <div className="page-head">
      <div><h1>{t("alerts.title")}</h1><p>{t("alerts.hint")}</p></div>
      <div className="topbar-actions">
        {tab === "channels" && canWrite && <button className="btn btn-primary btn-with-icon" onClick={() => openChannel("new")}><Plus size={15} />{t("alerts.createChannel")}</button>}
        {tab === "rules" && canWrite && <button className="btn btn-primary btn-with-icon" onClick={() => openRule("new")}><Plus size={15} />{t("alerts.createRule")}</button>}
      </div>
    </div>

    <div className="tabs" role="tablist" style={{ paddingInline: 0, marginBottom: "var(--s4)" }}>
      {([["channels", t("alerts.channels")], ["rules", t("alerts.rules")], ["deliveries", t("alerts.deliveries")]] as const).map(([key, label]) => (
        <button key={key} role="tab" aria-selected={tab === key} className={`tab${tab === key ? " is-active" : ""}`}
          onClick={() => { setSearchParams(key === "channels" ? {} : { tab: key }, { replace: true }); setDeliveryPage(1); }}>
          {label}
        </button>
      ))}
    </div>
    {/* 派发记录的筛选项跟着所属标签进工具卡（2026-09-19）：它只筛这一段的表，
        放到列表卡里会被当成整页的三个筛选各管一段。 */}
    {tab === "deliveries" && <div className="filter-bar">
      <Select
        value={deliveryChannel}
        onChange={(value) => { setDeliveryChannel(value); setDeliveryPage(1); }}
        style={{ width: 200 }}
        options={[{ value: "all", label: t("alerts.channels") }, ...channels.map((channel) => ({ value: channel.id, label: channel.name }))]}
      />
      <Select
        value={deliveryStatus}
        onChange={(value) => { setDeliveryStatus(value); setDeliveryPage(1); }}
        style={{ width: 148 }}
        options={[{ value: "all", label: t("filter.runStatusAll") }, { value: "sent", label: t("alerts.deliveryStatusSent") }, { value: "failed", label: t("alerts.deliveryStatusFailed") }]}
      />
    </div>}
    </PageToolbar>

    <div className="list-card">
    {/* ── 渠道 ── */}
    {tab === "channels" && (channels.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("alerts.channelName")}</th>
        <th>{t("alerts.channelType")}</th>
        <th className="mono">URL</th>
        <th className="col-status">{t("alerts.channelSecret")}</th>
        <th className="col-status">{t("schedules.enabled")}</th>
        <th className="col-owner">{t("common.createdBy")}</th>
        <th className="col-owner">{t("common.updatedBy")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {channels.map((channel) => <tr key={channel.id} data-clickable onClick={() => openChannel(channel)}>
          <td><strong className="truncate">{channel.name}</strong></td>
          <td>{t(`alerts.channelType${channel.type.charAt(0).toUpperCase()}${channel.type.slice(1)}`)}</td>
          <td className="mono muted truncate">{channel.url}</td>
          <td className="col-status">
            {channel.secretConfigured
              ? <span className="status" data-status="pass"><span className="status-mark" />{t("alerts.channelSecretConfigured")}</span>
              : <span className="muted">—</span>}
          </td>
          <td className="col-status">
            <span className="status" data-status={channel.enabled ? "pass" : "skip"}>
              <span className="status-mark" />{channel.enabled ? t("schedules.enabled") : t("schedules.disabled")}
            </span>
          </td>
          {/* 归属两列（P11-7）：告警引擎只写 last_fired_at（运行簿记），所以「系统」在这张表
              上只可能来自对账等真正的系统写（边界 3）。 */}
          <td className="col-owner mono muted truncate"><OwnerCell kind="created" email={channel.createdByEmail} /></td>
          <td className="col-owner mono muted truncate"><OwnerCell kind="updated" email={channel.updatedByEmail} createdAt={channel.createdAt} updatedAt={channel.updatedAt} /></td>
          <td className="col-actions" onClick={(event) => event.stopPropagation()}>
            {canWrite && <div className="row-actions">
              <IconButton icon={<Send size={14} />} label={t("alerts.channelTest")} disabled={testing === channel.id} onClick={() => void testChannel(channel)} />
              <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => openChannel(channel)} />
              <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => removeChannel(channel)} />
            </div>}
          </td>
        </tr>)}
      </tbody>
    </table></div> : !loading && <Empty title={t("alerts.channelsEmpty")} hint={t("alerts.channelsEmptyHint")} action={canWrite ? <button className="btn btn-primary" onClick={() => openChannel("new")}>{t("alerts.createChannel")}</button> : undefined} />)}

    {/* ── 规则 ── */}
    {tab === "rules" && (rules.length ? <div className="table-scroll"><table className="grid">
      <thead><tr>
        <th>{t("alerts.ruleName")}</th>
        <th>{t("alerts.ruleMetric")}</th>
        <th className="mono">{t("alerts.ruleThreshold")}</th>
        <th className="mono">{t("alerts.ruleWindow")}</th>
        <th>{t("alerts.ruleChannels")}</th>
        <th className="col-status">{t("schedules.enabled")}</th>
        <th className="col-owner">{t("common.createdBy")}</th>
        <th className="col-owner">{t("common.updatedBy")}</th>
        <th className="col-actions" />
      </tr></thead>
      <tbody>
        {rules.map((rule) => {
          /* 指标文案与阈值单位拼在一起读：82.4% < 90 比两列数字更接近一句话。 */
          const comparator = { gt: ">", gte: "≥", lt: "<", lte: "≤" }[rule.comparator];
          const threshold = rule.metric === "avg_duration" ? `${(rule.threshold / 1000).toFixed(1)}s` : rule.metric === "success_rate" ? `${rule.threshold}%` : rule.threshold;
          return <tr key={rule.id} data-clickable onClick={() => openRule(rule)}>
            <td><strong className="truncate">{rule.name}</strong></td>
            <td>{t(`alerts.metric${rule.metric.replace(/(^|_)(\w)/g, (_, prefix, char: string) => (prefix ? char.toUpperCase() : char))}`)}</td>
            <td className="mono">{comparator} {threshold}</td>
            <td className="mono muted">{rule.windowMinutes === undefined ? "—" : `${rule.windowMinutes}m`}</td>
            <td className="muted truncate">{rule.channelIds.map((id) => channels.find((channel) => channel.id === id)?.name ?? id).join(", ")}</td>
            <td className="col-status">
              <span className="status" data-status={rule.enabled ? "pass" : "skip"}>
                <span className="status-mark" />{rule.enabled ? t("schedules.enabled") : t("schedules.disabled")}
              </span>
            </td>
            {/* 归属两列（P11-7）：与渠道表同款；本表的「系统」只可能来自对账等真正的系统写。 */}
            <td className="col-owner mono muted truncate"><OwnerCell kind="created" email={rule.createdByEmail} /></td>
            <td className="col-owner mono muted truncate"><OwnerCell kind="updated" email={rule.updatedByEmail} createdAt={rule.createdAt} updatedAt={rule.updatedAt} /></td>
            <td className="col-actions" onClick={(event) => event.stopPropagation()}>
              {canWrite && <div className="row-actions">
                <IconButton icon={<Pencil size={14} />} label={t("action.edit")} onClick={() => openRule(rule)} />
                <IconButton icon={<Trash2 size={14} />} label={t("action.delete")} tone="danger" onClick={() => removeRule(rule)} />
              </div>}
            </td>
          </tr>;
        })}
      </tbody>
    </table></div> : !loading && <Empty title={t("alerts.rulesEmpty")} hint={t("alerts.rulesEmptyHint")} action={canWrite ? <button className="btn btn-primary" onClick={() => openRule("new")}>{t("alerts.createRule")}</button> : undefined} />)}

    {/* ── 派发记录 ── */}
    {tab === "deliveries" && <>
      {deliveries.length ? <div className="table-scroll"><table className="grid">
        <thead><tr>
          <th className="mono">{t("endpoints.duration")}</th>
          <th className="col-status">{t("endpoints.status")}</th>
          <th>{t("alerts.deliveryChannel")}</th>
          <th>{t("alerts.deliveryRule")}</th>
          <th>{t("environments.variables")}</th>
        </tr></thead>
        <tbody>
          {deliveries.map((delivery) => {
            const open = expandedDelivery === delivery.id;
            return <Fragment key={delivery.id}>
              <tr data-clickable onClick={() => setExpandedDelivery(open ? undefined : delivery.id)}>
                <td className="mono muted">{new Date(delivery.createdAt).toLocaleString()}</td>
                <td className="col-status"><span className="status" data-status={delivery.status === "sent" ? "pass" : "fail"}><span className="status-mark" />{delivery.status === "sent" ? t("alerts.deliveryStatusSent") : t("alerts.deliveryStatusFailed")}</span></td>
                <td className="truncate">{delivery.channelName ?? "—"}</td>
                <td className="truncate">{delivery.ruleName ?? "—"}</td>
                <td className="mono muted truncate" title={delivery.error ?? ""}>
                  {delivery.statusCode ? `${delivery.statusCode} · ` : ""}{delivery.error ?? t("alerts.deliveryPayload")}
                </td>
              </tr>
              {/* 展开的行紧贴它的来源行：实发 payload 是「对方到底收到了什么」的唯一复现物
                  （边界 10），要在被点开的那一行下面。 */}
              {open && <tr><td colSpan={5} style={{ padding: 0 }}>
                <pre className="mono script-error" style={{ margin: 0, maxHeight: 240, overflow: "auto" }}>
                  {JSON.stringify(delivery.payload, null, 2)}
                </pre>
              </td></tr>}
            </Fragment>;
          })}
        </tbody>
      </table></div> : <Empty title={t("alerts.deliveries")} hint={t("alerts.deliveriesEmpty")} />}
      {deliveryTotal > 20 && <div className="pager">
        <Pagination current={deliveryPage} pageSize={20} total={deliveryTotal} onChange={setDeliveryPage} pageSizeOptions={PAGE_SIZES} showSizeChanger={false} />
      </div>}
    </>}

    {/* 渠道抽屉 */}
    <Drawer
      title={channelEditing === "new" ? t("alerts.createChannel") : t("action.edit")}
      open={Boolean(channelEditing)}
      onClose={() => setChannelEditing(undefined)}
      width={520}
      footer={<div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn" onClick={() => setChannelEditing(undefined)}>{t("action.cancel")}</button>
        {canWrite && <button className="btn btn-primary" disabled={channelSaving} onClick={() => void saveChannel()}>{channelSaving ? "…" : t("action.save")}</button>}
      </div>}
    >
      <label className="field">
        <span>{t("alerts.channelName")}</span>
        <input className="input" value={channelForm.name} onChange={(event) => setChannelForm({ ...channelForm, name: event.target.value })} autoFocus />
      </label>
      <label className="field">
        <span>{t("alerts.channelType")}</span>
        <Select
          value={channelForm.type}
          onChange={(type) => setChannelForm({ ...channelForm, type })}
          options={CHANNEL_TYPES.map((type) => ({ value: type, label: t(`alerts.channelType${type.charAt(0).toUpperCase()}${type.slice(1)}`) }))}
          style={{ width: "100%" }}
        />
      </label>
      <label className="field">
        <span>{t("alerts.channelUrl")}</span>
        <input className="input mono" value={channelForm.url} onChange={(event) => setChannelForm({ ...channelForm, url: event.target.value })} placeholder="https://" spellCheck={false} />
      </label>
      <label className="field">
        <span>{t("alerts.channelSecret")}</span>
        <input
          className="input mono"
          type="password"
          value={channelForm.secret}
          onChange={(event) => setChannelForm({ ...channelForm, secret: event.target.value, clearSecret: false })}
          placeholder={channelEditing !== "new" && channelEditing?.secretConfigured ? t("dataSources.passwordKeep") : t("dataSources.noAuth")}
          spellCheck={false}
        />
        <p className="form-note">{t("alerts.channelSecretHint")}</p>
      </label>
      {channelEditing !== "new" && channelEditing?.secretConfigured && <label className="check-field">
        <input type="checkbox" checked={channelForm.clearSecret} onChange={(event) => setChannelForm({ ...channelForm, clearSecret: event.target.checked })} />
        {t("alerts.channelSecretClear")}
      </label>}
      <label className="field">
        <span>{t("alerts.channelPrefix")}</span>
        <input className="input" value={channelForm.templatePrefix} onChange={(event) => setChannelForm({ ...channelForm, templatePrefix: event.target.value })} />
        <p className="form-note">{t("alerts.channelPrefixHint")}</p>
      </label>
      <label className="check-field">
        <input type="checkbox" checked={channelForm.enabled} onChange={(event) => setChannelForm({ ...channelForm, enabled: event.target.checked })} />
        {t("schedules.enabled")}
      </label>
    </Drawer>

    {/* 规则抽屉 */}
    <Drawer
      title={ruleEditing === "new" ? t("alerts.createRule") : t("action.edit")}
      open={Boolean(ruleEditing)}
      onClose={() => setRuleEditing(undefined)}
      width={520}
      footer={<div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn" onClick={() => setRuleEditing(undefined)}>{t("action.cancel")}</button>
        {canWrite && <button className="btn btn-primary" disabled={ruleSaving} onClick={() => void saveRule()}>{ruleSaving ? "…" : t("action.save")}</button>}
      </div>}
    >
      <label className="field">
        <span>{t("alerts.ruleName")}</span>
        <input className="input" value={ruleForm.name} onChange={(event) => setRuleForm({ ...ruleForm, name: event.target.value })} autoFocus />
      </label>
      <label className="field">
        <span>{t("alerts.ruleMetric")}</span>
        <Select
          value={ruleForm.metric}
          onChange={(metric) => setRuleForm({ ...ruleForm, metric, windowMinutes: EVENT_METRICS.includes(metric) ? "" : ruleForm.windowMinutes || "15" })}
          options={METRICS.map((metric) => ({ value: metric, label: t(`alerts.metric${metric.replace(/(^|_)(\w)/g, (_, prefix, char: string) => (prefix ? char.toUpperCase() : char))}`) }))}
          style={{ width: "100%" }}
        />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 }}>
        <label className="field">
          <span>{t("alerts.ruleComparator")}</span>
          <Select
            value={ruleForm.comparator}
            onChange={(comparator) => setRuleForm({ ...ruleForm, comparator })}
            options={COMPARATORS.map((comparator) => ({ value: comparator, label: t(`alerts.comparator${comparator.charAt(0).toUpperCase()}${comparator.slice(1)}`) }))}
            style={{ width: "100%" }}
          />
        </label>
        <label className="field">
          <span>{t("alerts.ruleThreshold")}</span>
          <input className="input mono" value={ruleForm.threshold} onChange={(event) => setRuleForm({ ...ruleForm, threshold: event.target.value })} inputMode="decimal" />
          <p className="form-note">{thresholdUnit(ruleForm.metric)}</p>
        </label>
      </div>
      {!EVENT_METRICS.includes(ruleForm.metric) && <label className="field">
        <span>{t("alerts.ruleWindow")}</span>
        <input className="input mono" value={ruleForm.windowMinutes} onChange={(event) => setRuleForm({ ...ruleForm, windowMinutes: event.target.value })} inputMode="numeric" />
      </label>}
      <label className="field">
        <span>{t("alerts.ruleCooldown")}</span>
        <input className="input mono" value={ruleForm.cooldownSeconds} onChange={(event) => setRuleForm({ ...ruleForm, cooldownSeconds: event.target.value })} inputMode="numeric" />
        <p className="form-note">{t("alerts.ruleCooldownHint")}</p>
      </label>
      <label className="field">
        <span>{t("alerts.ruleChannels")}</span>
        <Select
          mode="multiple"
          value={ruleForm.channelIds}
          onChange={(channelIds) => setRuleForm({ ...ruleForm, channelIds })}
          options={channels.map((channel) => ({ value: channel.id, label: channel.name }))}
          placeholder={t("alerts.ruleChannelsRequired")}
          style={{ width: "100%" }}
        />
      </label>
      <label className="check-field">
        <input type="checkbox" checked={ruleForm.enabled} onChange={(event) => setRuleForm({ ...ruleForm, enabled: event.target.checked })} />
        {t("schedules.enabled")}
      </label>
    </Drawer>

    </div>
  </main>;
}
