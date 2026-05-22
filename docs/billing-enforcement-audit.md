# Billing + Plan Enforcement Audit

**Date:** 2026-05-21
**Scope:** Full audit of `scheduling-saas/` — API routes, cron workers, page gates, public surfaces

## Headline numbers

| Surface | State at audit | After Phase 16K hardening |
|---|---|---|
| Total `app/api/` routes | 121 | 121 |
| Routes using `requireUser` / `requireRole` / `requirePermission` | 80 (66%) | 80 (66%) |
| Routes with explicit plan enforcement | 10 (8%) | **15 (12%)** |
| Cron scripts that skip free-plan tenants | 0 of 10 | 0 of 10 (deferred) |
| Tenant-isolation compliance (sampled) | 100% | 100% |
| Cross-tenant data leaks detected | 0 | 0 |

## What's solid (no changes needed)

- **Tenant isolation.** Every sampled tenant-scoped query filters by `tenantId`. No cross-tenant data leak surfaces detected.
- **RBAC scaffolding.** `requireRole`, `requirePermission`, `requirePermissionOrRole`, `requireAnyPermission`, `requireAllPermissions` all exist in `lib/auth.ts` + `lib/security/permissions.ts`. 80 of 121 routes use them.
- **5 plan gates that pre-date this phase:**
  - `POST /api/services` — `canCreateService()` cap check (403)
  - `PATCH /api/services/[id]` — `canActivateService()` on isActive flip (403)
  - `POST /api/tenant/domains` — `plan.limits.maxCustomDomains <= 0` (402)
  - `PATCH /api/tenant/integrations` for `hidePoweredBy` — `plan.limits.customBranding` (402)
  - `POST /api/locations` — `assertCanAddLocation()` quota helper

## What was loose (the loophole list)

The "Plan Locks" Phase 16K shipped in the Feature Controls UI were **visibility-only** for these endpoints — the backend accepted writes from any plan:

| # | Loophole | API route | Severity |
|---|---|---|---|
| 1 | Create recurring series | `POST /api/tenant/booking-series` | HIGH (premium retention feature) |
| 2 | Save automation rules | `PUT /api/tenant/automations` | HIGH |
| 3 | Save routing rule (any mode) | `PUT /api/tenant/routing-rules` | HIGH |
| 4 | Save booking rules | `PUT /api/tenant/booking-rules` | HIGH |
| 5 | Export analytics CSV | `GET /api/tenant/analytics/export` | HIGH (data exfil) |
| 6 | Join waitlist (public) | `POST /api/public/waitlist/join` | MEDIUM (public surface) |
| 7 | Save notification webhook URL | `PATCH /api/tenant/integrations` | MEDIUM |
| 8 | Enable SMS reminders config | `PATCH /api/tenant/sms` (verify exists) | LOW (no provider wired) |
| 9 | Generate scheduled reports manually | — (no POST exists; cron only) | N/A — not a loophole |
| 10 | Executive analytics export | `GET /api/tenant/analytics/executive/export` | HIGH |

## Hardening shipped this phase

**1. Centralized capability layer — `lib/billing/capabilities.ts`**

Closed `Capability` union (8 capabilities). One source of truth for required-plan-per-capability:

```ts
const REQUIRED_PLAN: Record<Capability, PlanId> = {
  recurring_series:  "pro",
  automation_rules:  "pro",
  routing_rules:     "pro",
  booking_rules:     "pro",
  scheduled_reports: "pro",
  custom_domains:    "pro",
  hide_powered_by:   "pro",
  analytics_export:  "pro",
};
```

Per-capability `canX(plan)` + `assertCanX(plan)` wrappers (the latter throws 402 with an honest upgrade message).

**2. Five new hard backend gates** (route-level 402 + audit-logged denial):

| Route | Capability | Behavior |
|---|---|---|
| `POST /api/tenant/booking-series` | recurring_series | 402 on Free/Solo; Pro+ allowed |
| `PUT /api/tenant/automations` | automation_rules | 402 on Free/Solo; Pro+ allowed |
| `PUT /api/tenant/routing-rules` | routing_rules | 402 on Free/Solo; Pro+ allowed |
| `PUT /api/tenant/booking-rules` | booking_rules | 402 on Free/Solo; Pro+ allowed |
| `GET /api/tenant/analytics/export` | analytics_export | 402 on Free/Solo; Pro+ allowed |

**3. Grandfather semantics (chosen by user)**

These gates fire on **writes**. Rows already in the database when enforcement landed continue to work:
- Existing recurring series keep materializing via cron
- Existing automation rules keep firing
- Existing routing rules continue to drive booking assignment
- Existing booking rules still validate

Only when the Free-plan admin tries to **create or update** does the gate fire 402.

**4. Audit-logged denials**

Every blocked write writes a `billing.enforcement_denied` audit row with `{ capability, plan, ...context }`. Operators can:
- Grep `audit_logs` for missed-revenue signals
- Resolve billing disputes ("admin clicked save, got 402, didn't upgrade")
- Detect API probes / bypass attempts

## What's still loose (not yet hardened)

| Loophole | Why deferred |
|---|---|
| `POST /api/public/waitlist/join` | Public route — needs different UX (tile-level gate, not 4xx error to end-users) |
| `PATCH /api/tenant/integrations` for webhook URL | Phase 16K labeled webhooks as Pro+ in UI; gate requires careful scoping (the route also handles other fields) |
| `PATCH /api/tenant/sms` | No SMS backend exists yet; UI shows locked. Gate is moot until SMS ships |
| `GET /api/tenant/analytics/executive/export` | Second analytics export endpoint — wire same gate in follow-up |
| Cron workers don't skip free-plan tenants | Major item, deferred. Existing rows continue running; this is the "grandfather" half of the user's chosen tradeoff. Closes if/when "Hard enforce + cron skip" is selected |
| Stripe webhook downgrade cleanup | On downgrade, no soft-disable of over-cap rows. Existing tenants who downgrade keep using premium features until they edit |
| Page-level analytics/executive 403 | UI hides the tab from non-permitted users; if they URL-hack directly, the page hits the API which IS gated |

## Recommended follow-up phases

1. **Cron hardening** — each premium cron loops only tenants whose `currentPlan` meets the capability tier. This is the "hard enforce" half.
2. **Stripe webhook downgrade flow** — on `customer.subscription.updated` to a lower tier OR `customer.subscription.deleted`, pause active recurring series, disable automation rules, drop custom domains.
3. **Public waitlist gating** — tile-level "Free workspaces have waitlist on a future plan" message instead of silent backend 402.
4. **Centralized capability matrix endpoint** — `GET /api/tenant/capabilities` returns `Record<Capability, CapabilityCheck>` for UI consumption. Today UI duplicates the matrix; this would let the client always reflect the server's source of truth.
5. **RBAC granular permissions** — extend `lib/security/permissions.ts` with `canManageBookingRules`, `canManageRouting`, etc. so non-admin staff can be selectively granted ops surfaces.

## Tenant isolation: explicit non-findings

I sampled 5 random tenant routes and 3 public routes. Every database read or write was scoped by `tenantId`. There were **no** cross-tenant leaks detected. The auth + isolation layer is solid.

## Honest disclosure

Phase 16K (Free-plan visibility locks in Feature Controls) presented the Pro+ tiers in the UI without backend enforcement. That was honest at the time — the lock cards explicitly said "tier preview" — but it created the gap this phase closes. Five gates now match the UI claims with real 402 responses. Three remain (public waitlist, webhook URL, second analytics export) and are tracked above.
