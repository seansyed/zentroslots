import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { customers, tenants } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { getClientSession } from "@/lib/client-auth";
import { normalizePrefs } from "@/lib/client-prefs";
import { audit, ipFromHeaders } from "@/lib/audit";

// GET /api/client/[slug]/preferences — returns normalized prefs.
// PATCH same path — partial update; missing keys are left untouched.
//
// The delivery pipeline (scripts/send-reminders.ts) reads this directly,
// so toggles here actually affect outbound mail in production.

const patchSchema = z.object({
  emailEnabled:         z.boolean().optional(),
  smsEnabled:           z.boolean().optional(),
  reminder24hEnabled:   z.boolean().optional(),
  reminder1hEnabled:    z.boolean().optional(),
  // Phase 2A — per-event toggles. Defaults true for all pre-existing
  // customers via normalizePrefs() so behavior is unchanged until
  // the customer explicitly opts out.
  confirmationsEnabled: z.boolean().optional(),
  cancellationsEnabled: z.boolean().optional(),
  waitlistEnabled:      z.boolean().optional(),
  marketingEnabled:     z.boolean().optional(),
});

async function loadContext(slug: string) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.active) throw new HttpError(404, "Workspace not found");

  const session = await getClientSession();
  if (!session || session.tenantId !== tenant.id) {
    throw new HttpError(401, "Not signed in");
  }

  const customer = await db.query.customers.findFirst({
    where: and(eq(customers.id, session.customerId), eq(customers.tenantId, tenant.id)),
  });
  if (!customer) throw new HttpError(404, "Customer record not found");
  return { tenant, customer };
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const { customer } = await loadContext(slug);
    return NextResponse.json(normalizePrefs(customer.commPrefs));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const { tenant, customer } = await loadContext(slug);

    const body = patchSchema.parse(await req.json());
    if (Object.keys(body).length === 0) throw new HttpError(400, "Nothing to update");

    // Merge over the current canonical prefs so callers can PATCH a single
    // toggle without clobbering the rest.
    const merged = { ...normalizePrefs(customer.commPrefs), ...body };

    const [updated] = await db
      .update(customers)
      .set({ commPrefs: merged, updatedAt: new Date() })
      .where(and(eq(customers.id, customer.id), eq(customers.tenantId, tenant.id)))
      .returning();

    audit({
      tenantId: tenant.id,
      action: "client.preferences.update",
      entityType: "customer",
      entityId: updated.id,
      actorLabel: `${updated.name} <${updated.email}>`,
      metadata: { changed: Object.keys(body) },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json(normalizePrefs(updated.commPrefs));
  } catch (err) {
    return errorResponse(err);
  }
}
