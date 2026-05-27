# Demo Tenant Runbook — ZentroMeet Documentation Workspace

**Purpose**: A permanent, deterministic, side-effect-free workspace used for autonomous screenshot capture, knowledge-base tutorials, onboarding intelligence, contextual help, and future AI training/simulation. NEVER serves real customers.

**Critical guarantees**:
- Every demo tenant has `tenants.is_demo = true`.
- `lib/demo-safe.ts` suppresses outbound email / push / calendar / Stripe activity for `is_demo=true` tenants.
- Marker `docs-demo-v1` lives in `tenants.onboarding_progress->>'seeded_by'` — `reset-docs-demo.ts` only deletes rows tagged with this marker. Real customer data is never touched.
- All passwords gated behind `is_demo` — the documented demo password works ONLY on these tenants.

---

## 1. Tenant inventory

| Slug | Name | Plan | Onboarding | Purpose |
|------|------|------|------------|---------|
| `docs-demo` | ZentroMeet Demo Workspace | pro | complete | **Primary** screenshot target — full data, ~150+ bookings, 7 departments, 10 services |
| `docs-demo-partial` | Northwind Tax & Advisory | solo | partial | Half-configured — services + staff, no integrations |
| `docs-demo-new` | Brightline Coaching (new) | free | none | Fresh signup — empty wizard state |
| `docs-demo-stalled` | Pinecrest Legal Group | solo | stalled (14d) | Re-engagement / nudge screenshots |
| `docs-demo-ent` | Helix Health Systems | enterprise | complete | Enterprise scale + workforce screenshots |

Each tenant resolves at:
```
https://app.zentromeet.com/u/<slug>          # public booking page
https://app.zentromeet.com/login             # dashboard login (use any user below)
```

---

## 2. Credentials

**Password (all demo users)**: `DemoZentro2026!`

The password ONLY authenticates against users belonging to a tenant with `is_demo = true`. Do not redistribute outside the documentation context.

### Primary tenant (`docs-demo`)
| Role | Email |
|------|-------|
| Workspace Admin | `admin@docs-demo.zentromeet.demo` |
| Senior Tax Advisor | `sarah.johnson@docs-demo.zentromeet.demo` |
| Bookkeeping Lead | `michael.lee@docs-demo.zentromeet.demo` |
| Customer Success Manager | `emily.davis@docs-demo.zentromeet.demo` |
| Technical Support | `support.agent@docs-demo.zentromeet.demo` |

### Enterprise tenant (`docs-demo-ent`)
| Role | Email |
|------|-------|
| Practice Director | `admin@docs-demo-ent.zentromeet.demo` |
| Lead Physician | `physician1@docs-demo-ent.zentromeet.demo` |
| Specialist | `physician2@docs-demo-ent.zentromeet.demo` |
| Operations Manager | `manager@docs-demo-ent.zentromeet.demo` |

### Partial / stalled tenants
- `admin@docs-demo-partial.zentromeet.demo`
- `staff1@docs-demo-partial.zentromeet.demo`
- `admin@docs-demo-stalled.zentromeet.demo`

(`docs-demo-new` has no users — empty wizard state by design.)

---

## 3. Screenshot-worthy flows

### Primary tenant (`docs-demo`)
| Surface | URL | What it demonstrates |
|---------|-----|----------------------|
| Public booking page | `/u/docs-demo` | Branded landing, service list, staff identity |
| Service deep-link | `/u/docs-demo/intro-consultation` | Date strip, slot grid, intake form |
| Dashboard home | `/dashboard` | KPI hero, mini-schedule, onboarding "done" state |
| Appointments | `/dashboard/appointments` | Agenda timeline with 90d of populated bookings |
| Calendar | `/dashboard/calendar` | Week view with realistic density |
| Customers | `/dashboard/customers` | 8-row CRM with status/notes |
| Analytics | `/dashboard/analytics` | 90 days of pre-computed snapshots, populated charts |
| Communications | `/dashboard/communications` | Hub with response KPIs |
| Staff | `/dashboard/staff` | Workforce intelligence — 5 staff, full coverage |
| Departments | `/dashboard/departments` | 7 departments with color tagging |
| Services | `/dashboard/services` | 10-service catalog with pricing + assignments |
| Settings → branding | `/dashboard/settings/branding` | Configured workspace branding |
| Settings → calendar | `/dashboard/settings/calendar` | (no real connection — demo gate) |

### State variety (other tenants)
| Use case | Tenant | URL |
|----------|--------|-----|
| Onboarding wizard — empty | `docs-demo-new` | `/dashboard` (after login) |
| Onboarding "partial" callouts | `docs-demo-partial` | `/dashboard` |
| Stalled-onboarding re-engagement | `docs-demo-stalled` | `/dashboard` |
| Enterprise workforce | `docs-demo-ent` | `/dashboard/staff` |

---

## 4. CLI operations (run on EC2)

```bash
# SSH in
ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42
cd /var/www/scheduling-saas

# First-time seed (or after a reset)
ALLOW_DEV_SIMULATION=true npm run docs-demo:seed

# Wipe and reseed (idempotent — preserves all real tenants)
ALLOW_DEV_SIMULATION=true npm run docs-demo:reset
ALLOW_DEV_SIMULATION=true npm run docs-demo:seed

# Status check (without DB writes)
psql "$DATABASE_URL" -c "SELECT slug, name, plan, is_demo FROM tenants WHERE is_demo = true ORDER BY slug;"
```

The `ALLOW_DEV_SIMULATION=true` env var is also required by the existing chaos-simulation seeder; it serves as a triple-gate against accidental production execution.

---

## 5. Side-effect suppression — what's blocked and where

Every outbound side effect goes through a tenant-aware gate. For `is_demo=true` tenants, all of these short-circuit:

| Surface | Gate location | Behavior |
|---------|---------------|----------|
| Scheduling emails (confirm, reschedule, cancel, reminders, waitlist) | `lib/communications/preferences.ts` → `gateSchedulingEmail` | Returns `{ allowed: false, reason: "demo_tenant" }`, logged via `logDemoSuppression` |
| Push notifications | `lib/push/enqueue.ts` → `enqueueBookingPush` | Early return, no rows inserted into `push_deliveries` |
| External calendar sync (Google, Microsoft, Zoom) | `lib/calendar/sync.ts` → `onBookingCreated/Rescheduled/Cancelled` | Returns `{ status: "skipped", reason: "no_connection" }` |
| Stripe charges | env-gated (no `STRIPE_SECRET_KEY` in webhook config) + `is_demo` filter in admin rollups | No real money movement |
| Admin finance / intelligence rollups | `lib/admin-analytics/*` (filter `WHERE is_demo = true` to exclude) | Demo bookings never skew real KPIs |

All suppressions emit a structured log event:
```json
{ "evt": "demo_side_effect_suppressed", "surface": "email", "tenant_id": "...", "ts": "..." }
```

---

## 6. Determinism and screenshot stability

- **Frozen seed date**: `FROZEN_NOW = 2026-05-15T16:00:00.000Z` in `scripts/seed-docs-demo.ts`. Every timestamp the seeder writes is anchored here, so a re-run produces byte-identical rows (modulo any new schema columns added since the last run).
- **Booking schedule**: hand-tuned 90-day plan (60d past + 30d future) — same calendar every time.
- **Analytics snapshots**: deterministic curve in `seedAnalyticsSnapshots` — charts look natural but never drift.
- **Reset before reseed** if you change the seed code. Re-running on top of an old seed only updates conflict-safe fields.

**What is NOT stable yet** (known unstable surfaces — refine before relying on them for automated screenshots):
- "Now" indicator lines on calendar/agenda views — they follow real wall-clock time. Capture during a fixed wall-clock window or accept the moving Now line.
- Relative time strings ("in 3 days") on the dashboard depend on real time vs `FROZEN_NOW`. After enough drift these will look weird (e.g., "in 5 months"). Plan to bump `FROZEN_NOW` quarterly and re-seed.

---

## 7. Adding to the demo

To extend (e.g. a new department, more bookings, a service variant):
1. Edit `scripts/seed-docs-demo.ts` — add to the constants at the top (`DEPARTMENTS_FULL`, `SERVICES_FULL`, `STAFF_PRIMARY`, etc.) or extend `bookingSchedule()`.
2. Rebuild + redeploy the Next.js app so the script tx-runs against the latest schema.
3. Reset + reseed:
   ```bash
   ALLOW_DEV_SIMULATION=true npm run docs-demo:reset
   ALLOW_DEV_SIMULATION=true npm run docs-demo:seed
   ```
4. Eyeball the affected routes; commit the seeder change.

---

## 8. Removing the demo entirely

If we ever retire the docs-demo workspace:
```bash
ALLOW_DEV_SIMULATION=true npm run docs-demo:reset
```

Then optionally drop the `is_demo` column (migration to write later) and the helper:
```sql
ALTER TABLE tenants DROP COLUMN IF EXISTS is_demo;
DROP INDEX IF EXISTS tenants_is_demo_true_idx;
```

The `lib/demo-safe.ts` helper would then return false universally and the side-effect gates become no-ops without harm — but cleanup is preferred.

---

## 9. Troubleshooting

**Seeder reports `error: relation "tenants" does not exist`** → wrong `DATABASE_URL`. Re-check the env file.

**`is_demo` column missing** → migration 0070 not applied. Run:
```bash
psql "$DATABASE_URL" -f db/migrations/0070_demo_tenant_flag.sql
```

**Demo password doesn't work** → make sure the user belongs to a `is_demo=true` tenant. The bcrypt hash itself is identical to a real-tenant one; what gates the login is whether the tenant is flagged.

**Real customer email arrives from a demo booking** → side-effect gate didn't fire. Check `lib/demo-safe.ts` cache (60s TTL); call `invalidateDemoCache()` after flipping the flag manually. Log a P0 incident — the gate is a hard contract.

**Charts show "no data"** → `analytics_daily_snapshots` rows weren't written. Re-run seed; verify `snapshotDate` uniqueness conflicts aren't silently swallowing them.

---

## 10. Status check from `/admin/dev/simulation`

The Simulation Control Center page renders a "Permanent Demo Workspace" card listing all `is_demo=true` tenants matching `docs-demo%`. It's read-only — mutate via CLI.
