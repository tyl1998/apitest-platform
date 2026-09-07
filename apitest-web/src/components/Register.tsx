import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";

/**
 * 邀请码注册页（P6-3，计划 10.3；在 Protected 之外——码即凭据，与分享页同层）。
 *
 * 进人两条通道中的①：签发人把 `apiinv_` 码带外转给本人（企微/钉钉），本人开
 * `/register?invite=…` 自设邮箱姓名密码。注册即登录——不制造「注册完再登一次」的
 * 空转，token 直接落地。
 *
 * 邮箱由注册人自报、服务端只做形状校验（边界 2：内网平台不预填邮箱验证，归属由
 * 签发人在转交那一刻目视判断）。错误分四路（401 无效 / 403 吊销 / 410 过期 /
 * 409 已用或邮箱冲突），各自指路而不是一句「注册失败」。
 */
export function Register() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const register = useAuthStore((state) => state.register);
  const [invite, setInvite] = useState(searchParams.get("invite") ?? "");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    if (password !== confirm) { setError(t("register.passwordMismatch")); setBusy(false); return; }
    try {
      await register(invite.trim(), email.trim(), name.trim(), password);
      /* 注册即登录：成功直接进看板。没有 returnTo 语义——注册前本来就没登录态。 */
      navigate("/dashboard", { replace: true });
    } catch (cause) {
      /* 服务端的分路报错（401/403/410/409 各带 message）直接透给用户——「码过期了找
         签发人重发」这句指引只有服务端知道该说哪一句。 */
      const body = (cause as { response?: { data?: { message?: string } } })?.response?.data;
      setError(body?.message || t("register.error"));
    } finally { setBusy(false); }
  }

  return <main className="login"><form className="login-card" onSubmit={submit}>
    <div className="lockup"><span className="lockup-mark mono">AT</span><span className="lockup-name">ApiTrack</span></div>
    <h1>{t("register.title")}</h1><p>{t("register.subtitle")}</p>
    <label className="field"><span>{t("register.invite")}</span><input className="input mono" required value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="apiinv_…" /></label>
    <label className="field"><span>{t("register.email")}</span><input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    <label className="field"><span>{t("register.name")}</span><input className="input" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label className="field"><span>{t("register.password")}</span><input className="input" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    <label className="field"><span>{t("register.confirm")}</span><input className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "…" : t("register.submit")}</button>
    <p className="form-note">{t("register.haveAccount")} <Link to="/login">{t("register.toLogin")}</Link></p>
  </form></main>;
}
