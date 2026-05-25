/**
 * Phase ICAL-4 — tenant-wide external feed health observability.
 *
 *   GET /api/admin/calendar-feed-health
 *
 * Admin/manager only. Returns aggregate metrics for the calling
 * tenant's external ICS feeds:
 *   • total / by health state
 *   • avg sync duration
 *   • top provider kinds
 *   • top error categories
 *
 * Strictly tenant-scoped. The Phase ICAL-3 schema guarantees every
 * feed row carries tenant_id; we WHERE on it in every query.
 *
 * Why a separate endpoint (not folded into /api/health):
 *   • /api/health is INFRA health (DB up, SMTP reachable, etc.).
 *     Feed health is OPERATIONAL — it's about a specific feature's
 *     state for one tenant. Separating them keeps the infra health
 *     check cheap + non-tenant-scoped.
 *   • This endpoint pulls per-feed rows + classifies them through
 *     the Phase ICAL-4 health classifier. That's not appropriate
 *     for the load-balancer health probe.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { externalCalendarFeeds } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";
import { classifyFeedHealth, type FeedHealthState } from "@/lib/calendar/externalFeeds/feedHealth";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const caller = await requireRole(["admin", "manager"]);

    const rows = await db
      .select()
      .from(externalCalendarFeeds)
      .where(eq(externalCalendarFeeds.tenantId, caller.tenantId));

    const now = new Date();

    // Per-row health classification.
    const classified = rows.map((r) => ({
      row: r,
      health: classifyFeedHealth(
        {
          isEnabled: r.isEnabled,
          lastSyncedAt: r.lastSyncedAt,
          lastSyncStatus: r.lastSyncStatus,
          consecutiveFailures: r.consecutiveFailures,
          createdAt: r.createdAt,
        },
        now,
      ),
    }));

    // ─── Bucket counts ──────────────────────────────────────────
    const byState: Record<FeedHealthState, number> = {
      healthy: 0,
      warning: 0,
      stale: 0,
      error: 0,
      disabled: 0,
    };
    for (const c of classified) byState[c.health.state]++;

    // ─── Provider distribution ──────────────────────────────────
    const byProvider: Record<string, number> = {};
    for (const c of classified) {
      const k = c.row.providerKind || "other";
      byProvider[k] = (byProvider[k] ?? 0) + 1;
    }

    // ─── Error category breakdown ───────────────────────────────
    // We bucket by lastSyncStatus when it indicates failure.
    const errorCategories: Record<string, number> = {};
    for (const c of classified) {
      const s = c.row.lastSyncStatus;
      if (
        s &&
        s !== "ok" &&
        s !== "not_modified" &&
        s !== "pending"
      ) {
        errorCategories[s] = (errorCategories[s] ?? 0) + 1;
      }
    }

    // ─── Sync duration stats ────────────────────────────────────
    const durations = rows
      .map((r) => r.syncDurationMs)
      .filter((d): d is number => typeof d === "number" && d > 0);
    const avgDurationMs =
      durations.length > 0
        ? Math.round(
            durations.reduce((a, b) => a + b, 0) / durations.length,
          )
        : null;
    const p95DurationMs =
      durations.length >= 5
        ? Math.round(durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)])
        : null;

    // ─── Event volume ───────────────────────────────────────────
    const totalImportedEvents = rows.reduce(
      (sum, r) => sum + (r.eventCount ?? 0),
      0,
    );

    // ─── Recent failing feeds — surface up to 10 with redacted
    // identity (id + provider + state) for quick triage. ──────────
    const recentFailing = classified
      .filter(
        (c) =>
          c.health.state === "error" ||
          c.health.state === "stale" ||
          c.health.state === "warning",
      )
      .slice(0, 10)
      .map((c) => ({
        feedId: c.row.id,
        providerKind: c.row.providerKind,
        state: c.health.state,
        reason: c.health.reason,
        lastSyncedAt: c.row.lastSyncedAt?.toISOString() ?? null,
        consecutiveFailures: c.row.consecutiveFailures,
      }));

    return NextResponse.json({
      tenantId: caller.tenantId,
      generatedAt: now.toISOString(),
      total: rows.length,
      byState,
      byProvider,
      errorCategories,
      durations: {
        avgMs: avgDurationMs,
        p95Ms: p95DurationMs,
        sampleSize: durations.length,
      },
      totalImportedEvents,
      recentFailing,
      // Aggregate success rate over the population (a feed is
      // "succeeding" if its current lastSyncStatus is ok or
      // not_modified). Distinct from a per-feed historical rate
      // which would need a separate timeseries table.
      successRate:
        rows.length > 0
          ? Math.round(
              (rows.filter(
                (r) =>
                  r.lastSyncStatus === "ok" ||
                  r.lastSyncStatus === "not_modified",
              ).length /
                rows.length) *
                100,
            )
          : 100,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
