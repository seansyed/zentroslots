/**
 * Auth endpoints. Mirrors the web app at /api/auth/*.
 *
 * - login(email, password)
 * - signup({email, password, name, role, ...})
 * - logout()
 * - me()  — fetches current session profile (used to hydrate store)
 *
 * OAuth (Google / Microsoft) is wired via WebBrowser in src/hooks/
 * useAuth.ts — the start endpoint redirects to the provider, the
 * callback eventually returns to a mobile deep link.
 */

import { apiGet, apiPost } from "./client";

import type { AuthUser } from "@/store/authStore";

export type LoginResponse = {
  ok: boolean;
  user: AuthUser;
  // Some backends echo the token in the body too — we capture either
  // path. The cookie is grabbed automatically by the response
  // interceptor in client.ts.
  token?: string;
};

export type SignupPayload = {
  email: string;
  password: string;
  name: string;
  role: "admin" | "staff" | "client";
  timezone?: string;
  workspaceName?: string;
  tenantSlug?: string;
};

export const authApi = {
  async login(email: string, password: string): Promise<LoginResponse> {
    // The web backend returns the user object directly at the top
    // level: { id, email, name, role, timezone, tenantId, ... }.
    // Older variants wrapped it in { ok, user, token }. Accept both
    // so future backend reshapes don't break the mobile/web client.
    const raw = await apiPost<unknown>("/api/auth/login", { email, password });
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      // Already wrapped shape — pass through.
      if (r.user && typeof r.user === "object" && "id" in (r.user as object)) {
        return r as unknown as LoginResponse;
      }
      // Bare user shape — wrap it.
      if (typeof r.id === "string" && typeof r.email === "string") {
        return {
          ok: true,
          user: r as unknown as AuthUser,
          token: typeof r.token === "string" ? r.token : undefined,
        };
      }
    }
    throw new Error("Unexpected login response shape");
  },

  async signup(payload: SignupPayload): Promise<LoginResponse> {
    return apiPost<LoginResponse>("/api/auth/signup", payload);
  },

  async logout(): Promise<{ ok: true }> {
    return apiPost("/api/auth/logout");
  },

  /**
   * Lightweight session-validate. Returns null if not authed; throws
   * only on network errors so the caller can distinguish "logged out"
   * from "couldn't reach server".
   */
  async me(): Promise<AuthUser | null> {
    try {
      return await apiGet<AuthUser>("/api/auth/me");
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 401 || status === 404) return null;
      throw err;
    }
  },

  async forgotPassword(email: string): Promise<{ ok: true }> {
    return apiPost("/api/auth/forgot-password", { email });
  },
};
