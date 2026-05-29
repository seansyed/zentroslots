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
    hydrate();
    // Hydrate local presence from SecureStore once at boot — fire and
    // forget; the UI defaults to "available" until this resolves.
    void hydratePresence();
    // Rehydrate the TanStack Query cache from AsyncStorage so cold-start
    // shows last-known appointments while the network catches up. Fire
    // and forget — empty cache is a perfectly fine starting point.
    void hydrateQueryCache(queryClient);
    // Rehydrate the telemetry buffer so a post-crash relaunch still
    // shows the trail leading up to the crash.
    void hydrateTelemetry();
    track("info", "App boot", "info");
    // Start writing snapshots back to disk on every successful query.
    const teardownPersistence = wireUpPersistence(queryClient);
    // Phase 3 — start batched telemetry remote sink. Flushes the
    // in-app ring buffer to the backend every 60s plus on app
    // background, so beta crashes show up in pm2 logs even when
    // the operator never re-opens the app.
    const teardownSink = startTelemetrySink();
    return () => {
      teardownPersistence();
      teardownSink();
    };
  }, [hydrate, hydratePresence]);

  // Hide splash once BOTH hydration + fonts complete. We don't gate
  // hydration on fonts — render the system font in the meantime so
  // a slow font load never blocks UI.
  React.useEffect(() => {
    if (hydrated && fontsLoaded) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [hydrated, fontsLoaded]);

  useAuthGate();
  useOAuthDeepLink();
  // Push notification lifecycle — silent until auth lands, then
  // registers token + listens for taps so notification → booking
  // detail routing works.
  usePushNotifications();
  // Phase 1C — AppState foreground refetch + push-arrival cache
  // invalidation. Independent of usePushNotifications so the two
  // can evolve without coupling (taps vs arrivals are different
  // signals).
  useAppLifecycle();
  // Phase 2E — observability. Breadcrumbs for navigation + capture for
  // runtime errors that bypass React (async, unhandled rejections).
  useNavigationBreadcrumbs();
  useGlobalErrorHandlers();

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
