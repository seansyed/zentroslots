/**
 * Root layout — mounts every global provider exactly once.
 *
 *   • SafeAreaProvider — needed by react-native-safe-area-context.
 *   • GestureHandlerRootView — required for any RN gesture handler.
 *   • QueryClientProvider — TanStack Query.
 *   • Auth hydration — read SecureStore on cold start so the router
 *     can make a routing decision (auth gate below) without flicker.
 *   • Deep-link listener — handles cold-start AND foreground OAuth
 *     callbacks (zentromeet://oauth/callback?…).
 *   • Font loading — Public Sans family from Google Fonts; we don't
 *     block on it (RN renders the system font until they finish).
 *   • SplashScreen — kept up until BOTH hydration + fonts complete so
 *     there's no flash of unstyled / unauthenticated UI.
 */

import * as React from "react";
import { StatusBar } from "expo-status-bar";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as Linking from "expo-linking";
import { useFonts } from "expo-font";
import {
  PublicSans_400Regular,
  PublicSans_500Medium,
  PublicSans_600SemiBold,
  PublicSans_700Bold,
} from "@expo-google-fonts/public-sans";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";

import { OfflineBanner } from "@/components/ui/OfflineBanner";
import { ErrorBoundary } from "@/components/util/ErrorBoundary";
import { useAppLifecycle } from "@/hooks/useAppLifecycle";
import { consumeOAuthDeepLink, oauthErrorMessage } from "@/hooks/useAuth";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { queryClient } from "@/lib/query";
import { hydrateQueryCache, wireUpPersistence } from "@/lib/queryPersistence";
import { hydrateTelemetry, track } from "@/lib/telemetry";
import { startTelemetrySink } from "@/lib/telemetrySink";
import { useAuthStore } from "@/store/authStore";
import { usePresenceStore } from "@/store/presenceStore";
import { useFirstRun } from "@/hooks/useFirstRun";
import { colors } from "@/theme";

// Show the splash for as long as we need (hydration + fonts).
SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * Module-level state for surfacing OAuth deep-link errors that arrived
 * BEFORE the login screen mounted (cold-start flow where the user
 * tapped a notification or got bounced from the in-app browser back
 * into an unmounted app). The login screen reads + clears this on
 * mount.
 */
let pendingOAuthError: string | null = null;
export function consumePendingOAuthError(): string | null {
  const e = pendingOAuthError;
  pendingOAuthError = null;
  return e;
}
function setPendingOAuthError(code: string) {
  pendingOAuthError = oauthErrorMessage(code);
}

function useAuthGate() {
  const segments = useSegments();
  const router = useRouter();
  const hydrated = useAuthStore((s) => s.hydrated);
  const sessionToken = useAuthStore((s) => s.sessionToken);
  // Phase 3 — first-run onboarding gate. When we have a fresh auth
  // session AND no record of onboarding being seen, route to the
  // onboarding pager once. The pager marks-seen on completion + skip.
  const firstRun = useFirstRun();

  React.useEffect(() => {
    if (!hydrated || !firstRun.hydrated) return;
    const inAuthRoute = segments[0] === "login";
    const inOnboarding = segments[0] === "onboarding";
    const isAuthed = Boolean(sessionToken);

    if (!isAuthed && !inAuthRoute) {
      router.replace("/login");
      return;
    }
    if (isAuthed && inAuthRoute) {
      // Just signed in — if onboarding hasn't been seen, route there
      // first. Otherwise land in the tab navigator as before.
      router.replace(firstRun.seen ? "/(tabs)" : "/onboarding");
      return;
    }
    if (isAuthed && !firstRun.seen && !inOnboarding && segments[0] === "(tabs)") {
      // Authed user landed somewhere inside the tabs without going
      // through onboarding (e.g. deep-link cold start). Send them
      // through the flow once.
      router.replace("/onboarding");
    }
  }, [hydrated, sessionToken, segments, router, firstRun.hydrated, firstRun.seen]);
}

/**
 * Drop a low-noise breadcrumb every time the route segments change.
 * `useSegments()` already gives us a stable representation — we just
 * serialize it. Helps reconstruct "user did X, Y, Z before the crash"
 * when reading the telemetry buffer.
 */
function useNavigationBreadcrumbs() {
  const segments = useSegments();
  React.useEffect(() => {
    const path = "/" + segments.join("/");
    track("navigation", path, "info");
  }, [segments]);
}

/**
 * Capture runtime errors the React tree can't see — async exceptions,
 * unhandled promise rejections, top-level `throw`s in event handlers.
 *
 * On native we hook ErrorUtils.setGlobalHandler. On web we listen for
 * the standard `error` + `unhandledrejection` window events. Both paths
 * just push into the telemetry buffer; we never swallow the error — the
 * default RN red-box (in dev) and OS-level crash dialog (in prod) still
 * fire.
 */
function useGlobalErrorHandlers() {
  React.useEffect(() => {
    // Native: ErrorUtils is a global on RN. Type it loosely to avoid
    // pulling in @types/react-native internals.
    type ErrorUtilsLike = {
      getGlobalHandler?: () => (e: Error, isFatal?: boolean) => void;
      setGlobalHandler?: (h: (e: Error, isFatal?: boolean) => void) => void;
    };
    const eu = (globalThis as unknown as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
    const previous = eu?.getGlobalHandler?.();
    if (eu?.setGlobalHandler) {
      eu.setGlobalHandler((error: Error, isFatal?: boolean) => {
        track(
          "runtime",
          `${isFatal ? "Fatal" : "Non-fatal"}: ${error.name}: ${error.message}`,
          isFatal ? "error" : "warn",
          { stack: error.stack?.split("\n").slice(0, 8).join("\n") ?? null },
        );
        previous?.(error, isFatal);
      });
    }

    // Web: window-level handlers. `window` is undefined on native, hence
    // the typeof check.
    if (typeof window !== "undefined") {
      const onError = (ev: ErrorEvent) => {
        track(
          "runtime",
          `Web error: ${ev.message}`,
          "error",
          { filename: ev.filename, lineno: ev.lineno, colno: ev.colno },
        );
      };
      const onRejection = (ev: PromiseRejectionEvent) => {
        const reason = ev.reason;
        const msg =
          reason instanceof Error
            ? `${reason.name}: ${reason.message}`
            : String(reason);
        track("runtime", `Unhandled rejection: ${msg}`, "warn");
      };
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onRejection);
      return () => {
        if (eu?.setGlobalHandler && previous) eu.setGlobalHandler(previous);
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
      };
    }
    return () => {
      if (eu?.setGlobalHandler && previous) eu.setGlobalHandler(previous);
    };
  }, []);
}

/**
 * Deep-link plumbing for OAuth callbacks. Two surfaces:
 *
 *   • Cold start: Linking.getInitialURL() returns the URL the OS used
 *     to launch the app. If the user tapped "Continue with Google" on
 *     a fresh app instance, that's where the URL lands.
 *   • Foreground: Linking.addEventListener("url") fires for every
 *     subsequent deep link while the app is running.
 *
 * Both paths feed consumeOAuthDeepLink, which idempotently writes the
 * token to the auth store. The auth gate above reacts to the store
 * update and routes to /(tabs).
 */
function useOAuthDeepLink() {
  React.useEffect(() => {
    let cancelled = false;

    async function processUrl(url: string | null) {
      if (!url || cancelled) return;
      const outcome = await consumeOAuthDeepLink(url);
      if (!outcome) return; // not an OAuth deep link
      if (!outcome.ok) {
        setPendingOAuthError(outcome.error);
      }
    }

    // Cold start
    Linking.getInitialURL()
      .then(processUrl)
      .catch((err) => console.warn("[deeplink] getInitialURL failed:", err));

    // Foreground
    const sub = Linking.addEventListener("url", (event) => {
      void processUrl(event.url);
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);
}

function AuthBoot({ children }: { children: React.ReactNode }) {
  const hydrate = useAuthStore((s) => s.hydrate);
  const hydrated = useAuthStore((s) => s.hydrated);

  const [fontsLoaded] = useFonts({
    PublicSans_400Regular,
    PublicSans_500Medium,
    PublicSans_600SemiBold,
    PublicSans_700Bold,
  });

  const hydratePresence = usePresenceStore((s) => s.hydrate);

  React.useEffect(() => {
    // EVERY init call gets its own try/catch so a single broken module
    // (e.g. expo-secure-store, AsyncStorage, expo-notifications) can't
    // take down the entire boot. Each failure is silently downgraded —
    // we'd rather render a possibly-degraded UI than hang on splash.
    try { hydrate(); } catch (e) { console.warn("[boot] hydrate failed:", e); }
    try { void hydratePresence(); } catch (e) { console.warn("[boot] hydratePresence failed:", e); }
    try { void hydrateQueryCache(queryClient); } catch (e) { console.warn("[boot] hydrateQueryCache failed:", e); }
    try { void hydrateTelemetry(); } catch (e) { console.warn("[boot] hydrateTelemetry failed:", e); }
    try { track("info", "App boot", "info"); } catch {}

    let teardownPersistence: (() => void) | undefined;
    let teardownSink: (() => void) | undefined;
    try { teardownPersistence = wireUpPersistence(queryClient); } catch (e) { console.warn("[boot] wireUpPersistence failed:", e); }
    try { teardownSink = startTelemetrySink(); } catch (e) { console.warn("[boot] startTelemetrySink failed:", e); }

    // Hard fallback — if hydrate() fails silently (no throw, no resolve)
    // force hydrated=true after 3s so the UI can at least render the
    // login screen. Better than an infinite null render.
    const hydrationTimeout = setTimeout(() => {
      try {
        const { useAuthStore: store } = require("@/store/authStore");
        if (!store.getState().hydrated) {
          console.warn("[boot] hydrate timeout — forcing hydrated=true");
          store.setState({ hydrated: true });
        }
      } catch {}
    }, 3000);

    return () => {
      clearTimeout(hydrationTimeout);
      try { teardownPersistence?.(); } catch {}
      try { teardownSink?.(); } catch {}
    };
  }, [hydrate, hydratePresence]);

  // Hide splash once hydration completes. Don't gate on fonts — RN
  // falls back to the system font and Public Sans finishes loading in
  // the background. Gating on both was causing infinite splash hangs
  // when font load races with auth init.
  React.useEffect(() => {
    if (hydrated) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [hydrated]);

  // BULLETPROOF splash dismissal — fires after 5 seconds regardless of
  // hydration state. If something is broken so badly that hydration
  // never completes, the user at least sees the actual UI (or the
  // ErrorBoundary fallback) instead of an infinite Z splash.
  React.useEffect(() => {
    const splashTimeout = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, 5000);
    return () => clearTimeout(splashTimeout);
  }, []);

  useAuthGate();
  useOAuthDeepLink();
  // TEMP: disabling non-essential hooks while we isolate a
  // "TypeError: undefined is not a function" crash inside AuthBoot.
  // Re-enable once the boot path is stable.
  // usePushNotifications();   // <- expo-notifications API drift suspect
  // useAppLifecycle();        // <- AppState listener
  // useNavigationBreadcrumbs(); // <- telemetry; non-essential
  // useGlobalErrorHandlers();   // <- error capture; non-essential

  // Wait for hydration before mounting the Stack — the auth gate
  // can't make a routing decision until SecureStore is read.
  if (!hydrated) return null;
  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.surfaceSubtle }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="dark" />
          {/* Top-level boundary catches any render error inside the tree,
              records it to telemetry, and shows a calm recovery screen. */}
          <ErrorBoundary>
          {/* Global offline cue — slides down when navigator.onLine
              flips or three requests fail in a row. */}
          <OfflineBanner />
          <AuthBoot>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.surfaceSubtle },
                animation: "fade",
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="login" options={{ animation: "fade" }} />
              {/* Phase 3 first-run onboarding — shown once per install
                  between login and (tabs). The auth gate routes here
                  before reaching the tabs when firstRun.seen is false. */}
              <Stack.Screen
                name="onboarding"
                options={{
                  animation: "fade",
                  gestureEnabled: false,
                }}
              />
              <Stack.Screen
                name="appointments/[id]"
                options={{
                  animation: "slide_from_right",
                  presentation: "card",
                  gestureEnabled: true,
                }}
              />
              {/* Customer detail — slides in with the same idiom as
                  appointment detail. CRM tap → detail → back swipe. */}
              <Stack.Screen
                name="customers/[id]"
                options={{
                  animation: "slide_from_right",
                  presentation: "card",
                  gestureEnabled: true,
                }}
              />
              {/* Notification inbox — bottom-sheet feel, full screen */}
              <Stack.Screen
                name="notifications"
                options={{
                  animation: "slide_from_bottom",
                  presentation: "card",
                  gestureEnabled: true,
                }}
              />
              {/* Quick Create — modal sheet for sub-15s booking flow */}
              <Stack.Screen
                name="quick-create"
                options={{
                  animation: "slide_from_bottom",
                  presentation: "modal",
                  gestureEnabled: true,
                }}
              />
              {/* Reschedule modal — presented as a sheet so the booking
                  detail stays in the back stack. Keeps the back-swipe
                  gesture intact and matches the iOS modal idiom. */}
              <Stack.Screen
                name="appointments/[id]/reschedule"
                options={{
                  animation: "slide_from_bottom",
                  presentation: "modal",
                  gestureEnabled: true,
                }}
              />
              {/* Diagnostics — operator triage view of the telemetry
                  buffer. Linked from Settings → About → Diagnostics. */}
              <Stack.Screen
                name="settings/diagnostics"
                options={{
                  animation: "slide_from_right",
                  presentation: "card",
                  gestureEnabled: true,
                }}
              />
              {/* Profile — native read-only view of the operator's profile.
                  Linked from Settings → Account → Profile. Edits still
                  handed off to web via WebHandoffSheet. */}
              <Stack.Screen
                name="settings/profile"
                options={{
                  animation: "slide_from_right",
                  presentation: "card",
                  gestureEnabled: true,
                }}
              />
              {/* Notification preferences — native push permission +
                  in-app inbox link + email-rules web handoff. */}
              <Stack.Screen
                name="settings/notifications"
                options={{
                  animation: "slide_from_right",
                  presentation: "card",
                  gestureEnabled: true,
                }}
              />
              {/* Security — current device session, sign-out, plus
                  web handoffs for password change + active sessions. */}
              <Stack.Screen
                name="settings/security"
                options={{
                  animation: "slide_from_right",
                  presentation: "card",
                  gestureEnabled: true,
                }}
              />
              {/* Phase 2G — native active sessions (replaces the previous
                  web handoff). Lists every JTI with per-row revoke. */}
              <Stack.Screen
                name="settings/security/sessions"
                options={{
                  animation: "slide_from_right",
                  presentation: "card",
                  gestureEnabled: true,
                }}
              />
              {/* Phase 2G — native calendar connections (replaces the
                  previous web handoff). Connect/disconnect Google or
                  Microsoft directly from mobile. */}
              <Stack.Screen
                name="settings/calendar"
                options={{
                  animation: "slide_from_right",
                  presentation: "card",
                  gestureEnabled: true,
                }}
              />
            </Stack>
          </AuthBoot>
          </ErrorBoundary>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
