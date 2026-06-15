/**
 * useAppLifecycle — Phase 1C reliability hook.
 *
 * Listens for two signals that mean "cached data is probably stale":
 *
 *   1. AppState transitions from background/inactive → active. We
 *      treat anything older than STALE_AFTER_MS as untrusted and
 *      invalidate the appointment caches so the next render shows
 *      fresh data. The 60s threshold avoids burning bandwidth on
 *      quick tab-outs while catching the "phone in pocket for an
 *      hour" case.
 *
 *   2. Inbound push notifications. The server-side payload includes
 *      `type` + `bookingId`. Any booking_* event invalidates the
 *      affected booking's detail key + the list so the next render
 *      shows the new state instead of the cached one.
 *
 * TanStack Query has built-in focusManager support, but React Native
 * has no native "window focus" — AppState is the equivalent surface
 * and we wire it manually so we control the threshold + log shape.
 *
 * Idempotent: invalidations are no-ops when the cache is already
 * fresh (queryClient drops them). Never throws.
 *
 * Mounted once in app/_layout.tsx.
 */

import * as React from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as Notifications from "expo-notifications";
import { useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query";

// Hide-then-show this quickly = treat as "still in flow", don't refetch.
// 60s is roughly the boundary where users expect data to feel fresh.
const STALE_AFTER_MS = 60_000;

type BookingPushType =
  | "booking_reminder"
  | "booking_created"
  | "booking_cancelled"
  | "booking_rescheduled";

function isBookingPushType(v: unknown): v is BookingPushType {
  return (
    v === "booking_reminder" ||
    v === "booking_created" ||
    v === "booking_cancelled" ||
    v === "booking_rescheduled"
  );
}

export function useAppLifecycle(): void {
  const queryClient = useQueryClient();
  const lastActiveAtRef = React.useRef<number>(Date.now());
  const lastStateRef = React.useRef<AppStateStatus>(AppState.currentState);

  // ── AppState: invalidate stale appointment data on foreground ──
  React.useEffect(() => {
    function handleChange(next: AppStateStatus) {
      const prev = lastStateRef.current;
      lastStateRef.current = next;

      if (next === "active" && prev !== "active") {
        const idleMs = Date.now() - lastActiveAtRef.current;
        if (idleMs >= STALE_AFTER_MS) {
          // Invalidate both list + open detail screens. The detail
          // screen will refetch on its own when remounted; if it's
          // still mounted, query will refetch automatically because
          // we marked the key stale.
          void queryClient.invalidateQueries({ queryKey: queryKeys.appointments() });
          void queryClient.invalidateQueries({ queryKey: ["appointment"] });
          void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
          // Also refresh /me so plan/role changes from another device
          // propagate without a manual reload.
          void queryClient.invalidateQueries({ queryKey: queryKeys.me });
          // Services are tenant CONFIG — operators expect a dashboard
          // edit (durationMinutes, name, price, isActive) to show up
          // the next time mobile is opened. Without this invalidation
          // a stale Service.durationMinutes can survive in the
          // in-memory cache across an entire foreground session.
          void queryClient.invalidateQueries({ queryKey: ["services"] });
        }
        lastActiveAtRef.current = Date.now();
      } else if (next === "background" || next === "inactive") {
        // Stamp the moment we leave so the next "active" can measure.
        lastActiveAtRef.current = Date.now();
      }
    }

    // Fail-open: the AppState attach is a native call and must never throw out
    // of this passive effect (a throw here unmounts the tree and freezes boot).
    let sub: { remove: () => void } | null = null;
    try {
      sub = AppState.addEventListener("change", handleChange);
    } catch (e) {
      try {
        console.error("[boot:appStateListener] failed:", (e as Error)?.message ?? e);
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
  }, [queryClient]);

  // ── Push arrival: invalidate the affected booking's cached state ──
  // Distinct from the response (tap) listener in usePushNotifications.
  // This fires for EVERY arriving notification — even ones the user
  // doesn't tap — so the in-app appointment list / detail stays
  // truthful without waiting for a focus event.
  React.useEffect(() => {
    // Fail-open: attaching the listener is a native call (expo-notifications).
    // If the native module is unavailable it must not bubble out of the
    // effect — return a no-op cleanup instead.
    let sub: { remove: () => void } | null = null;
    try {
      sub = Notifications.addNotificationReceivedListener((notification) => {
        try {
          const raw = notification.request.content.data ?? {};
          const type = isBookingPushType(raw.type) ? raw.type : null;
          const bookingId = typeof raw.bookingId === "string" ? raw.bookingId : null;
          if (!type) return;

          // Always invalidate the list — a new/cancelled/rescheduled
          // booking changes its position or status in the agenda.
          void queryClient.invalidateQueries({ queryKey: queryKeys.appointments() });

          if (bookingId) {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.appointment(bookingId),
            });
          }
        } catch {
          // Listener must never throw — silently ignore malformed payloads.
        }
      });
    } catch {
      sub = null;
    }
    return () => {
      try { sub?.remove(); } catch { /* noop */ }
    };
  }, [queryClient]);
}
