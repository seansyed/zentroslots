import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";

export async function POST() {
  try {
    const admin = await requireRole(["admin"]);
    await db
      .update(tenants)
      .set({ onboardingCompletedAt: new Date(), updatedAt: new Date() })
      .where(eq(tenants.id, admin.tenantId));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
