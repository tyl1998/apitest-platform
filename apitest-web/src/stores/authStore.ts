import { create } from "zustand";
import { api, type User } from "../api";

type AuthState = { token: string | null; user: User | null; login: (email: string, password: string) => Promise<void>; hydrate: () => Promise<void>; logout: () => void };

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem("apitest.token"), user: null,
  login: async (email, password) => { const result = await api.login(email, password); localStorage.setItem("apitest.token", result.token); set({ token: result.token, user: result.user }); },
  hydrate: async () => { if (!localStorage.getItem("apitest.token")) return; try { set({ user: await api.me() }); } catch { localStorage.removeItem("apitest.token"); set({ token: null, user: null }); } },
  logout: () => { localStorage.removeItem("apitest.token"); set({ token: null, user: null }); },
}));
