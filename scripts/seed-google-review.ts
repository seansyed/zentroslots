#!/usr/bin/env tsx
/**
 * seed-google-review.ts — Dedicated reviewer account for Google Play
 * Store app review.
 *
 * Creates a single tenant + admin user with credentials Google's
 * reviewers can use to evaluate the ZentroMeet mobile app, plus
 * realistic sample data (customers, services, bookings, availability)
 * so the reviewer sees a populated workspace, not an empty shell.
 *
 * Credentials:
 *   email:    googlereview@zentromeet.com
 *   password: ZMReview2026!
 *   role:     admin
 *   tenant:   google-review
 *
 * Idempotent — safe to re-run; existing rows are preserved and the
 * password hash is re-stamped each run so the credentials never drift.
 *
 * Safety: tenant is flagged is_demo=true → lib/demo-safe.ts blocks
 * all outbound side effects (no real emails, no real Stripe charges).
 *
 * Run:
 *   ALLOW_DEV_SIMULATION=true npx tsx scripts/seed-google-review.ts
 *
 * Output:
 *   JSON to stdout summarising created rows + login URL.
 */

import "dotenv/config";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  availability,
  bookings,
  customers,
  services,
  tenants,
  users,
} from "@/db/schema";

// ─── Constants ──────────────────────────────────────────────────────

const REVIEWER_EMAIL = "googlereview@zentromeet.com";
const REVIEWER_PASSWORD = "ZMReview2026!";
const TENANT_SLUG = "google-review";
const TENANT_NAME = "ZentroMeet (Reviewer Workspace)";
const PRIMARY_COLOR = "#359df3";
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const SEED_MARKER = "google-review-v1";

// Frozen baseline so re-runs produce identical timestamps.
const NOW = new Date("2026-05-29T16:00:00.000Z");

// ─── Sample data ────────────────────────────────────────────────────

const SAMPLE_CUSTOMERS = [
  { email: "alice.thompson@example.demo", name: "Alice Thompson", phone: "+1 555 0101" },
  { email: "ben.morales@example.demo",    name: "Ben Morales",    phone: "+1 555 0102" },
  { email: "carla.singh@example.demo",    name: "Carla Singh",    phone: "+1 555 0103" },
  { email: "david.kim@example.demo",      name: "David Kim",      phone: "+1 555 0104" },
  { email: "emma.rossi@example.demo",     name: "Emma Rossi",     phone: "+1 555 0105" },
  { email: "felix.brown@example.demo",    name: "Felix Brown",    phone: "+1 555 0106" },
];

const SAMPLE_SERVICES = [
  { name: "Intro Consultation",   durationMinutes: 30, priceCents: 0 },
  { name: "Strategy Session",     durationMinutes: 60, priceCents: 15000 },
  { name: "Quarterly Review",     durationMinutes: 45, priceCents: 12500 },
  { name: "Follow-up Call",       durationMinutes: 30, priceCents: 7500 },
  { name: "Onboarding Session",   durationMinutes: 60, priceCents: 0 },
];

// ─── Helpers ────────────────────────────────────────────────────────

function daysFromNow(offsetDays: number, hour: number, minute = 0): Date {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

function endOfBooking(start: Date, durationMinutes: number): Date {
  return new Date(start.getTime() + durationMinutes * 60_000);
}

// ─── Tenant + user ──────────────────────────────────────────────────

async function upsertTenant() {
  const onboardingProgress = {
    seeded_by: SEED_MARKER,
    seeded_at: NOW.toISOString(),
    note: "Reviewer-only tenant. is_demo=true gates outbound side effects.",
  };

  try {
    const [row] = await db
      .insert(tenants)
      .values({
        name: TENANT_NAME,
        slug: TENANT_SLUG,
        plan: "pro",
        currentPlan: "pro",
        active: true,
        isDemo: true,
        primaryColor: PRIMARY_COLOR,
        tagline: "Reviewer workspace — populated demo for app review.",
        description: "Sample tenant used exclusively by app-store reviewers.",
        billingEmail: `billing@${TENANT_SLUG}.zentromeet.demo`,
        subscriptionStatus: "active",
        onboardingCompletedAt: new Date(NOW.getTime() - 7 * 24 * 60 * 60_000),
        onboardingStartedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
        onboardingProgress,
        createdAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
        updatedAt: NOW,
      })
      .returning();
    return row;
  } catch {
    const existing = await db.query.tenants.findFirst({ where: eq(tenants.slug, TENANT_SLUG) });
    if (!existing) throw new Error(`tenant upsert failed for slug=${TENANT_SLUG}`);
    await db
      .update(tenants)
      .set({ isDemo: true, onboardingProgress, updatedAt: NOW })
      .where(eq(tenants.id, existing.id));
    return existing;
  }
}

async function upsertReviewerUser(tenantId: string) {
  const passwordHash = bcrypt.hashSync(REVIEWER_PASSWORD, 10);
  try {
    const [row] = await db
      .insert(users)
      .values({
        tenantId,
        email: REVIEWER_EMAIL,
        passwordHash,
        role: "admin",
        name: "Google Reviewer",
        timezone: DEFAULT_TIMEZONE,
        publicDisplayName: "Google Reviewer",
        publicTitle: "Workspace Admin",
        createdAt: NOW,
      })
      .returning();
    return row;
  } catch {
    const existing = await db.query.users.findFirst({ where: eq(users.email, REVIEWER_EMAIL) });
    if (!existing) throw new Error(`user upsert failed for email=${REVIEWER_EMAIL}`);
    await db
      .update(users)
      .set({
        passwordHash,
        tenantId,
        role: "admin",
        name: "Google Reviewer",
        publicDisplayName: "Google Reviewer",
        publicTitle: "Workspace Admin",
      })
      .where(eq(users.id, existing.id));
    return { ...existing, passwordHash, tenantId };
  }
}

// ─── Services + availability + customers + bookings ────────────────

async function upsertServices(tenantId: string, staffUserId: string) {
  const created: { id: string; name: string; durationMinutes: number }[] = [];
  for (const s of SAMPLE_SERVICES) {
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    try {
      const [row] = await db
        .insert(services)
        .values({
          tenantId,
          name: s.name,
          slug,
          durationMinutes: s.durationMinutes,
          priceCents: s.priceCents,
          active: true,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .returning();
      created.push({ id: row.id, name: row.name, durationMinutes: row.durationMinutes });
    } catch {
      const existing = await db.query.services.findFirst({
        where: and(eq(services.tenantId, tenantId), eq(services.slug, slug)),
      });
      if (existing) {
        created.push({
          id: existing.id,
          name: existing.name,
          durationMinutes: existing.durationMinutes,
        });
      }
    }
  }
  // Reference staff so TypeScript doesn't flag the var as unused — actual
  // service↔staff binding is handled by the service_staff join table which
  // this minimal seeder skips (services default to "any staff" in the UI).
  void staffUserId;
  return created;
}

async function upsertAvailability(tenantId: string, userId: string) {
  let count = 0;
  // Mon-Fri, 9am-5pm
  for (let dow = 1; dow <= 5; dow++) {
    try {
      await db.insert(availability).values({
        tenantId,
        userId,
        dayOfWeek: dow,
        startTime: "09:00",
        endTime: "17:00",
        createdAt: NOW,
      });
      count++;
    } catch {
      /* duplicate — skip */
    }
  }
  return count;
}

async function upsertCustomers(tenantId: string) {
  const created: { id: string; email: string; name: string }[] = [];
  for (const c of SAMPLE_CUSTOMERS) {
    try {
      const [row] = await db
        .insert(customers)
        .values({
          tenantId,
          email: c.email,
          name: c.name,
          phone: c.phone,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .returning();
      created.push({ id: row.id, email: row.email, name: row.name });
    } catch {
      const existing = await db.query.customers.findFirst({
        where: and(eq(customers.tenantId, tenantId), eq(customers.email, c.email)),
      });
      if (existing) created.push({ id: existing.id, email: existing.email, name: existing.name });
    }
  }
  return created;
}

async function seedBookings(
  tenantId: string,
  staffUserId: string,
  serviceList: { id: string; name: string; durationMinutes: number }[],
  customerList: { id: string; email: string; name: string }[],
) {
  let created = 0;
  // Past: 12 completed bookings spread across the last 14 weekdays.
  // Future: 8 confirmed bookings spread across the next 10 weekdays.
  const plans: Array<{
    offset: number;
    hour: number;
    serviceIdx: number;
    customerIdx: number;
    status: "completed" | "confirmed";
  }> = [];

  let countPast = 0;
  for (let d = -14; d < 0 && countPast < 12; d++) {
    const dow = (NOW.getUTCDay() + d + 7000) % 7;
    if (dow === 0 || dow === 6) continue;
    const hour = 10 + (countPast % 4) * 2;
    plans.push({
      offset: d,
      hour,
      serviceIdx: countPast % serviceList.length,
      customerIdx: countPast % customerList.length,
      status: "completed",
    });
    countPast++;
  }

  let countFuture = 0;
  for (let d = 0; d <= 14 && countFuture < 8; d++) {
    const dow = (NOW.getUTCDay() + d + 7000) % 7;
    if (dow === 0 || dow === 6) continue;
    const hour = 11 + (countFuture % 3) * 2;
    plans.push({
      offset: d,
      hour,
      serviceIdx: countFuture % serviceList.length,
      customerIdx: countFuture % customerList.length,
      status: "confirmed",
    });
    countFuture++;
  }

  for (const p of plans) {
    const svc = serviceList[p.serviceIdx];
    const cust = customerList[p.customerIdx];
    if (!svc || !cust) continue;
    const start = daysFromNow(p.offset, p.hour, 0);
    const end = endOfBooking(start, svc.durationMinutes);
    try {
      await db.insert(bookings).values({
        tenantId,
        serviceId: svc.id,
        staffUserId,
        customerId: cust.id,
        customerEmail: cust.email,
        customerName: cust.name,
        startsAt: start,
        endsAt: end,
        status: p.status,
        durationMinutes: svc.durationMinutes,
        createdAt: NOW,
        updatedAt: NOW,
      });
      created++;
    } catch (err) {
      // Likely overlap or duplicate — skip silently
      void err;
    }
  }
  return created;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log("[seed-google-review] starting");
  const tenant = await upsertTenant();
  console.log(`  ✓ tenant: ${tenant.slug} (${tenant.id})`);

  const user = await upsertReviewerUser(tenant.id);
  console.log(`  ✓ user:   ${user.email} (${user.id})`);

  const availCount = await upsertAvailability(tenant.id, user.id);
  console.log(`  ✓ availability rows: ${availCount}`);

  const svcs = await upsertServices(tenant.id, user.id);
  console.log(`  ✓ services: ${svcs.length}`);

  const custs = await upsertCustomers(tenant.id);
  console.log(`  ✓ customers: ${custs.length}`);

  const bookingCount = await seedBookings(tenant.id, user.id, svcs, custs);
  console.log(`  ✓ bookings: ${bookingCount}`);

  console.log("");
  console.log("=== REVIEWER CREDENTIALS ===");
  console.log(JSON.stringify(
    {
      loginUrl: "https://app.zentromeet.com/login",
      email: REVIEWER_EMAIL,
      password: REVIEWER_PASSWORD,
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      sampleData: {
        services: svcs.length,
        customers: custs.length,
        bookings: bookingCount,
        availabilityRows: availCount,
      },
    },
    null,
    2,
  ));
  console.log("============================");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[seed-google-review] FAILED:", err);
    process.exit(1);
  });
