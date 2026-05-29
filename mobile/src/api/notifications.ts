/**
 * Notifications.
 *
 * Backend endpoints (already shipped in scheduling-saas):
 *   • GET    /api/notifications/unread-count  →  { count: number }
 *   • GET    /api/notifications?limit=N       →  Notification[]
 *   • PATCH  /api/notifications                →  { ok: true, updated: N }   (mark all read)
 *   • PATCH  /api/notifications/{id}           →  { ok: true }                (mark one read)
 *
 * The previous stub returned hardcoded empty data because the backend
 * routes did not exist yet. They do now, so this module talks to them.
 * The exported types (NotificationRow, NotificationListResponse) and
 * the function signatures are unchanged — every caller continues to work.
 */

import type { AxiosRequestConfig } from "axios";

import { apiGet, apiPatch } from "@/api/client";

export type NotificationRow = {
  id: string;
  title: string;
  body: string;
  category: "booking" | "system" | "billing" | "automation" | "info";
  severity?: "info" | "warning" | "critical" | null;
  readAt?: string | null;
  createdAt: string;
  actionUrl?: string | null;
};

export type NotificationListResponse = {
  rows: NotificationRow[];
  unread: number;
};

/** Backend row shape — the dashboard's API returns these fields. We
 *  normalise to the mobile NotificationRow shape so screens don't care
 *  about server naming. */
type BackendNotification = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
};

function normaliseCategory(kind: string): NotificationRow["category"] {
  if (kind.startsWith("booking") || kind.startsWith("appointment")) return "booking";
  if (kind.startsWith("billing") || kind.startsWith("payment")) return "billing";
  if (kind.startsWith("automation") || kind.startsWith("workflow")) return "automation";
  if (kind.startsWith("system") || kind.startsWith("ops")) return "system";
  return "info";
}

function toRow(b: BackendNotification): NotificationRow {
  return {
    id: b.id,
    title: b.title,
    body: b.body ?? "",
    category: normaliseCategory(b.kind),
    severity: null,
    readAt: b.readAt,
    createdAt: b.createdAt,
    actionUrl: b.link,
  };
}

export const notificationsApi = {
  async list(config?: AxiosRequestConfig): Promise<NotificationListResponse> {
    // Two parallel reads: the items themselves + the canonical unread
    // count. We could derive unread from the items list, but the count
    // endpoint is cheaper (a single COUNT(*) query) AND it counts all
    // unread notifications, not just the first `limit` rows. The
    // distinction matters once a user has >20 unread.
    const [rowsRaw, countRes] = await Promise.all([
      apiGet<BackendNotification[]>("/api/notifications?limit=20", config),
      apiGet<{ count: number }>("/api/notifications/unread-count", config),
    ]);
    const rows = Array.isArray(rowsRaw) ? rowsRaw.map(toRow) : [];
    const unread = typeof countRes?.count === "number" ? countRes.count : 0;
    return { rows, unread };
  },

  /** Quick read of just the unread count. Cheaper than `list()` — used
   *  by the bell badge in the page header where we don't need the rows. */
  async unreadCount(config?: AxiosRequestConfig): Promise<number> {
    const res = await apiGet<{ count: number }>(
      "/api/notifications/unread-count",
      config,
    );
    return typeof res?.count === "number" ? res.count : 0;
  },

  async markRead(id: string): Promise<{ ok: true }> {
    await apiPatch<{ ok: true }>(`/api/notifications/${id}`);
    return { ok: true };
  },

  async markAllRead(): Promise<{ ok: true; updated: number }> {
    const res = await apiPatch<{ ok: true; updated?: number }>("/api/notifications");
    return { ok: true, updated: res?.updated ?? 0 };
  },
};
