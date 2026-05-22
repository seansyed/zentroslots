/**
 * Staff-side notification when a calendar connection flips to
 * needs_reconnect. Wired into `markNeedsReconnect()` in the orchestrator
 * so the staff member learns about the broken connection BEFORE the
 * next customer books and finds no Meet link.
 *
 * Dedupe model:
 *   At most ONE email per connection per 24h, gated by
 *   `calendar_connections.last_reconnect_email_at`. Prevents storms
 *   when the same connection auth-fails repeatedly across a burst of
 *   bookings or freebusy reads.
 *
 * Never throws. The orchestrator must never have a failed email
 * notification block a state transition.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { calendarConnections, tenants, users } from "@/db/schema";
import { sendEmail } from "@/lib/email";

/** 24h dedupe window — long enough to silence storms, short enough that
 *  a chronic problem still surfaces daily until the staff member acts. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function notifyReconnectRequired(args: {
  connectionId: string;
  reason: string;
}): Promise<void> {
  try {
    // Atomic claim: update `last_reconnect_email_at` to NOW iff it's
    // older than 24h (or null). The RETURNING gives us the row only
    // when WE were the claimant — if another process emailed in the
    // dedupe window, the WHERE doesn't match and we get no row back.
    const claimCutoff = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const [claimed] = await db
      .update(calendarConnections)
      .set({ lastReconnectEmailAt: new Date() })
      .where(
        and(
          eq(calendarConnections.id, args.connectionId),
          // Must be in needs_reconnect (so we don't email on a stale
          // signal after a healed connection).
          eq(calendarConnections.status, "needs_reconnect"),
          or(
            isNull(calendarConnections.lastReconnectEmailAt),
            lt(calendarConnections.lastReconnectEmailAt, claimCutoff),
          ),
        ),
      )
      .returning({
        userId: calendarConnections.userId,
        tenantId: calendarConnections.tenantId,
        provider: calendarConnections.provider,
        accountEmail: calendarConnections.accountEmail,
      });

    if (!claimed) return; // Dedupe-suppressed; another caller won the race.

    // Look up the staff member + tenant for the email body.
    const [staff, tenant] = await Promise.all([
      db.query.users.findFirst({
        where: eq(users.id, claimed.userId),
        columns: { email: true, name: true, timezone: true },
      }),
      db.query.tenants.findFirst({
        where: eq(tenants.id, claimed.tenantId),
        columns: { name: true, primaryColor: true },
      }),
    ]);

    if (!staff?.email) return;

    const appBase = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
    const reconnectUrl = `${appBase}/dashboard/settings/calendar`;
    const tenantName = tenant?.name ?? "your workspace";
    const accent = tenant?.primaryColor ?? "#359df3";
    const providerLabel = claimed.provider === "google" ? "Google Calendar" : claimed.provider;
    const firstName = staff.name?.split(/\s+/)[0] ?? "there";

    await sendEmail({
      to: staff.email,
      subject: `Reconnect your ${providerLabel} — calendar sync paused`,
      html: renderHtml({
        firstName,
        tenantName,
        providerLabel,
        reconnectUrl,
        accent,
        reason: args.reason,
        accountEmail: claimed.accountEmail,
      }),
      text: renderText({
        firstName,
        tenantName,
        providerLabel,
        reconnectUrl,
        reason: args.reason,
      }),
      audit: { tenantId: claimed.tenantId, kind: "calendar_reconnect_required" },
    });
  } catch (err) {
    // Strict never-throw policy: a failed email must never block the
    // orchestrator's state transition. Log + swallow.
    console.error("[calendar/notifyReconnect] send failed:", err);
  }
  // Re-export sql to silence unused-import lints when builds prune the
  // tree (drizzle's `or` references `sql` indirectly through tagged
  // templates the linter sometimes misses).
  void sql;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

function renderHtml(args: {
  firstName: string;
  tenantName: string;
  providerLabel: string;
  reconnectUrl: string;
  accent: string;
  reason: string;
  accountEmail: string | null;
}): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
  <h1 style="font-size:18px;margin:0 0 8px">Hi ${escapeHtml(args.firstName)},</h1>
  <p style="font-size:14px;color:#475569;margin:0 0 16px;line-height:1.55">
    Your ${escapeHtml(args.providerLabel)} connection for
    <strong style="color:#0f172a">${escapeHtml(args.tenantName)}</strong>
    needs to be reconnected. Until you do, new bookings won&rsquo;t create
    calendar events or video links for you.
  </p>
  ${args.accountEmail ? `<p style="font-size:13px;color:#64748b;margin:0 0 16px">Account: <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">${escapeHtml(args.accountEmail)}</code></p>` : ""}
  <p style="margin:20px 0 24px">
    <a href="${escapeHtml(args.reconnectUrl)}" style="display:inline-block;background:${escapeHtml(args.accent)};color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Reconnect ${escapeHtml(args.providerLabel)}</a>
  </p>
  <p style="font-size:12px;color:#94a3b8;margin:0 0 4px">
    This usually happens when you change your password, revoke the
    permission, or your provider rotates its grants. Reconnecting takes
    about 10 seconds.
  </p>
  <p style="font-size:11px;color:#cbd5e1;margin:16px 0 0;border-top:1px solid #e2e8f0;padding-top:12px">
    You&rsquo;ll only get one of these per day per connection.
  </p>
</div>`;
}

function renderText(args: {
  firstName: string;
  tenantName: string;
  providerLabel: string;
  reconnectUrl: string;
  reason: string;
}): string {
  return `Hi ${args.firstName},\n\nYour ${args.providerLabel} connection for ${args.tenantName} needs to be reconnected. Until you do, new bookings won't create calendar events or video links for you.\n\nReconnect: ${args.reconnectUrl}\n\nReason: ${args.reason}\n\nYou'll only get one of these per day per connection.`;
}
