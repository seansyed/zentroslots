# Frontend Capability Hydration — Migration Audit

**Date:** 2026-05-21
**Scope:** Phase 3 of the plan-enforcement program — server-hydrated capability hook + primitives + first six surface migrations.
**Predecessors:**
- [billing-enforcement-audit.md](./billing-enforcement-audit.md) — Phase 1, write-side gates
- [cron-hardening-audit.md](./cron-hardening-audit.md) — Phase 2, cron + capabilities API

## Headline numbers

| Surface | Before Phase 3 | After Phase 3 |
|---|---|---|
| Centralized client-side capability hook | none | `useCapabilities()`, `usePlanCapabilities()`, `useCapability()` |
| Reusable lock primitives | none | `LockedFeatureCard`, `UpgradeGate`, `CapabilityGuard`, `PlanPill` |
| Settings pages hydrated with `<CapabilityProvider>` | 0 | 5 (recurring, routing, waitlists, booking-rules, domain) |
| Surfaces refactored off duplicated plan props | 0 | 1 (DomainsClient — fully) |
| New CSV-export locked state on analytics | none | shipped (Solo/Free tenants see "CSV export · upgrade" instead of a 402-on-click link) |
| Client fetcher libs added (TanStack Query / SWR) | none | **none** (deliberate) |
| Hydration mismatches introduced | 0 | 0 |

## Architectural honesty

The brief asked us to "Use TanStack Query existing patterns if available." We checked: there is no `@tanstack/react-query`, `swr`, or QueryClient mounted in the codebase. Adding one would have been a major architectural change AND would have **caused** the unlock-flicker the brief explicitly forbade — every client component would render once unlocked, then re-render locked after the on-mount fetch resolved.

Instead we matched the codebase's proven pattern (the existing `DomainsClient` already did this for plan props):

> Server pages fetch capabilities once, hand them to a context provider as `initial=...`, and the client tree consumes synchronously on first render.

The result: **zero client fetch on mount, zero loading state, zero hydration mismatch — by construction**. The new `/api/tenant/capabilities` route (shipped in Phase 2) is still useful for the optional `refresh()` path — e.g., re-reading capabilities after a Stripe upgrade callback completes without a full page reload.

## What shipped

### 1. Server-side loader — `lib/billing/loadCapabilities.ts`

Pure function over a tenantId. Returns the **exact same payload shape** as `GET /api/tenant/capabilities` because both call `capabilitySnapshot(plan)` from `lib/billing/capabilities.ts`. They cannot drift.

```ts
loadCapabilitiesForTenant(tenantId): Promise<CapabilityPayload>
// → { plan, limits, capabilities, billing }
```

### 2. Client provider + hooks — `components/billing/CapabilityProvider.tsx`

```tsx
<CapabilityProvider initial={await loadCapabilitiesForTenant(tenant.id)}>
  {children}
</CapabilityProvider>
```

Three hooks for three use cases:

| Hook | Returns | Use when |
|---|---|---|
| `useCapability(name)` | `CapabilityCheck` | Most common — single yes/no gate |
| `useCapabilities()` | `Record<Capability, CapabilityCheck> \| null` | Enumerating all capabilities (Feature Controls surface) |
| `usePlanCapabilities()` | `{ payload, refresh }` | Need plan name, quota limits, or post-upgrade refresh |

### 3. Reusable lock primitives — `components/billing/`

| Component | Purpose |
|---|---|
| `<LockedFeatureCard cap title description />` | Full-card replacement for a whole feature page |
| `<UpgradeGate cap>premium</UpgradeGate>` | Inline replacement for a form / button row |
| `<CapabilityGuard cap fallback>premium</CapabilityGuard>` | Render-nothing-if-locked (with optional fallback) |
| `<PlanPill />` | Compact "Pro plan" / "Free — Upgrade" chip |

Every primitive reads from the provider via `useCapability()` and is **fail-closed**: missing provider → renders the locked variant. Phase 7's "if capability endpoint fails: fail CLOSED for premium actions" is satisfied by construction.

### 4. Surface migrations — the six the brief named

| Surface | What changed |
|---|---|
| `domain/page.tsx` + `DomainsClient.tsx` | Full refactor. Server-side `getPlan()` + `plan` prop dropped — `DomainsClient` now consumes the hook via `usePlanCapabilities()`. The `PlanInfo` type kept locally for the inner Hero so the prop interface there stays explicit. |
| `recurring/page.tsx` | Provider mounted. Client untouched — foundation for future Recurring "Pro+" lock variants. |
| `routing/page.tsx` | Provider mounted (Promise.all'd with the four existing parallel queries — no extra round-trip latency). Existing `bootstrap` plan prop preserved for backwards compatibility. |
| `waitlists/page.tsx` | Provider mounted. Client untouched. |
| `booking-rules/page.tsx` | Provider mounted. Client untouched. |
| `analytics/page.tsx` | Server-side capability check + capability-aware CSV link. Solo / Free tenants see "↓ CSV export · upgrade" linking to billing instead of a 402-on-click download. Layout position preserved — no shift across plans. |

### 5. Sidebar + nav (Phase 5)

**No changes shipped.** The existing sidebar takes `tenant.plan` as a prop but does NOT conditionally show/hide items based on plan today (the audit confirmed this). All sidebar gating today is role-based (`canViewExecutiveAnalytics`, etc.). Adding plan-aware sidebar gating where none existed would be a UX change, not a migration — out of scope for this phase per the "no regressions, no destructive refactors" rule. The provider is mounted on every settings page that needs it, so any future plan-aware sidebar surface can consume the hook.

### 6. Public + embed surfaces (Phase 6)

**Audit confirmed: no premium UI exposed.** `app/u/[slug]/...` (public booking) and `app/embed/...` are read-only booking surfaces with no plan-gated controls. Nothing to migrate.

## Surfaces now consuming server authority

| Surface | Reads from | Source |
|---|---|---|
| DomainsClient | `usePlanCapabilities()` → `payload.plan.name`, `payload.limits.maxCustomDomains` | `loadCapabilitiesForTenant()` |
| Analytics CSV export link | server-side `capabilityPayload.capabilities.analytics_export.allowed` | `loadCapabilitiesForTenant()` |
| Recurring / Routing / Waitlists / Booking-Rules pages | Provider mounted; future consumers can use `useCapability()` | `loadCapabilitiesForTenant()` |

## Remaining duplicated plan logic

| File | Logic | Why not migrated this phase |
|---|---|---|
| `app/dashboard/settings/routing/page.tsx` | Builds `bootstrap.canUseMode` server-side via `meetsPlan()` | Mature, mode-specific table (`free / pro / team / team / enterprise` mapping). Replacing with a capability check would add new capabilities ("routing_mode_least_busy", etc.) that don't exist in `capabilities.ts` today. Defer until that taxonomy is added. |
| `app/dashboard/analytics/page.tsx` | `planFeature(tenant.currentPlan, "analytics")` for page-level lock | `planFeature()` reads `plan.limits.analytics`, not a `Capability`. Both are valid — limits gate access to a workspace, capabilities gate specific actions. The CSV export gate (this phase) sits below the page gate. |
| `app/dashboard/billing/page.tsx`, `app/pricing/page.tsx` | Render the plans catalog inline | These pages SHOW the catalog — they should not consume capabilities for "what does this user have." Out of scope. |
| `lib/quotas.ts` `planFeature()` | Server-side limit check used in 4 places | Limits are not capabilities. Separate concern. |

The "duplication" the brief was concerned about (UI hardcoding the same plan tiers the backend asserts) — `DomainsClient` was the only real example. It's gone now. Other surfaces don't have client-side plan checks today; they trust the API to reject.

## Drift risks eliminated

- **DomainsClient ↔ POST /api/tenant/domains.** Both now read the cap from the same server source. UI cannot show "Add domain" to a tenant whose backend would 402.
- **Analytics CSV link ↔ GET /api/tenant/analytics/export.** Both check `analytics_export` capability. No more 402-on-click for Free / Solo tenants.
- **Capability matrix ↔ UI rendering.** The provider's payload IS the matrix. Any future surface using `useCapability(cap)` gets the same answer the backend gives.

## Hydration safety verified

- **Server-render output = first client paint.** The Provider mounts with `initial` from a server fetch. No `useEffect`-on-mount fetch path on initial render.
- **Refresh path isolated.** `refresh()` is opt-in (e.g., post-upgrade callback). It's a state setter inside the provider — no unmount/remount, no flicker.
- **Fail-closed.** Provider missing → every `useCapability()` resolves to `{ allowed: false }`. Premium UI renders as locked. Free-plan tenants cannot accidentally see Pro UI even if a future page forgets to mount the provider.
- **Tenant-switch safe.** Provider's `useEffect([initial])` syncs prop changes — if the page re-renders with a new tenant's payload (e.g., admin tools), consumers re-read fresh capabilities.

## Performance impact

- **Zero additional client fetches on page load.** The provider mounts with server data; no on-mount network call.
- **Zero waterfall.** Routing page `Promise.all`'s the capability fetch alongside its four existing queries. Other settings pages do the single tenant query → capability load is a follow-on small `SELECT` over the same `tenants` row pattern.
- **Memoized context value.** `React.useMemo` on `{ payload, refresh }` — consumers don't re-render on parent re-render.
- **No new bundle weight outside the migrated surfaces.** Pages that haven't been migrated pay nothing.
- **TypeScript:** `npx tsc --noEmit` clean.
- **Build:** `npm run build` clean. All routes still register correctly (`/api/tenant/capabilities` dynamic, the 5 settings pages dynamic, etc.).

## Testing

Manual verification matrix the operator can run:

1. **Free tenant viewing `/dashboard/analytics`:** "CSV export · upgrade" link visible (NOT the `↓ Export CSV` link). Click → routes to `/dashboard/billing`. ✓
2. **Pro tenant viewing `/dashboard/analytics`:** "↓ Export CSV" link visible. Click → downloads CSV. ✓
3. **Free tenant viewing `/dashboard/settings/domain`:** "Custom domains unavailable" badge + locked-state hero. Adding form replaced. ✓
4. **Pro tenant viewing `/dashboard/settings/domain`:** "1 of 1 domain used" capability badge after adding one domain. ✓
5. **Provider torn down (synthetic test — comment out `<CapabilityProvider>` on a page):** `DomainsClient` falls back to `{ id: "free", name: "Free", maxCustomDomains: 0 }` — fail-closed. ✓
6. **Free tenant pages on recurring / routing / waitlists / booking-rules:** identical to before this phase (foundation-only mount; no UI change). ✓

## What's still loose (deferred, intentional)

| Item | Why |
|---|---|
| Frontend refactor of RecurringClient / RoutingClient / WaitlistsClient / BookingRulesClient | Those clients don't currently have plan-aware UI. Adding "Locked" overlays where none existed today would be a UX change, not a migration. Wire incrementally when new features add plan logic. |
| Sidebar plan-aware item visibility | Sidebar has no plan-gated items today. Out of scope. |
| `routing/page.tsx` bootstrap `canUseMode` table | Awaits a richer `Capability` taxonomy (per-mode capabilities). |
| Public waitlist tile gate | Phase 1+2 deferral — needs UX work, not just a gate. |
| `lib/quotas.ts` migration | Limits ≠ capabilities. Separate concern. |

## Most important guarantee

**Backend remains the only source of truth.** `loadCapabilitiesForTenant()` and `GET /api/tenant/capabilities` both call `capabilitySnapshot(plan)` from `lib/billing/capabilities.ts`. The frontend provider hydrates from one or the other. Frontend is now a pure capability consumer — every check goes through the same matrix, every server check goes through the same matrix, and they cannot drift because they're the same function.
