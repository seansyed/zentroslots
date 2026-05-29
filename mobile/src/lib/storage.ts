/**
 * Cross-platform secure storage wrapper.
 *
 * `expo-secure-store` is iOS/Android only. On web it throws. This
 * wrapper hides that asymmetry so callers never branch on platform:
 *
 *   - iOS / Android: SecureStore (Keychain / Keystore)
 *   - Web:           localStorage (best-effort — web isn't a
 *                    production target for this app, but devs run
 *                    `expo start --web` constantly so it has to work)
 *
 * Every call is wrapped in try/catch — storage failures should never
 * crash the app. If we can't read a token we just behave as if it
 * isn't there.
 */

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const WEB_STORAGE_PREFIX = "zentromeet:";

function webGet(key: string): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(WEB_STORAGE_PREFIX + key);
  } catch {
    return null;
  }
}
function webSet(key: string, value: string): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(WEB_STORAGE_PREFIX + key, value);
  } catch {
    /* noop */
  }
}
function webDelete(key: string): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(WEB_STORAGE_PREFIX + key);
  } catch {
    /* noop */
  }
}

export const storage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === "web") return webGet(key);
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") return webSet(key, value);
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      /* noop */
    }
  },

  async deleteItem(key: string): Promise<void> {
    if (Platform.OS === "web") return webDelete(key);
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      /* noop */
    }
  },
};

/** Canonical storage keys — keep additions here so we don't collide. */
export const STORAGE_KEYS = {
  sessionToken: "session_token",
  sessionCookie: "session_cookie",
  userId: "user_id",
  userEmail: "user_email",
  // Phase 2B — local presence (available/busy/paused). Persisted so the
  // user's chosen state survives app restarts. Will move server-side
  // when /api/me/presence ships.
  presence: "presence",
} as const;
