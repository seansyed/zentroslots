/**
 * GET /api/admin/tenants/search?q=foo
 *
 * Lightweight tenant search for the SA-9 command palette. Returns
 * up to 10 tenants matching by name/slug/email (case-insensitive).
 * Distinct from /api/admin/tenants/intelligence which runs the full
 * 18-column scoring pipeline — this endpoint is built for sub-100ms
 * keystroke-time responses.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requireSuperAdmin();
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length < 1) {
      return NextResponse.json({ tenants: [] }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const term = `%${q.toLowerCase()}%`;
    const rows = (await db.execute(
      sql`SELECT id::text AS id, name, slug, plan, active
            FROM tenants
           WHERE LOWER(name) LIKE ${term}
              OR LOWER(slug) LIKE ${term}
              OR LOWER(COALESCE(billing_email, '')) LIKE ${term}
           ORDER BY active DESC, name ASC
           LIMIT 10`,
    )) as unknown as Array<{ id: string; name: string; slug: string; plan: string; active: boolean }>;
    return NextResponse.json(
      { tenants: rows },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
