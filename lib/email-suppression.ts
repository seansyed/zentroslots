/**
 * Phase: SES deliverability hardening — suppression list helpers.
 *
 * Pre-send safety net for the email transport: addresses that have
 * **permanently bounced** or **filed a spam complaint** at SES land in
 * the `email_suppressions` table and must never receive another send.
 *
 * Why this matters:
 *   AWS SES tracks per-account bounce + complaint rates. Bounce > 5%
 *   or complaint > 0.1% → account-wide sending pause. ONE customer
 *   with a bouncing mailbox who keeps getting reminder emails can
 *   tip the rate and break delivery for every tenant on the account.
 *
 * Population:
 *   /api/webhooks/ses parses SNS notifications (bounce/complaint) and
 *   UPSERTs into email_suppressions. Manual additions are allowed too
 *   (`kind='manual'`, `source='manual:<userId>'`) for ops escapes.
 *
 * Honoring:
 *   lib/email.ts → sendEmail() calls isSuppressed(to) and skips the
 *   send with a categorized `suppressed:<kind>` reason if hit. The
 *   skipped send is logged structurally so admins can see "We did
 *   NOT send X because Y previously bounced/complained."
 *
 * Performance:
 *   Single indexed lookup per send. `email_lower` is the unique key
 *   and is canonicalized via toLowerCase().trim(). Total added latency
 *   is < 5ms in our prod profile.
 *
 * Failure isolation:
 *   If the suppression check itself throws (DB unreachable), we MUST
 *   NOT block sends — a downed DB shouldn't take down the email path.
 *   We log + return `false` (treat as not-suppressed) so the email
 *   attempts via SES; SES will reject if the address is genuinely
 *   bad, and the bounce will re-populate this table next round.
 */

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { emailSuppressions } from "@/db/schema";

/** Closed enum mirroring the migration. */
export type SuppressionKind = "bounce" | "complaint" | "manual";

/** Normalize an email address to the storage form. Mirrored on both
 *  the write (recordSuppression) and read (isSuppressed) paths. */
function canon(email: string): string {
  return email.trim().toLowerCase();
}

/** True when the address has ANY suppression row (bounce OR complaint
 *  OR manual). Suppressed addresses MUST NOT receive new sends.
 *
 *  Never throws. Returns `false` on DB error (fail-open) — see the
 *  module header for the reasoning. */
export async function isSuppressed(email: string): Promise<boolean> {
  if (!email || !email.includes("@")) return false;
  try {
    const rows = await db
      .select({ id: emailSuppressions.id })
      .from(emailSuppressions)
      .where(eq(emailSuppressions.emailLower, canon(email)))
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    // Structured log so log aggregators can flag DB-reach issues, but
    // never block the send. SES will reject a bad address anyway.
    try {
      console.error(
        JSON.stringify({
          evt: "suppression_check_failed",
          ts: new Date().toISOString(),
          to_domain: email.split("@")[1] ?? "?",
          err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        }),
      );
    } catch {}
    return false;
  }
}

/** Return all suppression kinds an address has (empty array if none).
 *  Used by the admin diagnostic surface — when investigating "why
 *  didn't this customer get the email", they can see whether it was
 *  a bounce (mailbox issue) or a complaint (spam button). */
export async function suppressionKindsFor(email: string): Promise<SuppressionKind[]> {
  if (!email || !email.includes("@")) return [];
  try {
    const rows = await db
      .select({ kind: emailSuppressions.kind })
      .from(emailSuppressions)
      .where(eq(emailSuppressions.emailLower, canon(email)));
    return rows.map((r) => r.kind as SuppressionKind);
  } catch {
    return [];
  }
}

/** Record a suppression event. UPSERTs on (email_lower, kind) — re-
 *  occurring events increment event_count and refresh last_seen_at
 *  rather than inserting a duplicate row.
 *
 *  Callers:
 *    - SES SNS webhook (kind='bounce'|'complaint')
 *    - Admin "Suppress address" action (kind='manual', source='manual:<userId>')
 *
 *  Returns the row id on success. Never throws — DB errors are logged
 *  and the function returns `null` so the webhook still 200-OKs to SNS
 *  (otherwise SNS retries forever and we keep crashing). */
export async function recordSuppression(args: {
  email: string;
  kind: SuppressionKind;
  bounceSubtype?: string | null;
  reason?: string | null;
  source?: string;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  const email = canon(args.email);
  if (!email || !email.includes("@")) return null;
  try {
    const rows = await db
      .insert(emailSuppressions)
      .values({
        emailLower: email,
        kind: args.kind,
        bounceSubtype: args.bounceSubtype ?? null,
        reason: args.reason ?? null,
        source: args.source ?? "ses-sns",
        metadata: args.metadata ?? {},
        // first_seen_at, last_seen_at, event_count all default
      })
      // UPSERT: refresh last_seen_at + increment event_count when we
      // see the same (email, kind) again. We deliberately leave
      // first_seen_at + bounce_subtype + source untouched on conflict
      // — those reflect the ORIGINAL signal, which is more useful
      // for forensics than the latest one.
      .onConflictDoUpdate({
        target: [emailSuppressions.emailLower, emailSuppressions.kind],
        set: {
          lastSeenAt: sql`NOW()`,
          eventCount: sql`${emailSuppressions.eventCount} + 1`,
          reason: args.reason ?? sql`${emailSuppressions.reason}`,
        },
      })
      .returning({ id: emailSuppressions.id });
    return rows[0]?.id ?? null;
  } catch (err) {
    try {
      console.error(
        JSON.stringify({
          evt: "suppression_record_failed",
          ts: new Date().toISOString(),
          to_domain: email.split("@")[1] ?? "?",
          kind: args.kind,
          err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        }),
      );
    } catch {}
    return null;
  }
}

/** Remove a suppression. Used when an operator confirms the bounce
 *  was transient (mailbox fixed) or a complaint was a misclick. */
export async function clearSuppression(email: string, kind?: SuppressionKind): Promise<number> {
  const e = canon(email);
  if (!e) return 0;
  try {
    const result = kind
      ? await db
          .delete(emailSuppressions)
          .where(and(eq(emailSuppressions.emailLower, e), eq(emailSuppressions.kind, kind)))
          .returning({ id: emailSuppressions.id })
      : await db
          .delete(emailSuppressions)
          .where(eq(emailSuppressions.emailLower, e))
          .returning({ id: emailSuppressions.id });
    return result.length;
  } catch {
    return 0;
  }
}

/** Rolling counts for the /api/health dashboard.
 *
 *    bounce24h   — permanent bounces recorded in the last 24h
 *    complaint24h — complaints recorded in the last 24h
 *    total       — total active suppressions
 *
 *  A bounce rate trending up is the strongest early warning that
 *  list quality is degrading or SES reputation is at risk. */
export async function suppressionStats(): Promise<{
  bounce24h: number;
  complaint24h: number;
  total: number;
}> {
  try {
    const rows = await db.execute(
      sql`SELECT
        (SELECT COUNT(*)::int FROM email_suppressions WHERE kind = 'bounce' AND last_seen_at > NOW() - INTERVAL '24 hours') AS bounce_24h,
        (SELECT COUNT(*)::int FROM email_suppressions WHERE kind = 'complaint' AND last_seen_at > NOW() - INTERVAL '24 hours') AS complaint_24h,
        (SELECT COUNT(*)::int FROM email_suppressions) AS total`,
    );
    const r = (rows as unknown as Array<{ bounce_24h: number; complaint_24h: number; total: number }>)[0];
    return {
      bounce24h: Number(r?.bounce_24h ?? 0),
      complaint24h: Number(r?.complaint_24h ?? 0),
      total: Number(r?.total ?? 0),
    };
  } catch {
    return { bounce24h: 0, complaint24h: 0, total: 0 };
  }
}
