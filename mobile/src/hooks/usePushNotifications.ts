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
import Constants from "expo-constants";

import { pushTokensApi } from "@/api/pushTokens";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useAuthStore } from "@/store/authStore";
import { track } from "@/lib/telemetry";
import { createRunOnceSafe, bootBreadcrumb } from "@/lib/safeInit";
import { shouldProcessResponse } from "@/lib/notificationDedup";
import {
  classifyTokenError,
  errorMessage,
  recordPushDiagnostic,
} from "@/lib/pushDiagnostics";

/**
 * Resolve the EAS projectId for getExpoPushTokenAsync. In a standalone
 * build expo-notifications auto-reads this from app.json, but passing it
 * explicitly is more robust and makes the value observable in diagnostics.
 */
function resolveProjectId(): string | null {
  try {
    const fromExtra = (
      Constants?.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
    )?.eas?.projectId;
    const fromEasConfig = (
      Constants as unknown as { easConfig?: { projectId?: string } }
    )?.easConfig?.projectId;
    return fromExtra ?? fromEasConfig ?? null;
  } catch {
    return null;
  }
}

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
// Persists the OS identifier of the most recently HANDLED notification tap, so
// a cold launch can tell "the user just tapped this" from "the OS is replaying
// the last tap on a plain relaunch" — preventing the cold-start re-fire.
const LAST_HANDLED_PUSH_RESPONSE_KEY = "push_last_handled_response_id";

// In-memory guard for the current app session (survives effect re-runs, not a
// cold start). Combined with the persisted id above it covers all three states.
const handledResponseIds = new Set<string>();

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
      lightColor: "#2563EB",
      vibrationPattern: [0, 240, 240, 240],
    });
  } catch {
    /* noop */
  }
}

async function requestPermissionAndToken(): Promise<string | null> {
  // Simulators / emulators can't receive push.
  if (!Device.isDevice) {
    track("info", "push: skipped — not a physical device", "info", { stage: "permission" });
    recordPushDiagnostic({
      stage: "failed",
      pushAvailable: false,
      lastError: "not_a_physical_device",
      lastErrorStage: "permission",
    });
    return null;
  }

  // ── Stage 1: permission ──────────────────────────────────────────
  let granted = false;
  try {
    recordPushDiagnostic({ stage: "permission" });
    const settings = await Notifications.getPermissionsAsync();
    granted =
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
  } catch (e) {
    // Previously swallowed silently. Now logged with the exact exception
    // + stage, while preserving UX (push is enhancement → still return null).
    const msg = errorMessage(e);
    track("runtime", "push: permission check failed", "error", { stage: "permission", error: msg });
    recordPushDiagnostic({
      stage: "failed",
      permissionGranted: false,
      pushAvailable: false,
      lastError: msg,
      lastErrorStage: "permission",
    });
    return null;
  }

  recordPushDiagnostic({ permissionGranted: granted });
  if (!granted) {
    track("info", "push: notifications permission not granted", "warn", { stage: "permission" });
    recordPushDiagnostic({
      stage: "failed",
      pushAvailable: false,
      lastError: "permission_not_granted",
      lastErrorStage: "permission",
    });
    return null;
  }

  // ── Stage 2: token capture ───────────────────────────────────────
  // getExpoPushTokenAsync first obtains a native FCM (Android) / APNs (iOS)
  // token; on Android that requires Firebase/FCM config in the build. When
  // it's missing this throws "Default FirebaseApp failed to initialize …".
  // We pass projectId EXPLICITLY (auto-resolved from app.json otherwise).
  const projectId = resolveProjectId();
  recordPushDiagnostic({ stage: "token", projectId });
  if (!projectId) {
    track("runtime", "push: EAS projectId unresolved", "warn", { stage: "token" });
  }
  try {
    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const token = tokenResponse.data ?? null;
    if (!token) {
      track("runtime", "push: getExpoPushTokenAsync returned empty token", "error", {
        stage: "token",
        projectId,
      });
      recordPushDiagnostic({
        stage: "failed",
        tokenObtained: false,
        pushAvailable: false,
        lastError: "empty_token",
        lastErrorStage: "token",
      });
      return null;
    }
    // Success ⇒ the native Firebase/FCM (Android) / APNs (iOS) layer is up.
    track("info", "push: expo token obtained", "info", {
      stage: "token",
      projectId,
      tokenPrefix: token.slice(0, 14),
    });
    recordPushDiagnostic({
      tokenObtained: true,
      firebaseAvailable: true,
      lastError: null,
      lastErrorStage: null,
    });
    return token;
  } catch (e) {
    // The exact failure that was previously invisible. Log the full
    // exception + classify the Firebase/FCM-not-configured signature so the
    // root cause is visible immediately (telemetry + diagnostics snapshot).
    const msg = errorMessage(e);
    const { firebaseAvailable, reason } = classifyTokenError(e);
    track("runtime", "push: getExpoPushTokenAsync failed", "error", {
      stage: "token",
      projectId,
      reason,
      firebaseAvailable,
      error: msg,
    });
    recordPushDiagnostic({
      stage: "failed",
      tokenObtained: false,
      firebaseAvailable,
      pushAvailable: false,
      lastError: msg,
      lastErrorStage: "token",
    });
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
    bootBreadcrumb("push:installHandler");
    installNotificationHandler();
  }, []);

  // ── Registration: runs once when auth lands ───────────────────────
  React.useEffect(() => {
    bootBreadcrumb("push:registration authed=" + isAuthed);
    if (!isAuthed) return;
    let cancelled = false;

    async function registerOnce() {
      track("info", "push: registration starting", "info", { platform: Platform.OS });
      await ensureAndroidChannel();

      // Skip if we've already registered THIS token with the backend.
      // We store the last registered value so re-renders / cold starts
      // don't spam the endpoint.
      const cached = await storage.getItem(PUSH_TOKEN_STORAGE_KEY);
      const fresh = await requestPermissionAndToken();
      if (cancelled || !fresh) return;
      if (cached === fresh) {
        // Already registered & uploaded in a prior session — push is ready.
        // (requestPermissionAndToken already recorded tokenObtained=true.)
        recordPushDiagnostic({ stage: "ready", tokenUploaded: true, pushAvailable: true });
        return;
      }

      const platform: "ios" | "android" | "web" =
        Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";
      const deviceLabel = Device.modelName ?? Device.deviceName ?? "Unknown device";

      // ── Stage 3: upload ──────────────────────────────────────────
      recordPushDiagnostic({ stage: "upload" });
      try {
        const res = await pushTokensApi.register({ token: fresh, platform, deviceLabel });
        if (!cancelled) {
          await storage.setItem(PUSH_TOKEN_STORAGE_KEY, fresh);
        }
        track("info", "push: token uploaded", "info", {
          stage: "upload",
          persisted: res?.persisted ?? null,
        });
        recordPushDiagnostic({
          stage: "ready",
          tokenUploaded: true,
          pushAvailable: true,
          lastError: null,
          lastErrorStage: null,
        });
      } catch (err) {
        // Token will retry on next cold start since we never persisted.
        const msg = errorMessage(err);
        console.warn("[push] backend registration failed:", err);
        track("network", "push: token upload failed", "error", { stage: "upload", error: msg });
        recordPushDiagnostic({
          stage: "failed",
          tokenUploaded: false,
          pushAvailable: false,
          lastError: msg,
          lastErrorStage: "upload",
        });
      }
    }

    void registerOnce();
    return () => {
      cancelled = true;
    };
  }, [isAuthed]);

  // Handle a notification TAP exactly once across cold-start / background /
  // foreground. Dedup on the OS identifier: an in-memory Set guards the current
  // session; a persisted last-handled id guards across cold starts (so
  // getLastNotificationResponseAsync replaying the last tap on a plain relaunch
  // no longer re-navigates). The routing logic itself is unchanged.
  const handleResponseOnce = React.useCallback(
    async (response: Notifications.NotificationResponse | null | undefined) => {
      if (!response) return;
      const id = response.notification.request.identifier ?? null;
      let lastPersisted: string | null = null;
      try {
        lastPersisted = await storage.getItem(LAST_HANDLED_PUSH_RESPONSE_KEY);
      } catch {
        /* storage read failure → fail toward handling (a real tap matters) */
      }
      if (!shouldProcessResponse(id, handledResponseIds, lastPersisted)) return;
      if (id) {
        handledResponseIds.add(id);
        void storage.setItem(LAST_HANDLED_PUSH_RESPONSE_KEY, id).catch(() => {});
      }
      const payload = parsePayload(response.notification);
      if (payload?.bookingId) {
        router.push(`/appointments/${payload.bookingId}`);
      }
    },
    [router],
  );

  // ── Cold-start: if the user tapped a notification to launch the app,
  // getLastNotificationResponseAsync gives us the payload. Routes through the
  // single deduped tap-handling path (same as the foreground listener).
  React.useEffect(() => {
    bootBreadcrumb("push:coldStartTap authed=" + isAuthed);
    if (!isAuthed) return;
    let cancelled = false;

    async function handleColdStartTap() {
      const last = await Notifications.getLastNotificationResponseAsync();
      if (cancelled || !last) return;
      await handleResponseOnce(last);
    }

    void handleColdStartTap();
    return () => {
      cancelled = true;
    };
  }, [isAuthed, router]);

  // ── Foreground tap handler ────────────────────────────────────────
  React.useEffect(() => {
    bootBreadcrumb("push:foregroundTap authed=" + isAuthed);
    if (!isAuthed) return;
    // Fail-open: the listener attach is a native call. If it throws it must
    // NOT bubble out of this passive effect (that would unmount the tree and
    // freeze boot) — return a no-op cleanup instead.
    let sub: { remove: () => void } | null = null;
    try {
      sub = Notifications.addNotificationResponseReceivedListener((response) => {
        // Same deduped path — a tap that also launched the app (delivered to
        // both cold-start and this listener) is processed exactly once.
        void handleResponseOnce(response);
      });
    } catch (e) {
      try {
        console.error("[boot:pushResponseListener] failed:", (e as Error)?.message ?? e);
      } catch {
        /* logging must never throw */
      }
      sub = null;
    }
    return () => {
      try {
        sub?.remove();
      } catch {
        /* noop */
      }
    };
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
    // Detach ONLY this device's token, not every device the user owns —
    // signing out on a phone must not silence the user's other devices.
    const thisDeviceToken = await storage.getItem(PUSH_TOKEN_STORAGE_KEY);
    await pushTokensApi.unregister(thisDeviceToken ?? undefined);
  } catch {
    /* noop — already invalid token is fine */
  }
  await storage.deleteItem(PUSH_TOKEN_STORAGE_KEY);
}

// Re-export the storage key for code that wants to inspect it (e.g.
// debug / settings screens).
export { PUSH_TOKEN_STORAGE_KEY };
