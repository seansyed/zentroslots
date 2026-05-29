/**
 * Axios client — single shared instance.
 *
 * Responsibilities:
 *   • baseURL from env
 *   • Attach session cookie / bearer token from the auth store
 *   • Capture Set-Cookie on login/signup so we can replay it later
 *   • Surface a typed error shape (ApiError) so screens render
 *     friendly messages instead of "Network Error"
 *   • Auto-signout on 401 so the user lands on /login cleanly
 *
 * Why cookie-replay: the web app uses an httpOnly session cookie. On
 * mobile we read the raw Set-Cookie value off the login response and
 * stash it in SecureStore, then send it back as `Cookie:` on every
 * subsequent request. No backend changes needed.
 */

import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from "axios";

import { env } from "@/lib/env";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { markSessionExpired, useAuthStore } from "@/store/authStore";
import { useNetworkStore } from "@/store/networkStore";

export class ApiError extends Error {
  status: number;
  data: unknown;
  code: string | null;
  /** "network" when the request never reached the server, "server"
   *  when we got a 5xx, "client" when 4xx, "unknown" for anything else.
   *  Screens use this to pick the right ErrorState tone + copy. */
  kind: "network" | "client" | "server" | "unknown";
  constructor(
    message: string,
    opts: {
      status: number;
      data?: unknown;
      code?: string | null;
      kind?: "network" | "client" | "server" | "unknown";
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.data = opts.data;
    this.code = opts.code ?? null;
    this.kind =
      opts.kind ??
      (opts.status === 0
        ? "network"
        : opts.status >= 500
          ? "server"
          : opts.status >= 400
            ? "client"
            : "unknown");
  }
}

function pickCookie(setCookieHeader: string | string[] | undefined): string | null {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  // Match the same cookie names the web auth route mints. We don't
  // hardcode a single name because cookie naming has changed twice
  // before — capture any `*_session` or `*_token` style cookie.
  const interesting = headers.find((h) => /session|token|auth/i.test(h));
  if (!interesting) return null;
  // Cookie header is "name=value; Path=/; HttpOnly; ...". Keep only
  // the "name=value" portion — that's all the server checks back.
  return interesting.split(";")[0] ?? null;
}

export const api: AxiosInstance = axios.create({
  baseURL: env.apiBaseUrl,
  timeout: 20_000,
  headers: { Accept: "application/json", "Content-Type": "application/json" },
  // We do cookie management manually — don't let axios try.
  withCredentials: false,
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = useAuthStore.getState().sessionToken;
  if (token) {
    // If it looks like a cookie (`name=value`), send as Cookie header.
    // Else assume bearer token.
    if (token.includes("=")) {
      config.headers.set("Cookie", token);
    } else {
      config.headers.set("Authorization", `Bearer ${token}`);
    }
  }
  return config;
});

api.interceptors.response.use(
  (res) => {
    // Capture session cookie on auth responses so the store stays
    // fresh even if the user logged in via the /signup endpoint.
    const url = res.config?.url ?? "";
    if (/\/api\/auth\/(login|signup|oauth\/.*\/callback)$/.test(url)) {
      const cookie = pickCookie(res.headers["set-cookie"] as string | string[] | undefined);
      if (cookie) {
        // Fire-and-forget — store will pick it up on next request.
        void storage.setItem(STORAGE_KEYS.sessionToken, cookie);
      }
    }
    // Every successful response is a connectivity heartbeat — clear the
    // offline banner if we previously flipped it on heuristic failures.
    try {
      useNetworkStore.getState().reportRequestSuccess();
    } catch {
      // Store may not be ready during early boot; ignore.
    }
    return res;
  },
  async (error: AxiosError) => {
    const status = error.response?.status ?? 0;
    const data = error.response?.data as { error?: string; message?: string; code?: string } | undefined;
    const code = data?.code ?? null;
    const message =
      data?.error ||
      data?.message ||
      (status === 0 ? "Network unavailable. Check your connection." : `Request failed (${status})`);

    if (status === 401) {
      // Stale or invalid session — clear everything so the auth gate
      // routes the user back to /login cleanly. Flag the next login
      // surface so the user sees "Your session expired" rather than
      // wondering why they got bounced.
      const wasAuthed = Boolean(useAuthStore.getState().sessionToken);
      if (wasAuthed) markSessionExpired();
      await useAuthStore.getState().signOut();
    }

    // status === 0 means the request never reached the server — wifi
    // off, captive-portal stall, DNS fail. Tag it as a connectivity
    // signal so the offline banner reflects reality even on native.
    if (status === 0) {
      try {
        useNetworkStore.getState().reportRequestFailure();
      } catch {
        // Store may not be ready during early boot; ignore.
      }
    }

    throw new ApiError(message, { status, data, code });
  },
);

/** Thin wrappers so endpoint modules don't repeat boilerplate. */
export async function apiGet<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const res = await api.get<T>(url, config);
  return res.data;
}
export async function apiPost<T, B = unknown>(url: string, body?: B, config?: AxiosRequestConfig): Promise<T> {
  const res = await api.post<T>(url, body, config);
  return res.data;
}
export async function apiPatch<T, B = unknown>(url: string, body?: B, config?: AxiosRequestConfig): Promise<T> {
  const res = await api.patch<T>(url, body, config);
  return res.data;
}
export async function apiDelete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const res = await api.delete<T>(url, config);
  return res.data;
}
