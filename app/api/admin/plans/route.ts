import { NextRequest, NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { plans } from "@/db/schema";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

const planInput = z.object({
  slug: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/, "lowercase, digits, hyphens only"),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  priceMonthlyCents: z.number().int().min(0).default(0),
  priceYearlyCents: z.number().int().min(0).default(0),
  stripePriceIdMonthly: z.string().max(120).nullish(),
  stripePriceIdYearly: z.string().max(120).nullish(),
  quotaStaff: z.number().int().min(0).default(1),
  quotaBookingsPerMonth: z.number().int().min(0).default(100),
  quotaServices: z.number().int().min(0).default(5),
  features: z.array(z.string().min(1).max(120)).default([]),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});

export async function GET() {
  try {
    await requireSuperAdmin();
    const rows = await db
      .select()
      .from(plans)
      .orderBy(asc(plans.sortOrder), asc(plans.priceMonthlyCents));
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireSuperAdmin();
    const body = planInput.parse(await req.json());
    const [row] = await db.insert(plans).values(body).returning();
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
