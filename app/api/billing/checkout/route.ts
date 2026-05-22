import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { ensureStripeCustomer, getStripe, isStripeConfigured, priceIdFor } from "@/lib/stripe";

// Phase 16A — accept the new Solo + Enterprise tiers and an optional
// `interval` ("month" | "year"). Interval defaults to "month" so any
// older clients (and any direct API callers that don't know about
// yearly billing) keep behaving exactly as they did.
//
// Phase 16E — `trialDays` removed. Free trials are not part of the
// product offering: Free is its own permanent tier; paid tiers bill
// immediately. If a future tier ever needs a trial it should be
// configured server-side per Stripe Price (so the trial lives in
// Stripe Dashboard and is verifiable, never injected client-side).
const bodySchema = z.object({
  plan: z.enum(["solo", "pro", "team", "enterprise"]),
  interval: z.enum(["month", "year"]).default("month"),
});

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3001";

export async function POST(req: NextRequest) {
  try {
    if (!isStripeConfigured()) {
      throw new HttpError(503, "Stripe is not configured on this server.");
    }
    const admin = await requireRole(["admin"]);
    const body = bodySchema.parse(await req.json());

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, admin.tenantId) });
    if (!tenant) throw new HttpError(404, "Tenant not found");

    const priceId = priceIdFor(body.plan, body.interval);
    if (!priceId) {
      throw new HttpError(
        400,
        `No Stripe price configured for ${body.plan} (${body.interval}ly). Set the matching STRIPE_PRICE_* env var.`,
      );
    }

    const customerId = await ensureStripeCustomer(tenant, admin.email);
    const stripe = await getStripe();

    // Idempotency key derived from (tenantId, plan, interval,
    // calendar-hour). A double-click within the same hour returns the
    // same session instead of creating a second one. Including interval
    // means switching monthly↔yearly within the hour creates a fresh
    // session (correct — different price).
    //
    // ── Versioning (Phase 16E hotfix) ──
    // BUMP THIS VERSION any time the shape of the Stripe checkout
    // session request body changes. Stripe caches the response under
    // an idempotency key for 24 hours; a key reused with different
    // params 409s ("Keys for idempotent requests can only be used
    // with the same parameters they were first used with"). v2
    // invalidates all v1 keys cached during the 14-day-trial bug
    // window — those keys had `subscription_data.trial_period_days`
    // baked into the request, the current body does not.
    const IDEMPOTENCY_VERSION = "v2";
    const hourBucket = Math.floor(Date.now() / (60 * 60_000));
    const idempotencyKey = `sub-checkout:${IDEMPOTENCY_VERSION}:${tenant.id}:${body.plan}:${body.interval}:${hourBucket}`;

    // No `subscription_data.trial_period_days` — paid plans bill on
    // first charge. If a specific Stripe Price has a trial configured
    // in the Stripe Dashboard, Stripe will honor it without us
    // forcing one here. (See Phase 16E.)
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${APP_BASE_URL}/dashboard/billing?status=success`,
        cancel_url: `${APP_BASE_URL}/dashboard/billing?status=cancelled`,
        allow_promotion_codes: true,
        metadata: { tenantId: tenant.id, plan: body.plan, interval: body.interval },
      },
      { idempotencyKey }
    );

    return NextResponse.json({ url: session.url });
  } catch (err) {
    return errorResponse(err);
  }
}
