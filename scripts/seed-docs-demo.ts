#!/usr/bin/env tsx
/**
 * seed-docs-demo.ts — Permanent ZentroMeet Demo Workspace seeder.
 *
 * Builds the documentation / screenshot / KB / onboarding-intelligence
 * demo environment. Idempotent: safe to re-run; existing demo rows are
 * preserved (writes use ON CONFLICT DO NOTHING / DO UPDATE patterns).
 *
 * Five tenants representing different onboarding states so screenshot
 * automation has visual variety without cross-tenant data leakage:
 *
 *   1. docs-demo          — fully configured, primary screenshot target
 *   2. docs-demo-partial  — half-configured (no Stripe, partial branding)
 *   3. docs-demo-new      — empty wizard state (just signed up)
 *   4. docs-demo-stalled  — onboarding started 14 days ago, no progress
 *   5. docs-demo-ent      — enterprise plan, fully configured, scale demo
 *
 * Safety:
 *   • Every tenant is flagged is_demo=true → lib/demo-safe.ts blocks
 *     all outbound side effects (email/push/calendar/Stripe).
 *   • Marker "docs-demo-v1" stored in tenants.onboarding_progress
 *     under "seeded_by" — reset-docs-demo.ts uses this as the WHERE
 *     clause; existing dev-seeding marker ("dev-seeding-v1") is
 *     ignored so the simulation reset never wipes this workspace.
 *   • Deterministic seed date FROZEN_NOW so timestamps don't shift
 *     between runs. Screenshots stay byte-identical.
 *   • Demo users get real passwords (gated by is_demo) so screenshot
 *     automation can authenticate. Password: DemoZentro2026!
 *
 * Usage:
 *   ALLOW_DEV_SIMULATION=true npm run docs-demo:seed
 *
 * Output:
 *   JSON report to stdout — credentials, URLs, entity counts. Pipe
 *   to docs/operations/demo-tenant-credentials.json for record.
 */

import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  analyticsDailySnapshots,
  auditLogs,
  availability,
  bookings,
  customers,
  departments,
  services,
  serviceStaff,
  tenants,
  users,
} from "@/db/schema";

// ─── Constants ─────────────────────────────────────────────────────

/** Marker stored in tenants.onboarding_progress->'seeded_by'.
 *  Distinct from "dev-seeding-v1" so the chaos simulation reset
 *  doesn't wipe the permanent docs demo. */
const DOCS_DEMO_MARKER = "docs-demo-v1" as const;

/** Frozen "now" — every timestamp is anchored to this so the demo
 *  tenants look identical across re-runs. Screenshots can be cached. */
const FROZEN_NOW = new Date("2026-05-15T16:00:00.000Z");

/** Password every demo user is seeded with. Gated by is_demo so this
 *  bcrypt hash only exists on demo tenants. */
const DEMO_PASSWORD = "DemoZentro2026!" as const;

const PRIMARY_COLOR = "#359df3" as const;

// ─── Helpers ───────────────────────────────────────────────────────

const DEFAULT_TIMEZONE = "America/Los_Angeles";

let cachedHash: string | null = null;
function demoPasswordHash(): string {
  if (cachedHash) return cachedHash;
  cachedHash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  return cachedHash;
}

function daysFromFrozen(daysOffset: number, hour = 9, minute = 0): Date {
  const d = new Date(FROZEN_NOW);
  d.setUTCDate(d.getUTCDate() + daysOffset);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function seedMetadata(extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    seeded_by: DOCS_DEMO_MARKER,
    seeded_at: FROZEN_NOW.toISOString(),
    note: "Permanent docs-demo tenant. is_demo=true gates all outbound side effects.",
  };
}

// ─── Tenant definitions ────────────────────────────────────────────

type TenantSpec = {
  slug: string;
  name: string;
  plan: "free" | "solo" | "pro" | "team" | "enterprise";
  tagline: string;
  description: string;
  /** "complete" = fully onboarded; "partial" = some tasks done;
   *  "new" = wizard never opened; "stalled" = started long ago. */
  onboardingState: "complete" | "partial" | "new" | "stalled";
  /** Department + service catalog richness — primary gets full set;
   *  others get smaller slices for state variety. */
  richness: "full" | "minimal" | "empty";
};

const TENANT_SPECS: TenantSpec[] = [
  {
    slug: "docs-demo",
    name: "ZentroMeet Demo Workspace",
    plan: "pro",
    tagline: "The fully-configured demo workspace for screenshots, KB, and onboarding tutorials.",
    description:
      "Permanent enterprise-grade demo environment. Used by automated screenshot capture, " +
      "documentation generation, and contextual help systems.",
    onboardingState: "complete",
    richness: "full",
  },
  {
    slug: "docs-demo-partial",
    name: "Northwind Tax & Advisory",
    plan: "solo",
    tagline: "Tax & accounting boutique — partially configured",
    description: "Mid-onboarding tenant: services and staff configured, integrations pending.",
    onboardingState: "partial",
    richness: "minimal",
  },
  {
    slug: "docs-demo-new",
    name: "Brightline Coaching (new)",
    plan: "free",
    tagline: "Fresh signup — onboarding wizard not yet entered",
    description: "Brand-new tenant for empty-state and onboarding-wizard screenshots.",
    onboardingState: "new",
    richness: "empty",
  },
  {
    slug: "docs-demo-stalled",
    name: "Pinecrest Legal Group",
    plan: "solo",
    tagline: "Started onboarding 14 days ago, no progress since",
    description: "Stalled-onboarding tenant — for re-engagement / nudge screenshots.",
    onboardingState: "stalled",
    richness: "minimal",
  },
  {
    slug: "docs-demo-ent",
    name: "Helix Health Systems",
    plan: "enterprise",
    tagline: "Enterprise demo — multi-department health system",
    description: "Fully configured enterprise tenant for scale + workforce screenshots.",
    onboardingState: "complete",
    richness: "full",
  },
];

// ─── Department + service catalog (full richness) ──────────────────

const DEPARTMENTS_FULL = [
  { name: "Sales", color: "#359df3" },
  { name: "Customer Support", color: "#10b981" },
  { name: "Onboarding", color: "#f59e0b" },
  { name: "Tax Consultation", color: "#7c3aed" },
  { name: "Bookkeeping", color: "#0ea5e9" },
  { name: "Payroll", color: "#ef4444" },
  { name: "Enterprise Success", color: "#0891b2" },
];

const SERVICES_FULL = [
  { name: "Intro Consultation",        durationMinutes: 30, price: 0,    department: "Sales" },
  { name: "Tax Planning Session",      durationMinutes: 60, price: 25000, department: "Tax Consultation" },
  { name: "Payroll Review",            durationMinutes: 45, price: 15000, department: "Payroll" },
  { name: "Bookkeeping Onboarding",    durationMinutes: 60, price: 0,    department: "Onboarding" },
  { name: "Enterprise Demo",           durationMinutes: 45, price: 0,    department: "Sales" },
  { name: "Customer Success Check-In", durationMinutes: 30, price: 0,    department: "Customer Support" },
  { name: "Technical Support Session", durationMinutes: 45, price: 0,    department: "Customer Support" },
  { name: "Annual Review",             durationMinutes: 90, price: 30000, department: "Enterprise Success" },
  { name: "Strategy Consultation",     durationMinutes: 60, price: 20000, department: "Tax Consultation" },
  { name: "Compliance Review",         durationMinutes: 60, price: 22500, department: "Bookkeeping" },
];

// Minimal catalog used by the "partial" + "stalled" tenants
const SERVICES_MINIMAL = [
  { name: "Intro Consultation",   durationMinutes: 30, price: 0,    department: null },
  { name: "Tax Planning Session", durationMinutes: 60, price: 25000, department: null },
  { name: "Compliance Review",    durationMinutes: 60, price: 22500, department: null },
];

// ─── Staff roster (primary tenant) ─────────────────────────────────

type StaffSpec = {
  email: string;
  name: string;
  role: "admin" | "manager" | "staff";
  title: string;
};

const STAFF_PRIMARY: StaffSpec[] = [
  { email: "admin@docs-demo.zentromeet.demo",         name: "Alex Rivera",      role: "admin",   title: "Workspace Admin" },
  { email: "sarah.johnson@docs-demo.zentromeet.demo", name: "Sarah Johnson",    role: "staff",   title: "Senior Tax Advisor" },
  { email: "michael.lee@docs-demo.zentromeet.demo",   name: "Michael Lee",      role: "staff",   title: "Bookkeeping Lead" },
  { email: "emily.davis@docs-demo.zentromeet.demo",   name: "Emily Davis",      role: "manager", title: "Customer Success Manager" },
  { email: "support.agent@docs-demo.zentromeet.demo", name: "Jamie Patel",      role: "staff",   title: "Technical Support" },
];

const STAFF_ENT: StaffSpec[] = [
  { email: "admin@docs-demo-ent.zentromeet.demo",     name: "Dr. Helena Chen",  role: "admin",   title: "Practice Director" },
  { email: "physician1@docs-demo-ent.zentromeet.demo", name: "Dr. Marcus Okafor", role: "staff",  title: "Lead Physician" },
  { email: "physician2@docs-demo-ent.zentromeet.demo", name: "Dr. Priya Mehta",   role: "staff",  title: "Specialist" },
  { email: "manager@docs-demo-ent.zentromeet.demo",    name: "Robin Castillo",    role: "manager", title: "Operations Manager" },
];

const STAFF_MINIMAL: StaffSpec[] = [
  { email: "admin@docs-demo-partial.zentromeet.demo", name: "Quinn Sutton", role: "admin", title: "Owner" },
  { email: "staff1@docs-demo-partial.zentromeet.demo", name: "Morgan Hale",  role: "staff", title: "Advisor" },
];

const STAFF_STALLED: StaffSpec[] = [
  { email: "admin@docs-demo-stalled.zentromeet.demo", name: "Avery Crane", role: "admin", title: "Founder" },
];

// ─── Customer roster (primary tenant) ──────────────────────────────

const CUSTOMERS_PRIMARY = [
  { email: "john.smith@example.demo",     name: "John Smith",     phone: "+1 555 0142" },
  { email: "olivia.wilson@example.demo",  name: "Olivia Wilson",  phone: "+1 555 0166" },
  { email: "david.miller@example.demo",   name: "David Miller",   phone: "+1 555 0188" },
  { email: "sophia.moore@example.demo",   name: "Sophia Moore",   phone: "+1 555 0204" },
  { email: "noah.taylor@example.demo",    name: "Noah Taylor",    phone: "+1 555 0231" },
  { email: "ava.thomas@example.demo",     name: "Ava Thomas",     phone: "+1 555 0252" },
  { email: "liam.jackson@example.demo",   name: "Liam Jackson",   phone: "+1 555 0277" },
  { email: "isabella.white@example.demo", name: "Isabella White", phone: "+1 555 0299" },
];

// ─── Booking schedule generator (deterministic) ────────────────────

type BookingPlan = {
  /** Days offset from FROZEN_NOW. Negative = past, 0 = today, positive = future. */
  dayOffset: number;
  hour: number;
  minute: number;
  serviceIndex: number;
  staffIndex: number;
  customerIndex: number;
  status: "confirmed" | "completed" | "cancelled" | "no_show";
};

/** A fixed 90-day schedule pattern. Past 60 days are completed/no_show/cancelled
 *  (realistic mix). Next 30 days are confirmed. Hand-tuned for visual variety. */
function bookingSchedule(): BookingPlan[] {
  const plans: BookingPlan[] = [];
  // Past 60 days: 2-4 bookings per weekday, distributed.
  for (let d = -60; d < 0; d++) {
    const dow = (FROZEN_NOW.getUTCDay() + d + 7000) % 7;
    if (dow === 0 || dow === 6) continue; // weekends quiet
    const bookingsToday = 2 + (Math.abs(d) % 3); // 2-4 deterministic
    for (let i = 0; i < bookingsToday; i++) {
      const hour = 9 + i * 2;
      const serviceIndex = (Math.abs(d) + i) % SERVICES_FULL.length;
      const staffIndex = 1 + ((Math.abs(d) + i) % 4); // skip admin
      const customerIndex = (Math.abs(d) + i) % CUSTOMERS_PRIMARY.length;
      // 78% completed, 10% no_show, 12% cancelled (deterministic by index)
      const roll = (Math.abs(d) * 7 + i) % 100;
      const status: BookingPlan["status"] =
        roll < 78 ? "completed" : roll < 88 ? "no_show" : "cancelled";
      plans.push({ dayOffset: d, hour, minute: 0, serviceIndex, staffIndex, customerIndex, status });
    }
  }
  // Future 30 days: 1-3 confirmed bookings per weekday
  for (let d = 0; d <= 30; d++) {
    const dow = (FROZEN_NOW.getUTCDay() + d + 7000) % 7;
    if (dow === 0 || dow === 6) continue;
    const bookingsToday = 1 + (d % 3);
    for (let i = 0; i < bookingsToday; i++) {
      const hour = 10 + i * 2;
      const serviceIndex = (d + i) % SERVICES_FULL.length;
      const staffIndex = 1 + ((d + i) % 4);
      const customerIndex = (d + i) % CUSTOMERS_PRIMARY.length;
      plans.push({
        dayOffset: d,
        hour,
        minute: 0,
        serviceIndex,
        staffIndex,
        customerIndex,
        status: "confirmed",
      });
    }
  }
  return plans;
}

// ─── Seed orchestration ────────────────────────────────────────────

async function seedTenant(spec: TenantSpec): Promise<typeof tenants.$inferSelect> {
  // Upsert pattern: try insert, on slug conflict fall through and read existing.
  const onboardingProgress = seedMetadata({
    spec_state: spec.onboardingState,
  });

  const onboardingCompletedAt =
    spec.onboardingState === "complete" ? new Date(FROZEN_NOW.getTime() - 7 * 24 * 60 * 60_000) : null;
  const onboardingStartedAt =
    spec.onboardingState === "new"
      ? null
      : spec.onboardingState === "stalled"
        ? new Date(FROZEN_NOW.getTime() - 14 * 24 * 60 * 60_000)
        : new Date(FROZEN_NOW.getTime() - 30 * 24 * 60 * 60_000);

  // 1) Try insert
  try {
    const [row] = await db
      .insert(tenants)
      .values({
        name: spec.name,
        slug: spec.slug,
        plan: spec.plan,
        currentPlan: spec.plan,
        active: true,
        isDemo: true,
        primaryColor: PRIMARY_COLOR,
        tagline: spec.tagline,
        description: spec.description,
        billingEmail: `billing@${spec.slug}.zentromeet.demo`,
        subscriptionStatus: spec.plan === "free" ? null : "active",
        onboardingCompletedAt,
        onboardingStartedAt,
        onboardingProgress,
        createdAt: onboardingStartedAt ?? FROZEN_NOW,
        updatedAt: FROZEN_NOW,
      })
      .returning();
    return row;
  } catch {
    // Slug collision = already seeded. Read existing row and ensure
    // is_demo + marker are set (re-runs after a manual flip).
    const existing = await db.query.tenants.findFirst({ where: eq(tenants.slug, spec.slug) });
    if (!existing) throw new Error(`tenant insert failed AND lookup failed for slug=${spec.slug}`);
    await db
      .update(tenants)
      .set({
        isDemo: true,
        onboardingProgress: onboardingProgress as Record<string, unknown>,
        updatedAt: FROZEN_NOW,
      })
      .where(eq(tenants.id, existing.id));
    return existing;
  }
}

async function seedDepartments(
  tenantId: string,
  richness: TenantSpec["richness"],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (richness === "empty") return map;
  const list = richness === "full" ? DEPARTMENTS_FULL : DEPARTMENTS_FULL.slice(0, 2);
  for (const d of list) {
    try {
      const [row] = await db
        .insert(departments)
        .values({
          tenantId,
          name: d.name,
          color: d.color,
          description: `${d.name} department for ZentroMeet demo workspace.`,
          createdAt: FROZEN_NOW,
          updatedAt: FROZEN_NOW,
        })
        .returning();
      map.set(d.name, row.id);
    } catch {
      // already exists — look up
      const existing = await db.query.departments.findFirst({
        where: and(eq(departments.tenantId, tenantId), eq(departments.name, d.name)),
      });
      if (existing) map.set(d.name, existing.id);
    }
  }
  return map;
}

async function seedUsers(
  tenantId: string,
  staffSpecs: StaffSpec[],
): Promise<Map<string, typeof users.$inferSelect>> {
  const out = new Map<string, typeof users.$inferSelect>();
  const passwordHash = demoPasswordHash();
  for (const s of staffSpecs) {
    try {
      const [row] = await db
        .insert(users)
        .values({
          tenantId,
          email: s.email,
          passwordHash,
          role: s.role,
          name: s.name,
          timezone: DEFAULT_TIMEZONE,
          publicDisplayName: s.name,
          publicTitle: s.title,
          createdAt: FROZEN_NOW,
        })
        .returning();
      out.set(s.email, row);
    } catch {
      const existing = await db.query.users.findFirst({ where: eq(users.email, s.email) });
      if (existing) {
        // Re-stamp the password hash + title so re-runs always
        // converge on the documented demo password.
        await db
          .update(users)
          .set({ passwordHash, name: s.name, role: s.role, publicTitle: s.title })
          .where(eq(users.id, existing.id));
        out.set(s.email, { ...existing, passwordHash, name: s.name, role: s.role });
      }
    }
  }
  return out;
}

async function seedAvailability(
  tenantId: string,
  staff: Map<string, typeof users.$inferSelect>,
): Promise<number> {
  let count = 0;
  for (const u of staff.values()) {
    // 9am-5pm Monday..Friday (dayOfWeek 1..5)
    for (let dow = 1; dow <= 5; dow++) {
      try {
        await db.insert(availability).values({
          tenantId,
          userId: u.id,
          dayOfWeek: dow,
          startTime: "09:00",
          endTime: "17:00",
          createdAt: FROZEN_NOW,
        });
        count++;
      } catch {
        /* duplicate — skip */
      }
    }
  }
  return count;
}

async function seedServices(
  tenantId: string,
  richness: TenantSpec["richness"],
  deptMap: Map<string, string>,
  staffMap: Map<string, typeof users.$inferSelect>,
): Promise<typeof services.$inferSelect[]> {
  if (richness === "empty") return [];
  const catalog = richness === "full" ? SERVICES_FULL : SERVICES_MINIMAL;
  const created: typeof services.$inferSelect[] = [];
  for (const s of catalog) {
    const departmentId = s.department ? deptMap.get(s.department) ?? null : null;
    try {
      const [row] = await db
        .insert(services)
        .values({
          tenantId,
          name: s.name,
          slug: s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          durationMinutes: s.durationMinutes,
          price: s.price,
          isActive: 1,
          videoProvider: "google_meet",
          departmentId,
          description: `${s.name} — ZentroMeet demo service for documentation.`,
          createdAt: FROZEN_NOW,
        })
        .returning();
      created.push(row);
    } catch {
      const existing = await db.query.services.findFirst({
        where: and(eq(services.tenantId, tenantId), eq(services.slug, s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"))),
      });
      if (existing) created.push(existing);
    }
  }

  // Assign every staff member to every service (full coverage for demo)
  const staffArr = [...staffMap.values()].filter((u) => u.role !== "admin" || staffMap.size === 1);
  for (const svc of created) {
    for (const u of staffArr) {
      try {
        await db.insert(serviceStaff).values({ serviceId: svc.id, userId: u.id, tenantId });
      } catch {
        /* PK collision — skip */
      }
    }
  }

  return created;
}

async function seedCustomers(
  tenantId: string,
  richness: TenantSpec["richness"],
): Promise<typeof customers.$inferSelect[]> {
  if (richness === "empty") return [];
  const roster = richness === "full" ? CUSTOMERS_PRIMARY : CUSTOMERS_PRIMARY.slice(0, 3);
  const out: typeof customers.$inferSelect[] = [];
  for (const c of roster) {
    try {
      const [row] = await db
        .insert(customers)
        .values({
          tenantId,
          name: c.name,
          email: c.email,
          phone: c.phone,
          notes: "Seeded demo customer — non-production fixture data.",
          createdAt: FROZEN_NOW,
          updatedAt: FROZEN_NOW,
        })
        .returning();
      out.push(row);
    } catch {
      const existing = await db.query.customers.findFirst({
        where: and(eq(customers.tenantId, tenantId), eq(customers.email, c.email)),
      });
      if (existing) out.push(existing);
    }
  }
  return out;
}

async function seedBookings(
  tenantId: string,
  svcs: typeof services.$inferSelect[],
  staffMap: Map<string, typeof users.$inferSelect>,
  custs: typeof customers.$inferSelect[],
  richness: TenantSpec["richness"],
): Promise<{ count: number; revenue_cents: number }> {
  if (richness !== "full" || svcs.length === 0 || custs.length === 0) {
    return { count: 0, revenue_cents: 0 };
  }
  const staffArr = [...staffMap.values()];
  const plans = bookingSchedule();

  let count = 0;
  let revenue = 0;

  for (const p of plans) {
    const svc = svcs[p.serviceIndex % svcs.length]!;
    const staff = staffArr[p.staffIndex % staffArr.length]!;
    const cust = custs[p.customerIndex % custs.length]!;
    const startAt = daysFromFrozen(p.dayOffset, p.hour, p.minute);
    const endAt = new Date(startAt.getTime() + svc.durationMinutes * 60_000);

    try {
      await db.insert(bookings).values({
        tenantId,
        serviceId: svc.id,
        staffUserId: staff.id,
        customerId: cust.id,
        clientName: cust.name,
        clientEmail: cust.email,
        startAt,
        endAt,
        status: p.status,
        amountChargedCents: p.status === "completed" ? svc.price : null,
        notes: "Seeded demo booking — non-production fixture.",
      });
      count++;
      if (p.status === "completed") revenue += svc.price;
    } catch {
      /* EXCLUDE constraint collision — skip overlap */
    }
  }

  return { count, revenue_cents: revenue };
}

async function seedAnalyticsSnapshots(
  tenantId: string,
  richness: TenantSpec["richness"],
): Promise<number> {
  if (richness !== "full") return 0;
  // 90 days of populated snapshots — keeps the analytics dashboard
  // looking rich. Deterministic curve so charts look natural.
  let count = 0;
  for (let d = -90; d < 0; d++) {
    const total = 3 + ((Math.abs(d) * 5) % 7); // 3-9 bookings/day
    const completed = Math.floor(total * 0.78);
    const cancelled = Math.floor(total * 0.12);
    const noShow = total - completed - cancelled;
    const snapshotDate = dateOnly(daysFromFrozen(d));
    try {
      await db.insert(analyticsDailySnapshots).values({
        tenantId,
        snapshotDate,
        totalBookings: total,
        completedBookings: completed,
        cancelledBookings: cancelled,
        noShowBookings: Math.max(0, noShow),
        recurringBookings: Math.floor(total * 0.15),
        waitlistJoins: d % 5 === 0 ? 1 : 0,
        waitlistConversions: d % 12 === 0 ? 1 : 0,
        reviewRequestsSent: completed,
        reviewsCompleted: Math.floor(completed * 0.4),
        reminderEmailsSent: total * 2,
        reminderEmailsSuppressed: 0,
        followupsSent: completed,
        averageBookingLeadHours: 36 + (Math.abs(d) % 24),
        extras: { seeded_by: DOCS_DEMO_MARKER },
        createdAt: FROZEN_NOW,
      });
      count++;
    } catch {
      /* unique conflict on (tenant, date) — skip */
    }
  }
  return count;
}

async function seedAuditLog(
  tenantId: string,
  staffMap: Map<string, typeof users.$inferSelect>,
  richness: TenantSpec["richness"],
): Promise<number> {
  if (richness === "empty") return 0;
  let count = 0;
  const staffArr = [...staffMap.values()];
  // 30 days of "login" events for visual variety on the activity log
  for (let d = -30; d < 0; d++) {
    for (let i = 0; i < 2; i++) {
      const actor = staffArr[(Math.abs(d) + i) % staffArr.length]!;
      const ts = daysFromFrozen(d, 8 + i * 6, 0);
      try {
        await db.insert(auditLogs).values({
          tenantId,
          action: "security.authentication.success",
          actorUserId: actor.id,
          actorLabel: actor.email,
          ipAddress: "10.0.0.1",
          metadata: { seeded_by: DOCS_DEMO_MARKER },
          createdAt: ts,
        });
        count++;
      } catch {}
    }
  }
  return count;
}

// ─── Public entry point ────────────────────────────────────────────

type Report = {
  marker: string;
  frozenNow: string;
  tenants: Array<{
    slug: string;
    name: string;
    plan: string;
    onboarding: string;
    isDemo: boolean;
    counts: {
      departments: number;
      users: number;
      availabilityRows: number;
      services: number;
      customers: number;
      bookings: number;
      auditLogs: number;
      analyticsSnapshots: number;
    };
    publicBookingUrl: string;
    dashboardLoginEmail: string;
  }>;
  password: string;
  passwordNote: string;
};

async function main() {
  // Guard — same gate the chaos seeder uses.
  if (process.env.ALLOW_DEV_SIMULATION !== "true") {
    console.error(
      "Refusing to seed: ALLOW_DEV_SIMULATION must be 'true'. " +
        "Set this env var on the target environment before running.",
    );
    process.exit(2);
  }

  const t0 = Date.now();
  const report: Report = {
    marker: DOCS_DEMO_MARKER,
    frozenNow: FROZEN_NOW.toISOString(),
    tenants: [],
    password: DEMO_PASSWORD,
    passwordNote:
      "All demo users share this password. Only valid on is_demo=true tenants. " +
      "Do NOT distribute outside the documentation/screenshot context.",
  };

  for (const spec of TENANT_SPECS) {
    const tenant = await seedTenant(spec);
    const deptMap = await seedDepartments(tenant.id, spec.richness);

    let staffSpecs: StaffSpec[];
    if (spec.slug === "docs-demo") staffSpecs = STAFF_PRIMARY;
    else if (spec.slug === "docs-demo-ent") staffSpecs = STAFF_ENT;
    else if (spec.slug === "docs-demo-stalled") staffSpecs = STAFF_STALLED;
    else if (spec.slug === "docs-demo-new") staffSpecs = []; // empty state
    else staffSpecs = STAFF_MINIMAL;

    const staffMap = await seedUsers(tenant.id, staffSpecs);
    const availabilityRows = await seedAvailability(tenant.id, staffMap);
    const svcs = await seedServices(tenant.id, spec.richness, deptMap, staffMap);
    const custs = await seedCustomers(tenant.id, spec.richness);
    const bookingResult = await seedBookings(tenant.id, svcs, staffMap, custs, spec.richness);
    const snapshotCount = await seedAnalyticsSnapshots(tenant.id, spec.richness);
    const auditCount = await seedAuditLog(tenant.id, staffMap, spec.richness);

    const adminEmail = staffSpecs.find((s) => s.role === "admin")?.email ?? "(no admin)";

    report.tenants.push({
      slug: tenant.slug,
      name: tenant.name,
      plan: tenant.plan,
      onboarding: spec.onboardingState,
      isDemo: true,
      counts: {
        departments: deptMap.size,
        users: staffMap.size,
        availabilityRows,
        services: svcs.length,
        customers: custs.length,
        bookings: bookingResult.count,
        auditLogs: auditCount,
        analyticsSnapshots: snapshotCount,
      },
      publicBookingUrl: `/u/${tenant.slug}`,
      dashboardLoginEmail: adminEmail,
    });
  }

  const durationMs = Date.now() - t0;
  console.log(JSON.stringify({ evt: "docs_demo_seeded", durationMs, ...report }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(JSON.stringify({ evt: "docs_demo_seed_failed", error: String(err) }));
    process.exit(1);
  });
