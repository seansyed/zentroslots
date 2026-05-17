import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { promotions } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

const promoInput = z.object({
  code: z.string().min(2).max(40).regex(/^[A-Z0-9_-]+$/i, "letters, digits, _ or -"),
  description: z.string().max(500).nullish(),
  kind: z.enum(["percent", "fixed", "trial_extension"]),
  percentOff: z.number().int().min(1).max(100).nullish(),
  amountOffCents: z.number().int().min(1).nullish(),
  trialExtensionDays: z.number().int().min(1).max(365).nullish(),
  appliesToPlan: z.string().max(40).nullish(),
  maxRedemptions: z.number().int().min(1).nullish(),
  startsAt: z.string().datetime().nullish(),
  expiresAt: z.string().datetime().nullish(),
  active: z.boolean().default(true),
}).refine(
  (p) =>
    (p.kind === "percent" && p.percentOff != null) ||
    (p.kind === "fixed" && p.amountOffCents != null) ||
    (p.kind === "trial_extension" && p.trialExtensionDays != null),
  { message: "Value field must match kind" }
);

export async function GET() {
  try {
    await requireSuperAdmin();
    const rows = await db
      .select()
      .from(promotions)
      .orderBy(desc(promotions.createdAt));
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireSuperAdmin();
    const body = promoInput.parse(await req.json());
    try {
      const [row] = await db
        .insert(promotions)
        .values({
          ...body,
          code: body.code.toUpperCase(),
          startsAt: body.startsAt ? new Date(body.startsAt) : null,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        })
        .returning();
      return NextResponse.json(row, { status: 201 });
    } catch (e: unknown) {
      // Unique-violation on code — surface cleanly.
      if ((e as { code?: string })?.code === "23505") {
        throw new HttpError(409, "Promotion code already exists");
      }
      throw e;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
