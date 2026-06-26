import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { phoneCallLogs } from "@/db/schema";
import { errorResponse, requireRole, HttpError } from "@/lib/auth";
import { parseCallLogQuery, shapeCallLogRow } from "@/lib/business-line-calls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tenant/business-line/calls — paginated, filterable call log.
 *
 * Admin + manager (read-only operational data). Tenant-scoped. Supports
 * limit/offset, a status filter, an optional direction filter, and a startedAt
 * date range. Returns SAFE fields only via shapeCallLogRow — never raw Telnyx
 * payloads, signature headers, or internal call-control IDs.
 *
 * Read-only: no Telnyx contact, no forwarding, no settings mutation.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireRole(["admin", "manager"]);
    const tenantId = user.tenantId;

    const parsed = parseCallLogQuery(req.nextUrl.searchParams);
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const q = parsed.query;

    const conds = [eq(phoneCallLogs.tenantId, tenantId)];
    if (q.status) conds.push(eq(phoneCallLogs.status, q.status));
    if (q.direction) conds.push(eq(phoneCallLogs.direction, q.direction));
    if (q.from) conds.push(gte(phoneCallLogs.startedAt, q.from));
    if (q.to) conds.push(lt(phoneCallLogs.startedAt, q.to));

    // Fetch one extra row to compute hasMore without a second COUNT query.
    const rows = await db.query.phoneCallLogs.findMany({
      where: and(...conds),
      orderBy: [desc(phoneCallLogs.startedAt)],
      limit: q.limit + 1,
      offset: q.offset,
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;

    return NextResponse.json({
      calls: page.map(shapeCallLogRow),
      limit: q.limit,
      offset: q.offset,
      hasMore,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
