import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantDomains } from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import {
  createCustomHostname,
  extractCfErrors,
  mapCfSslStatus,
  refreshHostnameStatus,
} from "@/lib/cloudflare-hostnames";
import {
  dnsInstructions,
  invalidateHostnameCache,
  serializeDomain,
  verifyDomainDns,
} from "@/lib/domains";

/**
 * POST /api/tenant/domains/[id]/verify
 *
 * Two-stage operation, both run on every call:
 *
 *   Stage A — DNS verification (real lookups)
 *     - Resolves the TXT verification record and CNAME via node:dns
 *     - Marks status = verified | failed
 *     - Sets last_checked_at + verified_at on first success
 *
 *   Stage B — Cloudflare edge provisioning (Phase 15C)
 *     - If verification just passed and no cf_hostname_id yet:
 *         creates a Cloudflare Custom Hostname for automatic TLS
 *     - Always refreshes ssl_status from Cloudflare (if cf id present)
 *     - Sets activated_at the first time ssl_status hits "active"
 *     - Surfaces CF validation errors into verification_errors so the
 *       operator UI can show actionable diagnostics
 *
 * If CLOUDFLARE_API_TOKEN is unset, Stage B is skipped cleanly — the
 * domain stays verified at the DNS layer with ssl_status="pending".
 * No fake "active" state is ever written.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireRole(["admin"]);
    const { id } = await params;

    const row = await db.query.tenantDomains.findFirst({
      where: and(
        eq(tenantDomains.id, id),
        eq(tenantDomains.tenantId, admin.tenantId),
      ),
    });
    if (!row) throw new HttpError(404, "Domain not found");

    // ─── Stage A: DNS verification ──────────────────────────────
    const outcome = await verifyDomainDns(row.normalizedHost, row.verificationToken);
    const verifiedNow = outcome.status === "verified";
    const verifiedAt = verifiedNow ? row.verifiedAt ?? outcome.checkedAt : null;

    // ─── Stage B: Cloudflare edge provisioning ─────────────────
    let sslStatus: string = outcome.sslStatus;
    let cfHostnameId: string | null = row.cfHostnameId;
    let activatedAt: Date | null = row.activatedAt;
    let verificationErrors: string | null = outcome.reason ?? null;

    if (verifiedNow) {
      // 1) Provision CF Custom Hostname if not yet created
      if (!cfHostnameId) {
        const created = await createCustomHostname(row.normalizedHost);
        if (created.ok) {
          cfHostnameId = created.result.id;
          const mapped = mapCfSslStatus(created.result.ssl?.status);
          sslStatus = mapped.status;
          verificationErrors = extractCfErrors(created.result);
        } else {
          // 503 = CF not configured → leave ssl_status untouched as
          // "pending". Any other error → surface it but don't fail
          // the whole verify call (DNS already passed).
          if (created.status !== 503) {
            verificationErrors = created.message;
          }
        }
      } else {
        // 2) Already provisioned — refresh state
        const refreshed = await refreshHostnameStatus(cfHostnameId);
        if (refreshed.ok) {
          const mapped = mapCfSslStatus(refreshed.result.ssl?.status);
          sslStatus = mapped.status;
          verificationErrors = extractCfErrors(refreshed.result);
        }
      }

      // First-time active → stamp activated_at
      if (sslStatus === "active" && !activatedAt) {
        activatedAt = outcome.checkedAt;
      }
    } else {
      // DNS failed — never write "active". Keep last known cf state.
      sslStatus = row.sslStatus;
    }

    // ─── Persist ────────────────────────────────────────────────
    const [updated] = await db
      .update(tenantDomains)
      .set({
        status: outcome.status,
        sslStatus,
        cfHostnameId,
        verificationErrors,
        verifiedAt,
        activatedAt,
        lastCheckedAt: outcome.checkedAt,
        updatedAt: outcome.checkedAt,
      })
      .where(eq(tenantDomains.id, row.id))
      .returning();

    invalidateHostnameCache(row.normalizedHost);

    // Audit — log every verification attempt outcome.
    await audit({
      tenantId: admin.tenantId,
      action: verifiedNow ? "domain.verified" : "domain.verify_failed",
      actorUserId: admin.id,
      entityType: "tenant_domain",
      entityId: row.id,
      ipAddress: ipFromHeaders(req.headers),
      metadata: {
        host: row.normalizedHost,
        ssl_status: sslStatus,
        cf_hostname_id: cfHostnameId,
        reason: verificationErrors ?? undefined,
      },
    });

    return NextResponse.json({
      domain: serializeDomain(updated),
      instructions: dnsInstructions(updated.normalizedHost, updated.verificationToken),
      outcome: {
        status: outcome.status,
        sslStatus,
        txt: outcome.txt,
        cname: outcome.cname,
        reason: verificationErrors,
        checkedAt: outcome.checkedAt.toISOString(),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
