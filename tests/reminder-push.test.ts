/**
 * Reminder push copy + event wiring.
 *
 * `booking_reminder` is now enqueued by scripts/send-reminders.ts (alongside the
 * email) for the 24h/2h/1h windows. These tests lock the push CONTENT and prove
 * `booking_reminder` is a first-class, formatted PushEventType (it was
 * previously defined-but-never-enqueued).
 *
 * The "enqueued exactly once" guarantee is enforced at the DB layer by the
 * atomic `reminder*SentAt` claim in send-reminders.ts (the same claim that
 * dedups the email): the push is enqueued only on the run that wins the claim,
 * and is placed AFTER triggerAutomation so an engine throw that releases the
 * claim cannot double-enqueue. That is an integration property of the worker;
 * here we cover the pure, importable surface (copyFor).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { copyFor, type PushEventType } from "../lib/push/enqueue";

function args(overrides: Partial<{ startAt: Date; clientName: string; serviceName: string }> = {}) {
  return {
    tenantId: "t1",
    booking: {
      id: "b1",
      staffUserId: "u1",
      clientName: overrides.clientName ?? "Jordan Lee",
      startAt: overrides.startAt ?? new Date(Date.now() + 2 * 60 * 60_000), // 2h out
      serviceId: "s1",
    },
    serviceName: overrides.serviceName ?? "Intro Consultation",
    event: "booking_reminder" as PushEventType,
  };
}

test("booking_reminder copy: title + service + client + relative time", () => {
  const c = copyFor("booking_reminder", args(), "UTC");
  assert.equal(c.title, "Upcoming appointment");
  assert.match(c.body, /Intro Consultation/);
  assert.match(c.body, /Jordan Lee/);
  // 2h out → formatRelativeBrief renders "in 2h".
  assert.match(c.body, /in 2h/);
});

test("booking_reminder 1h window renders 'in 1h'", () => {
  const c = copyFor("booking_reminder", args({ startAt: new Date(Date.now() + 60 * 60_000) }), "UTC");
  assert.match(c.body, /in 1h/);
});

test("booking_reminder falls back to 'Appointment' when service name is empty", () => {
  const c = copyFor("booking_reminder", args({ serviceName: "" }), "UTC");
  assert.match(c.body, /^Appointment with /);
});

test("each PushEventType has distinct, non-empty copy (reminder included)", () => {
  const events: PushEventType[] = [
    "booking_created",
    "booking_reminder",
    "booking_cancelled",
    "booking_rescheduled",
  ];
  const titles = new Set<string>();
  for (const e of events) {
    const c = copyFor(e, { ...args(), event: e }, "UTC");
    assert.ok(c.title.length > 0, `${e} title`);
    assert.ok(c.body.length > 0, `${e} body`);
    titles.add(c.title);
  }
  assert.equal(titles.size, events.length, "every event has a distinct title");
});
