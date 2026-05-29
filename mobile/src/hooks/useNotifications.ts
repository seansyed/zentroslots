/**
 * useNotifications + useUnreadNotificationCount
 *
 * Two layers:
 *
 *   • useNotifications()       — full list + unread count, used by the
 *                                /notifications inbox screen
 *   • useUnreadNotificationCount() — just the count, used by every
 *                                page header bell badge
 *
 * The separation matters for cost: the bell is mounted on every
 * non-Home tab and refreshes more aggressively than the inbox does. A
 * dedicated COUNT(*) endpoint keeps that refresh cheap.
 */

import { useQuery } from "@tanstack/react-query";

import { notificationsApi } from "@/api/notifications";
import { queryKeys } from "@/lib/query";

/** Full inbox — used by /notifications. 60s stale window is fine; the
 *  user opens this screen intentionally and a manual pull-to-refresh
 *  covers the "I want it fresh right now" case. */
export function useNotifications() {
  return useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => notificationsApi.list(),
    staleTime: 60_000,
  });
}

/** Unread count only — feeds the bell badge in PageHeader. 30s stale
 *  + 30s refetchInterval gives the badge a "live-ish" feel without
 *  burning network on idle tabs. AppState foreground also invalidates
 *  this query (wired centrally in _layout.tsx). */
export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: ["notifications", "unread-count"] as const,
    queryFn: () => notificationsApi.unreadCount(),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    // If the backend hiccups, fall back to 0 (badge hidden) rather
    // than throwing. The bell is decorative — never user-blocking.
    retry: 1,
  });
}
