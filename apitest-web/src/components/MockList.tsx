import { useEffect, useState } from "react";
import { Drawer, Modal, Select, message } from "antd";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useParams } from "react-router-dom";
import { api, type Endpoint, type Execution, type Mock, type MockInput, type MockMode, type MockProxyConfig, type MockProxyPathMode, type MockProxyQueryMode } from "../api";
import { Empty } from "../ui";
import { IconButton } from "./IconButton";
import { apiMessage } from "./DataSourceList";

const initial: MockInput = { name: "", mode: "fixed", enabled: true, priority: 0, requestMatch: {}, response: { statusCode: 200, headers: { "content-type": "application/json" }, body: {} }, delayMs: 0 };

function parseFixedQuery(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of text.split(",")) {
    const pair = part.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq).trim();
    if (!key) continue;
    result[key] = eq === -1 ? "" : pair.slice(eq + 1).trim();
  }
  return result;
}
function serializeFixedQuery(value: Record<string, string> | undefined): string {
  return Object.entries(value ?? {}).map(([key, item]) => `${key}=${item}`).join(", ");
}

export function MockList() {
  const { projectId } = useParams();
  const [items, setItems] = useState<Mock[]>([]); const [loading, setLoading] = useState(true); const [editing, setEditing] = useState<Mock | "new">();
  async function load() { if (!projectId) return; setLoading(true); try { setItems(await api.mocks(projectId)); } catch { message.error("无法加载 Mock 规则"); } finally { setLoading(false); } }
  useEffect(() => { void load(); }, [projectId]);
  async function remove(item: Mock) { if (!projectId) return; Modal.confirm({ title: `删除 ${item.name}？`, content: "删除后公开地址将立即失效。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: async () => { await api.deleteMock(projectId, item.id); await load(); } }); }
  function copy(item: Mock) { const path = String(item.requestMatch.path ?? "").replace(/^\//, ""); void navigator.clipboard.writeText(`${window.location.origin.replace(/:\d+$/, ":3000")}/mock/${item.publicId}/${path}`); message.success("公开地址已复制"); }
  return <main className="content"><div className="page-head"><div><h1>Mock</h1><p>为外部联调方提供独立、匿名可访问的接口桩。</p></div><button className="btn btn-primary btn-with-icon" onClick={() => setEditing("new")}><Plus size={14} />新建 Mock</button></div>
    {loading ? <p className="muted">加载中…</p> : items.length ? <div className="table-scroll"><table className="grid"><thead><tr><th>规则</th><th>模式</th><th>匹配</th><th>公开地址</th><th className="col-actions" /></tr></thead><tbody>{items.map((item) => { const path = String(item.requestMatch.path ?? ""); return <tr key={item.id} data-clickable onClick={() => setEditing(item)}><td><strong>{item.name}</strong><span className="resource-type mono">{item.enabled ? "enabled" : "disabled"}</span></td><td className="mono">{item.mode}</td><td className="mono">{String(item.requestMatch.method ?? "ANY")} {path || "/*"}</td><td className="mono truncate" title={`/mock/${item.publicId}/${path.replace(/^\//, "")}`}>/mock/{item.publicId}/{path.replace(/^\//, "")}</td><td className="col-actions"><div className="row-actions" onClick={(event) => event.stopPropagation()}><IconButton icon={<Copy size={14} />} label="复制公开地址" onClick={() => copy(item)} /><IconButton icon={<Pencil size={14} />} label="编辑" onClick={() => setEditing(item)} /><IconButton icon={<Trash2 size={14} />} label="删除" tone="danger" onClick={() => void remove(item)} /></div></td></tr>; })}</tbody></table></div> : <Empty title="还没有 Mock 规则" hint="创建一个固定响应，让外部团队先完成联调。" action={<button className="btn btn-primary" onClick={() => setEditing("new")}>新建 Mock</button>} />}
    {projectId && <MockDrawer projectId={projectId} item={editing} onClose={() => setEditing(undefined)} onSaved={async () => { setEditing(undefined); await load(); }} />}
  </main>;
}

function MockDrawer({ projectId, item, onClose, onSaved }: { projectId: string; item?: Mock | "new"; onClose: () => void; onSaved: () => Promise<void> }) {
  const [input, setInput] = useState<MockInput>(initial); const [responseText, setResponseText] = useState(JSON.stringify(initial.response.body, null, 2)); const [saving, setSaving] = useState(false);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  useEffect(() => { if (item) { const next = item === "new" ? initial : { endpointId: item.endpointId, executionId: item.snapshotExecutionId, name: item.name, mode: item.mode, enabled: item.enabled, priority: item.priority, requestMatch: item.requestMatch, response: item.response, proxyConfig: item.proxyConfig, delayMs: item.delayMs }; setInput(next); setResponseText(JSON.stringify(next.response.body ?? {}, null, 2)); } }, [item]);
  useEffect(() => { void api.endpoints(projectId).then(setEndpoints).catch(() => setEndpoints([])); }, [projectId]);
  useEffect(() => { if (input.mode !== "auto" || !input.endpointId) { setExecutions([]); return; } void api.executions(projectId, { endpointId: input.endpointId, status: "success", pageSize: 100 }).then((page) => setExecutions(page.items)).catch(() => setExecutions([])); }, [projectId, input.mode, input.endpointId]);
  function patch<K extends keyof MockInput>(key: K, value: MockInput[K]) { setInput((current) => ({ ...current, [key]: value })); }
  function patchProxy<K extends keyof MockProxyConfig>(key: K, value: MockProxyConfig[K]) {
    const current = input.proxyConfig ?? { targetUrl: "", allowedHosts: [], timeoutMs: 5000, maxResponseBytes: 1048576 };
    patch("proxyConfig", { ...current, [key]: value });
  }
  async function save() { if (!input.name.trim()) { message.error("请输入规则名称"); return; } if (input.mode !== "proxy" && input.mode !== "auto") { try { setInput((current) => ({ ...current, response: { ...current.response, body: JSON.parse(responseText) } })); } catch { message.error("响应体必须是有效 JSON"); return; } } setSaving(true); try { const payload = input.mode !== "proxy" && input.mode !== "auto" ? { ...input, response: { ...input.response, body: JSON.parse(responseText) } } : input; item === "new" ? await api.createMock(projectId, payload) : await api.updateMock(projectId, item!.id, payload); message.success(item === "new" ? "Mock 创建成功" : "Mock 保存成功"); await onSaved(); } catch (error) { message.error(apiMessage(error) ?? "保存 Mock 失败"); } finally { setSaving(false); } }
  return <Drawer title={item === "new" ? "新建 Mock" : "编辑 Mock"} open={Boolean(item)} onClose={onClose} width={640} footer={<div className="drawer-actions"><button className="btn" onClick={onClose}>取消</button><button className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "…" : "保存"}</button></div>}><div className="form-grid">
    <label className="field field-wide"><span>规则名称</span><input autoFocus className="input" value={input.name} onChange={(event) => patch("name", event.target.value)} /></label>
    <label className="field"><span>模式</span><Select value={input.mode} onChange={(value) => patch("mode", value as MockMode)} options={[{ value: "fixed", label: "固定响应" }, { value: "template", label: "模板响应" }, { value: "auto", label: "自动快照" }, { value: "proxy", label: "代理" }]} style={{ width: "100%" }} /></label>
    {input.mode === "auto" && <><label className="field field-wide"><span>快照来源接口</span><Select value={input.endpointId ?? undefined} placeholder="请选择接口" onChange={(value) => { patch("endpointId", value || null); patch("executionId", null); }} options={endpoints.map((endpoint) => ({ value: endpoint.id, label: `${endpoint.method} ${endpoint.name}` }))} style={{ width: "100%" }} /><small className="form-note">先选接口，再选择该接口某一次成功执行。来源可以是调试、用例或流程请求。</small></label><label className="field field-wide"><span>具体快照</span><Select value={input.executionId ?? undefined} placeholder={input.endpointId ? "请选择成功执行记录" : "请先选择接口"} disabled={!input.endpointId} onChange={(value) => patch("executionId", value || null)} options={executions.map((execution) => ({ value: execution.id, label: `${new Date(execution.createdAt).toLocaleString()} · ${execution.statusCode ?? "无状态码"} · ${execution.source}` }))} style={{ width: "100%" }} /><small className="form-note">保存时复制这一条记录的状态码、响应头和响应 Body，之后与原执行记录独立。</small></label></>}
    <label className="field"><span>优先级</span><input className="input mono" type="number" value={input.priority} onChange={(event) => patch("priority", Number(event.target.value))} /></label>
    <label className="field"><span>请求方法</span><Select value={String(input.requestMatch.method ?? "")} onChange={(value) => patch("requestMatch", { ...input.requestMatch, method: value })} options={[{ value: "", label: "ANY" }, "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((value) => typeof value === "string" ? { value, label: value } : value)} style={{ width: "100%" }} /></label>
    <label className="field"><span>请求路径</span><input className="input mono" placeholder="/orders" value={String(input.requestMatch.path ?? "")} onChange={(event) => patch("requestMatch", { ...input.requestMatch, path: event.target.value })} /></label>
    <label className="field"><span>状态码</span><input className="input mono" type="number" value={input.response.statusCode} onChange={(event) => patch("response", { ...input.response, statusCode: Number(event.target.value) })} /></label>
    <label className="field"><span>延迟 ms</span><input className="input mono" type="number" min="0" value={input.delayMs} onChange={(event) => patch("delayMs", Number(event.target.value))} /></label>
    {input.mode !== "proxy" && input.mode !== "auto" && <label className="field field-wide"><span>响应 JSON {input.mode === "template" ? "（{{body}} 直接返回完整请求 Body；{{body.name}} 获取字段；{{query.id}} 获取查询参数）" : ""}</span><textarea className="input mono" rows={10} value={responseText} onChange={(event) => setResponseText(event.target.value)} /></label>}
    <label className="check-field field-wide"><input type="checkbox" checked={input.enabled} onChange={(event) => patch("enabled", event.target.checked)} />启用规则</label>
  </div>{input.mode === "proxy" && <><p className="form-note">代理模式把请求转发到目标服务，并透传目标服务的状态码、响应头和响应体。管理页的响应 JSON 不参与代理响应。</p><div className="form-grid">
    <label className="field field-wide"><span>目标 URL</span><input className="input mono" value={input.proxyConfig?.targetUrl ?? ""} onChange={(event) => patchProxy("targetUrl", event.target.value)} /></label>
    <label className="field field-wide"><span>允许目标主机（逗号分隔）</span><input className="input mono" value={(input.proxyConfig?.allowedHosts ?? []).join(", ")} onChange={(event) => patchProxy("allowedHosts", event.target.value.split(",").map((value) => value.trim()).filter(Boolean))} /></label>
    <label className="field"><span>路径策略</span><Select value={input.proxyConfig?.pathMode ?? "append"} onChange={(value) => patchProxy("pathMode", value as MockProxyPathMode)} options={[{ value: "append", label: "拼接：目标路径 + 请求路径" }, { value: "fixed", label: "仅目标路径（忽略请求路径）" }, { value: "replace", label: "仅请求路径（替换目标路径）" }]} style={{ width: "100%" }} /></label>
    <label className="field"><span>查询参数</span><Select value={input.proxyConfig?.queryMode ?? "forward"} onChange={(value) => patchProxy("queryMode", value as MockProxyQueryMode)} options={[{ value: "forward", label: "转发请求查询参数" }, { value: "drop", label: "丢弃请求查询参数" }, { value: "append", label: "转发 + 追加固定参数" }]} style={{ width: "100%" }} /></label>
    {(input.proxyConfig?.queryMode ?? "forward") === "append" && <label className="field field-wide"><span>追加固定参数（key=value，逗号分隔）</span><input className="input mono" value={serializeFixedQuery(input.proxyConfig?.fixedQuery)} onChange={(event) => patchProxy("fixedQuery", parseFixedQuery(event.target.value))} placeholder="token=abc, env=prod" /></label>}
    <label className="field"><span>保护性超时 ms</span><input className="input mono" type="number" value={input.proxyConfig?.timeoutMs ?? 5000} onChange={(event) => patchProxy("timeoutMs", Number(event.target.value))} /></label>
    <label className="field"><span>响应上限 bytes</span><input className="input mono" type="number" value={input.proxyConfig?.maxResponseBytes ?? 1048576} onChange={(event) => patchProxy("maxResponseBytes", Number(event.target.value))} /></label>
  </div></>}</Drawer>;
}
