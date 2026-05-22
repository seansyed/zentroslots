/**
 * Google Calendar push notification (events.watch) helper.
 *
 * Wave E — Google's push model:
 *   • POST /calendars/{calendarId}/events/watch with body
 *     { id, type:"web_hook", address, token, expiration? }
 *   • Response: { id, resourceId, expiration } — store both
 *   • Google then POSTs to `address` whenever ANY event in that
 *     calendar changes. Notification headers carry:
 *       X-Goog-Channel-ID    — matches what we sent in `id`
 *       X-Goog-Channel-Token — matches what we sent in `token`
 *       X-Goog-Resource-State — "sync" (initial) | "exists" (change)
 *                             | "not_exists" (deleted)
 *       X-Goog-Resource-ID   — matches the resourceId we stored
 *   • Channels expire after ~7 days max. The renewal cron extends them.
 *   • Stop a channel: POST /channels/stop with { id, resourceId }.
 *
 * Returns the raw response shape so the orchestrator can persist
 * channel + resource ids into the webhook_channels table.
 */
import { google } from "googleapis";

import { oauthClient } from "../google";

/** Maximum channel TTL accepted by Google (7 days). We request the
 *  full max to minimize renewal frequency. */
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type GoogleWatchResult = {
  channelId: string;
  resourceId: string;
  expiresAt: Date;
};

/**
 * Create a watch channel on the user's primary calendar.
 *
 *   refreshToken: from the active connection row (decrypted)
 *   calendarId  : "primary" today; future multi-cal expansion will iterate
 *   address     : public HTTPS URL of our receiver
 *   channelId   : unique opaque id (uuid). Google echoes it back on
 *                 every notification.
 *   token       : random secret. Google echoes it back as
 *                 X-Goog-Channel-Token so we can verify authenticity.
 */
export async function watchCalendar(args: {
  refreshToken: string;
  calendarId?: string;
  address: string;
  channelId: string;
  token: string;
}): Promise<GoogleWatchResult> {
  const client = oauthClient();
  client.setCredentials({ refresh_token: args.refreshToken });
  const cal = google.calendar({ version: "v3", auth: client });

  const res = await cal.events.watch({
    calendarId: args.calendarId || "primary",
    requestBody: {
      id: args.channelId,
      type: "web_hook",
      address: args.address,
      token: args.token,
      // Google accepts `expiration` as a Unix timestamp in ms (string).
      // Request the maximum allowed — Google clamps if needed.
      expiration: String(Date.now() + MAX_TTL_MS),
    },
  });

  const resourceId = res.data.resourceId ?? "";
  const exp = res.data.expiration ? Number(res.data.expiration) : Date.now() + MAX_TTL_MS;
  if (!res.data.id || !resourceId) {
    throw new Error("Google watch response missing id or resourceId");
  }
  return {
    channelId: res.data.id,
    resourceId,
    expiresAt: new Date(exp),
  };
}

/**
 * Stop an active watch channel. Idempotent on Google's side — calling
 * stop on an already-expired/cancelled channel returns 404 which we
 * silently absorb (the caller's intent is "this channel is gone now").
 */
export async function stopCalendarWatch(args: {
  refreshToken: string;
  channelId: string;
  resourceId: string;
}): Promise<void> {
  const client = oauthClient();
  client.setCredentials({ refresh_token: args.refreshToken });
  const cal = google.calendar({ version: "v3", auth: client });
  try {
    await cal.channels.stop({
      requestBody: { id: args.channelId, resourceId: args.resourceId },
    });
  } catch (err) {
    const status = (err as { code?: number; status?: number })?.code
      ?? (err as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 410) return;
    throw err;
  }
}
