import { create } from "zustand";
import { get, post, refreshAccessToken, tokenStore } from "@/lib/api";

export type Role = "RIDER" | "DRIVER" | "VEHICLE_OWNER" | "GARAGE_OWNER" | "MECHANIC" | "SELLER" | "BUYER" | "ADMIN";
export interface User { id: string; email: string; fullName: string; phone: string | null; roles: Role[] }

interface AuthState {
  user: User | null;
  status: "loading" | "anonymous" | "authenticated";
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { email: string; password: string; fullName: string; roles: Role[] }) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  has: (...roles: Role[]) => boolean;
}

export const useAuth = create<AuthState>((set, getState) => ({
  user: null,
  status: "loading",

  /** On page load: the refresh cookie (if any) gives us a fresh access token, then we ask who we are. */
  async bootstrap() {
    const t = await refreshAccessToken();
    if (!t) return set({ user: null, status: "anonymous" });
    try {
      const { user } = await get<{ user: User }>("/auth/me");
      set({ user, status: "authenticated" });
    } catch {
      tokenStore.set(null);
      set({ user: null, status: "anonymous" });
    }
  },

  async login(email, password) {
    const d = await post<{ user: User; accessToken: string }>("/auth/login", { email, password });
    tokenStore.set(d.accessToken);
    set({ user: d.user, status: "authenticated" });
  },

  async register(input) {
    const d = await post<{ user: User; accessToken: string }>("/auth/register", input);
    tokenStore.set(d.accessToken);
    set({ user: d.user, status: "authenticated" });
  },

  async logout() {
    try { await post("/auth/logout"); } catch { /* already signed out */ }
    tokenStore.set(null);
    set({ user: null, status: "anonymous" });
  },

  async reload() {
    const { user } = await get<{ user: User }>("/auth/me");
    set({ user });
  },

  has: (...roles) => !!getState().user?.roles.some((r) => roles.includes(r)),
}));

tokenStore.onLost(() => useAuth.setState({ user: null, status: "anonymous" }));
