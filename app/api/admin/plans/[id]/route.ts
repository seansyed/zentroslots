import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { plans } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

const patchInput = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullish(),
  priceMonthlyCents: z.number().int().min(0).optional(),
  priceYearlyCents: z.number().int().min(0).optional(),
  stripePriceIdMonthly: z.string().max(120).nullish(),
  stripePriceIdYearly: z.string().max(120).nullish(),
  quotaStaff: z.number().int().min(0).optional(),
  quotaBookingsPerMonth: z.number().int().min(0).optional(),
  quotaServices: z.number().int().min(0).optional(),
  features: z.array(z.string().min(1).max(120)).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin();
    const { id } = await context.params;
    const body = patchInput.parse(await req.json());
    const [row] = await db
      .update(plans)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(plans.id, id))
      .returning();
    if (!row) throw new HttpError(404, "Plan not found");
    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin();
    const { id } = await context.params;
    // Soft-delete by deactivating — keeps historical references intact for
    // any tenant whose `current_plan` slug pointed here.
    const [row] = await db
      .update(plans)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(plans.id, id))
      .returning();
    if (!row) throw new HttpError(404, "Plan not found");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
