/**
 * Auth store — global session state via Zustand.
 *
 * Holds the bare minimum: who's logged in, the session token, and a
 * hydration flag so the rest of the app waits for SecureStore to be
 * read before making routing decisions on startup.
 *
 * Persistence is manual (not via zustand/persist) so we can keep the
 * secrets in SecureStore rather than AsyncStorage.
 */

import { create } from "zustand";

import { queryClient } from "@/lib/query";
import { clearPersistedQueryCache } from "@/lib/queryPersistence";
import { STORAGE_KEYS, storage } from "@/lib/storage";

export type AuthUser = {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
  tenantSlug?: string | null;
  tenantName?: string | null;
};

type AuthState = {
  /** True once we've finished reading SecureStore on app start. */
  hydrated: boolean;
  user: AuthUser | null;
  /**
   * Session cookie value (e.g. raw `zb_session=...` string) OR a
   * bearer token. Treated opaquely; src/api/client.ts decides how to
   * attach it to outgoing requests.
   */
  sessionToken: string | null;

  hydrate: () => Promise<void>;
  signIn: (payload: { user: AuthUser; token: string }) => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (user: AuthUser | null) => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  hydrated: false,
  user: null,
  sessionToken: null,

  async hydrate() {
    const [token, id, email] = await Promise.all([
      storage.getItem(STORAGE_KEYS.sessionToken),
      storage.getItem(STORAGE_KEYS.userId),
      storage.getItem(STORAGE_KEYS.userEmail),
    ]);
    set({
      hydrated: true,
      sessionToken: token,
      user: token && id && email ? { id, email } : null,
    });
  },

  async signIn({ user, token }) {
    await Promise.all([
      storage.setItem(STORAGE_KEYS.sessionToken, token),
      storage.setItem(STORAGE_KEYS.userId, user.id),
      storage.setItem(STORAGE_KEYS.userEmail, user.email),
    ]);
    set({ user, sessionToken: token });
  },

  async signOut() {
    await Promise.all([
      storage.deleteItem(STORAGE_KEYS.sessionToken),
      storage.deleteItem(STORAGE_KEYS.userId),
      storage.deleteItem(STORAGE_KEYS.userEmail),
      // Drop the persisted query cache so the next signed-in user
      // never sees the previous user's bookings on cold start.
      clearPersistedQueryCache(),
    ]);
    // Flush the in-memory React Query cache too. Without this, a sign-in
    // immediately after sign-out reads stale `[]` from cached keys (most
    // visibly the services list, which the previous user may have seen
    // as empty if auth was degraded) for up to staleTime. Belt-and-
    // suspenders with tenant-keyed query keys: this guarantees a clean
    // slate even if a hook hasn't migrated to tenant-keyed yet.
    try {
      queryClient.clear();
    } catch {
      // Cache module may be torn down during shutdown; ignore.
    }
    set({ user: null, sessionToken: null });
  },

  setUser(user) {
    set({ user });
  },
}));

/** Selector helpers — avoid passing whole state object to consumers. */
export const selectIsAuthenticated = (s: AuthState) => Boolean(s.sessionToken && s.user);
export const selectUser = (s: AuthState) => s.user;
export const selectHydrated = (s: AuthState) => s.hydrated;

/**
 * Module-level flag used to surface a "Your session expired" banner on
 * the login screen when the axios 401 handler signs the user out
 * mid-session. Cleared by the login screen on mount.
 */
let pendingExpiredFlag = false;
export function markSessionExpired(): void {
  pendingExpiredFlag = true;
}
export function consumeSessionExpired(): boolean {
  const wasExpired = pendingExpiredFlag;
  pendingExpiredFlag = false;
  return wasExpired;
}
