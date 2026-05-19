import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { ensureStripeCustomer, getStripe, isStripeConfigured, priceIdFor } from "@/lib/stripe";

const bodySchema = z.object({
  plan: z.enum(["pro", "team"]),
  trialDays: z.number().int().min(0).max(30).optional(),
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

    const priceId = priceIdFor(body.plan);
    if (!priceId) throw new HttpError(400, `No Stripe price configured for ${body.plan}`);

    const customerId = await ensureStripeCustomer(tenant, admin.email);
    const stripe = await getStripe();

    // Idempotency key derived from (tenantId, plan, calendar-hour).
    // A double-click within the same hour returns the same session
    // instead of creating a second one. Hour granularity keeps
    // legitimate retries (e.g. user switches from pro→team) working.
    const hourBucket = Math.floor(Date.now() / (60 * 60_000));
    const idempotencyKey = `sub-checkout:${tenant.id}:${body.plan}:${hourBucket}`;

    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: body.trialDays ? { trial_period_days: body.trialDays } : undefined,
        success_url: `${APP_BASE_URL}/dashboard/billing?status=success`,
        cancel_url: `${APP_BASE_URL}/dashboard/billing?status=cancelled`,
        allow_promotion_codes: true,
        metadata: { tenantId: tenant.id, plan: body.plan },
      },
      { idempotencyKey }
    );

    return NextResponse.json({ url: session.url });
  } catch (err) {
    return errorResponse(err);
  }
}
