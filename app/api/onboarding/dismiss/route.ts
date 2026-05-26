/**
 * Phase Onboarding-UX — dismiss / resume the dashboard checklist.
 *
 *   POST   /api/onboarding/dismiss  → sets onboarding_dismissed_at = now
 *   DELETE /api/onboarding/dismiss  → clears onboarding_dismissed_at (resume)
 *
 * Distinct from /api/onboarding/skip (wizard escape hatch) and
 * /api/onboarding/complete (terminal completion):
 *
 *   • skipped  — admin closed the WIZARD; redirect gate stops forcing
 *                them into it. Wizard progress preserved.
 *   • dismissed — admin closed the DASHBOARD CHECKLIST card. Dashboard
 *                renders a tiny "Resume setup" pill in its place until
 *                the user clicks it (or auto-completion fires).
 *   • completed — every REQUIRED task done. Terminal state. Set by
 *                the auto-completion fire in app/dashboard/page.tsx
 *                (or by the wizard terminal step).
 *
 * Admin-only. Idempotent: dismissing twice → ok; resuming when not
 * dismissed → ok.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const admin = await requireRole(["admin"]);
    await db
      .update(tenants)
      .set({ onboardingDismissedAt: new Date(), updatedAt: new Date() })
      .where(eq(tenants.id, admin.tenantId));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  try {
    const admin = await requireRole(["admin"]);
    await db
      .update(tenants)
      .set({ onboardingDismissedAt: null, updatedAt: new Date() })
      .where(eq(tenants.id, admin.tenantId));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
