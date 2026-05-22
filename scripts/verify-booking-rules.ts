/**
 * scripts/verify-booking-rules.ts
 *
 * End-to-end verification that every booking rule actually fires.
 * Tests the SAME validator the production /api/bookings POST calls
 * (lib/booking-rules/validateBookingRules.ts).
 *
 * Strategy:
 *   1. Find a tenant + service + staff (any — read-only discovery)
 *   2. Snapshot any existing tenant-default rule
 *   3. For each of 8 rules:
 *        a. Set the tenant-default rule with the single field under test
 *        b. Call validateBookingRules with a violating input → assert
 *           ok=false + matching errorCode
 *        c. Call with a satisfying input → assert ok=true (no rule
 *           failure)
 *        d. For cap-type rules, insert N dummy bookings before the
 *           test, clean up after
 *   4. Restore the snapshotted rule
 *   5. Delete every test artifact (bookings + temp rule)
 *
 * NEVER fires emails, notifications, or webhooks — those are wired
 * at the API layer, not the engine. Engine + DB only.
 *
 * Run with: npx tsx scripts/verify-booking-rules.ts
 */
import "dotenv/config";
import { and, eq, isNull, like } from "drizzle-orm";

import { db } from "../db/client";
import {
  bookingRules,
  bookings,
  services,
  tenants,
  users,
} from "../db/schema";
import { validateBookingRules } from "../lib/booking-rules/validateBookingRules";

const TEST_CUSTOMER_EMAIL = "rules-verify-2026-05-21@zentromeet-verify.invalid";
const TEST_NOTES_TAG = "RULES_VERIFY_2026_05_21";

type Result = { rule: string; pass: boolean; details: string };

async function main() {
  const tenant = await db.query.tenants.findFirst();
  if (!tenant) throw new Error("No tenants in DB");
  const service = await db.query.services.findFirst({
    where: eq(services.tenantId, tenant.id),
  });
  if (!service) throw new Error(`No services for tenant ${tenant.id}`);
  const staff = await db.query.users.findFirst({
    where: and(eq(users.tenantId, tenant.id)),
  });
  if (!staff) throw new Error(`No staff for tenant ${tenant.id}`);

  console.log("─────────────────────────────────────────────────");
  console.log(`Tenant:  ${tenant.name} (${tenant.id})`);
  console.log(`Service: ${service.name} (${service.id})`);
  console.log(`Staff:   ${staff.name} (${staff.id})  tz=${staff.timezone}`);
  console.log(`Customer: ${TEST_CUSTOMER_EMAIL}`);
  console.log("─────────────────────────────────────────────────\n");

  // Snapshot existing tenant-default rule.
  const existingRule = await db.query.bookingRules.findFirst({
    where: and(
      eq(bookingRules.tenantId, tenant.id),
      isNull(bookingRules.serviceId),
      isNull(bookingRules.locationId),
    ),
  });
  console.log(
    existingRule
      ? `Snapshotted existing tenant-default rule (id=${existingRule.id})`
      : "No existing tenant-default rule — will delete temp rule on exit",
  );

  const results: Result[] = [];

  try {
    // ─── 1. min_notice ────────────────────────────────────────
    await setRule(tenant.id, { enabled: true, minNoticeMinutes: 120 });
    const now = new Date();
    const violateAt = new Date(now.getTime() + 30 * 60_000); // 30 min — under 120
    const passAt = new Date(now.getTime() + 3 * 60 * 60_000); // 3h — over 120

    const violateRes1 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: violateAt,
      endAt: new Date(violateAt.getTime() + 30 * 60_000),
    });
    const passRes1 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: passAt,
      endAt: new Date(passAt.getTime() + 30 * 60_000),
    });
    results.push({
      rule: "min_notice (120 min)",
      pass:
        !violateRes1.ok &&
        violateRes1.error.code === "min_notice" &&
        passRes1.ok,
      details: `violate=${describe(violateRes1)}, satisfy=${describe(passRes1)}`,
    });

    // ─── 2. max_advance ───────────────────────────────────────
    await setRule(tenant.id, { enabled: true, maxAdvanceDays: 30 });
    const farFuture = new Date(now.getTime() + 60 * 24 * 60 * 60_000); // 60d
    const nearFuture = new Date(now.getTime() + 7 * 24 * 60 * 60_000); // 7d

    const violateRes2 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: farFuture,
      endAt: new Date(farFuture.getTime() + 30 * 60_000),
    });
    const passRes2 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: nearFuture,
      endAt: new Date(nearFuture.getTime() + 30 * 60_000),
    });
    results.push({
      rule: "max_advance (30 days)",
      pass:
        !violateRes2.ok &&
        violateRes2.error.code === "max_advance" &&
        passRes2.ok,
      details: `violate=${describe(violateRes2)}, satisfy=${describe(passRes2)}`,
    });

    // ─── 3. blackout_date ─────────────────────────────────────
    // Use a date 5 days from now so it's well past min notice + within
    // max advance for whatever defaults remain.
    const blackoutTarget = new Date(now.getTime() + 5 * 24 * 60 * 60_000);
    const blackoutYmd = blackoutTarget.toISOString().slice(0, 10);
    const safeDate = new Date(now.getTime() + 6 * 24 * 60 * 60_000); // next day
    await setRule(tenant.id, {
      enabled: true,
      blackoutDates: [blackoutYmd],
    });
    // Pick mid-day to avoid TZ edge cases.
    const blackoutAt = new Date(blackoutYmd + "T15:00:00Z");
    const safeAt = new Date(safeDate.toISOString().slice(0, 10) + "T15:00:00Z");

    const violateRes3 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: blackoutAt,
      endAt: new Date(blackoutAt.getTime() + 30 * 60_000),
    });
    const passRes3 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: safeAt,
      endAt: new Date(safeAt.getTime() + 30 * 60_000),
    });
    results.push({
      rule: `blackout_date (${blackoutYmd} blocked)`,
      pass:
        !violateRes3.ok &&
        violateRes3.error.code === "blackout_date" &&
        passRes3.ok,
      details: `violate=${describe(violateRes3)}, satisfy=${describe(passRes3)}`,
    });

    // ─── 4. outside_business_hours ────────────────────────────
    // Configure business hours Mon-Fri 09:00–17:00 (in staff TZ). Test
    // a Sat-or-Sun booking + a weekday-3am booking; both should fail.
    await setRule(tenant.id, {
      enabled: true,
      requireBusinessHours: true,
      businessHours: {
        "1": { start: "09:00", end: "17:00" },
        "2": { start: "09:00", end: "17:00" },
        "3": { start: "09:00", end: "17:00" },
        "4": { start: "09:00", end: "17:00" },
        "5": { start: "09:00", end: "17:00" },
      },
    });
    // Find a known Tuesday at 14:00 (passes) and 03:00 (fails) in staff TZ.
    // 5 days from now is generally safe; we then compute next Tuesday.
    const nextTue = nextWeekday(2);
    const tueAfternoonUtc = wallClockToUtc(nextTue, "14:00", staff.timezone);
    const tueEarlyUtc = wallClockToUtc(nextTue, "03:00", staff.timezone);

    const violateRes4 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: tueEarlyUtc,
      endAt: new Date(tueEarlyUtc.getTime() + 30 * 60_000),
    });
    const passRes4 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: tueAfternoonUtc,
      endAt: new Date(tueAfternoonUtc.getTime() + 30 * 60_000),
    });
    results.push({
      rule: "outside_business_hours (M-F 9-5)",
      pass:
        !violateRes4.ok &&
        violateRes4.error.code === "outside_business_hours" &&
        passRes4.ok,
      details: `early=${describe(violateRes4)}, afternoon=${describe(passRes4)}`,
    });

    // ─── 5. daily_cap ─────────────────────────────────────────
    // Insert 2 dummy confirmed bookings on day D for service. Cap=2 →
    // a 3rd booking on D fails; same booking on D+1 passes.
    const dayD = new Date(now.getTime() + 5 * 24 * 60 * 60_000);
    const dayDStr = dayD.toISOString().slice(0, 10);
    const dayDPlus1 = new Date(now.getTime() + 6 * 24 * 60 * 60_000);

    const candAt1 = new Date(dayDStr + "T13:00:00Z");
    const candAt2 = new Date(dayDStr + "T15:00:00Z");
    const candAt3 = new Date(dayDStr + "T16:00:00Z");
    await insertTestBooking({
      tenant,
      service,
      staff,
      startAt: candAt1,
      endAt: new Date(candAt1.getTime() + 30 * 60_000),
      email: "filler-1@zentromeet-verify.invalid",
    });
    await insertTestBooking({
      tenant,
      service,
      staff,
      startAt: candAt2,
      endAt: new Date(candAt2.getTime() + 30 * 60_000),
      email: "filler-2@zentromeet-verify.invalid",
    });

    await setRule(tenant.id, { enabled: true, maxBookingsPerDay: 2 });

    const violateRes5 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: candAt3,
      endAt: new Date(candAt3.getTime() + 30 * 60_000),
    });
    const passRes5 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: new Date(dayDPlus1.toISOString().slice(0, 10) + "T13:00:00Z"),
      endAt: new Date(dayDPlus1.toISOString().slice(0, 10) + "T13:30:00Z"),
    });
    results.push({
      rule: "daily_cap (max 2/day)",
      pass:
        !violateRes5.ok &&
        violateRes5.error.code === "daily_cap" &&
        passRes5.ok,
      details: `3rd-same-day=${describe(violateRes5)}, next-day=${describe(passRes5)}`,
    });
    // Cleanup just these fillers — keep test customer's bookings for next test.
    await db
      .delete(bookings)
      .where(eq(bookings.clientEmail, "filler-1@zentromeet-verify.invalid"));
    await db
      .delete(bookings)
      .where(eq(bookings.clientEmail, "filler-2@zentromeet-verify.invalid"));

    // ─── 6. per_customer_daily_cap ────────────────────────────
    // Insert 1 booking on day D for TEST_CUSTOMER. Cap=1 → another
    // booking by same customer on D fails; on D+1 passes.
    await insertTestBooking({
      tenant,
      service,
      staff,
      startAt: candAt1,
      endAt: new Date(candAt1.getTime() + 30 * 60_000),
      email: TEST_CUSTOMER_EMAIL,
    });
    await setRule(tenant.id, {
      enabled: true,
      maxBookingsPerCustomerPerDay: 1,
    });

    const violateRes6 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: candAt3,
      endAt: new Date(candAt3.getTime() + 30 * 60_000),
    });
    const passRes6 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: new Date(dayDPlus1.toISOString().slice(0, 10) + "T13:00:00Z"),
      endAt: new Date(dayDPlus1.toISOString().slice(0, 10) + "T13:30:00Z"),
    });
    results.push({
      rule: "per_customer_daily_cap (1/day)",
      pass:
        !violateRes6.ok &&
        violateRes6.error.code === "per_customer_daily_cap" &&
        passRes6.ok,
      details: `same-day=${describe(violateRes6)}, next-day=${describe(passRes6)}`,
    });

    // ─── 7. concurrent_cap ────────────────────────────────────
    // Insert 1 booking at T..T+30 for THIS service. Cap=1 → another
    // booking overlapping T..T+30 fails; a non-overlapping booking
    // passes.
    // Reuse candAt1 (already inserted above for TEST_CUSTOMER on dayD).
    // For concurrent we need a separate fresh service-level booking.
    await insertTestBooking({
      tenant,
      service,
      staff,
      startAt: candAt2,
      endAt: new Date(candAt2.getTime() + 30 * 60_000),
      email: "concurrent-filler@zentromeet-verify.invalid",
    });
    await setRule(tenant.id, { enabled: true, maxConcurrentBookings: 1 });

    const overlapAt = new Date(candAt2.getTime() + 10 * 60_000); // mid-window
    const nonOverlapAt = new Date(candAt2.getTime() + 60 * 60_000); // after
    const violateRes7 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: "concurrent-tester@zentromeet-verify.invalid",
      startAt: overlapAt,
      endAt: new Date(overlapAt.getTime() + 30 * 60_000),
    });
    const passRes7 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: "concurrent-tester@zentromeet-verify.invalid",
      startAt: nonOverlapAt,
      endAt: new Date(nonOverlapAt.getTime() + 30 * 60_000),
    });
    results.push({
      rule: "concurrent_cap (max 1 overlap)",
      pass:
        !violateRes7.ok &&
        violateRes7.error.code === "concurrent_cap" &&
        passRes7.ok,
      details: `overlap=${describe(violateRes7)}, non-overlap=${describe(passRes7)}`,
    });

    // ─── 8. cooldown ──────────────────────────────────────────
    // TEST_CUSTOMER already has a booking at candAt1 (from per-customer
    // test). Cooldown=120 min → another booking within 120 min of
    // candAt1 fails; one >120 min away passes.
    await setRule(tenant.id, { enabled: true, cooldownMinutes: 120 });

    const tooCloseAt = new Date(candAt1.getTime() + 60 * 60_000); // 60 min after
    const farEnoughAt = new Date(candAt1.getTime() + 4 * 60 * 60_000); // 4h after
    const violateRes8 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: tooCloseAt,
      endAt: new Date(tooCloseAt.getTime() + 30 * 60_000),
    });
    const passRes8 = await validateBookingRules({
      tenantId: tenant.id,
      serviceId: service.id,
      clientEmail: TEST_CUSTOMER_EMAIL,
      startAt: farEnoughAt,
      endAt: new Date(farEnoughAt.getTime() + 30 * 60_000),
    });
    results.push({
      rule: "cooldown (120 min)",
      pass:
        !violateRes8.ok &&
        violateRes8.error.code === "cooldown" &&
        passRes8.ok,
      details: `too-close=${describe(violateRes8)}, far-enough=${describe(passRes8)}`,
    });
  } finally {
    // Restore snapshot.
    if (existingRule) {
      await db
        .update(bookingRules)
        .set({
          enabled: existingRule.enabled,
          minNoticeMinutes: existingRule.minNoticeMinutes,
          maxAdvanceDays: existingRule.maxAdvanceDays,
          maxBookingsPerDay: existingRule.maxBookingsPerDay,
          maxBookingsPerCustomerPerDay: existingRule.maxBookingsPerCustomerPerDay,
          maxConcurrentBookings: existingRule.maxConcurrentBookings,
          cooldownMinutes: existingRule.cooldownMinutes,
          blackoutDates: existingRule.blackoutDates,
          requireBusinessHours: existingRule.requireBusinessHours,
          businessHours: existingRule.businessHours,
          updatedAt: new Date(),
        })
        .where(eq(bookingRules.id, existingRule.id));
      console.log("\nRestored snapshotted tenant-default rule.");
    } else {
      await db
        .delete(bookingRules)
        .where(
          and(
            eq(bookingRules.tenantId, tenant.id),
            isNull(bookingRules.serviceId),
            isNull(bookingRules.locationId),
          ),
        );
      console.log("\nDeleted temp tenant-default rule.");
    }

    // Cleanup every test booking by client email pattern.
    const cleanup = await db
      .delete(bookings)
      .where(like(bookings.clientEmail, "%@zentromeet-verify.invalid"))
      .returning({ id: bookings.id });
    console.log(`Cleaned up ${cleanup.length} test booking row(s).`);
  }

  console.log("\n═══════════════ RESULTS ═══════════════");
  let failed = 0;
  for (const r of results) {
    const tag = r.pass ? "✅ PASS" : "❌ FAIL";
    console.log(`${tag}  ${r.rule}`);
    console.log(`         ${r.details}`);
    if (!r.pass) failed += 1;
  }
  console.log("═══════════════════════════════════════");
  console.log(
    failed === 0
      ? `All ${results.length} rules verified end-to-end.`
      : `${failed} of ${results.length} rules FAILED.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

// ─── helpers ───────────────────────────────────────────────────────────

type RuleFields = Partial<{
  enabled: boolean;
  minNoticeMinutes: number | null;
  maxAdvanceDays: number | null;
  maxBookingsPerDay: number | null;
  maxBookingsPerCustomerPerDay: number | null;
  maxConcurrentBookings: number | null;
  cooldownMinutes: number | null;
  blackoutDates: string[];
  requireBusinessHours: boolean;
  businessHours: Record<string, { start: string; end: string }>;
}>;

async function setRule(tenantId: string, fields: RuleFields) {
  // Reset every other field to null/empty so prior tests don't leak.
  const base: RuleFields = {
    enabled: true,
    minNoticeMinutes: null,
    maxAdvanceDays: null,
    maxBookingsPerDay: null,
    maxBookingsPerCustomerPerDay: null,
    maxConcurrentBookings: null,
    cooldownMinutes: null,
    blackoutDates: [],
    requireBusinessHours: false,
    businessHours: {},
    ...fields,
  };
  const existing = await db.query.bookingRules.findFirst({
    where: and(
      eq(bookingRules.tenantId, tenantId),
      isNull(bookingRules.serviceId),
      isNull(bookingRules.locationId),
    ),
  });
  if (existing) {
    await db
      .update(bookingRules)
      .set({ ...base, updatedAt: new Date() })
      .where(eq(bookingRules.id, existing.id));
  } else {
    await db.insert(bookingRules).values({
      tenantId,
      serviceId: null,
      locationId: null,
      enabled: base.enabled ?? true,
      minNoticeMinutes: base.minNoticeMinutes ?? null,
      maxAdvanceDays: base.maxAdvanceDays ?? null,
      maxBookingsPerDay: base.maxBookingsPerDay ?? null,
      maxBookingsPerCustomerPerDay: base.maxBookingsPerCustomerPerDay ?? null,
      maxConcurrentBookings: base.maxConcurrentBookings ?? null,
      cooldownMinutes: base.cooldownMinutes ?? null,
      blackoutDates: base.blackoutDates ?? [],
      requireBusinessHours: base.requireBusinessHours ?? false,
      businessHours: base.businessHours ?? {},
    });
  }
}

async function insertTestBooking(args: {
  tenant: { id: string };
  service: { id: string };
  staff: { id: string };
  startAt: Date;
  endAt: Date;
  email: string;
}) {
  await db.insert(bookings).values({
    tenantId: args.tenant.id,
    serviceId: args.service.id,
    staffUserId: args.staff.id,
    clientName: TEST_NOTES_TAG,
    clientEmail: args.email,
    startAt: args.startAt,
    endAt: args.endAt,
    status: "confirmed",
    assignmentMode: "direct",
    notes: TEST_NOTES_TAG,
  });
}

function describe(res: { ok: boolean; error?: { code: string } }): string {
  return res.ok ? "ok" : `BLOCKED:${res.error?.code ?? "?"}`;
}

function nextWeekday(target: number): Date {
  // target: 0=Sun..6=Sat. Returns a Date object for the next occurrence
  // of that weekday at midnight UTC. Skip today even if today matches.
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  for (let i = 1; i <= 7; i++) {
    const candidate = new Date(d.getTime() + i * 24 * 60 * 60_000);
    if (candidate.getUTCDay() === target) return candidate;
  }
  return d;
}

function wallClockToUtc(date: Date, hhmm: string, timezone: string): Date {
  // Builds a Date object representing the given wall-clock time on the
  // given UTC date in the given timezone. Uses the same offset-walk
  // trick the booking-rules engine itself uses.
  const ymd = date.toISOString().slice(0, 10);
  const guess = new Date(`${ymd}T${hhmm}:00Z`);
  const localFromUtc = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(guess);
  const get = (t: string) =>
    Number(localFromUtc.find((p) => p.type === t)?.value ?? "0");
  const back = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  const diff = guess.getTime() - back;
  return new Date(guess.getTime() + diff);
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(2);
});
