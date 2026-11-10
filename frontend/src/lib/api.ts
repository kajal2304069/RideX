import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";

/**
 * One axios instance. The access token lives in memory (not localStorage: an XSS bug cannot read what is not there);
 * the refresh token is an httpOnly cookie the browser sends on its own. A 401 triggers ONE refresh shared by every
 * request that failed at the same moment, then each is retried once.
 */
let accessToken: string | null = null;
let onAuthLost: () => void = () => {};
let refreshing: Promise<string | null> | null = null;

export const tokenStore = {
  get: () => accessToken,
  set: (t: string | null) => { accessToken = t; },
  onLost: (fn: () => void) => { onAuthLost = fn; },
};

export const api = axios.create({ baseURL: "/api", withCredentials: true, timeout: 20000 });

api.interceptors.request.use((cfg) => {
  if (accessToken) cfg.headers.set("Authorization", `Bearer ${accessToken}`);
  return cfg;
});

export async function refreshAccessToken(): Promise<string | null> {
  refreshing ??= axios
    .post("/api/auth/refresh", {}, { withCredentials: true })
    .then((r) => { accessToken = r.data.data.accessToken as string; return accessToken; })
    .catch(() => { accessToken = null; return null; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

api.interceptors.response.use(
  (r) => r,
  async (error: AxiosError) => {
    const cfg = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
    const isAuthCall = cfg?.url?.startsWith("/auth/");
    if (error.response?.status === 401 && cfg && !cfg._retried && !isAuthCall) {
      cfg._retried = true;
      const t = await refreshAccessToken();
      if (t) return api(cfg);
      onAuthLost();
    }
    return Promise.reject(error);
  }
);

export interface ApiFailure { status: number; code: string; message: string; fields?: Record<string, string[]> }

/** Turns any thrown value into something a person can read. */
export function errorMessage(err: unknown): string {
  const e = err as AxiosError<{ error?: { message?: string; details?: unknown } }>;
  if (e?.response?.data?.error?.message) {
    const d = e.response.data.error.details as { fieldErrors?: Record<string, string[]> } | undefined;
    const msgs = d?.fieldErrors ? Object.values(d.fieldErrors).flat() : [];
    return msgs.length ? msgs.slice(0, 2).join(". ") : e.response.data.error.message;
  }
  if (e?.code === "ECONNABORTED") return "The server took too long to respond. Try again.";
  if (e?.message === "Network Error") return "Can't reach the server. Check your connection.";
  return err instanceof Error ? err.message : "Something went wrong.";
}

/** GET/POST helpers that unwrap the `{ success, data }` envelope. */
export const get = async <T>(url: string, params?: object): Promise<T> => (await api.get(url, { params })).data.data as T;
export const post = async <T>(url: string, body?: object, headers?: Record<string, string>): Promise<T> => (await api.post(url, body ?? {}, { headers })).data.data as T;
export const patch = async <T>(url: string, body?: object): Promise<T> => (await api.patch(url, body ?? {})).data.data as T;
export const put = async <T>(url: string, body?: object): Promise<T> => (await api.put(url, body ?? {})).data.data as T;
export const del = async <T>(url: string): Promise<T> => (await api.delete(url)).data.data as T;
