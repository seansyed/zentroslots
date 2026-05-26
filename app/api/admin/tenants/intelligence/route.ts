/**
 * GET /api/admin/tenants/intelligence
 *
 * Paginated server-side query. Returns one page of tenant rows with
 * all 18 columns + computed health/risk scores. Pagination + filter +
 * sort + search all enforced at the DB level.
 *
 * Query params:
 *   search    free-text (name OR slug OR billingEmail, ilike)
 *   plan      exact match
 *   status    exact match (subscriptionStatus)
 *   risk      low | medium | high | critical (post-compute filter)
 *   sort      mrr | growth | health | risk | created | lastActive | name
 *   order     asc | desc
 *   page      1-based
 *   pageSize  5..100
 *   format    csv | json (json default)
 *
 * `format=csv` streams every row in the current filter (NOT paginated)
 * — used by the CSV export button.
 */
import { NextRequest, NextResponse } from "next/server";

import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";
import { fetchTenantIntelligence } from "@/lib/admin-analytics/tenant-intelligence";
import type { RiskLevel } from "@/lib/admin-analytics/tenant-scoring";

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
    const q = {
      search: url.searchParams.get("search") ?? undefined,
      plan: url.searchParams.get("plan") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      risk: (url.searchParams.get("risk") as RiskLevel | undefined) ?? undefined,
      sort: (url.searchParams.get("sort") as
        | "mrr"
        | "growth"
        | "health"
        | "risk"
        | "created"
        | "lastActive"
        | "name"
        | undefined) ?? undefined,
      order: (url.searchParams.get("order") as "asc" | "desc" | undefined) ?? undefined,
      page: url.searchParams.get("page") ? parseInt(url.searchParams.get("page")!, 10) : undefined,
      pageSize: url.searchParams.get("pageSize")
        ? parseInt(url.searchParams.get("pageSize")!, 10)
        : undefined,
    };
    const format = url.searchParams.get("format");

    if (format === "csv") {
      // CSV: pull up to 5000 rows in one shot (admin export tool —
      // not customer-facing; safe to send larger payload).
      const page = await fetchTenantIntelligence({ ...q, page: 1, pageSize: 5000 });
      const header = [
        "id",
        "name",
        "slug",
        "plan",
        "subscription_status",
        "mrr_cents",
        "user_count",
        "bookings_30d",
        "booking_growth_pct",
        "health_score",
        "risk_level",
        "churn_probability_pct",
        "google_connected",
        "microsoft_connected",
        "custom_domain",
        "failed_payments_30d",
        "onboarding_completed",
        "created_at",
        "trial_end",
        "last_active_at",
      ];
      const lines = [header.join(",")];
      for (const r of page.rows) {
        lines.push(
          [
            r.id,
            csvEscape(r.name),
            r.slug,
            r.plan ?? "",
            r.subscriptionStatus ?? "",
            r.mrrCents,
            r.userCount,
            r.bookings30d,
            r.bookingGrowthPct ?? "",
            r.healthScore,
            r.riskLevel,
            r.churnProbabilityPct,
            r.googleConnected,
            r.microsoftConnected,
            csvEscape(r.customDomain ?? ""),
            r.failedPayments30d,
            r.onboardingCompleted,
            r.createdAt,
            r.trialEnd ?? "",
            r.lastActiveAt ?? "",
          ].join(","),
        );
      }
      const csv = lines.join("\n");
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="tenant-intelligence-${new Date().toISOString().slice(0, 10)}.csv"`,
          "Cache-Control": "private, no-store",
        },
      });
    }

    const page = await fetchTenantIntelligence(q);
    return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
