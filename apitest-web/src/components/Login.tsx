import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuthStore } from "../stores/authStore";

export function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const login = useAuthStore((state) => state.login);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [email, setEmail] = useState("admin@local.test");
  const [password, setPassword] = useState("admin123");

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    try {
      await login(email, password);
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
    <p className="form-note">{t("login.local")}</p>
  </form></main>;
}
