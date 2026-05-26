/**
 * /api/admin/dev/simulation — simulation control endpoints.
 *
 *   GET  → returns isEnabled + currentStatus
 *   POST → runs an action: { action: "run"|"reset"|"inject", mode?, kind? }
 *
 * Triple-gated:
 *   1. requireSuperAdmin() — super-admin only.
 *   2. assertSeedingAllowed() inside each seeder — needs ALLOW_DEV_SIMULATION=true env.
 *   3. Every seeded row carries SEEDED_BY_MARKER → reset cannot touch real data.
 */
import { NextRequest, NextResponse } from "next/server";

import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";
import {
  getSimulationStatus,
  injectFailure,
  isSeedingEnabled,
  resetSimulation,
  runSimulation,
  type InjectorKind,
  type SimulationMode,
} from "@/lib/dev-seeding";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const enabled = isSeedingEnabled();
    const status = enabled
      ? await getSimulationStatus().catch(() => ({ tenants: 0, users: 0, bookings: 0, auditLogs: 0 }))
      : { tenants: 0, users: 0, bookings: 0, auditLogs: 0 };
    return NextResponse.json(
      { enabled, status },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireSuperAdmin();
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      mode?: string;
      kind?: string;
    };
    const action = body.action ?? "";

    if (action === "run") {
      const mode = (body.mode ?? "medium") as SimulationMode;
      if (!["light", "medium", "heavy", "enterprise"].includes(mode)) {
        return NextResponse.json({ error: "invalid_mode" }, { status: 400 });
      }
      const report = await runSimulation(mode);
      return NextResponse.json(report, { headers: { "Cache-Control": "private, no-store" } });
    }

    if (action === "reset") {
      const result = await resetSimulation();
      return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
    }

    if (action === "inject") {
      const kind = body.kind as InjectorKind;
      const allowed: InjectorKind[] = [
        "churn_spike",
        "booking_spike",
        "reminder_failures",
        "oauth_failures",
        "webhook_flood",
      ];
      if (!allowed.includes(kind)) {
        return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
      }
      const result = await injectFailure(kind);
      return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
    }

    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}
