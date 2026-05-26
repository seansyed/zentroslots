/**
 * Failure injectors — surgical bursts of events to test that the
 * monitoring / intelligence / activity surfaces light up correctly.
 *
 * Each injector writes a small, focused burst into the appropriate
 * table. All rows carry the seeded marker so resetSimulation()
 * removes them. The injectors target SEEDED tenants only.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  billingTransactions,
  communicationLogs,
} from "@/db/schema";

import { assertSeedingAllowed, SEEDED_BY_MARKER } from "./guards";
import { DEFAULT_SEED, makeRng } from "./rng";

async function getSeededTenantIds(): Promise<string[]> {
  const rows = (await db.execute(
    sql`SELECT id::text AS id FROM tenants WHERE onboarding_progress->>'seeded_by' = ${SEEDED_BY_MARKER}`,
  )) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export type InjectorKind =
  | "churn_spike"
  | "booking_spike"
  | "reminder_failures"
  | "oauth_failures"
  | "webhook_flood";

/** Churn spike: 3–5 subscription.cancel events in the last hour. */
export async function injectChurnSpike(): Promise<{ rows: number }> {
  assertSeedingAllowed();
  const ids = await getSeededTenantIds();
  if (ids.length === 0) return { rows: 0 };

  const rng = makeRng(DEFAULT_SEED ^ Date.now());
  const burst = rng.int(3, 5);
  let inserted = 0;
  for (let i = 0; i < burst; i++) {
    const tid = rng.pick(ids);
    const ts = new Date(Date.now() - rng.int(0, 60) * 60_000);
    try {
      await db.insert(auditLogs).values({
        tenantId: tid,
        action: "subscription.cancel.requested",
        actorLabel: "system:simulator",
        metadata: { reason: "injected" },
        createdAt: ts,
      });
      inserted++;
    } catch {}
  }
  return { rows: inserted };
}

/** Booking spike: 30–60 audit events tagged booking.created in last hour. */
export async function injectBookingSpike(): Promise<{ rows: number }> {
  assertSeedingAllowed();
  const ids = await getSeededTenantIds();
  if (ids.length === 0) return { rows: 0 };

  const rng = makeRng(DEFAULT_SEED ^ Date.now());
  const burst = rng.int(30, 60);
  let inserted = 0;
  for (let i = 0; i < burst; i++) {
    const tid = rng.pick(ids);
    const ts = new Date(Date.now() - rng.int(0, 60) * 60_000);
    try {
      await db.insert(auditLogs).values({
        tenantId: tid,
        action: "booking.created",
        actorLabel: "system:simulator",
        createdAt: ts,
      });
      inserted++;
    } catch {}
  }
  return { rows: inserted };
}

/** Reminder failure burst: 15–25 communication_logs.status='failed' in last hour. */
export async function injectReminderFailures(): Promise<{ rows: number }> {
  assertSeedingAllowed();
  const ids = await getSeededTenantIds();
  if (ids.length === 0) return { rows: 0 };

  const rng = makeRng(DEFAULT_SEED ^ Date.now());
  const burst = rng.int(15, 25);
  let inserted = 0;
  const reasons = [
    "554 Address rejected",
    "550 mailbox full",
    "rate limit exceeded",
    "address blacklisted",
  ];
  for (let i = 0; i < burst; i++) {
    const tid = rng.pick(ids);
    const ts = new Date(Date.now() - rng.int(0, 60) * 60_000);
    try {
      await db.insert(communicationLogs).values({
        tenantId: tid,
        channel: "email",
        eventType: "appointment.reminder.24h",
        status: "failed",
        provider: "ses",
        failureReason: rng.pick(reasons),
        createdAt: ts,
      });
      inserted++;
    } catch {}
  }
  return { rows: inserted };
}

/** OAuth failure burst: 5–10 google.oauth.refresh.failed audit rows. */
export async function injectOauthFailures(): Promise<{ rows: number }> {
  assertSeedingAllowed();
  const ids = await getSeededTenantIds();
  if (ids.length === 0) return { rows: 0 };

  const rng = makeRng(DEFAULT_SEED ^ Date.now());
  const burst = rng.int(5, 10);
  let inserted = 0;
  for (let i = 0; i < burst; i++) {
    const tid = rng.pick(ids);
    const provider = rng.pick(["google", "microsoft"] as const);
    const ts = new Date(Date.now() - rng.int(0, 60) * 60_000);
    try {
      await db.insert(auditLogs).values({
        tenantId: tid,
        action: `${provider}.oauth.refresh.failed`,
        actorLabel: "system:simulator",
        metadata: { reason: "invalid_grant" },
        createdAt: ts,
      });
      inserted++;
    } catch {}
  }
  return { rows: inserted };
}

/** Webhook flood: 20–40 stripe_webhook_error audit events. */
export async function injectWebhookFlood(): Promise<{ rows: number }> {
  assertSeedingAllowed();
  const ids = await getSeededTenantIds();
  if (ids.length === 0) return { rows: 0 };

  const rng = makeRng(DEFAULT_SEED ^ Date.now());
  const burst = rng.int(20, 40);
  let inserted = 0;
  for (let i = 0; i < burst; i++) {
    const tid = rng.pick(ids);
    const ts = new Date(Date.now() - rng.int(0, 60) * 60_000);
    try {
      await db.insert(auditLogs).values({
        tenantId: tid,
        action: "stripe_webhook_error",
        actorLabel: "system:simulator",
        ipAddress: `${rng.int(10, 220)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
        metadata: { reason: "invalid_signature" },
        createdAt: ts,
      });
      inserted++;
    } catch {}
  }
  return { rows: inserted };
}

export async function injectFailure(kind: InjectorKind): Promise<{ rows: number; kind: InjectorKind }> {
  let res: { rows: number };
  switch (kind) {
    case "churn_spike":
      res = await injectChurnSpike();
      break;
    case "booking_spike":
      res = await injectBookingSpike();
      break;
    case "reminder_failures":
      res = await injectReminderFailures();
      break;
    case "oauth_failures":
      res = await injectOauthFailures();
      break;
    case "webhook_flood":
      res = await injectWebhookFlood();
      break;
  }
  return { ...res, kind };
}
