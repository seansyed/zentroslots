/**
 * Background SSL sync — scripts/sync-domain-ssl.ts
 *
 * Phase 15C cron worker. Reconciles ssl_status / verification_errors /
 * activated_at for every domain that has a Cloudflare hostname id.
 * Run this on a 5-minute cadence:
 *
 *   *\/5 * * * *  cd /var/www/scheduling-saas && \
 *                 /usr/bin/node --experimental-strip-types \
 *                 scripts/sync-domain-ssl.ts \
 *                 >> /var/log/zm/sync-domain-ssl.log 2>&1
 *
 * What it does on each pass:
 *   - Loads every tenant_domain WHERE cf_hostname_id IS NOT NULL
 *   - Hits CF GET /custom_hostnames/:id for each
 *   - Updates ssl_status, verification_errors, last_checked_at
 *   - Stamps activated_at the first time ssl_status transitions to
 *     "active"
 *   - Detects deleted-on-cf hostnames → marks ssl_status="failed"
 *     and clears cf_hostname_id so the next /verify call re-provisions
 *
 * Honest discipline:
 *   - Skips entirely when CLOUDFLARE_API_TOKEN is unset
 *   - Per-domain failures are logged but never abort the sweep
 *   - Touches no DNS — that lives in /verify, not here
 */

import { isNotNull } from "drizzle-orm";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantDomains } from "@/db/schema";
import { audit } from "@/lib/audit";
import {
  cloudflareConfigured,
  extractCfErrors,
  mapCfSslStatus,
  refreshHostnameStatus,
} from "@/lib/cloudflare-hostnames";
import { invalidateHostnameCache } from "@/lib/domains";

async function main() {
  if (!cloudflareConfigured()) {
    console.log("[sync-domain-ssl] Cloudflare not configured — exiting cleanly.");
    return;
  }

  const rows = await db
    .select()
    .from(tenantDomains)
    .where(isNotNull(tenantDomains.cfHostnameId));

  console.log(`[sync-domain-ssl] reconciling ${rows.length} domains`);

  let activated = 0;
  let failed = 0;
  let unchanged = 0;
  let errors = 0;

  for (const row of rows) {
    if (!row.cfHostnameId) continue;
    try {
      const res = await refreshHostnameStatus(row.cfHostnameId);
      const now = new Date();

      if (!res.ok) {
        // 404 from CF → hostname was deleted externally. Clear our id
        // so the next operator click reprovisions cleanly.
        if (res.status === 404) {
          await db
            .update(tenantDomains)
            .set({
              cfHostnameId: null,
              sslStatus: "failed",
              verificationErrors: "Cloudflare hostname no longer exists — was likely deleted externally",
              lastCheckedAt: now,
              updatedAt: now,
            })
            .where(eq(tenantDomains.id, row.id));
          invalidateHostnameCache(row.normalizedHost);
          await audit({
            tenantId: row.tenantId,
            action: "domain.ssl_unhealthy",
            entityType: "tenant_domain",
            entityId: row.id,
            metadata: { host: row.normalizedHost, reason: "cf_hostname_deleted" },
          });
          failed++;
        } else {
          // CF unreachable — record the error but leave state alone.
          await db
            .update(tenantDomains)
            .set({
              verificationErrors: res.message,
              lastCheckedAt: now,
              updatedAt: now,
            })
            .where(eq(tenantDomains.id, row.id));
          errors++;
        }
        continue;
      }

      const mapped = mapCfSslStatus(res.result.ssl?.status);
      const cfErrors = extractCfErrors(res.result);
      const justActivated = mapped.status === "active" && !row.activatedAt;

      await db
        .update(tenantDomains)
        .set({
          sslStatus: mapped.status,
          verificationErrors: cfErrors,
          activatedAt: justActivated ? now : row.activatedAt,
          lastCheckedAt: now,
          updatedAt: now,
        })
        .where(eq(tenantDomains.id, row.id));
      invalidateHostnameCache(row.normalizedHost);

      if (justActivated) {
        await audit({
          tenantId: row.tenantId,
          action: "domain.ssl_active",
          entityType: "tenant_domain",
          entityId: row.id,
          metadata: { host: row.normalizedHost, cf_hostname_id: row.cfHostnameId },
        });
        activated++;
      } else if (mapped.status === "failed") {
        failed++;
      } else {
        unchanged++;
      }
    } catch (err) {
      console.error(`[sync-domain-ssl] domain=${row.id} host=${row.normalizedHost}`, err);
      errors++;
    }
  }

  console.log(
    `[sync-domain-ssl] done · activated=${activated} failed=${failed} unchanged=${unchanged} errors=${errors}`,
  );
}

main()
  .catch((err) => {
    console.error("[sync-domain-ssl] fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    process.exit(process.exitCode ?? 0);
  });
