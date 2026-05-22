# Cron + Capability Hardening Audit

**Date:** 2026-05-21
**Scope:** Phase 2 of the plan-enforcement program — centralized capability surface for the client + plan-aware execution across premium cron workers.
**Predecessor:** [billing-enforcement-audit.md](./billing-enforcement-audit.md) (Phase 1 — write-side gates)

## Headline numbers

| Surface | After Phase 1 | After Phase 2 (this) |
|---|---|---|
| Routes with explicit plan enforcement | 15 / 121 (12%) | 15 / 121 (12%) + 1 new read endpoint |
| Premium crons that skip free-plan tenants | 0 / 10 | **3 / 3 eligible** (recurring, automations, scheduled-reports) |
| Tenant-isolation compliance (sampled) | 100% | 100% |
| Cross-tenant data leaks detected | 0 | 0 |
| Capability matrix duplication on client | 14 surfaces | unchanged — superseded by new endpoint (rollout deferred) |

## What shipped

### 1. Centralized capabilities endpoint

`GET /api/tenant/capabilities` — single source of truth for the client.

```jsonc
{
  "plan":    { "id": "pro", "name": "Pro", "priceCents": 3000, "priceCentsYearly": 33000 },
  "limits":  { "maxStaff": 3, "maxLocations": 10, "customBranding": true, /* ... */ },
  "capabilities": {
    "recurring_series":   { "allowed": true,  "currentPlan": "pro", "requiredPlan": "pro", "reason": "..." },
    "automation_rules":   { "allowed": true,  /* ... */ },
    "routing_rules":      { "allowed": true,  /* ... */ },
    "booking_rules":      { "allowed": true,  /* ... */ },
    "scheduled_reports":  { "allowed": true,  /* ... */ },
    "custom_domains":     { "allowed": true,  /* ... */ },
    "hide_powered_by":    { "allowed": true,  /* ... */ },
    "analytics_export":   { "allowed": true,  /* ... */ }
  },
  "billing": {
    "active": true,
    "subscriptionStatus": "active",
    "trialEnd": null
  }
}
```

Tenant isolation: derived from authenticated user's tenantId — no query parameter. `force-dynamic` ensures a downgrade/upgrade reflects immediately on next page load with no cached stale Pro banners.

The endpoint reads the same `capabilitySnapshot(plan)` helper that the per-route assert helpers call. **UI + backend can never drift** — they read from the same matrix.

### 2. Cron-level billing guards

New module: `lib/billing/cronGuards.ts` — pure decision engine, no I/O beyond an optional batch tenant lookup.

```ts
type CronDecision =
  | { mode: "process";     reason: string }
  | { mode: "grandfather"; reason: string }
  | { mode: "skip";        reason: string };

decidePremiumCronExecution(tenant, capability): CronDecision
buildBatchDecisionMap({ db, tenantsTable, tenantIds, capability }): Map<string, CronDecision>
shouldExecute(decision): boolean      // process || grandfather
auditCategoryFor(decision): string | null
```

Decision matrix:

| Tenant state | Capability available on plan? | Decision |
|---|---|---|
| `active=false` | any | **skip** (`tenant_inactive`) |
| `subscriptionStatus IN (canceled,unpaid,incomplete_expired)` | any | **skip** (`billing_<status>`) |
| `active=true`, status sane, plan grants capability | yes | **process** |
| `active=true`, status sane, plan does NOT grant | no | **grandfather** (continue execution, audit-logged once per batch) |

**`past_due` is deliberately excluded** from suspended statuses. Stripe's retry window keeps the customer billable for ~10 days — short-term retention beats strict billing during that window. After the window expires the status flips to `unpaid` and the guard kicks in.

### 3. Crons hardened

| Cron | Capability gated | Behavior |
|---|---|---|
| `scripts/materialize-recurring.ts` | `recurring_series` | Active series in suspended/inactive tenants stop materializing; grandfathered Free-plan series continue. `materializeOccurrences()` was extended with an optional `tenantDecisions` map — backwards-compatible (callers that omit it process everything). |
| `scripts/run-automations.ts` | `automation_rules` | Per-row decision after the claim flip — skipped rows marked `skipped` with `reason='billing_guard:<reason>'`. The `processing` claim still happens atomically so concurrent workers see the row taken. |
| `scripts/generate-scheduled-reports.ts` | `scheduled_reports` | Free/Solo tenants get zero report rows generated. Existing reports in the table from prior plan tiers stay (grandfather policy). |

### 4. Audit log emission — one row per (tenant, decision) per run

Each cron emits at most one audit row per tenant per cron tick — never per claimed work item. That keeps `audit_logs` quiet on large tenants while still surfacing the operational signal.

| Decision | Audit category |
|---|---|
| `grandfather` | `billing.grandfathered_execution` |
| `skip` | `billing.cron_skip` |
| `process` | (no log — normal path) |

Each row carries `metadata: { capability, decision_mode, reason }` so ops can:
- Grep for `billing.cron_skip` to find tenants whose premium features stopped (after billing failure)
- Grep for `billing.grandfathered_execution` to size the missed-revenue exposure (Free tenants still executing premium rows)
- Trace exact reason codes (`billing_canceled`, `tenant_inactive`, `grandfathered_recurring_series_on_free`, etc.)

`actorLabel` is `system:cron:<script-name>` so the operator can tell that the row came from the cron, not from a user action.

### 5. Downgrade-prep inventory (read-only)

New module: `lib/billing/grandfathered.ts` — `listGrandfatheredRowCounts({ tenantId })`.

Returns the count of currently-active premium rows per capability that exceeds the tenant's current plan. Read-only; never deletes, pauses, or disables. Designed as the foundation for a future "preview downgrade impact" view in the Stripe webhook handler and the admin tools.

```jsonc
{
  "tenantId": "...",
  "currentPlan": "free",
  "clean": false,
  "rows": [
    { "capability": "recurring_series", "count": 4 },
    { "capability": "automation_rules", "count": 2 }
  ]
}
```

Splitting read from write deliberately preserves the user's grandfather policy. The choice between "soft-warn and grandfather indefinitely" vs "hard-pause on downgrade" remains a future product decision — when made, the action lives in `downgradeEnforcement.ts` and imports this inventory.

## Safety guards verified

- **No duplicate execution.** `run-automations.ts` keeps its atomic `UPDATE … RETURNING` claim flip — billing guard fires AFTER the claim, so a skipped row is reliably marked once.
- **No race conditions.** Decision map is built per cron run from a single `SELECT ... WHERE id = ANY(...)` over tenants — concurrent crons would each compute their own (stable for the run, never stale across runs).
- **No stale cache.** No cache layer; cronGuards reads tenant state fresh per batch. Plan changes from Stripe webhooks are visible on the next cron tick.
- **No cross-tenant leakage.** Every count query in `grandfathered.ts` filters by `tenantId`. Every cron iteration honors the row's `tenantId` for the decision lookup. No `IN (...)` queries without a tenant scope.
- **No new bypass surface.** The capabilities endpoint is read-only and tenant-scoped via the auth session. It does not accept a `tenantId` query parameter and cannot be used cross-tenant.
- **Backwards-compatible.** `materializeOccurrences()` gained an OPTIONAL `tenantDecisions` parameter. Callers that don't pass it process every occurrence — preserves byte-identical behavior for any test or admin tool that calls the helper directly.

## What's still loose (intentionally deferred)

| Item | Why deferred |
|---|---|
| Frontend refactor to consume `/api/tenant/capabilities` | All 14 current consumers do server-side gating; refactoring working UI to read the new endpoint changes no observable behavior. Wire it incrementally when a feature ships UI-side plan logic. |
| Public waitlist tile gate | Still Phase 1 deferred — needs UX work, not just a backend gate. |
| Webhook URL gate inside `PATCH /api/tenant/integrations` | Phase 1 deferred — route handles multiple fields. |
| Second analytics export endpoint (`/api/tenant/analytics/executive/export`) | Phase 1 deferred — same pattern as the first; copy `assertCanExportAnalytics()` and audit-log when it's wired. |
| Stripe-webhook downgrade pauses | This phase ships the INVENTORY (`listGrandfatheredRowCounts`). The mutation half — "on downgrade, soft-pause active recurring series + disable automation rules + drop excess domains" — is a separate policy decision. The user's stated tradeoff today is "hard-enforce on writes, grandfather existing rows", which Phase 1+2 honor. |
| Cron hardening for `aggregate-daily-analytics`, `send-reminders`, `expire-payment-holds`, `run-governance-retention`, `sync-domain-ssl`, `expire-waitlist-reservations` | Not premium-gated. These are hygiene/baseline features available on every plan. Wiring a cron guard would add zero protection and one query of overhead per run. |

## Honest disclosure

Phase 16K labeled premium tiers in the UI without backend enforcement. Phase 17 (the previous audit) closed five write gates. This phase closes the cron execution loophole — a tenant in a terminated billing state can no longer have premium crons fire on their behalf, and Free-plan tenants stop accumulating NEW premium artifacts at API time (Phase 1) while their existing rows continue executing (the deliberate grandfather).

The two pieces work together: **Phase 1 prevents new exposure, Phase 2 honors the existing exposure honestly** instead of pretending it doesn't exist. The audit log makes the exposure visible to ops without forcing a destructive pause-on-downgrade flow that would surprise customers.

The only place the system can still "leak" premium service to a non-paying tenant is the grandfather path itself — which is exactly what the user requested. When the product decision changes, `grandfathered.ts` is ready to feed the enforcement mutation.
