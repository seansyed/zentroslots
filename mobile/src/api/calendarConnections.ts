/**
 * Calendar connections — list, connect, disconnect.
 *
 * Distinct from `calendar.ts` which handles calendar EVENTS (bookings
 * shown on the day/week grid). This file handles the OAuth + sync
 * relationship between a user and an external provider (Google,
 * Microsoft, Zoom).
 *
 * Backed by:
 *
 *   GET  /api/users/:id/calendar-connections   — list
 *   GET  /api/calendar/google/connect          — OAuth start (302)
 *   GET  /api/calendar/microsoft/connect       — OAuth start (302)
 *   POST /api/calendar/disconnect              — { connectionId }
 *
 * The OAuth start endpoints are 302 redirects. For mobile we open
 * them via `Linking.openURL` so the system browser handles auth, and
 * the callback redirects back into the app via the existing
 * `zentromeet://` deep-link wiring (auth OAuth already supports
 * `?mobile=1`; calendar OAuth will follow the same pattern).
 */

import { apiGet, apiPost } from "./client";
import { env } from "@/lib/env";

export type CalendarProvider = "google" | "microsoft" | "zoom";
export type CalendarConnectionStatus = "connected" | "disconnected" | "error";

export type CalendarConnection = {
  id: string;
  provider: CalendarProvider;
  status: CalendarConnectionStatus;
  calendarId: string | null;
  accountEmail: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ListResponse = {
  connections: CalendarConnection[];
};

export const calendarConnectionsApi = {
  /**
   * List a user's calendar connections. The mobile app passes its own
   * `profile.id` — the backend route accepts self-reads + admin reads.
   */
  async list(userId: string): Promise<CalendarConnection[]> {
    const data = await apiGet<ListResponse>(
      `/api/users/${encodeURIComponent(userId)}/calendar-connections`,
    );
    return data.connections ?? [];
  },

  async disconnect(connectionId: string): Promise<{ ok: boolean }> {
    return apiPost<{ ok: boolean }, { connectionId: string }>(
      "/api/calendar/disconnect",
      { connectionId },
    );
  },

  /**
   * Begin a SECURE mobile calendar-connect. Bearer-authed call returns the
   * provider consent URL (carrying a short-lived signed state that binds
   * this user/tenant). The screen opens that URL in the system browser via
   * WebBrowser.openAuthSessionAsync; the backend callback stores the
   * encrypted tokens server-side and deep-links
   * zentromeet://oauth/calendar/{provider}/{success,error}. No tokens or
   * secrets ever touch the device.
   */
  async mobileConnectStart(provider: "google" | "microsoft"): Promise<{ authUrl: string }> {
    return apiGet<{ authUrl: string }>(
      `/api/calendar/${provider}/connect/mobile`,
    );
  },

  /**
   * Full URL for the system browser to open. We append `mobile=1` so
   * the callback knows to return a deep link.
   */
  connectUrl(provider: "google" | "microsoft"): string {
    const base = `${env.apiBaseUrl}/api/calendar/${provider}/connect`;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}mobile=1`;
  },
};
