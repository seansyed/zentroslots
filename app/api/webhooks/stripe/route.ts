import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

// Use Node runtime so we can read the raw body for signature verification.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function planFromPriceId(priceId: string | null | undefined): string | null {
  if (!priceId) return null;
  if (process.env.STRIPE_PRICE_PRO && priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (process.env.STRIPE_PRICE_TEAM && priceId === process.env.STRIPE_PRICE_TEAM) return "team";
  return null;
}

export async function POST(req: NextRequest) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Missing STRIPE_WEBHOOK_SECRET" }, { status: 500 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });

  const stripe = await getStripe();
  const raw = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const tenantId = (session.metadata?.tenantId as string | undefined) ?? null;
        const plan = (session.metadata?.plan as string | undefined) ?? null;
        if (tenantId) {
          await db
            .update(tenants)
            .set({
              stripeCustomerId: (session.customer as string) ?? null,
              stripeSubscriptionId: (session.subscription as string) ?? null,
              subscriptionStatus: "active",
              currentPlan: plan ?? "pro",
              updatedAt: new Date(),
            })
            .where(eq(tenants.id, tenantId));
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const priceId = sub.items?.data?.[0]?.price?.id;
        const planLabel = planFromPriceId(priceId);
        const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;

        await db
          .update(tenants)
          .set({
            stripeSubscriptionId: sub.id,
            subscriptionStatus: sub.status,
            currentPlan: planLabel ?? undefined,
            trialEnd,
            updatedAt: new Date(),
          })
          .where(eq(tenants.stripeCustomerId, customerId));
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        await db
          .update(tenants)
          .set({
            stripeSubscriptionId: null,
            subscriptionStatus: "canceled",
            currentPlan: "free",
            updatedAt: new Date(),
          })
          .where(eq(tenants.stripeCustomerId, customerId));
        break;
      }

      default:
        // Ignore other events for MVP — Stripe is happy with a 200.
        break;
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook handler error:", err);
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}
