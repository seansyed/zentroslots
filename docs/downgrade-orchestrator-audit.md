# Downgrade Enforcement Orchestrator — Audit

**Date:** 2026-05-21
**Scope:** Phase 5 of billing enforcement — orchestrator framework + RECURRING handler working end-to-end + admin CLI + audit categories.
**Predecessors:**
- [billing-enforcement-audit.md](./billing-enforcement-audit.md) — Phase 1, write-side gates
- [cron-hardening-audit.md](./cron-hardening-audit.md) — Phase 2, cron + capabilities API
- [frontend-capability-hydration-audit.md](./frontend-capability-hydration-audit.md) — Phase 3, server-hydrated provider
- [subscription-lifecycle-audit.md](./subscription-lifecycle-audit.md) — Phase 4, webhook idempotency + transition audits

## Honest scope read

The brief listed 13 phases of orchestration. There's a real tension in the brief itself: "Implement FULL downgrade enforcement" + "NO surprise customer breakage" + "preserve grandfather semantics where intended." Auto-firing destructive enforcement from a Stripe webhook would violate "no surprise breakage" — and the user's earlier explicit policy was grandfather-on-downgrade.

**The reconciliation chosen** (with user confirmation): ship the orchestrator architecture + policy framework + ONE feature working end-to-end + admin CLI for dry-run/apply. The webhook does NOT auto-fire enforcement — operators trigger after reviewing the action plan. This honors both halves of the brief.

| Phase | Status | Detail |
|---|---|---|
| 1 — Orchestrator | **Shipped** | `planDowngrade()`, `executeDowngradePlan()`, single source of truth in `lib/billing/enforcement/` |
| 2 — Enforcement modes | **Shipped** | Closed union `EnforcementMode = "soft" \| "grandfathered" \| "hard"`; per-(tenant, capability) override table |
| 3 — Feature-by-feature actions | **Shipped: RECURRING fully; others as planned-only stubs** | Honest about which handlers exist vs which are scheduled |
| 4 — Over-limit tenants | **Architecture ready** | `grandfathered.ts` (Phase 2) reports counts. The planner uses it implicitly via capability checks. Action handlers per feature follow in next iteration |
| 5 — Billing suspension mode | **Already covered (Phase 2)** | `cronGuards.ts` already skips `canceled`/`unpaid`/`incomplete_expired`. Orchestrator inherits — suspended billing pauses crons before they hit row level |
| 6 — Reactivation | **Shipped: RECURRING fully** | `planRecovery()`, `executeRecoveryPlan()`. Idempotent restore. Symmetric to downgrade |
| 7 — Safety layers | **Shipped** | Every handler is per-action try/catch'd, idempotent via `enforcement_event_id`, tenant-scoped, audit-emitting. Plan + execute are pure-then-mutate |
| 8 — UX | **Schema ready, UI deferred** | Columns exist (`enforcementPausedAt`, `enforcementPausedReason`, `enforcementEventId`); UI surfaces ("This series is grandfathered…") land in a follow-up |
| 9 — Admin/enterprise overrides | **Shipped (data model)** | `tenant_enforcement_overrides` table + `resolvePolicy()` resolver. Supports per-(tenant, capability) mode override + time-bounded `expires_at` + `granted_by` audit trail. Admin UI to manage rows deferred |
| 10 — Cron + worker enforcement | **Shipped: RECURRING** | `materialize-recurring.ts` Phase A filters by `enforcement_paused_at IS NULL`. `materializeOccurrences` Phase B skips paused series mid-run, marking occurrences with `enforcement_paused:<reason>` |
| 11 — Observability | **Shipped** | Three new audit categories: `billing.enforcement_action_applied`, `billing.enforcement_action_failed`, `billing.enforcement_recovery_applied` |
| 12 — Test matrix | **Documented (manual)** | No test framework wired in repo; verification scenarios listed below |
| 13 — Future-ready design | **Documented** | Section below on metered billing, add-ons, grace periods. No premature implementation |

## 1. Architecture

```
                       ┌────────────────────────────┐
   Stripe webhook ───▶ │ billing.downgrade_applied   │ ◀── (Phase 4 — observability only)
                       │   audit row + inventory     │
                       └────────────────────────────┘
                                    │ operator reviews via audit_logs grep
                                    ▼
                       ┌────────────────────────────┐
                       │ scripts/preview-downgrade   │ ◀── DRY-RUN (read-only)
                       │   prints JSON action plan   │
                       └────────────────────────────┘
                                    │ operator confirms
                                    ▼
                       ┌────────────────────────────┐
                       │ scripts/apply-downgrade     │ ◀── --confirm to mutate
                       │   • planDowngrade()         │
                       │   • executeDowngradePlan()  │
                       │     ├ pause_recurring_series ✓ (handler shipped)
                       │     ├ disable_automation_rules ⊘ (stub: not_implemented)
                       │     ├ deactivate_custom_domains ⊘ (stub)
                       │     └ ... other handlers   ⊘ (stub)
                       └────────────────────────────┘
                                    │ on upgrade later
                                    ▼
                       ┌────────────────────────────┐
                       │ planRecovery() + execute    │
                       │   restores enforcement-     │
                       │   paused rows               │
                       └────────────────────────────┘
```

Module layout (`lib/billing/enforcement/`):

| File | Role |
|---|---|
| `types.ts` | Closed unions (mode, action kind, status); plan + result envelopes |
| `policies.ts` | Default per-capability policy matrix + per-tenant override resolver |
| `actionPlan.ts` | `planDowngrade()` — pure planner |
| `executor.ts` | `executeDowngradePlan()` — DRY-RUN by default; idempotent handlers |
| `recovery.ts` | `planRecovery()` + `executeRecoveryPlan()` — symmetric reactivation |
| `index.ts` | Public barrel |

## 2. Enforcement matrix by feature

| Capability | Default policy | Available modes | Action kind(s) | Handler status (this commit) |
|---|---|---|---|---|
| `recurring_series` | grandfathered | soft / grandfathered / hard | `pause_recurring_series` ↔ `resume_recurring_series` | ✅ **fully working** |
| `automation_rules` | grandfathered | soft / grandfathered / hard | `disable_automation_rules` ↔ `enable_automation_rules` | ⊘ stub (not_implemented) |
| `routing_rules` | grandfathered | soft / grandfathered / hard | `disable_routing_rules_premium_modes` ↔ `enable_…` | ⊘ stub |
| `booking_rules` | grandfathered | soft only (no row to pause) | noop (logged) | n/a — write-gate suffices |
| `scheduled_reports` | grandfathered | soft / grandfathered / hard | (stubbed kind) | ⊘ stub |
| `custom_domains` | grandfathered | soft / grandfathered / hard | `deactivate_custom_domains` ↔ `reactivate_custom_domains` | ⊘ stub |
| `hide_powered_by` | grandfathered | n/a (plan-derived flag) | noop (logged) | n/a — re-read per render |
| `analytics_export` | **hard** (override) | hard only | `lock_analytics_export` (noop) | n/a — route-level 402 |

The handler-status column is honest. The five "stub" entries emit `not_implemented` results AND a `billing.enforcement_action_applied` audit row with `status=not_implemented`. The audit trail makes the gap visible — operators can grep `audit_logs WHERE metadata->>'status' = 'not_implemented'` to see what would have happened.

## 3. Grandfather policy matrix

The default policy for every capability (except `analytics_export`) is `grandfathered`. This means:

- Existing premium rows continue to execute (cron honors them — Phase 2 already enforces this)
- New creates are blocked at write time (Phase 1 gates 402)
- The orchestrator's `planDowngrade()` emits a NO-OP action for `grandfathered` capabilities (logged for audit, no row state changed)
- The cron continues processing grandfathered rows

To enforce harder for a specific tenant (e.g., on a cancellation cleanup or support request):

```sql
INSERT INTO tenant_enforcement_overrides
  (tenant_id, capability, mode, expires_at, granted_by, reason)
VALUES
  ('<uuid>', 'recurring_series', 'hard', NULL,
   'support:1234', 'customer requested cleanup');
```

Then `planDowngrade()` returns an action with `entityIds` populated, and `executeDowngradePlan(plan, { dryRun: false })` pauses them.

To grant temporary grace (e.g., promotional period):

```sql
INSERT INTO tenant_enforcement_overrides
  (tenant_id, capability, mode, expires_at, granted_by, reason)
VALUES
  ('<uuid>', 'recurring_series', 'soft', '2026-06-30 00:00:00+00',
   'sales:abc', 'Q2 promo extension');
```

After `expires_at`, the override is silently ignored and the default re-applies.

## 4. Over-limit handling

The `grandfathered.ts` inventory (Phase 2) gives "what's over cap right now":

```ts
listGrandfatheredRowCounts({ tenantId })
// → { tenantId, currentPlan: "free", clean: false, rows: [{ capability: "recurring_series", count: 4 }] }
```

The orchestrator surfaces this implicitly: the planner only emits row-level actions for capabilities the destination plan does NOT unlock. A tenant with 9 staff on a 5-seat plan would have `freeze_excess_staff_seats` emitted (stub today) with the over-cap staff ids in `entityIds`.

**No destructive deletions.** The planner never includes a `delete_*` action kind. Excess rows are MARKED frozen (column flip), not removed. Reactivation clears the flag.

## 5. Reactivation behavior

On upgrade, `planRecovery()` finds rows with `enforcement_paused_at IS NOT NULL` and emits restore actions. The recovery contract:

- Restores EXACTLY the rows that were enforcement-paused (we don't accidentally "restore" user-paused rows because we filter on `enforcement_paused_at`, not on `status`)
- Idempotent — restore filters out rows already cleared (`IS NOT NULL` predicate)
- Cross-event safe — multiple downgrade events can have piled up; the new plan unlocks ALL of them at once
- DRY-RUN by default — operators run via the `scripts/apply-downgrade.ts` companion (recovery CLI deferred — same pattern, low priority)

## 6. Cron enforcement updates

| Worker | Update |
|---|---|
| `scripts/materialize-recurring.ts` Phase A | Filters `WHERE status='active' AND enforcement_paused_at IS NULL`. Paused series stop generating future occurrences immediately |
| `lib/recurrence/materializeOccurrences` Phase B | After fetching series, checks `series.enforcementPausedAt`. If set, marks the queued occurrence as `skipped` with `failureReason='enforcement_paused:<reason>'` |

No new cron files. No webhook auto-fire. The existing per-tenant cron guards (Phase 2) still apply at the tenant level for billing-suspended tenants — enforcement-pause is a finer grain ON TOP of that.

## 7. Audit categories

Four new categories joining the Phase 2 + Phase 4 set:

| Category | When |
|---|---|
| `billing.enforcement_action_applied` | Every action the executor processes (including dry-run and not_implemented) — `metadata.status` discriminates outcome |
| `billing.enforcement_action_failed` | An action's handler threw — `metadata.error` carries the message; the executor returns ok=false |
| `billing.enforcement_recovery_applied` | Same for the recovery path |
| (existing) `billing.downgrade_applied` | Webhook detected downgrade — fires automatically (Phase 4); orchestrator does not |

Every audit row carries `metadata.event_id` so an operator can trace one execution end-to-end across rows.

## 8. Idempotency & race safety

| Concern | Guarantee |
|---|---|
| Re-run same `event_id` on same rows | No-op. The handler filters `IS NULL` predicate; rows already marked with this event_id skip |
| Re-run different event_id on same already-paused rows | No-op. The `IS NULL` predicate makes "already paused" → "skip" |
| Restore re-run | No-op. The recovery handler filters `IS NOT NULL` |
| Concurrent execution from two operators | Postgres row-level locking on the UPDATE; second concurrent UPDATE matches zero rows once first one commits |
| Partial failure mid-plan | Per-action try/catch. Successful actions are committed (their UPDATEs ran); failed actions log + return ok=false. Operator re-runs same plan; idempotency makes successful actions skip |
| Webhook duplicate (covered by Phase 4) | Phase 4's `tryClaimStripeEvent` skips duplicate webhooks before we get here |
| Orchestrator running while cron is iterating | Cron's `IS NULL` filter applies to the snapshot at SELECT time. A row paused mid-cron stops on the NEXT cron tick — current tick may still process. Bounded to ≤ cron cadence (~15 min) |

## 9. Files shipped

| File | Type | Purpose |
|---|---|---|
| `db/migrations/0041_downgrade_enforcement.sql` | migration | Override table + 3 columns on `booking_series` |
| `db/schema.ts` | schema | `tenantEnforcementOverrides` + `bookingSeries` enforcement columns (+62 lines additive) |
| `lib/billing/enforcement/types.ts` | types | Closed unions + plan/result shapes |
| `lib/billing/enforcement/policies.ts` | policy | Default matrix + per-tenant override resolver |
| `lib/billing/enforcement/actionPlan.ts` | planner | `planDowngrade()` — pure |
| `lib/billing/enforcement/executor.ts` | executor | `executeDowngradePlan()` — DRY-RUN default + RECURRING handler |
| `lib/billing/enforcement/recovery.ts` | recovery | `planRecovery()` + `executeRecoveryPlan()` |
| `lib/billing/enforcement/index.ts` | barrel | Public re-exports |
| `scripts/preview-downgrade.ts` | CLI | Read-only action plan preview |
| `scripts/apply-downgrade.ts` | CLI | Mutation runner (requires `--confirm`) |
| `scripts/materialize-recurring.ts` | cron | Now filters paused series in Phase A |
| `lib/recurrence/materializeOccurrences.ts` | cron lib | Now skips paused series in Phase B |
| `docs/downgrade-orchestrator-audit.md` | doc | This document |

## 10. Manual test matrix

| # | Scenario | Setup | Expected |
|---|---|---|---|
| 1 | Preview downgrade for a tenant with active series | Tenant on Pro with 3 active recurring series | `preview-downgrade --tenant=X --to=free` prints 3 series IDs under `pause_recurring_series` action with `mode=grandfathered` (no-op by default) |
| 2 | Add HARD override, preview again | `INSERT INTO tenant_enforcement_overrides ... mode='hard'` | Same script now shows `mode=hard` with the IDs queued for actual pause |
| 3 | Apply downgrade (dry-run) | `apply-downgrade --tenant=X --to=free` (NO --confirm) | Same plan as preview; audit row `enforcement_action_applied` with `dry_run=true`; series unchanged |
| 4 | Apply downgrade (mutate) | Same + `--confirm` | Series rows have `enforcement_paused_at` set; audit row with `dry_run=false, status=applied, affected=3` |
| 5 | Re-run same apply | `apply-downgrade --tenant=X --to=free --confirm --event=<same>` | All 3 rows skipped (already paused); audit `status=skipped_idempotent, affected=0` |
| 6 | Cron tick after pause | next `npm run recurring:materialize` run | Phase A query returns 0 active+unpaused series; Phase B marks any pre-queued occurrences `skipped` with `enforcement_paused:downgrade_pro_to_free` |
| 7 | Reactivate (upgrade) | Tenant back to Pro; `planRecovery()` + execute | All 3 series cleared (`enforcement_paused_at=NULL`); audit `enforcement_recovery_applied, status=applied, affected=3` |
| 8 | Override with expiry | `expires_at = now() + 1 hour, mode='hard'` | preview shows hard for 1h; after expiry, preview returns to grandfathered (default) |
| 9 | Stub feature | Preview/apply on tenant with active automations | `disable_automation_rules` audit `status=not_implemented`; automations rows untouched (handler not shipped yet) |
| 10 | Crash recovery | Kill the apply script mid-execution | Re-run with same event_id; idempotent — committed actions skip, uncommitted re-runs |

## 11. Remaining edge cases (deferred)

| Item | Why deferred |
|---|---|
| Per-feature handlers for automations / routing / domains / locations / seats | Schema columns + audit + UX considerations per feature; each is its own focused commit |
| Webhook auto-fire | Brief tension: "FULL enforcement" + "no surprise breakage". Operator-triggered today; if/when policy shifts, the orchestrator is ready to be called from `applyTenantBillingMutation`'s downgrade branch in `lib/billing/planTransitions.ts` |
| Admin UI for `tenant_enforcement_overrides` | Operator manages via SQL today; CRUD UI is a separate small phase |
| Recovery CLI script | Same shape as `apply-downgrade.ts`; `planRecovery()` + `executeRecoveryPlan()` are exported and callable. Trivial to wrap |
| UX banners ("Your recurring series is enforcement-paused — upgrade to resume") | Schema + audit are in place; UI surface lands in a frontend phase |
| Multi-tab broadcast on enforcement change | Existing Phase 4 BroadcastChannel can be reused — would need a small ping from the apply script (out of scope here) |
| Per-row UPDATE health metric | Future cron to detect rows stuck in "paused for > 30 days" — operator awareness signal |

## 12. Future-ready design notes

The framework is intentionally generic. Examples of how it extends:

- **Metered billing / usage overages.** Add a new action kind `cap_usage_overage` whose handler reads usage counts + flips an `over_cap_at` flag on the relevant rows. The planner + executor structure is identical.
- **Temporary feature unlocks.** Already supported via `tenant_enforcement_overrides` with `mode='soft'` and `expires_at`. A "beta access to new feature" is one INSERT.
- **AI credits / seat bursting.** Add a per-tenant `credits_remaining` counter elsewhere; the action plan resolver consults it via a new policy function. Same envelope.
- **Grace periods.** `tenant_enforcement_overrides.expires_at` already provides time-bounded overrides. Combined with future `granted_by='system:grace_period_3day'` scheduling, ops can auto-grant grace periods.
- **Granular per-row policies.** Future: a per-row override table keyed on (tenantId, capability, entityId) — same resolver shape; planner consults at the row level instead of capability level.

None of this is implemented yet. The architecture is designed so it doesn't have to be — adding a new mode or action kind is a closed-union extension, the compiler will catch every missing switch arm.

## 13. Production readiness

| Check | Status |
|---|---|
| `npx tsc --noEmit` | ✓ clean |
| `npm run build` | ✓ clean |
| Migration runs cleanly (`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`) | ✓ idempotent |
| Webhook continues to fire `billing.downgrade_applied` (Phase 4) | ✓ unchanged |
| Webhook does NOT auto-fire orchestrator | ✓ as designed — operator-triggered |
| Cron skips paused series | ✓ Phase A + Phase B both check `enforcement_paused_at` |
| Idempotent under retry | ✓ `enforcement_event_id` + `IS NULL`/`IS NOT NULL` filters |
| Tenant isolation | ✓ every UPDATE has `tenantId` predicate |
| Grandfather semantics preserved | ✓ default policy is `grandfathered`; only operator-set HARD pauses execute |
| Backwards compatible | ✓ existing recurring series unaffected (`enforcement_paused_at` NULL) |
| Audit trail | ✓ every action emits `billing.enforcement_action_applied` or `_failed` |

## Operator deploy notes

1. Run migration: `psql $DATABASE_URL -f db/migrations/0041_downgrade_enforcement.sql`
2. Restart PM2: `pm2 restart zentrobiz`
3. (Optional) preview a tenant: `npx tsx scripts/preview-downgrade.ts --tenant=<uuid>`
4. (Optional) apply HARD enforcement: insert override + `npx tsx scripts/apply-downgrade.ts --tenant=<uuid> --to=free --confirm`

The orchestrator is dormant until an operator runs the CLI. Stripe webhook behavior is unchanged from Phase 4.

## Most important guarantees

- **No customer data loss.** Every "destructive" action is a column flip, never a DELETE. Reactivation is symmetric. Reads continue to surface paused rows so customers see "paused" UI, not gaps.
- **No silent workflow corruption.** Per-action try/catch isolates failures. The `ExecutionResult.ok` boolean is exact.
- **No entitlement inconsistencies.** Capabilities API + cron guards + frontend provider + orchestrator all read from the same `capabilitySnapshot(plan)`. The orchestrator is the only thing that mutates row-level enforcement; everything else reads.
- **No bypasses.** The `enforcement_paused_at` predicate is in the cron's hot path; a paused series cannot fire even if Phase 1 / Phase 2 / Phase 3 / Phase 4 all somehow misbehaved.
- **No accidental destructive enforcement.** The webhook does NOT call the executor. The CLI requires `--confirm`. Without `--confirm` everything is dry-run. The default per-capability policy is `grandfathered` — even a confirm-run with no overrides is a no-op for active series.
