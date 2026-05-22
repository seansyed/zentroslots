/**
 * Billing & Subscription Center (Phase 16A).
 *
 * Strict invariants this rewrite preserves:
 *   - The existing /api/billing/checkout, /api/billing/portal, and
 *     /api/billing/state endpoints all keep working with their
 *     existing contracts. Phase 16A's only API change was extending
 *     /checkout to accept an optional `interval` parameter (defaults
 *     to "month" → identical to pre-Phase-16 behavior).
 *   - Existing subscriptions keep billing at their current Stripe
 *     Price. The legacy STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM env vars
 *     remain as fallbacks in `priceIdFor()`.
 *   - `getTenantUsage()` is called unchanged. Seat-enforcement logic
 *     elsewhere in the codebase is untouched.
 *   - When a Stripe Price ID isn't configured for a tier+interval,
 *     its CTA renders disabled with a clear message — never a fake
 *     checkout attempt.
 *
 * UX additions:
 *   - Premium hero with subscription status + insights
 *   - Monthly / yearly toggle (URL-driven via ?interval=year)
 *   - Five premium pricing cards (Free / Solo / Pro / Team / Enterprise)
 *   - "Most popular" badge on Pro
 *   - Yearly savings badge ("Save 1 month")
 *   - Seat / booking utilization meters
 *   - Comparison drawer (button → client-side drawer)
 *   - Subscription health card with next-renewal info
 *   - Billing policy section
 *   - Cancellation guidance section
 *   - Enterprise trust section
 *   - Polished "Stripe setup incomplete" card replacing the prior
 *     amber warning banner
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import {
  AlertTriangle,
  Award,
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  Crown,
  ExternalLink,
  Gauge,
  Info,
  Lock,
  Mail,
  Server,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingUp,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { getTenantUsage } from "@/lib/quotas";
import {
  getPlan,
  PLANS,
  formatPriceFor,
  isUnlimited,
  yearlyMonthsSaved,
  type Plan,
  type PlanId,
  type BillingInterval,
} from "@/lib/plans";
import { billingConfigSnapshot, isStripeConfigured, priceIdFor } from "@/lib/stripe";
import BillingActions from "@/components/BillingActions";
import BillingComparisonDrawer from "@/components/dashboard/BillingComparisonDrawer";
import Shell from "@/components/dashboard/Shell";
import { PremiumCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";

export const metadata = { title: "Billing & plan" };
export const dynamic = "force-dynamic";

const PLAN_ORDER: PlanId[] = ["free", "solo", "pro", "team", "enterprise"];

export default async function BillingPage(props: {
  searchParams: Promise<{ interval?: string; status?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const sp = await props.searchParams;
  const intervalParam = sp.interval === "year" ? "year" : "month";
  const interval: BillingInterval = intervalParam;
  const checkoutStatus = sp.status === "success" ? "success" : sp.status === "cancelled" ? "cancelled" : null;

  const usage = await getTenantUsage(user.tenantId);
  const currentPlan = getPlan(tenant.currentPlan);
  const stripeOn = isStripeConfigured();
  const isAdmin = user.role === "admin";

  // Resolve Stripe Price configuration for every plan+interval combo.
  // This stays server-side so we never leak env var contents to the
  // client — we only forward "is this configured?" booleans.
  const priceConfiguredFor: Record<PlanId, { month: boolean; year: boolean }> = {
    free: { month: true, year: true }, // Free has no checkout
    solo: { month: !!priceIdFor("solo", "month"), year: !!priceIdFor("solo", "year") },
    pro: { month: !!priceIdFor("pro", "month"), year: !!priceIdFor("pro", "year") },
    team: { month: !!priceIdFor("team", "month"), year: !!priceIdFor("team", "year") },
    enterprise: {
      month: !!priceIdFor("enterprise", "month"),
      year: !!priceIdFor("enterprise", "year"),
    },
  };

  // Phase 16B — full diagnostic snapshot for the admin-only wiring
  // section. Booleans only — env values themselves never cross the
  // server/client boundary.
  const billingDiag = billingConfigSnapshot();
  const wiredCount = (Object.keys(billingDiag.prices) as PlanId[]).reduce((sum, id) => {
    if (id === "free") return sum;
    const entry = billingDiag.prices[id];
    return sum + (entry.monthly || entry.legacyMonthly ? 1 : 0) + (entry.yearly ? 1 : 0);
  }, 0);
  // 8 = 4 paid plans × 2 intervals
  const missingCount = 8 - wiredCount;

  // Build the dynamic insight chips for the hero from the usage roll-up.
  const insightChips: string[] = [];
  if (usage.staff.limit > 0) {
    const staffPct = Math.round((usage.staff.used / Math.max(1, usage.staff.limit)) * 100);
    if (staffPct >= 80) {
      insightChips.push(`You're using ${staffPct}% of your staff capacity.`);
    } else if (staffPct >= 50) {
      insightChips.push(`${usage.staff.used} of ${usage.staff.limit} staff seats in use.`);
    }
  } else if (usage.staff.limit === -1) {
    insightChips.push(`${usage.staff.used} staff member${usage.staff.used === 1 ? "" : "s"} active.`);
  }
  if (currentPlan.id !== "free") {
    const monthsSaved = yearlyMonthsSaved(currentPlan);
    if (monthsSaved > 0 && interval === "month") {
      insightChips.push(`Annual billing on ${currentPlan.name} saves ${monthsSaved} month${monthsSaved === 1 ? "" : "s"}.`);
    }
  } else {
    insightChips.push("Upgrade to unlock executive analytics + automations.");
  }
  if (tenant.subscriptionStatus === "trialing" && tenant.trialEnd) {
    insightChips.push(`Trial ends ${new Date(tenant.trialEnd).toLocaleDateString()}.`);
  }

  const hasSubscription = Boolean(tenant.stripeSubscriptionId);
  const subscriptionStatus = tenant.subscriptionStatus ?? null;
  const trialEnd = tenant.trialEnd ? new Date(tenant.trialEnd).toISOString() : null;

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.currentPlan,
        logoUrl: tenant.logoUrl,
      }}
      title="Billing"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Billing" }]}
    >
      <div className="relative mt-2 space-y-5 pb-12">
        {/* Ambient depth — matches the rest of the dashboard */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-32 top-24 -z-10 h-[28rem] w-[28rem] rounded-full bg-brand-accent/[0.06] blur-[120px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 top-80 -z-10 h-[24rem] w-[24rem] rounded-full bg-emerald-300/[0.05] blur-[120px]"
        />

        {/* Checkout result banners (preserved from prior behavior) */}
        {checkoutStatus === "success" && (
          <FadeIn>
            <PremiumCard className="relative overflow-hidden border-emerald-200/40 bg-gradient-to-br from-emerald-50/40 via-surface to-surface p-4">
              <div className="flex items-start gap-3">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/40">
                  <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <div>
                  <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">
                    Checkout complete
                  </h3>
                  <p className="mt-0.5 text-[11.5px] text-ink-muted">
                    Stripe is finalizing your subscription — your plan may take a few seconds to update.
                  </p>
                </div>
              </div>
            </PremiumCard>
          </FadeIn>
        )}

        {/* ── Hero ───────────────────────────────────────────────── */}
        <FadeIn>
          <BillingHero
            tenantName={tenant.name}
            currentPlan={currentPlan}
            subscriptionStatus={subscriptionStatus}
            trialEnd={trialEnd}
            usage={usage}
            insightChips={insightChips}
            interval={interval}
            hasSubscription={hasSubscription}
            isAdmin={isAdmin}
            stripeOn={stripeOn}
          />
        </FadeIn>

        {/* ── Stripe-not-configured premium card ─────────────────── */}
        {!stripeOn && (
          <FadeIn delay={1}>
            <StripeSetupIncomplete />
          </FadeIn>
        )}

        {/* ── Phase 16B — Admin-only Stripe price wiring diagnostic
            Renders only for the workspace admin AND only when at
            least one Phase-16A price ID is missing. Shows boolean
            wiring status per (plan, interval) — never leaks the
            env var values themselves. Hidden when fully wired. */}
        {isAdmin && stripeOn && missingCount > 0 && (
          <FadeIn delay={1}>
            <BillingWiringDiagnostic snapshot={billingDiag} wiredCount={wiredCount} missingCount={missingCount} />
          </FadeIn>
        )}

        {/* ── Seat utilization intelligence ─────────────────────── */}
        <FadeIn delay={1}>
          <UtilizationStrip usage={usage} currentPlan={currentPlan} />
        </FadeIn>

        {/* ── Subscription health ────────────────────────────────── */}
        <FadeIn delay={2}>
          <SubscriptionHealthCard
            currentPlan={currentPlan}
            subscriptionStatus={subscriptionStatus}
            trialEnd={trialEnd}
            hasSubscription={hasSubscription}
            stripeOn={stripeOn}
            isAdmin={isAdmin}
          />
        </FadeIn>

        {/* ── Monthly / Yearly toggle + Compare drawer trigger ───── */}
        <FadeIn delay={3}>
          <PricingHeader interval={interval} />
        </FadeIn>

        {/* ── Pricing cards ──────────────────────────────────────── */}
        <FadeIn delay={3}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {PLAN_ORDER.map((id) => {
              const plan = PLANS[id];
              const isCurrent = plan.id === currentPlan.id;
              const stripePriceConfigured = priceConfiguredFor[id][interval];
              return (
                <PricingCard
                  key={plan.id}
                  plan={plan}
                  interval={interval}
                  isCurrent={isCurrent}
                  isAdmin={isAdmin}
                  hasSubscription={hasSubscription}
                  stripeOn={stripeOn}
                  stripePriceConfigured={stripePriceConfigured}
                />
              );
            })}
          </div>
        </FadeIn>

        {/* ── Compare features (drawer) ──────────────────────────── */}
        <FadeIn delay={4}>
          <BillingComparisonDrawer currentPlanId={currentPlan.id} interval={interval} />
        </FadeIn>

        {/* ── Cancellation experience ───────────────────────────── */}
        <FadeIn delay={5}>
          <CancellationCard
            hasSubscription={hasSubscription}
            isAdmin={isAdmin}
            stripeOn={stripeOn}
          />
        </FadeIn>

        {/* ── Billing history (gracefully gated) ─────────────────── */}
        <FadeIn delay={6}>
          <BillingHistoryCard hasSubscription={hasSubscription} stripeOn={stripeOn} isAdmin={isAdmin} />
        </FadeIn>

        {/* ── Billing policy ────────────────────────────────────── */}
        <FadeIn delay={7}>
          <PolicyCard />
        </FadeIn>

        {/* ── Trust section ─────────────────────────────────────── */}
        <FadeIn delay={8}>
          <TrustCard />
        </FadeIn>
      </div>
    </Shell>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────

function BillingHero({
  tenantName,
  currentPlan,
  subscriptionStatus,
  trialEnd,
  usage,
  insightChips,
  interval,
  hasSubscription,
  isAdmin,
  stripeOn,
}: {
  tenantName: string;
  currentPlan: Plan;
  subscriptionStatus: string | null;
  trialEnd: string | null;
  usage: Awaited<ReturnType<typeof getTenantUsage>>;
  insightChips: string[];
  interval: BillingInterval;
  hasSubscription: boolean;
  isAdmin: boolean;
  stripeOn: boolean;
}) {
  const statusTone = subscriptionStatusTone(subscriptionStatus, currentPlan.id);
  const statusLabel = subscriptionStatusLabel(subscriptionStatus, currentPlan.id);

  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/55 via-surface to-surface"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full bg-brand-accent/[0.14] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-20 -bottom-20 h-56 w-56 rounded-full bg-emerald-200/[0.18] blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            <CreditCard className="h-3 w-3" strokeWidth={2} />
            Billing & subscription
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Billing & plan
          </h1>
          <p className="mt-0.5 max-w-2xl text-[12px] text-ink-muted">
            <span className="font-medium text-ink">{tenantName}</span> &middot; currently on{" "}
            <span className="font-medium text-ink">{currentPlan.name}</span>
            {currentPlan.id !== "free" && currentPlan.priceCents !== null && (
              <>
                {" "}
                &middot;{" "}
                <span className="font-medium text-ink">{formatPriceFor(currentPlan, interval)}</span>
              </>
            )}
            {trialEnd && subscriptionStatus === "trialing" && (
              <> &middot; trial ends {new Date(trialEnd).toLocaleDateString()}</>
            )}
          </p>

          {insightChips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {insightChips.slice(0, 4).map((line, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm"
                >
                  <Sparkles className="h-3 w-3 text-brand-accent" strokeWidth={2} />
                  {line}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              // `bg-gradient-to-r` was missing — the statusTone class
              // only defines from/to color stops, so without the
              // gradient direction utility the background stayed
              // transparent and the white text was invisible against
              // the hero. Adding it activates the from/to colors.
              "inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-white shadow-[0_2px_8px_rgba(0,0,0,0.10)] ring-1",
              statusTone,
            )}
          >
            {statusLabel}
          </span>
          {hasSubscription && isAdmin && stripeOn && (
            <form action="/api/billing/portal" method="post">
              <button
                type="submit"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
                Stripe portal
              </button>
            </form>
          )}
        </div>
      </div>
    </PremiumCard>
  );
}

function subscriptionStatusTone(status: string | null, planId: PlanId): string {
  if (planId === "free") return "from-slate-400 to-slate-500 ring-border/40";
  if (status === "active") return "from-emerald-500 to-emerald-600 ring-emerald-200/40";
  if (status === "trialing") return "from-blue-500 to-blue-600 ring-blue-200/40";
  if (status === "past_due") return "from-amber-500 to-amber-600 ring-amber-200/40";
  if (status === "unpaid") return "from-orange-500 to-orange-600 ring-orange-200/40";
  if (status === "paused") return "from-slate-400 to-slate-500 ring-border/40";
  if (status === "canceled" || status === "cancelled")
    return "from-rose-500 to-rose-600 ring-rose-200/40";
  if (status === "incomplete" || status === "incomplete_expired")
    return "from-amber-500 to-amber-600 ring-amber-200/40";
  return "from-brand-accent to-brand-hover ring-brand-accent/40";
}

function subscriptionStatusLabel(status: string | null, planId: PlanId): string {
  if (planId === "free") return "Free plan";
  if (status === "active") return "Active";
  if (status === "trialing") return "Trial";
  if (status === "past_due") return "Past due";
  if (status === "unpaid") return "Unpaid";
  if (status === "paused") return "Paused";
  if (status === "canceled" || status === "cancelled") return "Cancelled";
  if (status === "incomplete") return "Action required";
  if (status === "incomplete_expired") return "Expired";
  return status ? status.replace(/_/g, " ") : "Active";
}

// ─── Utilization strip ─────────────────────────────────────────────

function UtilizationStrip({
  usage,
  currentPlan,
}: {
  usage: Awaited<ReturnType<typeof getTenantUsage>>;
  currentPlan: Plan;
}) {
  return (
    <div>
      <SectionHead
        eyebrow="Workspace usage"
        title="Seat & capacity utilization"
        hint="Live counts from your workspace, compared against your current plan limits."
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <UsageMeter
          icon={Users}
          label="Staff seats"
          used={usage.staff.used}
          limit={usage.staff.limit}
          unit={null}
        />
        <UsageMeter
          icon={ShieldCheck}
          label="Manager seats"
          used={usage.managers.used}
          limit={usage.managers.limit}
          unit={null}
          gatedAtZero={currentPlan.limits.maxManagers === 0}
        />
        <UsageMeter
          icon={Calendar}
          label="Bookings this month"
          used={usage.bookingsThisMonth.used}
          limit={usage.bookingsThisMonth.limit}
          unit={null}
        />
      </div>
    </div>
  );
}

function UsageMeter({
  icon: Icon,
  label,
  used,
  limit,
  unit,
  gatedAtZero,
}: {
  icon: LucideIcon;
  label: string;
  used: number;
  limit: number;
  unit: string | null;
  gatedAtZero?: boolean;
}) {
  const unlimited = isUnlimited(limit);
  const pct = unlimited ? 0 : limit === 0 ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const danger = !unlimited && pct >= 90;
  const warn = !unlimited && pct >= 70 && !danger;
  const tone = danger ? "warning" : warn ? "watch" : "calm";
  const iconTone =
    tone === "warning"
      ? "bg-amber-50 text-amber-700 ring-amber-200/40"
      : tone === "watch"
        ? "bg-sky-50 text-sky-700 ring-sky-200/40"
        : "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15";
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {label}
          </div>
          <div className="mt-1 text-[22px] font-semibold tracking-tight text-ink tabular-nums">
            {used.toLocaleString()}
            {unit ? (
              <span className="ml-0.5 text-[14px] font-medium text-ink-muted">{unit}</span>
            ) : null}
            {!unlimited && limit > 0 && (
              <span className="text-[14px] font-medium text-ink-muted"> / {limit}</span>
            )}
            {unlimited && (
              <span className="ml-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-emerald-700">
                Unlimited
              </span>
            )}
            {gatedAtZero && (
              <span className="ml-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
                Not on plan
              </span>
            )}
          </div>
          {!unlimited && limit > 0 && (
            <div
              className={cn(
                "mt-1 text-[10.5px]",
                danger ? "text-amber-700" : "text-ink-muted",
              )}
            >
              {pct}% used &middot; {Math.max(0, limit - used)} remaining
            </div>
          )}
        </div>
        <span
          className={cn(
            "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1",
            iconTone,
          )}
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
      {!unlimited && limit > 0 && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-inset">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              danger
                ? "bg-gradient-to-r from-amber-400 to-amber-500"
                : warn
                  ? "bg-gradient-to-r from-sky-400 to-sky-500"
                  : "bg-gradient-to-r from-brand-accent to-brand-hover",
            )}
            style={{ width: `${pct}%` }}
            aria-hidden
          />
        </div>
      )}
    </div>
  );
}

// ─── Subscription health card ──────────────────────────────────────

function SubscriptionHealthCard({
  currentPlan,
  subscriptionStatus,
  trialEnd,
  hasSubscription,
  stripeOn,
  isAdmin,
}: {
  currentPlan: Plan;
  subscriptionStatus: string | null;
  trialEnd: string | null;
  hasSubscription: boolean;
  stripeOn: boolean;
  isAdmin: boolean;
}) {
  // Free tenants render an aspirational version instead of a "health"
  // card with no signal.
  if (currentPlan.id === "free") {
    return (
      <div>
        <SectionHead
          eyebrow="Subscription"
          title="No active subscription"
          hint="You're on the Free plan — upgrade any time to unlock the paid surfaces."
        />
        <PremiumCard className="relative mt-3 overflow-hidden p-4 sm:p-5">
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
                <Sparkles className="h-4 w-4" strokeWidth={1.75} />
              </span>
              <div>
                <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">
                  Free forever &middot; no payment required
                </h3>
                <p className="mt-0.5 max-w-xl text-[11.5px] leading-relaxed text-ink-muted">
                  Operate on Free as long as you like. When you're ready to unlock analytics,
                  automations, or additional seats, switch to Solo or higher below.
                </p>
              </div>
            </div>
          </div>
        </PremiumCard>
      </div>
    );
  }

  const status = subscriptionStatus ?? "unknown";
  const isTrialing = status === "trialing";
  const isPastDue = status === "past_due";
  const isCanceled = status === "canceled" || status === "cancelled";

  return (
    <div>
      <SectionHead
        eyebrow="Subscription"
        title="Subscription health"
        hint="Live status from Stripe, with quick access to invoices and payment methods."
      />
      <PremiumCard className="relative mt-3 overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        <div className="grid gap-3 sm:grid-cols-3">
          <HealthMetric
            icon={isPastDue ? AlertTriangle : isCanceled ? Clock : CheckCircle2}
            tone={isPastDue ? "warning" : isCanceled ? "neutral" : "positive"}
            label="Status"
            primary={subscriptionStatusLabel(status, currentPlan.id)}
            detail={
              isPastDue
                ? "Payment failed — update your card via the Stripe portal."
                : isCanceled
                  ? "Access continues until the end of the current billing period."
                  : isTrialing
                    ? trialEnd
                      ? `Trial ends ${new Date(trialEnd).toLocaleDateString()}`
                      : "Currently in trial period"
                    : "Subscription is active and billing on schedule."
            }
          />
          <HealthMetric
            icon={CreditCard}
            tone="brand"
            label="Plan"
            primary={currentPlan.name}
            detail={`${currentPlan.limits.maxStaff === -1 ? "Unlimited" : currentPlan.limits.maxStaff} staff · ${
              currentPlan.limits.maxManagers === -1
                ? "Unlimited managers"
                : currentPlan.limits.maxManagers === 0
                  ? "No manager seats"
                  : `${currentPlan.limits.maxManagers} manager seat${currentPlan.limits.maxManagers === 1 ? "" : "s"}`
            }`}
          />
          <HealthMetric
            icon={ExternalLink}
            tone="neutral"
            label="Billing portal"
            primary={hasSubscription && stripeOn && isAdmin ? "Open Stripe portal" : "Unavailable"}
            detail={
              hasSubscription && stripeOn && isAdmin
                ? "Update payment, view invoices, change plan."
                : !isAdmin
                  ? "Only the workspace admin can manage billing."
                  : "No active subscription yet."
            }
            asLink={hasSubscription && stripeOn && isAdmin}
          />
        </div>
      </PremiumCard>
    </div>
  );
}

function HealthMetric({
  icon: Icon,
  tone,
  label,
  primary,
  detail,
  asLink,
}: {
  icon: LucideIcon;
  tone: "positive" | "warning" | "neutral" | "brand";
  label: string;
  primary: string;
  detail: string;
  asLink?: boolean;
}) {
  const iconTone =
    tone === "positive"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
      : tone === "warning"
        ? "bg-amber-50 text-amber-700 ring-amber-200/40"
        : tone === "brand"
          ? "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15"
          : "bg-surface-inset text-ink-subtle ring-border/40";
  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {label}
          </div>
          <div className="mt-1 text-[14px] font-semibold tracking-tight text-ink">{primary}</div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{detail}</p>
        </div>
        <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1", iconTone)}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
    </>
  );
  const baseClass = "relative overflow-hidden rounded-xl border border-border/60 bg-surface p-3.5";
  if (asLink) {
    return (
      <form action="/api/billing/portal" method="post" className={cn(baseClass, "hover:-translate-y-0.5 hover:shadow-soft transition-all")}>
        <button type="submit" className="block w-full text-left">
          {inner}
        </button>
      </form>
    );
  }
  return <div className={baseClass}>{inner}</div>;
}

// ─── Pricing header (toggle + compare button anchor) ───────────────

function PricingHeader({ interval }: { interval: BillingInterval }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <SectionHead
        eyebrow="Plans"
        title="Pick the right plan for your workspace"
        hint="Yearly billing saves 1 month on every paid tier."
      />
      <div className="inline-flex items-center gap-1.5">
        <div className="inline-flex rounded-full border border-border bg-surface p-0.5 shadow-soft">
          <Link
            href="/dashboard/billing?interval=month"
            className={cn(
              "rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all",
              interval === "month"
                ? "bg-brand-accent text-white shadow-[0_2px_8px_rgba(53,157,243,0.32)]"
                : "text-ink-muted hover:text-ink",
            )}
          >
            Monthly
          </Link>
          <Link
            href="/dashboard/billing?interval=year"
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all",
              interval === "year"
                ? "bg-brand-accent text-white shadow-[0_2px_8px_rgba(53,157,243,0.32)]"
                : "text-ink-muted hover:text-ink",
            )}
          >
            Yearly
            <span
              className={cn(
                "inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]",
                interval === "year"
                  ? "bg-white/20 text-white"
                  : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/40",
              )}
            >
              Save 1 month
            </span>
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Pricing card ──────────────────────────────────────────────────

function PricingCard({
  plan,
  interval,
  isCurrent,
  isAdmin,
  hasSubscription,
  stripeOn,
  stripePriceConfigured,
}: {
  plan: Plan;
  interval: BillingInterval;
  isCurrent: boolean;
  isAdmin: boolean;
  hasSubscription: boolean;
  stripeOn: boolean;
  stripePriceConfigured: boolean;
}) {
  const isMostPopular = plan.id === "pro";
  const isEnterprise = plan.id === "enterprise";
  const monthsSaved = yearlyMonthsSaved(plan);
  const priceLabel = formatPriceFor(plan, interval);

  // Frame tone — Pro gets the brand-popular ring; current plan gets
  // a stronger ring; everything else stays neutral.
  const frame = isCurrent
    ? "border-brand-accent/40 ring-2 ring-brand-accent/30 shadow-[0_8px_24px_rgba(53,157,243,0.16)]"
    : isMostPopular
      ? "border-brand-accent/30 ring-1 ring-brand-accent/20 shadow-[0_8px_24px_rgba(53,157,243,0.10)]"
      : "border-border/60";

  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-2xl border bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-md",
        frame,
      )}
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />

      {/* Top-right badges */}
      <div className="absolute right-3 top-3 flex flex-col items-end gap-1">
        {isCurrent && (
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-accent px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-white shadow-[0_4px_12px_rgba(53,157,243,0.32)]">
            Current plan
          </span>
        )}
        {!isCurrent && isMostPopular && (
          <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-500 to-amber-600 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-white shadow-[0_4px_12px_rgba(217,119,6,0.32)]">
            <Star className="h-2.5 w-2.5" strokeWidth={2.25} />
            Most popular
          </span>
        )}
        {!isCurrent && isEnterprise && (
          <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-violet-500 to-violet-600 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-white shadow-[0_4px_12px_rgba(124,58,237,0.32)]">
            <Crown className="h-2.5 w-2.5" strokeWidth={2.25} />
            Enterprise
          </span>
        )}
      </div>

      {/* Plan name */}
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-subtle">
        {plan.name}
      </div>

      {/* Price */}
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[26px] font-semibold tracking-tight text-ink">{priceLabel}</span>
      </div>
      {interval === "year" && monthsSaved > 0 && (
        <div className="mt-1 inline-flex items-center gap-1 self-start rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-emerald-700 ring-1 ring-emerald-200/40">
          <Sparkles className="h-2.5 w-2.5" strokeWidth={2.25} />
          Save {monthsSaved} month{monthsSaved === 1 ? "" : "s"}
        </div>
      )}

      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-muted">{plan.description}</p>

      {/* Feature list (first 4-5) */}
      <ul className="mt-3 space-y-1 text-[11.5px] text-ink">
        {plan.features.slice(0, 5).map((f) => (
          <li key={f} className="flex items-start gap-1.5">
            <CheckCircle2
              className={cn(
                "mt-0.5 h-3 w-3 shrink-0",
                isMostPopular ? "text-brand-accent" : "text-emerald-600",
              )}
              strokeWidth={2.25}
            />
            <span>{f}</span>
          </li>
        ))}
        {plan.features.length > 5 && (
          <li className="text-[10.5px] text-ink-subtle">
            +{plan.features.length - 5} more
          </li>
        )}
      </ul>

      {/* CTA — pushed to the bottom */}
      <div className="mt-auto pt-4">
        <BillingActions
          planId={plan.id}
          interval={interval}
          isCurrent={isCurrent}
          isAdmin={isAdmin}
          hasSubscription={hasSubscription}
          stripeOn={stripeOn}
          stripePriceConfigured={stripePriceConfigured}
        />
      </div>
    </div>
  );
}

// ─── Cancellation card ─────────────────────────────────────────────

function CancellationCard({
  hasSubscription,
  isAdmin,
  stripeOn,
}: {
  hasSubscription: boolean;
  isAdmin: boolean;
  stripeOn: boolean;
}) {
  if (!hasSubscription) return null;
  return (
    <div>
      <SectionHead
        eyebrow="Cancellation"
        title="If you need to pause or stop billing"
        hint="No surprise charges, no immediate lockout — your access continues until the end of the billing period."
      />
      <PremiumCard className="relative mt-3 overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-inset text-ink-muted ring-1 ring-border/40">
              <Clock className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">
                Do not renew my subscription
              </h3>
              <p className="mt-0.5 max-w-2xl text-[11.5px] leading-relaxed text-ink-muted">
                Cancelling stops automatic renewal but keeps your access through the end of the
                current billing period. You can reactivate anytime before expiration without losing
                any data. After expiration, your workspace becomes read-only until renewed.
              </p>
            </div>
          </div>
          {isAdmin && stripeOn && (
            <form action="/api/billing/portal" method="post">
              <button
                type="submit"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-ink shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:shadow-md"
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} />
                Manage in Stripe
              </button>
            </form>
          )}
        </div>
      </PremiumCard>
    </div>
  );
}

// ─── Billing history (gracefully gated) ────────────────────────────

function BillingHistoryCard({
  hasSubscription,
  stripeOn,
  isAdmin,
}: {
  hasSubscription: boolean;
  stripeOn: boolean;
  isAdmin: boolean;
}) {
  return (
    <div>
      <SectionHead
        eyebrow="History"
        title="Invoices & receipts"
        hint="Every charge, refund, and renewal — accessible from the Stripe billing portal."
      />
      <PremiumCard className="relative mt-3 overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
              <Mail className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">
                Stripe-hosted invoice history
              </h3>
              <p className="mt-0.5 max-w-2xl text-[11.5px] leading-relaxed text-ink-muted">
                Stripe stores every invoice with PDF + email copy. Failed-payment retries, refunds,
                and renewal dates are all visible in the portal. Inline invoice rendering arrives
                in a follow-up phase.
              </p>
            </div>
          </div>
          {hasSubscription && stripeOn && isAdmin ? (
            <form action="/api/billing/portal" method="post">
              <button
                type="submit"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-accent px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_4px_14px_rgba(53,157,243,0.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(53,157,243,0.40)]"
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} />
                Open invoice portal
              </button>
            </form>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-inset/40 px-3 py-1.5 text-[11.5px] font-medium text-ink-subtle">
              <Lock className="h-3 w-3" strokeWidth={2} />
              {!hasSubscription
                ? "No invoices yet"
                : !isAdmin
                  ? "Admin access only"
                  : "Stripe not configured"}
            </span>
          )}
        </div>
      </PremiumCard>
    </div>
  );
}

// ─── Stripe setup incomplete (replaces the prior amber banner) ─────

function StripeSetupIncomplete() {
  return (
    <div>
      <PremiumCard className="relative overflow-hidden border-amber-200/40 bg-gradient-to-br from-amber-50/40 via-surface to-surface p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700 ring-1 ring-amber-200/40">
            <AlertTriangle className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-amber-700 ring-1 ring-amber-200/40">
              Setup required
            </div>
            <h3 className="mt-1 text-[13.5px] font-semibold tracking-tight text-ink">
              Billing setup incomplete
            </h3>
            <p className="mt-0.5 max-w-2xl text-[11.5px] leading-relaxed text-ink-muted">
              Stripe credentials aren't set on this server yet. Plan grids stay read-only until the
              operator configures <code className="rounded bg-surface-inset px-1 py-0.5 text-[10.5px] font-mono">STRIPE_SECRET_KEY</code>{" "}
              and the per-plan price IDs in <code className="rounded bg-surface-inset px-1 py-0.5 text-[10.5px] font-mono">.env</code>.
              Existing subscriptions and webhook handlers are unaffected.
            </p>
            <ul className="mt-2 space-y-0.5 text-[11px] text-ink-muted">
              <li className="flex items-start gap-1.5">
                <span aria-hidden className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-amber-500" />
                <span>Stripe Dashboard → Developers → API keys → copy the secret key</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span aria-hidden className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-amber-500" />
                <span>Create Products + Prices for each tier &middot; both monthly and yearly</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span aria-hidden className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-amber-500" />
                <span>
                  Set <code className="font-mono text-[10.5px]">STRIPE_PRICE_*_MONTH</code> and{" "}
                  <code className="font-mono text-[10.5px]">STRIPE_PRICE_*_YEAR</code> env vars
                </span>
              </li>
              <li className="flex items-start gap-1.5">
                <span aria-hidden className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-amber-500" />
                <span>Restart the app to pick up the new env</span>
              </li>
            </ul>
          </div>
        </div>
      </PremiumCard>
    </div>
  );
}

// ─── Phase 16B · Admin-only wiring diagnostic ──────────────────────

function BillingWiringDiagnostic({
  snapshot,
  wiredCount,
  missingCount,
}: {
  snapshot: ReturnType<typeof billingConfigSnapshot>;
  wiredCount: number;
  missingCount: number;
}) {
  const planLabels: Array<{ id: PlanId; name: string }> = [
    { id: "solo", name: "Solo" },
    { id: "pro", name: "Pro" },
    { id: "team", name: "Team" },
    { id: "enterprise", name: "Enterprise" },
  ];
  return (
    <div>
      <PremiumCard className="relative overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700 ring-1 ring-amber-200/40">
            <Server className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-amber-700 ring-1 ring-amber-200/40">
              Admin diagnostic
            </div>
            <h3 className="mt-1 text-[13.5px] font-semibold tracking-tight text-ink">
              Stripe price wiring &mdash; {wiredCount} of 8 configured
            </h3>
            <p className="mt-0.5 max-w-2xl text-[11.5px] leading-relaxed text-ink-muted">
              {missingCount} price ID{missingCount === 1 ? " is" : "s are"} missing from{" "}
              <code className="rounded bg-surface-inset px-1 py-0.5 font-mono text-[10.5px]">.env</code>.
              Unconfigured tiers render their CTA disabled — no fake checkouts. Legacy
              <code className="ml-1 rounded bg-surface-inset px-1 py-0.5 font-mono text-[10.5px]">STRIPE_PRICE_PRO</code>
              {" "}/
              <code className="ml-1 rounded bg-surface-inset px-1 py-0.5 font-mono text-[10.5px]">STRIPE_PRICE_TEAM</code>
              {" "}values still count as monthly fallbacks for existing subscribers.
            </p>
            <div className="mt-3 overflow-x-auto rounded-xl border border-border/60 bg-surface">
              <table className="w-full text-[11.5px]">
                <thead className="bg-surface-inset/60 text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
                  <tr>
                    <th className="px-3 py-2 text-left">Plan</th>
                    <th className="px-3 py-2 text-left">Monthly env</th>
                    <th className="px-3 py-2 text-left">Yearly env</th>
                    <th className="px-3 py-2 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {planLabels.map((p) => {
                    const entry = snapshot.prices[p.id];
                    const monthlyOk = entry.monthly || entry.legacyMonthly;
                    const yearlyOk = entry.yearly;
                    const fullyWired = monthlyOk && yearlyOk;
                    return (
                      <tr key={p.id} className="border-t border-border/40">
                        <td className="px-3 py-2 font-semibold text-ink">{p.name}</td>
                        <td className="px-3 py-2 text-ink-muted">
                          {monthlyOk ? (
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <CheckCircle2 className="h-3 w-3" strokeWidth={2.25} />
                              <code className="font-mono text-[10.5px]">
                                STRIPE_PRICE_{p.id.toUpperCase()}_MONTH
                              </code>
                              {entry.legacyMonthly && !entry.monthly && (
                                <span className="inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-700 ring-1 ring-amber-200/40">
                                  Legacy
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-ink-subtle">
                              <Lock className="h-3 w-3" strokeWidth={2.25} />
                              <code className="font-mono text-[10.5px]">
                                STRIPE_PRICE_{p.id.toUpperCase()}_MONTH
                              </code>
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-ink-muted">
                          {yearlyOk ? (
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <CheckCircle2 className="h-3 w-3" strokeWidth={2.25} />
                              <code className="font-mono text-[10.5px]">
                                STRIPE_PRICE_{p.id.toUpperCase()}_YEAR
                              </code>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-ink-subtle">
                              <Lock className="h-3 w-3" strokeWidth={2.25} />
                              <code className="font-mono text-[10.5px]">
                                STRIPE_PRICE_{p.id.toUpperCase()}_YEAR
                              </code>
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ring-1",
                              fullyWired
                                ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
                                : monthlyOk || yearlyOk
                                  ? "bg-amber-50 text-amber-700 ring-amber-200/40"
                                  : "bg-surface-inset text-ink-subtle ring-border/40",
                            )}
                          >
                            {fullyWired ? "Live" : monthlyOk || yearlyOk ? "Partial" : "Unwired"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-2 flex items-center justify-between text-[10.5px] text-ink-subtle">
              <span>Webhook signing secret: {snapshot.webhookSecret ? "set" : "missing"}</span>
              <span>Existing subscribers on legacy prices keep billing unchanged.</span>
            </div>
          </div>
        </div>
      </PremiumCard>
    </div>
  );
}

// ─── Policy card ───────────────────────────────────────────────────

function PolicyCard() {
  const policies: Array<{ title: string; body: string }> = [
    {
      title: "No refunds",
      body: "All sales are final. We don't issue refunds for charges already processed.",
    },
    {
      title: "No prorated refunds",
      body: "Upgrading mid-cycle does not generate a prorated refund of the prior charge.",
    },
    {
      title: "Cancellation disables renewal",
      body: "Cancelling stops the next renewal — it doesn't issue a refund for the current period.",
    },
    {
      title: "Access continues until period end",
      body: "After cancelling, your workspace remains fully operational through the billing period.",
    },
    {
      title: "Downgrades take effect at the next cycle",
      body: "When you switch to a lower tier, the change applies starting the next billing period.",
    },
    {
      title: "Expired workspaces become read-only",
      body: "Once a paid plan lapses, the workspace stays accessible but read-only until renewed.",
    },
  ];
  return (
    <div>
      <SectionHead
        eyebrow="Policy"
        title="Billing policy"
        hint="Clear, non-hostile, and operator-friendly. No surprises."
      />
      <PremiumCard className="relative mt-3 overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        <ul className="grid gap-2.5 sm:grid-cols-2">
          {policies.map((p) => (
            <li key={p.title} className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-surface-inset/30 p-3">
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
                <Info className="h-3.5 w-3.5" strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <div className="text-[12px] font-semibold tracking-tight text-ink">{p.title}</div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{p.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </PremiumCard>
    </div>
  );
}

// ─── Trust card ────────────────────────────────────────────────────

function TrustCard() {
  const trustItems: Array<{ icon: LucideIcon; title: string; body: string }> = [
    {
      icon: ShieldCheck,
      title: "Secure billing",
      body: "Card data never touches our servers. Stripe handles PCI compliance end-to-end.",
    },
    {
      icon: Server,
      title: "Stripe-powered",
      body: "Industry-standard subscription billing trusted by millions of businesses.",
    },
    {
      icon: Award,
      title: "Encrypted credentials",
      body: "Workspace API credentials are encrypted at rest with audit-grade key management.",
    },
    {
      icon: Zap,
      title: "Enterprise SLA-ready",
      body: "Enterprise tier ships with uptime guarantees, SSO/SAML, and dedicated onboarding.",
    },
  ];
  return (
    <div>
      <SectionHead
        eyebrow="Trust"
        title="Billing you can trust"
        hint="The plumbing behind every transaction."
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {trustItems.map((t) => {
          const Icon = t.icon;
          return (
            <div
              key={t.title}
              className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft"
            >
              <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
              <div className="flex items-start gap-2.5">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0">
                  <h3 className="text-[12.5px] font-semibold tracking-tight text-ink">{t.title}</h3>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{t.body}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Shared ────────────────────────────────────────────────────────

function SectionHead({
  eyebrow,
  title,
  hint,
}: {
  eyebrow: string;
  title: string;
  hint?: string;
}) {
  return (
    <header className="mb-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
        {eyebrow}
      </div>
      <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
      {hint && <p className="mt-0.5 text-[12px] text-ink-muted">{hint}</p>}
    </header>
  );
}

// Unused-icon retention for future surfaces:
void Gauge;
void TrendingUp;
