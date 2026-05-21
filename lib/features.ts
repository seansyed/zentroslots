/**
 * Tenant feature toggles.
 *
 * Only flags whose runtime backend EXISTS are listed in FeatureFlag. The
 * "no fake toggles" rule is enforced at the type level: a developer
 * cannot ship a switch for a feature that doesn't exist without first
 * extending this union (and the type checker forces them to wire it).
 *
 * Reads go through `loadTenantFeatures(tenantId)` which has a 60-second
 * in-process cache. The cache is invalidated by `invalidateTenantFeatures`
 * on every successful write to /api/tenant/features. Multi-process
 * deploys (PM2 cluster mode is NOT in use here — single instance) would
 * need a pub/sub bump; in single-process PM2 the cache is correct.
 *
 * Defaults are "on" — a tenant who has never visited the settings page
 * keeps the pre-feature-flag behavior byte-identical.
 */
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantFeatureSettings } from "@/db/schema";

// Closed union — adding a key here REQUIRES wiring its gate at the
// runtime site (engine, API, UI). The TypeScript compiler will catch
// any consumer that forgets to handle a new key.
export type FeatureFlag =
  | "reminders"          // engine skips appointment.reminder_* events
  | "rescheduling"       // admin + public reschedule routes 403; UI hides buttons
  | "cancellations"      // admin + public cancel routes 403; UI hides buttons
  | "intakeForms"        // public booking skips intake step; service.intakeFormId becomes no-op
  | "googleMeet"         // booking POST skips createCalendarEventForStaff()
  | "emailNotifications" // Phase 16: lib/communications/engine.ts skips email dispatch
  | "bookingBuffers"     // Phase 16: lib/availability.ts ignores per-service before/after buffers
  | "webhookDelivery";   // Phase 16: lib/outbound.ts skips POST to notificationWebhookUrl

export const FEATURE_FLAGS: readonly FeatureFlag[] = [
  "reminders",
  "rescheduling",
  "cancellations",
  "intakeForms",
  "googleMeet",
  "emailNotifications",
  "bookingBuffers",
  "webhookDelivery",
] as const;

export type FeatureFlags = Record<FeatureFlag, boolean>;

// Defaults preserve pre-flag behavior — every toggle starts ON. A
// tenant who never touches the settings page sees zero behavior change.
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  reminders: true,
  rescheduling: true,
  cancellations: true,
  intakeForms: true,
  googleMeet: true,
  emailNotifications: true,
  bookingBuffers: true,
  webhookDelivery: true,
};

// Human-readable metadata for the admin UI. Description is what tenants
// actually read when deciding whether to flip a toggle — write it for
// the admin, not the engineer.
export const FEATURE_FLAG_META: Record<
  FeatureFlag,
  { label: string; description: string; impact: string }
> = {
  reminders: {
    label: "Automated reminders",
    description: "Send 24-hour and 1-hour email reminders before each appointment.",
    impact: "When off, the reminder cron skips all booked appointments — customers receive no reminder emails.",
  },
  rescheduling: {
    label: "Customer rescheduling",
    description: "Allow customers to reschedule their appointments themselves via the reschedule link.",
    impact: "When off, both the customer-facing reschedule page and the dashboard reschedule action are disabled.",
  },
  cancellations: {
    label: "Customer cancellations",
    description: "Allow customers to cancel their appointments themselves via the cancel link.",
    impact: "When off, both the customer-facing cancel page and the dashboard cancel action are disabled.",
  },
  intakeForms: {
    label: "Intake forms",
    description: "Collect intake form responses before confirming a booking when the service has a form attached.",
    impact: "When off, intake steps are skipped at booking time and intake validation is bypassed.",
  },
  googleMeet: {
    label: "Google Meet auto-links",
    description: "Auto-generate a Google Meet link when a booking is created for a Google-Meet-enabled service.",
    impact: "When off, no Meet link is created — staff can still attach one manually.",
  },
  emailNotifications: {
    label: "Email notifications",
    description: "Send transactional booking emails — confirmations, reschedules, cancellations, and reminders.",
    impact: "When off, the communications engine skips every outbound email. Customers receive no booking emails of any kind.",
  },
  bookingBuffers: {
    label: "Booking buffers",
    description: "Honor the per-service \"buffer before\" and \"buffer after\" padding when computing availability.",
    impact: "When off, the availability engine ignores buffer minutes — back-to-back bookings become possible even when buffers are configured on a service.",
  },
  webhookDelivery: {
    label: "Outbound webhooks",
    description: "Deliver booking lifecycle events (created, cancelled, rescheduled) to your configured notification webhook URL.",
    impact: "When off, no outbound webhook POSTs are made. Your webhook receiver will stop seeing booking events until re-enabled.",
  },
};

// ─── In-process cache ──────────────────────────────────────────────────
// 60s TTL is enough that the dashboard "save → reload" loop feels live
// (loadTenantFeatures is invalidated on PUT), and the cache absorbs the
// per-request hammer when every API handler asks.
const CACHE_TTL_MS = 60_000;
type CacheEntry = { value: FeatureFlags; expiresAt: number };
const cache = new Map<string, CacheEntry>();

export function invalidateTenantFeatures(tenantId: string): void {
  cache.delete(tenantId);
}

export function _clearAllForTests(): void {
  cache.clear();
}

/**
 * Merge a partial flag set (from DB) with defaults. Unknown keys are
 * silently dropped — important: if a tenant's row contains a key we
 * removed from the union, it doesn't poison anything. Type-safety holds.
 */
export function mergeFlags(raw: unknown): FeatureFlags {
  const out: FeatureFlags = { ...DEFAULT_FEATURE_FLAGS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  for (const key of FEATURE_FLAGS) {
    const v = obj[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

/**
 * Load the resolved flag set for a tenant. Hits the DB at most once
 * per CACHE_TTL_MS per tenant; missing row → defaults.
 */
export async function loadTenantFeatures(tenantId: string): Promise<FeatureFlags> {
  const now = Date.now();
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > now) return cached.value;

  const row = await db.query.tenantFeatureSettings.findFirst({
    where: eq(tenantFeatureSettings.tenantId, tenantId),
  });
  const resolved = mergeFlags(row?.flags);
  cache.set(tenantId, { value: resolved, expiresAt: now + CACHE_TTL_MS });
  return resolved;
}

/**
 * Convenience predicate. Always re-uses the cache.
 */
export async function isFeatureEnabled(
  tenantId: string,
  flag: FeatureFlag
): Promise<boolean> {
  const flags = await loadTenantFeatures(tenantId);
  return flags[flag];
}
