/**
 * GET /api/admin/security/audit — paginated audit-row explorer.
 *
 * Filters: action / actor / tenantId / ip / since / until / cursor / limit / format=csv
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchAuditRows } from "@/lib/admin-analytics/security";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes("\n") || s.includes('"')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: NextRequest) {
  try {
    await requireSuperAdmin();
    const url = new URL(req.url);
    const sp = url.searchParams;
    const args = {
      cursor: sp.get("cursor"),
      limit: sp.get("limit") ? parseInt(sp.get("limit")!, 10) : 50,
      action: sp.get("action"),
      actor: sp.get("actor"),
      tenantId: sp.get("tenantId"),
      ip: sp.get("ip"),
      since: sp.get("since"),
      until: sp.get("until"),
    };

    if (sp.get("format") === "csv") {
      // CSV export — pull up to 2000 rows in one shot. Admin tool;
      // safe to allow larger payload (no public exposure).
      const page = await fetchAuditRows({ ...args, limit: 2000, cursor: null });
      const header = ["id", "ts", "action", "actor", "tenant_id", "entity_type", "entity_id", "ip", "metadata"];
      const lines = [header.join(",")];
      for (const r of page.rows) {
        lines.push(
          [
            r.id,
            r.ts,
            csvEscape(r.action),
            csvEscape(r.actor ?? ""),
            r.tenantId ?? "",
            r.entityType ?? "",
            r.entityId ?? "",
            r.ipAddress ?? "",
            csvEscape(JSON.stringify(r.metadata ?? {})),
          ].join(","),
        );
      }
      return new NextResponse(lines.join("\n"), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
          "Cache-Control": "private, no-store",
        },
      });
    }

    const page = await fetchAuditRows(args);
    return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
