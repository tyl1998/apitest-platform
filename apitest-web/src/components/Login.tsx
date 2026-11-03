import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuthStore } from "../stores/authStore";

/**
 * 登录页（P6-3 起：**不再预填 admin@local.test / admin123**——第二个账号已经存在，
 * 预填会把「默认凭据」焊在界面上，邀请码通道等于白做）。`login.local` 的提示文案
 * 相应退役。
 *
 * 登录响应带 `mustChangePassword`：为 true 时导航目标被改写为 /change-password
 * （初始密码是管理员/重置给的，首登必须自设）。这个判定放这里而不是路由守卫——
 * 守卫在 token 存在时放行一切，而「该不该改密」只有登录那一刻才知道。
 */
export function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const login = useAuthStore((state) => state.login);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    try {
      await login(email, password);
      /* 强制改密优先于一切跳转目标：returnTo/上次页面改完密码再去也不迟。 */
      if (useAuthStore.getState().mustChangePassword) {
        navigate("/change-password", { replace: true });
        return;
      }
      const preferences = await api.preferences();
      const returnTo = searchParams.get("returnTo") ?? localStorage.getItem("apitest.lastPage");
      navigate(preferences.restoreLastPage && returnTo?.startsWith("/") ? returnTo : "/dashboard", { replace: true });
    } catch { setError(t("login.error")); } finally { setBusy(false); }
  }

  return <main className="login"><form className="login-card" onSubmit={submit}>
    <div className="lockup"><span className="lockup-mark mono">AT</span><span className="lockup-name">ApiTrack</span></div>
    <h1>{t("login.title")}</h1><p>{t("login.subtitle")}</p>
    <label className="field"><span>{t("login.email")}</span><input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    <label className="field"><span>{t("login.password")}</span><input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "…" : t("action.login")}</button>
    <p className="form-note">{t("login.inviteHint")} <Link to="/register">{t("login.toRegister")}</Link></p>
  </form></main>;
}
