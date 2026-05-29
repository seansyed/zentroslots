/**
 * useServices — fetch the tenant's services list.
 *
 * Returns a ServiceListResult, NOT a Service[] — callers should read
 * `.active` for what's bookable, and use `.hasAny` / `.allInactive` to
 * decide which empty-state copy to show.
 *
 * Query key is `["services", userId]` so swapping accounts (e.g. via
 * Settings → Sign out → re-login) invalidates automatically. Without
 * the user id in the key, the previous user's empty cache would
 * survive the in-memory QueryClient across a sign-out.
 *
 * FRESHNESS CONTRACT
 * ------------------
 * Services are tenant CONFIG metadata, not operational data. The
 * single source of truth is the production backend. Three guarantees:
 *
 *   1. `staleTime: 0` — every screen mount considers the existing
 *      cache stale and triggers a background refetch. Old data still
 *      paints instantly (no flicker) but new data overwrites it the
 *      moment the network responds.
 *
 *   2. `refetchOnMount: "always"` — even if the cache is "fresh" by
 *      some other selector's lens, mounting useServices refetches.
 *      Belt-and-suspenders with #1.
 *
 *   3. The persistence layer (lib/queryPersistence) explicitly does
 *      NOT write the services cache to AsyncStorage. So a cold start
 *      can never paint a stale-from-disk service.
 *
 * Together these eliminate the "operator edited a service in the
 * dashboard but mobile still shows the old duration" failure mode.
 * The booking POST already recomputes endAt server-side from
 * service.durationMinutes, so the actual booking is never wrong —
 * but the picker tile's display would lag without these guardrails.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { servicesApi, type ServiceListResult } from "@/api/services";
import { useAuthStore } from "@/store/authStore";
import { track } from "@/lib/telemetry";

export function useServices() {
  const userId = useAuthStore((s) => s.user?.id);

  const q = useQuery<ServiceListResult>({
    queryKey: ["services", userId ?? "anon"] as const,
    queryFn: () => servicesApi.list(),
    // See FRESHNESS CONTRACT above. Anything > 0 here would re-introduce
    // the stale-duration bug.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnReconnect: true,
    enabled: Boolean(userId),
  });

  // Diagnostic breadcrumb — fires once per fetch settle. Captures the
  // raw count + duration distribution so a future "the duration is
  // wrong on mobile" report can be triaged against telemetry instead
  // of guessing.
  const lastSignatureRef = React.useRef<string>("");
  React.useEffect(() => {
    if (!q.data || q.isLoading) return;
    const all = q.data.all;
    // Cheap deterministic signature: id|duration|active for each
    // service. Lets us tell "same data" from "changed data" without
    // shipping full payloads to telemetry.
    const signature = all
      .map((s) => `${s.id.slice(0, 8)}:${s.durationMinutes}:${s.isActive ?? "?"}`)
      .sort()
      .join("|");
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;
    const durations = all.map((s) => s.durationMinutes);
    const minDur = durations.length ? Math.min(...durations) : 0;
    const maxDur = durations.length ? Math.max(...durations) : 0;
    track("info", `services payload: ${all.length} total, ${q.data.active.length} active`, "info", {
      total: all.length,
      active: q.data.active.length,
      durationsRange: `${minDur}-${maxDur}m`,
      // Slice durations to first 8 services for readability; full list
      // would be noisy and serves no triage purpose.
      sample: all.slice(0, 8).map((s) => ({
        id: s.id.slice(0, 8),
        name: s.name,
        durationMinutes: s.durationMinutes,
        active: Boolean(s.isActive),
      })),
    });
  }, [q.data, q.isLoading]);

  return q;
}
