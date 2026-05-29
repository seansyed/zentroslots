/**
 * useAuth — composite auth hook.
 *
 * Wraps the Zustand store + the auth API + WebBrowser-based OAuth so
 * screens import a single hook.
 *
 * OAuth (Phase 1A — 2026-05-27):
 *   1. Open `/api/auth/oauth/{provider}/start?mobile=1` in
 *      WebBrowser.openAuthSessionAsync(). The web start route stashes
 *      a `zm_oauth_mobile=1` cookie so the callback knows to deep-link
 *      instead of setting a session cookie.
 *   2. The provider redirects to our callback. The callback mints a
 *      raw JWT and redirects to:
 *        zentromeet://oauth/callback?token=<JWT>&userId=...&email=...&name=...
 *   3. WebBrowser detects the custom scheme + closes. Result is
 *      { type: "success", url: "<the deep link>" }.
 *   4. We parse the URL, stash the token, and we're authed.
 *
 * Error handling: the callback also deep-links errors as
 * `?error=<code>` so the login screen renders the matching label
 * from OAUTH_ERROR_LABELS.
 *
 * Cold-start: app/_layout.tsx wires Linking.getInitialURL() +
 * Linking.addEventListener("url") to `consumeOAuthDeepLink()` below.
 * That keeps the OAuth completion logic in ONE place no matter how
 * the URL arrived.
 */

import { useCallback } from "react";
import * as WebBrowser from "expo-web-browser";

import { ApiError } from "@/api/client";
import { authApi } from "@/api/auth";
import { unregisterPushTokenForSignOut } from "@/hooks/usePushNotifications";
import { env } from "@/lib/env";
import { useAuthStore, type AuthUser } from "@/store/authStore";

WebBrowser.maybeCompleteAuthSession();

export type OAuthProvider = "google" | "microsoft";

/**
 * Human-readable copy for every error code the OAuth callback emits.
 * Mirrored from app.zentromeet.com/dashboard/login.
 */
export const OAUTH_ERROR_LABELS: Record<string, string> = {
  cancelled: "You cancelled the sign-in. Try again any time.",
  state_mismatch: "The sign-in link expired. Tap Continue with Google or Microsoft to try again.",
  token_exchange_failed: "We couldn't reach the identity provider. Try again in a moment.",
  email_not_verified:
    "That Google account's email isn't verified. Verify it in your Google settings, then try again.",
  missing_email:
    "We couldn't read your email from that provider. Use email + password to continue.",
  invalid_callback: "Sign-in didn't complete. Please try again.",
  provider_error: "The identity provider returned an error. Try again.",
  not_configured:
    "Single sign-on isn't configured yet on this workspace. Use email + password to continue.",
  session_mint_failed: "Sign-in completed, but we couldn't start your session. Please try again.",
};

export function oauthErrorMessage(code: string | null | undefined): string {
  if (!code) return "Sign-in didn't complete. Please try again.";
  return OAUTH_ERROR_LABELS[code] ?? "Sign-in didn't complete. Please try again.";
}

/**
 * Parse a `zentromeet://oauth/callback?...` deep link. Returns either
 * a success payload (token + user) or an error code. Never throws.
 */
export function parseOAuthDeepLink(rawUrl: string):
  | { ok: true; token: string; user: AuthUser }
  | { ok: false; error: string }
  | null {
  try {
    if (!rawUrl.includes("oauth/callback")) return null;
    const url = new URL(rawUrl);
    const error = url.searchParams.get("error");
    if (error) return { ok: false, error };
    const token = url.searchParams.get("token");
    const id = url.searchParams.get("userId");
    const email = url.searchParams.get("email");
    const name = url.searchParams.get("name");
    if (!token || !id || !email) {
      return { ok: false, error: "invalid_callback" };
    }
    return {
      ok: true,
      token,
      user: { id, email, name: name ?? null },
    };
  } catch {
    return { ok: false, error: "invalid_callback" };
  }
}

/**
 * Apply a successful deep-link to the auth store. Idempotent — called
 * by both the cold-start handler and the openAuthSessionAsync success
 * branch. Doing it once in here avoids duplicated logic + double-write
 * races between the two surfaces.
 */
export async function consumeOAuthDeepLink(rawUrl: string): Promise<
  { ok: true } | { ok: false; error: string } | null
> {
  const parsed = parseOAuthDeepLink(rawUrl);
  if (!parsed) return null;
  if (!parsed.ok) return { ok: false, error: parsed.error };
  // Idempotency: if the store already holds this exact token, skip.
  const current = useAuthStore.getState().sessionToken;
  if (current === parsed.token) return { ok: true };
  await useAuthStore.getState().signIn({ user: parsed.user, token: parsed.token });
  return { ok: true };
}

export function useAuth() {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.sessionToken);
  const hydrated = useAuthStore((s) => s.hydrated);
  const signInToStore = useAuthStore((s) => s.signIn);
  const signOutStore = useAuthStore((s) => s.signOut);

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      const res = await authApi.login(email, password);
      // The axios interceptor in api/client.ts captured the Set-Cookie
      // header — but on mobile we ALSO prefer the explicit token if
      // the server echoes one. Either way, signIn() persists.
      const tokenToStore = res.token ?? "cookie:captured";
      await signInToStore({ user: res.user, token: tokenToStore });
      return res.user;
    },
    [signInToStore],
  );

  const signInWithOAuth = useCallback(
    async (provider: OAuthProvider) => {
      const startUrl = `${env.apiBaseUrl}/api/auth/oauth/${provider}/start?mobile=1`;
      const redirectUrl = `${env.appScheme}://oauth/callback`;
      let result: WebBrowser.WebBrowserAuthSessionResult;
      try {
        result = await WebBrowser.openAuthSessionAsync(startUrl, redirectUrl, {
          // Reuse a freshly cleared browser session so account picker
          // shows even when the user already authed once. This matches
          // the web `prompt: select_account` behavior.
          preferEphemeralSession: true,
        });
      } catch (err) {
        throw new Error(
          err instanceof Error ? err.message : "Couldn't open the sign-in window",
        );
      }
      if (result.type === "cancel" || result.type === "dismiss") {
        throw new Error(OAUTH_ERROR_LABELS.cancelled);
      }
      if (result.type !== "success" || !result.url) {
        throw new Error("Sign-in didn't complete. Please try again.");
      }
      const outcome = await consumeOAuthDeepLink(result.url);
      if (!outcome) {
        throw new Error("Sign-in didn't return to the app. Try again.");
      }
      if (!outcome.ok) {
        throw new Error(oauthErrorMessage(outcome.error));
      }
    },
    [],
  );

  const signOut = useCallback(async () => {
    // Best-effort push token detach BEFORE we drop the auth token —
    // the DELETE endpoint requires auth.
    await unregisterPushTokenForSignOut();
    try {
      await authApi.logout();
    } catch (err) {
      // Even if the network call fails, clear local state. The token
      // expires naturally on the server-side jti list anyway.
      if (!(err instanceof ApiError) || err.status >= 500) {
        // Swallow but don't hide unexpected errors.
        console.warn("[auth] logout API failed:", err);
      }
    }
    await signOutStore();
  }, [signOutStore]);

  return {
    user,
    token,
    hydrated,
    isAuthenticated: Boolean(user && token),
    signInWithPassword,
    signInWithOAuth,
    signOut,
  };
}
