import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";
import { planFeature } from "@/lib/quotas";
import { invalidateTenantTimezone } from "@/lib/tenant-timezone";

/** True when `tz` is a real IANA zone the runtime can format. */
function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  logoUrl: z.string().url().nullable().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected hex like #1a2b3c").optional(),
  tagline: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  bookingHeadline: z.string().max(200).nullable().optional(),
  billingEmail: z.string().email().nullable().optional(),
  // Canonical BUSINESS timezone (IANA). Core scheduling setting — NOT gated
  // behind the branding plan feature. Drives booking interpretation + display.
  timezone: z
    .string()
    .max(64)
    .refine(isValidIanaTimezone, "Invalid timezone")
    .optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireRole(["admin"]);
    const body = patchSchema.parse(await req.json());

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, admin.tenantId) });
    if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

    // Gate branding fields behind the plan feature flag.
    const usesBrandingFields =
      body.logoUrl !== undefined ||
      body.primaryColor !== undefined ||
      body.tagline !== undefined ||
      body.description !== undefined ||
      body.bookingHeadline !== undefined;
    if (usesBrandingFields && !planFeature(tenant.currentPlan, "customBranding")) {
      return NextResponse.json(
        { error: "Custom branding requires Pro or higher." },
        { status: 402 }
      );
    }

    const [updated] = await db
      .update(tenants)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(tenants.id, admin.tenantId))
      .returning();

    // Drop the cached business tz so the new value takes effect immediately
    // across booking interpretation + display.
    if (body.timezone !== undefined) invalidateTenantTimezone(admin.tenantId);

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      logoUrl: updated.logoUrl,
      primaryColor: updated.primaryColor,
      tagline: updated.tagline,
      description: updated.description,
      bookingHeadline: updated.bookingHeadline,
      billingEmail: updated.billingEmail,
      timezone: updated.timezone,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
