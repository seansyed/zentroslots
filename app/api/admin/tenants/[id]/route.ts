import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

// Single-route patch endpoint — covers suspend/reactivate, plan override,
// trial extension. Action shape is discriminated by `op` for one round-trip
// per UI button. Keeps the surface small and auditable in one place.
const patchSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("suspend") }),
  z.object({ op: z.literal("reactivate") }),
  z.object({ op: z.literal("plan_override"), plan: z.string().min(1).max(40) }),
  z.object({ op: z.literal("extend_trial"), days: z.number().int().min(1).max(365) }),
]);

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin();
    const { id } = await context.params;
    const body = patchSchema.parse(await req.json());

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
    if (!tenant) throw new HttpError(404, "Tenant not found");

    let patch: Partial<typeof tenants.$inferInsert> = { updatedAt: new Date() };

    switch (body.op) {
      case "suspend":
        patch = { ...patch, active: false };
        break;
      case "reactivate":
        patch = { ...patch, active: true };
        break;
      case "plan_override":
        // Both the legacy `plan` and the canonical `current_plan` are
        // written so old code paths that still read `plan` see the
        // change too.
        patch = { ...patch, plan: body.plan, currentPlan: body.plan };
        break;
      case "extend_trial": {
        const base = tenant.trialEnd && tenant.trialEnd > new Date() ? tenant.trialEnd : new Date();
        const next = new Date(base.getTime() + body.days * 24 * 60 * 60 * 1000);
        patch = { ...patch, trialEnd: next };
        break;
      }
    }

    const [updated] = await db
      .update(tenants)
      .set(patch)
      .where(eq(tenants.id, id))
      .returning();

    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}
