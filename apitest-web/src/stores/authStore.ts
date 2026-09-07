import { create } from "zustand";
import { api, type User } from "../api";

type AuthState = {
  token: string | null;
  user: User | null;
  /** 服务端说「首登必须改密」（P6-3）：为 true 时路由只放行 /change-password。 */
  mustChangePassword: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** 邀请码注册即登录（P6-3）：token 直接落地，mustChangePassword 恒为 false（密码是注册人自己设的）。 */
  register: (invite: string, email: string, name: string, password: string) => Promise<void>;
  hydrate: () => Promise<void>;
  logout: () => void;
  /**
   * 改密成功后换发 token（P6-5）：改密使旧 token 全部失效（pwdEpoch +1），服务端在
   * 同一响应里给了新的——落地替换，当前会话凭它续命；顺带清 must_change_password。
   */
  renewSession: (result: { token: string; user: User }) => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem("apitest.token"), user: null, mustChangePassword: false,
  login: async (email, password) => {
    const result = await api.login(email, password);
    localStorage.setItem("apitest.token", result.token);
    set({ token: result.token, user: result.user, mustChangePassword: Boolean(result.mustChangePassword) });
  },
  register: async (invite, email, name, password) => {
    const result = await api.register({ invite, email, name, password });
    localStorage.setItem("apitest.token", result.token);
    set({ token: result.token, user: result.user, mustChangePassword: false });
  },
  hydrate: async () => {
    if (!localStorage.getItem("apitest.token")) return;
    try {
      /* me() 带回 mustChangePassword：刷新页面后强制改密闸仍在（登录响应里的旗活不过
         一次刷新；服务端改密即时清列，这里读到的永远是当前值）。 */
      const user = await api.me();
      set({ user, mustChangePassword: Boolean(user.mustChangePassword) });
    }
    catch { localStorage.removeItem("apitest.token"); set({ token: null, user: null, mustChangePassword: false }); }
  },
  logout: () => { localStorage.removeItem("apitest.token"); set({ token: null, user: null, mustChangePassword: false }); },
  renewSession: (result) => {
    localStorage.setItem("apitest.token", result.token);
    set({ token: result.token, user: result.user, mustChangePassword: false });
  },
}));
