import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuthStore } from "../stores/authStore";

/**
 * 强制改密页（P6-3，计划 10.3）：登录后发现 `mustChangePassword` 则只放行这里。
 *
 * 面向两类人共用一张表：管理员建号/重置的初始密码（密码是别人给的）、以及本页
 * 自己的常规改密入口（顶栏）。旧密码必验——强制改密挡的是「初始密码还在别人聊天
 * 记录里」，不是「会话被盗」（后者由 pwdEpoch 收口）。
 *
 * 改密使全部旧 token 失效（P6-5 的 pwdEpoch），服务端在同一响应里换发带新 epoch
 * 的 token——renewSession 落地替换后当前会话无缝续命，其他设备上的旧会话下线。
 */
export function ChangePassword() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const renewSession = useAuthStore((state) => state.renewSession);
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    if (newPassword !== confirm) { setError(t("changePassword.mismatch")); setBusy(false); return; }
    try {
      const result = await api.changePassword(currentPassword, newPassword);
      renewSession(result);
      /* 强制路径回看板（进来的唯一目的就是改密）；常规入口同样回看板——改完没有
          下一个必去的地方。 */
      navigate("/dashboard", { replace: true });
    } catch (cause) {
      const body = (cause as { response?: { data?: { message?: string } } })?.response?.data;
      setError(body?.message || t("changePassword.error"));
    } finally { setBusy(false); }
  }

  return <main className="login"><form className="login-card" onSubmit={submit}>
    <div className="lockup"><span className="lockup-mark mono">AT</span><span className="lockup-name">ApiTrack</span></div>
    <h1>{t("changePassword.title")}</h1><p>{t("changePassword.subtitle")}</p>
    <label className="field"><span>{t("changePassword.current")}</span><input className="input" type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrent(e.target.value)} /></label>
    <label className="field"><span>{t("changePassword.next")}</span><input className="input" type="password" autoComplete="new-password" required minLength={8} value={newPassword} onChange={(e) => setNext(e.target.value)} /></label>
    <label className="field"><span>{t("changePassword.confirm")}</span><input className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "…" : t("changePassword.submit")}</button>
    <p className="form-note">{t("changePassword.note")}</p>
  </form></main>;
}
