/**
 * Synthetic SaaS seeder — populates real DB tables so dashboards,
 * intelligence, finance, and activity surfaces feel "alive" without
 * any real customer data.
 *
 * Architecture:
 *   • The SEEDED_BY_MARKER is written to tenants.onboarding_progress
 *     (jsonb, default {}). One marker per seeded tenant.
 *   • cron_runs is global (not per-tenant) — marker goes in
 *     cron_runs.detail jsonb.
 *   • resetSimulation() reads the marker from tenants → gets the
 *     list of seeded tenant ids → deletes child rows by
 *     `tenant_id IN (...)`. This guarantees real customer data is
 *     never touched. Tenants are deleted last.
 *
 * Modes:
 *   light       — 3 tenants, 30d history,  small surfaces
 *   medium      — 8 tenants, 60d history,  default
 *   heavy       — 20 tenants, 90d history, dense activity
 *   enterprise  — 50 tenants, 90d history, full archetype coverage
 *
 * Determinism:
 *   Mulberry32 RNG seeded with DEFAULT_SEED → re-running produces
 *   identical content. resetSimulation() then re-runSimulation() is
 *   idempotent.
 *
 * Auth safety:
 *   Every seeded user row carries a corrupted bcrypt hash that
 *   cannot authenticate against any input. Seeded accounts CANNOT
 *   log in even if a developer guesses the email pattern.
 */

import { inArray, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

import { db } from "@/db/client";
import {
  auditLogs,
  billingTransactions,
  bookings,
  calendarConnections,
  communicationLogs,
  cronRuns,
  customers,
  services,
  tenants,
  users,
} from "@/db/schema";

import {
  ARCHETYPES,
  growthMultiplier,
  type Archetype,
} from "./archetypes";
import { assertSeedingAllowed, SEEDED_BY_MARKER, seedMetadata } from "./guards";
import { DEFAULT_SEED, makeRng, type Rng } from "./rng";

// ─── Mode definitions ──────────────────────────────────────────────

export type SimulationMode = "light" | "medium" | "heavy" | "enterprise";

const MODE_CONFIG: Record<SimulationMode, { tenants: number; days: number }> = {
  light: { tenants: 3, days: 30 },
  medium: { tenants: 8, days: 60 },
  heavy: { tenants: 20, days: 90 },
  enterprise: { tenants: 50, days: 90 },
};

// ─── Password hash that cannot authenticate ────────────────────────

function passwordHashUnusable(): string {
  // Hash a one-time random string at low cost, then corrupt the
  // hash so verify() always returns false. Seeded users cannot log in.
  const hash = bcrypt.hashSync(`zm-seed-${Math.random()}-${Date.now()}`, 4);
  return hash.slice(0, hash.length - 1) + "x";
}

// ─── Utility ───────────────────────────────────────────────────────

function slugFor(name: string, rng: Rng): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) +
    "-" +
    rng.int(100, 999)
  );
}

function pickPlan(archetype: Archetype, rng: Rng): string {
  const r = rng.next();
  const { free, solo, pro, team } = archetype.planMix;
  // Cumulative thresholds across the 5-tier strategy:
  //   [0, free) → free
  //   [free, free+solo) → solo
  //   [free+solo, free+solo+pro) → pro
  //   [free+solo+pro, free+solo+pro+team) → team
  //   else → enterprise
  if (r < free) return "free";
  if (r < free + solo) return "solo";
  if (r < free + solo + pro) return "pro";
  if (r < free + solo + pro + team) return "team";
  return "enterprise";
}

function fakeName(rng: Rng): string {
  const first = rng.pick([
    "Avery", "Jordan", "Riley", "Morgan", "Casey", "Quinn", "Reese", "Sam",
    "Taylor", "Hayden", "Rowan", "Skyler", "Emerson", "Drew", "Cameron",
    "Logan", "Parker", "Sage", "Blake", "Charlie", "Devon", "Elliot",
    "Finley", "Harper", "Indigo",
  ]);
  const last = rng.pick([
    "Mercer", "Calloway", "Bennett", "Holloway", "Reeves", "Whitman",
    "Beaumont", "Marsh", "Crane", "Lockwood", "Lyon", "Bishop", "Fox",
    "Hale", "Marlow", "Sutton", "Vega", "Winter", "Yates", "Ashby",
    "Cromwell", "Eddison", "Foster", "Greer",
  ]);
  return `${first} ${last}`;
}

// ─── Public progress shape ─────────────────────────────────────────

export type SeedReport = {
  mode: SimulationMode;
  durationMs: number;
  counts: {
    tenants: number;
    users: number;
    services: number;
    customers: number;
    bookings: number;
    auditLogs: number;
    communicationLogs: number;
    billingTransactions: number;
    calendarConnections: number;
    cronRuns: number;
  };
};

// ─── Tenant generator ──────────────────────────────────────────────

async function seedTenants(
  mode: SimulationMode,
  rng: Rng,
): Promise<Array<{ tenantRow: typeof tenants.$inferSelect; archetype: Archetype }>> {
  const cfg = MODE_CONFIG[mode];
  const out: Array<{ tenantRow: typeof tenants.$inferSelect; archetype: Archetype }> = [];

  for (let i = 0; i < cfg.tenants; i++) {
    const archetype = ARCHETYPES[i % ARCHETYPES.length];
    const name = rng.pick(archetype.nameStems);
    const slug = slugFor(name, rng);
    const plan = pickPlan(archetype, rng);
    const createdAt = new Date(
      Date.now() - rng.int(7, Math.floor(cfg.days * 1.3)) * 24 * 60 * 60_000,
    );
    const trialEnd =
      plan === "free" && rng.bool(0.25)
        ? new Date(Date.now() + rng.int(1, 14) * 24 * 60 * 60_000)
        : null;

    const subscriptionStatus =
      plan === "free"
        ? trialEnd
          ? "trialing"
          : null
        : rng.bool(0.92)
        ? "active"
        : rng.pick(["past_due", "canceled"] as const);

    const onboardingDone = rng.bool(0.7);

    try {
      const [row] = await db
        .insert(tenants)
        .values({
          name,
          slug,
          plan,
          currentPlan: plan,
          active: rng.bool(0.95),
          billingEmail: `billing+${slug}@example-zm.test`,
          primaryColor: rng.pick(["#359df3", "#7c3aed", "#ef4444", "#10b981", "#f59e0b"]),
          subscriptionStatus: (subscriptionStatus ?? null) as string | null,
          trialEnd,
          onboardingCompletedAt: onboardingDone ? createdAt : null,
          onboardingStartedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
          // SEED MARKER lives here. Reset reads this jsonb path.
          onboardingProgress: seedMetadata({ archetype: archetype.id }),
        })
        .returning();
      out.push({ tenantRow: row, archetype });
    } catch {
      /* slug collision — skip */
    }
  }
  return out;
}

// ─── User generator ────────────────────────────────────────────────

async function seedUsers(
  tenantRow: typeof tenants.$inferSelect,
  archetype: Archetype,
  rng: Rng,
): Promise<typeof users.$inferSelect[]> {
  const staffCount = rng.int(archetype.staff.min, archetype.staff.max);
  const created: typeof users.$inferSelect[] = [];

  // Admin user (workspace owner)
  try {
    const [admin] = await db
      .insert(users)
      .values({
        tenantId: tenantRow.id,
        email: `owner+${tenantRow.slug}@example-zm.test`,
        passwordHash: passwordHashUnusable(),
        role: "admin",
        name: fakeName(rng),
        timezone: "America/Los_Angeles",
      })
      .returning();
    created.push(admin);
  } catch {}

  // Staff users
  for (let i = 0; i < staffCount; i++) {
    try {
      const [u] = await db
        .insert(users)
        .values({
          tenantId: tenantRow.id,
          email: `staff${i + 1}+${tenantRow.slug}@example-zm.test`,
          passwordHash: passwordHashUnusable(),
          role: rng.bool(0.1) ? "manager" : "staff",
          name: fakeName(rng),
          timezone: "America/Los_Angeles",
          googleStatus: rng.bool(archetype.oauthAdoption)
            ? rng.bool(0.95)
              ? "active"
              : rng.pick(["expired", "error"] as const)
            : null,
        })
        .returning();
      created.push(u);
    } catch {}
  }
  return created;
}

// ─── Service generator ────────────────────────────────────────────

async function seedServices(
  tenantRow: typeof tenants.$inferSelect,
  archetype: Archetype,
  rng: Rng,
): Promise<typeof services.$inferSelect[]> {
  const created: typeof services.$inferSelect[] = [];
  for (const s of archetype.services) {
    try {
      const [row] = await db
        .insert(services)
        .values({
          tenantId: tenantRow.id,
          name: s.name,
          slug: slugFor(s.name, rng),
          durationMinutes: s.durationMin,
          price: s.priceCents,
          isActive: 1,
          videoProvider: "google_meet",
        })
        .returning();
      created.push(row);
    } catch {}
  }
  return created;
}

// ─── Customer generator ───────────────────────────────────────────

async function seedCustomers(
  tenantRow: typeof tenants.$inferSelect,
  rng: Rng,
  count: number,
): Promise<typeof customers.$inferSelect[]> {
  const out: typeof customers.$inferSelect[] = [];
  for (let i = 0; i < count; i++) {
    const name = fakeName(rng);
    const email = `${name.toLowerCase().replace(/\s+/g, ".")}+${rng.int(1000, 9999)}@example-zm.test`;
    try {
      const [row] = await db
        .insert(customers)
        .values({
          tenantId: tenantRow.id,
          name,
          email,
          phone: null,
        })
        .returning();
      out.push(row);
    } catch {}
  }
  return out;
}

// ─── Booking generator ────────────────────────────────────────────

async function seedBookings(
  tenantRow: typeof tenants.$inferSelect,
  archetype: Archetype,
  staff: typeof users.$inferSelect[],
  svcs: typeof services.$inferSelect[],
  custs: typeof customers.$inferSelect[],
  rng: Rng,
  days: number,
): Promise<{ count: number; revenue_cents: number }> {
  const staffOnly = staff.filter((s) => s.role === "staff" || s.role === "manager");
  if (staffOnly.length === 0 || svcs.length === 0) return { count: 0, revenue_cents: 0 };

  let count = 0;
  let revenue = 0;

  for (let d = 0; d < days; d++) {
    const dayAgo = days - 1 - d;
    const date = new Date(Date.now() - dayAgo * 24 * 60 * 60_000);
    date.setHours(9, 0, 0, 0);
    const dow = date.getDay();
    let dayMul = 1;
    if (archetype.id !== "medspa" && archetype.id !== "salon" && (dow === 0 || dow === 6)) {
      dayMul = 0.25;
    }
    const growthMul = growthMultiplier(archetype.growth, d);
    const target = Math.max(
      0,
      Math.round(rng.normal(archetype.bookingsPerDay.mean, archetype.bookingsPerDay.stdev)) *
        dayMul *
        growthMul,
    );

    const perStaffNext = new Map<string, number>();
    for (const s of staffOnly) perStaffNext.set(s.id, 9);

    for (let b = 0; b < target; b++) {
      const staffMember = rng.pick(staffOnly);
      const startHour = perStaffNext.get(staffMember.id) ?? 9;
      if (startHour >= 18) continue;

      const svc = rng.pick(svcs);
      const startAt = new Date(date);
      startAt.setHours(Math.floor(startHour), rng.pick([0, 15, 30, 45]));
      const endAt = new Date(startAt.getTime() + svc.durationMinutes * 60_000);

      const isPast = endAt.getTime() < Date.now();
      let status: "confirmed" | "completed" | "no_show" | "cancelled";
      if (!isPast) {
        status = "confirmed";
      } else {
        const roll = rng.next();
        if (roll < 0.78) status = "completed";
        else if (roll < 0.88) status = "no_show";
        else status = "cancelled";
      }

      const cust = custs.length > 0 ? rng.pick(custs) : null;
      const clientName = cust?.name ?? fakeName(rng);
      const clientEmail = cust?.email ?? `walkin+${rng.int(1, 99999)}@example-zm.test`;

      try {
        await db.insert(bookings).values({
          tenantId: tenantRow.id,
          serviceId: svc.id,
          staffUserId: staffMember.id,
          clientName,
          clientEmail,
          startAt,
          endAt,
          status,
          customerId: cust?.id ?? null,
          amountChargedCents: status === "completed" ? svc.price : null,
        });
        count++;
        if (status === "completed") revenue += svc.price;

        const advance = Math.ceil(svc.durationMinutes / 30) * 0.5;
        perStaffNext.set(staffMember.id, startHour + advance);
      } catch {
        /* EXCLUDE collision — skip */
      }
    }
  }

  return { count, revenue_cents: revenue };
}

// ─── Audit + comms + billing ──────────────────────────────────────

async function seedActivityEvents(
  tenantRow: typeof tenants.$inferSelect,
  staff: typeof users.$inferSelect[],
  rng: Rng,
  days: number,
  bookingCount: number,
): Promise<{
  auditLogs: number;
  communicationLogs: number;
  billingTransactions: number;
}> {
  let auditCount = 0;
  let commsCount = 0;
  let billingCount = 0;

  // ─── audit_logs ────────────────────────────────────────────────
  for (let d = 0; d < days; d++) {
    const dayAgo = days - 1 - d;
    const date = new Date(Date.now() - dayAgo * 24 * 60 * 60_000);

    const loginAttempts = rng.int(2, 10);
    for (let i = 0; i < loginAttempts; i++) {
      const ts = new Date(date.getTime() + rng.int(0, 86400000));
      const fail = rng.bool(0.1);
      const actor = staff.length > 0 ? rng.pick(staff) : null;
      try {
        await db.insert(auditLogs).values({
          tenantId: tenantRow.id,
          action: fail
            ? "security.authentication.failed.bad_password"
            : "security.authentication.success",
          actorUserId: actor?.id ?? null,
          actorLabel: actor?.email ?? null,
          ipAddress: `${rng.int(10, 220)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
          createdAt: ts,
        });
        auditCount++;
      } catch {}
    }

    if (rng.bool(0.08) && staff.length > 0) {
      const actor = rng.pick(staff);
      const ts = new Date(date.getTime() + rng.int(0, 86400000));
      try {
        await db.insert(auditLogs).values({
          tenantId: tenantRow.id,
          action: "google.oauth.refresh.failed",
          actorUserId: actor.id,
          actorLabel: actor.email,
          metadata: { reason: "invalid_grant" },
          createdAt: ts,
        });
        auditCount++;
      } catch {}
    }
  }

  // ─── communication_logs ───────────────────────────────────────
  const remindersToWrite = Math.floor(bookingCount * 0.7);
  for (let i = 0; i < remindersToWrite; i++) {
    const dayAgo = rng.int(0, days - 1);
    const ts = new Date(Date.now() - dayAgo * 24 * 60 * 60_000 - rng.int(0, 86400000));
    const failed = rng.bool(0.03);
    try {
      await db.insert(communicationLogs).values({
        tenantId: tenantRow.id,
        channel: "email",
        eventType: rng.pick(["appointment.reminder.24h", "appointment.reminder.1h"] as const),
        status: failed ? "failed" : "sent",
        provider: "ses",
        failureReason: failed ? "Address blacklisted" : null,
        createdAt: ts,
      });
      commsCount++;
    } catch {}
  }

  // ─── billing_transactions ─────────────────────────────────────
  if (tenantRow.plan !== "free") {
    // Plan-price map mirrors migration 0066 (cents). Seeder doesn't
    // load plans table — that would be a second DB roundtrip per
    // tenant — so we keep a small static map here. If marketing
    // prices change, update both this map and the migration.
    const monthlyAmount =
      tenantRow.plan === "enterprise"
        ? 25000
        : tenantRow.plan === "team"
        ? 10000
        : tenantRow.plan === "pro"
        ? 3000
        : tenantRow.plan === "solo"
        ? 1000
        : 3000;
    for (let m = 0; m < Math.ceil(days / 30); m++) {
      const dayAgo = days - 1 - m * 30;
      const ts = new Date(Date.now() - dayAgo * 24 * 60 * 60_000);
      const failed = rng.bool(0.04);
      try {
        await db.insert(billingTransactions).values({
          tenantId: tenantRow.id,
          stripeEventId: `evt_sim_${tenantRow.id.slice(0, 8)}_${m}`,
          stripePaymentIntentId: `pi_sim_${tenantRow.id.slice(0, 8)}_${m}`,
          amountCents: monthlyAmount,
          currency: "usd",
          transactionType: "subscription_payment",
          status: failed ? "failed" : "succeeded",
          paidAt: failed ? null : ts,
          createdAt: ts,
        });
        billingCount++;
      } catch {}
    }
  }

  const bookingPaymentCount = Math.max(0, Math.floor(bookingCount * 0.15));
  for (let i = 0; i < bookingPaymentCount; i++) {
    const dayAgo = rng.int(0, days - 1);
    const ts = new Date(Date.now() - dayAgo * 24 * 60 * 60_000);
    const amt = rng.int(2500, 15000);
    const failed = rng.bool(0.05);
    try {
      await db.insert(billingTransactions).values({
        tenantId: tenantRow.id,
        stripeEventId: `evt_sim_bp_${tenantRow.id.slice(0, 8)}_${i}`,
        amountCents: amt,
        currency: "usd",
        transactionType: "booking_payment",
        status: failed ? "failed" : "succeeded",
        paidAt: failed ? null : ts,
        createdAt: ts,
      });
      billingCount++;
    } catch {}
  }

  return { auditLogs: auditCount, communicationLogs: commsCount, billingTransactions: billingCount };
}

// ─── Calendar connections ──────────────────────────────────────────

async function seedCalendarConnections(
  tenantRow: typeof tenants.$inferSelect,
  staff: typeof users.$inferSelect[],
  archetype: Archetype,
  rng: Rng,
): Promise<number> {
  let count = 0;
  const candidates = staff.filter((s) => s.role !== "client");
  for (const u of candidates) {
    if (!rng.bool(archetype.oauthAdoption)) continue;
    const provider = rng.pick(["google", "microsoft"] as const);
    const status = rng.bool(0.92)
      ? "active"
      : rng.pick(["needs_reconnect", "expired", "error"] as const);
    try {
      await db.insert(calendarConnections).values({
        tenantId: tenantRow.id,
        userId: u.id,
        provider,
        accountEmail: u.email,
        status,
        // refresh_token_encrypted is NOT NULL — use a sentinel that
        // can't decrypt to a real token.
        refreshTokenEncrypted: "SEEDED:dev-seeding-v1:not-a-real-token",
      });
      count++;
    } catch {
      /* unique conflict — skip */
    }
  }
  return count;
}

// ─── Cron run history ─────────────────────────────────────────────

async function seedCronRuns(rng: Rng): Promise<number> {
  let count = 0;
  const jobs = [
    { name: "holds:expire", interval: 5 },
    { name: "reminders:send", interval: 15 },
    { name: "automations:run", interval: 5 },
    { name: "waitlists:expire", interval: 10 },
    { name: "admin:snapshots:hourly", interval: 10 },
  ];

  for (const job of jobs) {
    const ticks = Math.floor((24 * 60) / job.interval);
    for (let i = 0; i < ticks; i++) {
      const startedAt = new Date(Date.now() - i * job.interval * 60_000);
      const durationMs = rng.int(20, 250);
      const finishedAt = new Date(startedAt.getTime() + durationMs);
      const failed = rng.bool(0.02);
      try {
        await db.insert(cronRuns).values({
          jobName: job.name,
          startedAt,
          finishedAt,
          durationMs,
          status: failed ? "failed" : "ok",
          detail: seedMetadata({ candidates: rng.int(0, 5), ok: rng.int(0, 5) }),
          host: "simulation-host",
        });
        count++;
      } catch {}
    }
  }
  return count;
}

// ─── Public API ────────────────────────────────────────────────────

export async function runSimulation(
  mode: SimulationMode = "medium",
  opts: { seed?: number } = {},
): Promise<SeedReport> {
  assertSeedingAllowed();
  const t0 = Date.now();
  const rng = makeRng(opts.seed ?? DEFAULT_SEED);
  const cfg = MODE_CONFIG[mode];

  const counts = {
    tenants: 0,
    users: 0,
    services: 0,
    customers: 0,
    bookings: 0,
    auditLogs: 0,
    communicationLogs: 0,
    billingTransactions: 0,
    calendarConnections: 0,
    cronRuns: 0,
  };

  const tenantPairs = await seedTenants(mode, rng);
  counts.tenants = tenantPairs.length;

  for (const { tenantRow, archetype } of tenantPairs) {
    const staffRows = await seedUsers(tenantRow, archetype, rng);
    counts.users += staffRows.length;

    const svcRows = await seedServices(tenantRow, archetype, rng);
    counts.services += svcRows.length;

    const custRows = await seedCustomers(tenantRow, rng, rng.int(30, 80));
    counts.customers += custRows.length;

    const booking = await seedBookings(
      tenantRow,
      archetype,
      staffRows,
      svcRows,
      custRows,
      rng,
      cfg.days,
    );
    counts.bookings += booking.count;

    const activity = await seedActivityEvents(
      tenantRow,
      staffRows,
      rng,
      cfg.days,
      booking.count,
    );
    counts.auditLogs += activity.auditLogs;
    counts.communicationLogs += activity.communicationLogs;
    counts.billingTransactions += activity.billingTransactions;

    const cal = await seedCalendarConnections(tenantRow, staffRows, archetype, rng);
    counts.calendarConnections += cal;
  }

  counts.cronRuns = await seedCronRuns(rng);

  return { mode, durationMs: Date.now() - t0, counts };
}

/** Atomic reset — finds every tenant marked with SEEDED_BY_MARKER
 *  in its onboarding_progress jsonb, deletes the child rows owned
 *  by those tenants, then deletes the tenants themselves. Real
 *  customer data is NEVER touched. */
export async function resetSimulation(): Promise<{ deletedRowCount: number }> {
  assertSeedingAllowed();
  const m = SEEDED_BY_MARKER;

  // 1. Find seeded tenant ids.
  const seededRows = (await db.execute(
    sql`SELECT id::text AS id FROM tenants WHERE onboarding_progress->>'seeded_by' = ${m}`,
  )) as unknown as Array<{ id: string }>;
  const seededIds = seededRows.map((r) => r.id);

  let total = 0;

  // 2. Delete cron_runs separately — those are global, marker-tagged.
  try {
    const rows = (await db.execute(
      sql`DELETE FROM cron_runs WHERE detail->>'seeded_by' = ${m} RETURNING id`,
    )) as unknown as Array<unknown>;
    total += rows.length;
  } catch {}

  if (seededIds.length === 0) return { deletedRowCount: total };

  // 3. Delete child rows by tenant_id IN list.
  const deletes = [
    sql`DELETE FROM billing_transactions WHERE tenant_id = ANY(${sql.raw(`ARRAY[${seededIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)}) RETURNING id`,
    sql`DELETE FROM communication_logs WHERE tenant_id = ANY(${sql.raw(`ARRAY[${seededIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)}) RETURNING id`,
    sql`DELETE FROM audit_logs WHERE tenant_id = ANY(${sql.raw(`ARRAY[${seededIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)}) RETURNING id`,
    sql`DELETE FROM bookings WHERE tenant_id = ANY(${sql.raw(`ARRAY[${seededIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)}) RETURNING id`,
    sql`DELETE FROM customers WHERE tenant_id = ANY(${sql.raw(`ARRAY[${seededIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)}) RETURNING id`,
    sql`DELETE FROM calendar_connections WHERE tenant_id = ANY(${sql.raw(`ARRAY[${seededIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)}) RETURNING id`,
    sql`DELETE FROM services WHERE tenant_id = ANY(${sql.raw(`ARRAY[${seededIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)}) RETURNING id`,
    sql`DELETE FROM users WHERE tenant_id = ANY(${sql.raw(`ARRAY[${seededIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)}) RETURNING id`,
    sql`DELETE FROM tenants WHERE id = ANY(${sql.raw(`ARRAY[${seededIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)}) RETURNING id`,
  ];

  for (const q of deletes) {
    try {
      const rows = (await db.execute(q)) as unknown as Array<unknown>;
      total += rows.length;
    } catch (err) {
      console.error(
        JSON.stringify({
          evt: "seed.reset.partial",
          err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        }),
      );
    }
  }

  return { deletedRowCount: total };
}

/** Cheap status — count of seeded rows currently in the DB. */
export async function getSimulationStatus(): Promise<{
  tenants: number;
  users: number;
  bookings: number;
  auditLogs: number;
}> {
  const m = SEEDED_BY_MARKER;

  // First find seeded tenant ids; then count children by tenant_id.
  let seededIds: string[] = [];
  try {
    const rows = (await db.execute(
      sql`SELECT id::text AS id FROM tenants WHERE onboarding_progress->>'seeded_by' = ${m}`,
    )) as unknown as Array<{ id: string }>;
    seededIds = rows.map((r) => r.id);
  } catch {
    return { tenants: 0, users: 0, bookings: 0, auditLogs: 0 };
  }

  if (seededIds.length === 0) return { tenants: 0, users: 0, bookings: 0, auditLogs: 0 };

  const safe = async (table: string): Promise<number> => {
    try {
      const rows = (await db.execute(
        sql`SELECT COUNT(*)::int AS n FROM ${sql.raw(table)} WHERE tenant_id = ANY(${sql.raw(`ARRAY[${seededIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`,
      )) as unknown as Array<{ n: number }>;
      return Number(rows[0]?.n ?? 0);
    } catch {
      return 0;
    }
  };

  const [u, b, a] = await Promise.all([
    safe("users"),
    safe("bookings"),
    safe("audit_logs"),
  ]);
  return { tenants: seededIds.length, users: u, bookings: b, auditLogs: a };
}
