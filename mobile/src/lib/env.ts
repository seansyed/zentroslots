/**
 * Environment surface.
 *
 * Single source of truth for runtime config. Reads in this order:
 *   1. process.env.EXPO_PUBLIC_* (set by .env, statically inlined at build)
 *   2. app.json `extra` block (set via Expo config)
 *   3. hardcoded sensible defaults (last resort)
 *
 * Why a module instead of inline reads: gives us a single typed
 * surface that the rest of the app trusts, and a single place to add
 * staging/preview overrides in the future.
 */

import Constants from "expo-constants";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;

function resolveString(envKey: string, extraKey: string, fallback: string): string {
  const fromEnv = process.env[envKey];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const fromExtra = extra[extraKey];
  if (typeof fromExtra === "string" && fromExtra.length > 0) return fromExtra;
  return fallback;
}

export const env = {
  /** Base URL for all API calls. */
  apiBaseUrl: resolveString(
    "EXPO_PUBLIC_API_BASE_URL",
    "apiBaseUrl",
    "https://app.zentromeet.com",
  ),
  /** Deep-link scheme — keep in sync with app.json `scheme`. */
  appScheme: "zentromeet",
  /** Toggled by `__DEV__` — convenience flag. */
  isDev: __DEV__,
  /** App version + build — surfaced on the diagnostics screen. */
  appVersion: (Constants.expoConfig?.version as string | undefined) ?? "0.0.0",
  /** External-facing legal URLs. Editable in app.json extra. */
  privacyPolicyUrl: resolveString(
    "EXPO_PUBLIC_PRIVACY_URL",
    "privacyPolicyUrl",
    "https://app.zentromeet.com/legal/privacy",
  ),
  termsUrl: resolveString(
    "EXPO_PUBLIC_TERMS_URL",
    "termsUrl",
    "https://app.zentromeet.com/legal/terms",
  ),
  supportEmail: resolveString(
    "EXPO_PUBLIC_SUPPORT_EMAIL",
    "supportEmail",
    "support@zentromeet.com",
  ),
};
