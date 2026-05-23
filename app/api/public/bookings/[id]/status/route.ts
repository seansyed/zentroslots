/**
 * Wave H Phase 3 — public booking status poll.
 *
 *   GET /api/public/bookings/<id>/status
 *
 * Read-only status indicator for the post-checkout redirect page.
 * Returns the minimum the client needs to render
 *   "Awaiting confirmation..." vs "Confirmed" vs "Payment failed".
 *
 * Critical: this endpoint NEVER mutates a booking. The customer can
 * hit it infinitely without changing state. Booking finalization
 * happens exclusively in the webhook receiver — never here, never
 * in the redirect page, never in any client-trustable code path.
 *
 * Privacy: returns minimal fields. No email, no internal notes, no
 * provider session ids. The booking id is the access token (UUID v4,
 * ~122 bits entropy — unguessable across tenants).
 *
 * Rate-limited per IP to discourage enumeration attempts.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings } from "@/db/schema";
import { ipFromHeaders } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // 60 requests per minute per IP — comfortable for a poll-every-2-seconds
  // confirmation page, hostile to enumeration.
  const ip = ipFromHeaders(req.headers) ?? "anon";
  const rl = rateLimit({
    key: `booking-status:${ip}`,
    capacity: 60,
    refillTokens: 60,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

  const { id } = await context.params;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    // Don't reveal a 404 vs a 400 — both look like "not found" to a
    // probing attacker.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const row = await db.query.bookings.findFirst({
    where: eq(bookings.id, id),
    columns: {
      id: true,
      status: true,
      startAt: true,
      endAt: true,
      paymentHoldExpiresAt: true,
      paymentProviderId: true,
    },
  });
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Return the minimum the redirect page needs. No email, no client
  // name, no notes, no provider session id, no tenant id.
  return NextResponse.json({
    id: row.id,
    status: row.status,
    startAt: row.startAt,
    endAt: row.endAt,
    // Boolean — the page renders different copy when the hold is
    // about to expire. Don't surface the actual timestamp (would let
    // a probing attacker learn the hold window).
    paymentPending: row.status === "pending_payment",
    // Boolean — tells the UI whether to show a Wave H badge ("via
    // tenant Stripe") vs the legacy platform indicator. NEVER surface
    // the actual provider id.
    isTenantVault: !!row.paymentProviderId,
  });
}
