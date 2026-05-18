/**
 * DB-aware preference gate for scheduling/customer emails.
 *
 * Single entry point for every transactional scheduling send site:
 *
 *   const gate = await gateSchedulingEmail({
 *     tenantId, email, kind: "appointment_confirmation"
 *   });
 *   if (!gate.allowed) {
 *     console.log(`[CommPrefs] skipped ${kind} ... reason=${gate.reason}`);
 *     return;
 *   }
 *   await sendEmail({...});
 *
 * Backwards-compat: re-exports `normalizePrefs` so existing imports of
 * `lib/client-prefs` keep working; lib/client-prefs remains the
 * canonical place for the type + defaults.
 *
 * Tenant safety: the customer lookup is ALWAYS scoped by tenantId.
 * Case-insensitive email match. If no customer row matches, callers
 * get default prefs (everything on) — the same behavior the reminder
 * cron has shipped with since v1.
 *
 * What this gate DOES NOT touch:
 *   - magic-link client auth emails
 *   - any billing/Stripe email
 *   - any non-scheduling email
 *
 * That guarantee is enforced at the type level by `SchedulingEmailKind`.
 */

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { customers } from "@/db/schema";
import {
  DEFAULT_PREFS,
  normalizePrefs,
  type ClientCommPrefs,
} from "@/lib/client-prefs";
import {
  decideSchedulingEmail,
  type GateDecision,
  type SchedulingEmailKind,
} from "@/lib/communications/email-rules";

// Re-export the type + canonical normalizer so callers have one import.
export { normalizePrefs };
export type { ClientCommPrefs, SchedulingEmailKind, GateDecision };

/**
 * Load the canonical (normalized) prefs for a (tenant, email) pair.
 * Returns DEFAULT_PREFS when no customer record matches — covers fresh
 * bookings where the customer record is created in the same request.
 */
export async function loadCustomerPrefs(
  tenantId: string,
  email: string
): Promise<ClientCommPrefs> {
  const row = await db.query.customers.findFirst({
    where: and(
      eq(customers.tenantId, tenantId),
      sql`lower(${customers.email}) = lower(${email})`
    ),
  });
  if (!row) return { ...DEFAULT_PREFS };
  return normalizePrefs(row.commPrefs);
}

export type GateInput = {
  tenantId: string;
  email: string;
  kind: SchedulingEmailKind;
  /**
   * Manual-resend escape hatch. When `true`, the gate returns allowed
   * with `overridden: true` so the caller can log it and the staff
   * member who triggered the resend owns the decision. Used by
   * future "Resend confirmation" UIs — no caller in tree today.
   */
  override?: boolean;
};

export type GateResult =
  | { allowed: true; prefs: ClientCommPrefs; overridden?: boolean }
  | { allowed: false; prefs: ClientCommPrefs; reason: NonNullable<GateDecision["reason"]> };

/**
 * Single-shot decision: loads prefs and applies the rule. Use this at
 * every scheduling send site.
 */
export async function gateSchedulingEmail(input: GateInput): Promise<GateResult> {
  const prefs = await loadCustomerPrefs(input.tenantId, input.email);
  if (input.override) {
    return { allowed: true, prefs, overridden: true };
  }
  const decision = decideSchedulingEmail(prefs, input.kind);
  if (decision.allowed) return { allowed: true, prefs };
  return { allowed: false, prefs, reason: decision.reason };
}

/**
 * Structured one-line log helper. Console-only per spec — no new tables.
 * Format matches the spec example:
 *   [CommPrefs] skipped appointment_confirmation customer=<id> reason=email_disabled tenant=<id>
 */
export function logSuppressed(args: {
  kind: SchedulingEmailKind;
  reason: NonNullable<GateDecision["reason"]>;
  tenantId: string;
  email: string;
  bookingId?: string;
}): void {
  console.log(
    `[CommPrefs] skipped ${args.kind} ` +
      `reason=${args.reason} ` +
      `tenant=${args.tenantId} ` +
      `email=${redactEmail(args.email)}` +
      (args.bookingId ? ` booking=${args.bookingId}` : "")
  );
}

function redactEmail(e: string): string {
  const at = e.indexOf("@");
  if (at < 1) return "***";
  const local = e.slice(0, at);
  const domain = e.slice(at);
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(1, local.length - 1))}${domain}`;
}
