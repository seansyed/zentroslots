import { NextResponse } from "next/server";

/**
 * Legacy entry point: GET /api/google/connect
 *
 * Wave A — consolidated to the orchestrator's connect path.
 *
 * Now simply redirects to /api/calendar/google/connect which carries
 * the workspace integration gate + new authUrl flow. We preserve the
 * legacy URL so any cached deep links / dashboard buttons keep working.
 *
 * No body of its own anymore — the new endpoint owns all role checks,
 * workspace-disabled checks, and OAuth url construction.
 */
export async function GET() {
  return NextResponse.redirect(
    new URL("/api/calendar/google/connect", process.env.APP_BASE_URL ?? "http://localhost:3001"),
    { status: 307 },
  );
}
