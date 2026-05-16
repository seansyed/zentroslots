import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { ensureStripeCustomer, getStripe, isStripeConfigured } from "@/lib/stripe";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3001";

export async function POST() {
  try {
    if (!isStripeConfigured()) {
      throw new HttpError(503, "Stripe is not configured on this server.");
    }
    const admin = await requireRole(["admin"]);
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, admin.tenantId) });
    if (!tenant) throw new HttpError(404, "Tenant not found");

    const customerId = await ensureStripeCustomer(tenant, admin.email);
    const stripe = await getStripe();

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${APP_BASE_URL}/dashboard/billing`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    return errorResponse(err);
  }
}
