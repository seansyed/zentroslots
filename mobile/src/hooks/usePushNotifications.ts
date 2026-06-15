/**
 * usePushNotifications — Expo push notification lifecycle hook.
 *
 * Phase 1B Foundation responsibilities (2026-05-27):
 *   1. Foreground-handler config (so notifications show while open)
 *   2. Permission request — once per app lifetime, no nag loop
 *   3. Token capture via getExpoPushTokenAsync()
 *   4. SecureStore persistence (so we don't re-register every cold start)
 *   5. Backend registration POST /api/mobile/push-tokens
 *   6. Notification-response listener → deep-link routing into the
 *      booking detail screen
 *
 * Failure modes (declined permission, simulator without push, etc.)
 * are silent — push is enhancement, not core flow. Never throws,
 * never blocks render.
 *
 * Notification payload contract (server side will populate these):
 *   {
 *     type: "booking_reminder" | "booking_created" | "booking_cancelled" | "booking_rescheduled",
 *     bookingId: "<uuid>",     // for deep linking
 *     tenantId?: "<uuid>",     // analytics
 *   }
 */

import * as React from "react";
import { Platform } from "react-native";
import { useRouter } from "expo-router";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";

import { pushTokensApi } from "@/api/pushTokens";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useAuthStore } from "@/store/authStore";
import { track } from "@/lib/telemetry";
import { createRunOnceSafe } from "@/lib/safeInit";

// IMPORTANT: never touch an expo-notifications API at module-import time.
// `Notifications.setNotificationHandler(...)` previously ran here as a
// top-level side effect. In a RELEASE build that executes during bundle
// evaluation — BEFORE React (and the ErrorBoundary) mounts — so if the
// native module is not ready/available the root-layout import throws and
// the app shows a permanent WHITE SCREEN with no recoverable surface
// (release strips the dev red-box). We instead install the handler from a
// guarded, run-once effect AFTER mount (see the hook below). Push stays
// fully enabled; it simply can no longer crash boot.
// Run-once, never-throws, retryable. The arrow is NOT invoked at import —
// only when installNotificationHandler() is called from the hook's
// post-mount effect, so the native call can never crash bundle evaluation.
const installNotificationHandler = createRunOnceSafe(
  () => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        // `shouldShowAlert` is the legacy key still required by the
        // NotificationBehavior type in expo-notifications (SDK 52); the
        // newer `shouldShowBanner`/`shouldShowList` refine iOS 14+ behavior.
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: true,
      }),
    });
  },
  (e) => {
    // Fail-open: a notification-subsystem failure must NOT block render.
    try {
      track("runtime", "setNotificationHandler failed (non-fatal)", "warn", {
        error: String((e as Error)?.message ?? e),
      });
    } catch {
      /* telemetry must never throw on the boot path */
    }
  },
);

const PUSH_TOKEN_STORAGE_KEY = "expo_push_token";

type PushPayload = {
  type?: "booking_reminder" | "booking_created" | "booking_cancelled" | "booking_rescheduled";
  bookingId?: string;
};

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync("default", {
      name: "ZentroMeet",
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: "#359df3",
      vibrationPattern: [0, 240, 240, 240],
    });
  } catch {
    /* noop */
  }
}

async function requestPermissionAndToken(): Promise<string | null> {
  // Simulators on iOS can't receive push.
  if (!Device.isDevice) return null;

  try {
    const settings = await Notifications.getPermissionsAsync();
    let granted =
      settings.granted ||
      settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
      settings.status === "granted";

    if (!granted && settings.canAskAgain !== false) {
      const req = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
          allowDisplayInCarPlay: false,
        },
      });
      granted =
        req.granted ||
        req.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
        req.status === "granted";
    }

    if (!granted) return null;

    const tokenResponse = await Notifications.getExpoPushTokenAsync();
    return tokenResponse.data ?? null;
  } catch {
    return null;
  }
}

function parsePayload(notification: Notifications.Notification | null | undefined): PushPayload | null {
  if (!notification) return null;
  const raw = notification.request.content.data ?? {};
  // The runtime payload is `Record<string, unknown>` — coerce safely.
  const payload: PushPayload = {};
  if (typeof raw.type === "string") payload.type = raw.type as PushPayload["type"];
  if (typeof raw.bookingId === "string") payload.bookingId = raw.bookingId;
  return payload;
}

export function usePushNotifications() {
  const router = useRouter();
  const isAuthed = useAuthStore((s) => Boolean(s.sessionToken && s.user));

  // ── Install the foreground handler AFTER mount (run-once, guarded) ──
  // This replaces the old module-import-time call so a notification API
  // failure can never white-screen boot.
  React.useEffect(() => {
    installNotificationHandler();
  }, []);

  // ── Registration: runs once when auth lands ───────────────────────
  React.useEffect(() => {
    if (!isAuthed) return;
    let cancelled = false;

    async function registerOnce() {
      await ensureAndroidChannel();

      // Skip if we've already registered THIS token with the backend.
      // We store the last registered value so re-renders / cold starts
      // don't spam the endpoint.
      const cached = await storage.getItem(PUSH_TOKEN_STORAGE_KEY);
      const fresh = await requestPermissionAndToken();
      if (cancelled || !fresh) return;
      if (cached === fresh) return;

      const platform: "ios" | "android" | "web" =
        Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";
      const deviceLabel = Device.modelName ?? Device.deviceName ?? "Unknown device";

      try {
        await pushTokensApi.register({ token: fresh, platform, deviceLabel });
        if (!cancelled) {
          await storage.setItem(PUSH_TOKEN_STORAGE_KEY, fresh);
        }
      } catch (err) {
        // Token will retry on next cold start since we never persisted.
        console.warn("[push] backend registration failed:", err);
      }
    }

    void registerOnce();
    return () => {
      cancelled = true;
    };
  }, [isAuthed]);

  // ── Cold-start: if the user tapped a notification to launch the
  // app, getLastNotificationResponseAsync gives us the payload. We
  // dispatch the same routing logic as the foreground listener so
  // there's exactly one tap-handling path.
  React.useEffect(() => {
    if (!isAuthed) return;
    let cancelled = false;

    async function handleColdStartTap() {
      const last = await Notifications.getLastNotificationResponseAsync();
      if (cancelled || !last) return;
      const payload = parsePayload(last.notification);
      if (payload?.bookingId) {
        router.push(`/appointments/${payload.bookingId}`);
      }
    }

    void handleColdStartTap();
    return () => {
      cancelled = true;
    };
  }, [isAuthed, router]);

  // ── Foreground tap handler ────────────────────────────────────────
  React.useEffect(() => {
    if (!isAuthed) return;
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const payload = parsePayload(response.notification);
      if (payload?.bookingId) {
        router.push(`/appointments/${payload.bookingId}`);
      }
    });
    return () => sub.remove();
  }, [isAuthed, router]);

  // ── Foreground arrival (no tap) — placeholder for future toast UI.
  // For Phase 1B we let the system banner be the only signal so the
  // app surface stays calm.
  // useEffect(() => {
  //   const sub = Notifications.addNotificationReceivedListener(...);
  //   return () => sub.remove();
  // }, []);
}

/**
 * Detach the token from this device. Called from useAuth.signOut so
 * the backend stops dispatching to a device no one's signed into.
 */
export async function unregisterPushTokenForSignOut(): Promise<void> {
  try {
    await pushTokensApi.unregister();
  } catch {
    /* noop — already invalid token is fine */
  }
  await storage.deleteItem(PUSH_TOKEN_STORAGE_KEY);
}

// Re-export the storage key for code that wants to inspect it (e.g.
// debug / settings screens).
export { PUSH_TOKEN_STORAGE_KEY };
