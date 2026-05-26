/**
 * GET /api/admin/ops — Stabilization Wave operator diagnostics bundle.
 */
import { NextResponse } from "next/server";
import { computeOpsDiagnostics } from "@/lib/admin-analytics/opsDiagnostics";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const bundle = await computeOpsDiagnostics();
    return NextResponse.json(bundle, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
