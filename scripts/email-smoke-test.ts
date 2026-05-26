#!/usr/bin/env tsx
/**
 * scripts/email-smoke-test.ts — one-shot SES delivery proof.
 *
 * Sends a single email through each of the production code paths and
 * reports the `sendEmail()` return value. Used immediately after SES
 * domain verification to confirm the wire is live without waiting for
 * a real customer booking to trigger a reminder.
 *
 * USAGE
 *   ON THE EC2 BOX:
 *     cd /var/www/scheduling-saas
 *     npm run email:smoke -- recipient@example.com
 *
 *   ALTERNATELY:
 *     tsx scripts/email-smoke-test.ts recipient@example.com
 *
 * The first positional arg is the recipient. We require it explicitly
 * so a stray invocation cannot dump tests to a random address. The
 * script NEVER inserts DB rows (no booking, no customer) — it only
 * exercises the email-send paths and reports back. communication_logs
 * stays clean from this script.
 *
 * Exits 0 on success (≥1 of the 4 send paths returned ok:true), or
 * 1 if all paths failed (treat as P0 alarm).
 */

import "dotenv/config";

import {
  sendEmail,
  renderConfirmation,
  renderReminder,
  renderCancellation,
  renderReschedule,
} from "../lib/email";
import { adminNotify } from "../lib/admin-notify";

// Mirror the (private) BookingForEmail shape locally so this script
// stays standalone without changing lib/email's export surface.
type BookingForEmailLike = Parameters<typeof renderConfirmation>[0];

function panic(msg: string): never {
  console.error(`[email:smoke] ${msg}`);
  process.exit(1);
}

const recipient = process.argv[2];
if (!recipient || !recipient.includes("@")) {
  panic(
    `Usage: tsx scripts/email-smoke-test.ts <recipient@domain>\n` +
      `  e.g. tsx scripts/email-smoke-test.ts admin@zentromeet.com\n` +
      `  This script will NOT run without an explicit recipient.`,
  );
}

// Test fixture used by all four booking-email renderers.
const fixtureBooking: BookingForEmailLike = {
  id: "00000000-0000-0000-0000-000000000000",
  clientName: "Smoke Test Client",
  clientEmail: recipient,
  staffEmail: recipient, // unused by these templates, but required by the type
  startAt: new Date(Date.now() + 24 * 60 * 60_000), // 24h from now
  endAt: new Date(Date.now() + 25 * 60 * 60_000),
  serviceName: "SES Wire Verification",
  tenantName: process.env.BRAND_NAME ?? "ZentroMeet",
  staffName: "Verification Bot",
  meetLink: null,
  cancelToken: "smoke-test-token-cancel",
  rescheduleToken: "smoke-test-token-reschedule",
};

type Step = { name: string; ok: boolean; provider?: string; reason?: string };
const steps: Step[] = [];

async function tryStep(name: string, fn: () => Promise<{ ok: boolean; reason?: string; provider?: string }>) {
  try {
    const r = await fn();
    steps.push({ name, ...r });
    const tag = r.ok ? "OK" : "FAIL";
    console.log(`[email:smoke] ${tag}  ${name}  provider=${r.provider ?? "?"}  ${r.reason ? "reason=" + r.reason : ""}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown";
    steps.push({ name, ok: false, reason });
    console.error(`[email:smoke] FAIL ${name}  threw=${reason}`);
  }
}

async function main() {
  console.log(`[email:smoke] recipient=${recipient}`);
  console.log(`[email:smoke] BRAND_NAME=${process.env.BRAND_NAME ?? "(unset)"}`);
  console.log(`[email:smoke] APP_BASE_URL=${process.env.APP_BASE_URL ?? "(unset)"}`);
  console.log(`[email:smoke] EMAIL_FROM=${process.env.EMAIL_FROM ?? "(unset)"}`);
  console.log(`[email:smoke] SMTP_HOST=${process.env.SMTP_HOST ?? "(unset)"}`);
  console.log("");

  // ── 1. booking confirmation ───────────────────────────────────────
  {
    const t = renderConfirmation(fixtureBooking);
    await tryStep("renderConfirmation", () =>
      sendEmail({ to: recipient, subject: `[SMOKE] ${t.subject}`, html: t.html, text: t.text }),
    );
  }

  // ── 2. 24h reminder ───────────────────────────────────────────────
  {
    const t = renderReminder(fixtureBooking, "24 hours");
    await tryStep("renderReminder(24h)", () =>
      sendEmail({ to: recipient, subject: `[SMOKE] ${t.subject}`, html: t.html, text: t.text }),
    );
  }

  // ── 3. 1h reminder ────────────────────────────────────────────────
  {
    const t = renderReminder(fixtureBooking, "1 hour");
    await tryStep("renderReminder(1h)", () =>
      sendEmail({ to: recipient, subject: `[SMOKE] ${t.subject}`, html: t.html, text: t.text }),
    );
  }

  // ── 4. cancellation ───────────────────────────────────────────────
  {
    const t = renderCancellation(fixtureBooking);
    await tryStep("renderCancellation", () =>
      sendEmail({ to: recipient, subject: `[SMOKE] ${t.subject}`, html: t.html, text: t.text }),
    );
  }

  // ── 5. reschedule notice ──────────────────────────────────────────
  {
    // renderReschedule takes the new booking (it shows the new time).
    // Caller is expected to have updated startAt/endAt before invoking.
    const t = renderReschedule({
      ...fixtureBooking,
      startAt: new Date(Date.now() + 48 * 60 * 60_000),
      endAt: new Date(Date.now() + 49 * 60 * 60_000),
    });
    await tryStep("renderReschedule", () =>
      sendEmail({ to: recipient, subject: `[SMOKE] ${t.subject}`, html: t.html, text: t.text }),
    );
  }

  // ── 6. admin-notify info (operational alert path) ────────────────
  // Different recipient — adminNotify resolves its own inbox cascade.
  // The send happens via the same SES SMTP transport, so it proves
  // the operational-alert path is live and not just the booking path.
  await tryStep("adminNotify(info)", async () => {
    const r = await adminNotify({
      kind: "new_tenant_signup",
      severity: "info",
      summary: "SES wire smoke test — please ignore",
      details: `One-shot send from scripts/email-smoke-test.ts at ${new Date().toISOString()}.`,
      metadata: {
        invocation: "smoke-test",
        recipient,
      },
      dedupeKey: `smoke-test::${Date.now()}`, // unique per run
    });
    return { ok: r.ok, reason: r.reason };
  });

  // ── Summary ────────────────────────────────────────────────────────
  console.log("");
  const okCount = steps.filter((s) => s.ok).length;
  const failCount = steps.length - okCount;
  console.log(`[email:smoke] summary: ${okCount} ok / ${failCount} failed (of ${steps.length} total)`);

  if (failCount > 0) {
    console.log("[email:smoke] FAILED STEPS:");
    for (const s of steps.filter((x) => !x.ok)) {
      console.log(`              - ${s.name}: ${s.reason ?? "?"}`);
    }
  }

  if (okCount === 0) {
    console.error("[email:smoke] ALL PATHS FAILED — SES is not live. Check .env + AWS Console.");
    process.exit(1);
  }
  console.log("[email:smoke] ✓ SES wire is live.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[email:smoke] fatal:", err);
  process.exit(1);
});
