/**
 * Brand Studio (Phase 18).
 *
 * Premium server-render layer that wraps the existing BrandingForm
 * client. Strict invariants this rewrite preserves:
 *
 *   - BrandingForm is mounted UNCHANGED. All persistence, theme
 *     application, live iframe preview, and tenant isolation logic
 *     continue to live there.
 *   - The /api/tenant PATCH contract (called by save()) is not
 *     touched.
 *   - planFeature(plan, "customBranding") gate is preserved — when
 *     false, BrandingForm renders disabled and we surface a premium
 *     locked-preview card instead of the prior amber warning banner.
 *   - Tenant slug + public URL behavior unchanged.
 *
 * UX additions (all in this server component — no new client deps):
 *   - Premium hero with brand status + insight chips + quick actions
 *   - Public URL preview chip with copy-to-clipboard-on-click hint
 *   - Brand health diagnostic chips (logo / tagline / color / etc.
 *     all derived from real tenant column values)
 *   - Pro upsell card (locked preview style) for Free plans
 *   - Plan capability echo so admins know exactly what tier their
 *     workspace operates at
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ExternalLink,
  Eye,
  Image as ImageIcon,
  Lock,
  Palette,
  Sparkles,
  Type,
  type LucideIcon,
} from "lucide-react";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { planFeature } from "@/lib/quotas";
import { getPlan } from "@/lib/plans";
import BrandingForm from "@/components/BrandingForm";
import Shell from "@/components/dashboard/Shell";
import { PremiumCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";

export const metadata = { title: "Brand Studio" };
export const dynamic = "force-dynamic";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3001";

export default async function BrandingPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  // Stale-session safety (2026-05-27): if the JWT references a user.id
  // that no longer exists (e.g. after a DB cleanup), send the visitor
  // back to login to mint a fresh session instead of bouncing them to
  // /dashboard where the same lookup would fail again.
  if (!user) redirect("/dashboard/login");
  if (user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard/login");

  const allowed = planFeature(tenant.currentPlan, "customBranding");
  const plan = getPlan(tenant.currentPlan);
  const publicUrl = `${APP_BASE_URL}/u/${tenant.slug}`;

  // Brand health — pure derivation from real tenant fields. No
  // fabricated metrics. Each row is a real boolean the operator can
  // verify themselves on the public page.
  const health = computeBrandHealth({
    name: tenant.name,
    logoUrl: tenant.logoUrl,
    primaryColor: tenant.primaryColor,
    tagline: tenant.tagline,
    description: tenant.description,
    bookingHeadline: tenant.bookingHeadline,
    hidePoweredBy: !!tenant.hidePoweredBy,
    whitelabelUnlocked: allowed,
  });

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Brand Studio"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Brand Studio" },
      ]}
    >
      <div className="relative mt-2 space-y-6 pb-12">
        {/* Ambient depth */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-32 top-24 -z-10 h-[28rem] w-[28rem] rounded-full opacity-50 blur-[120px]"
          style={{ backgroundColor: tenant.primaryColor, opacity: 0.06 }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 top-80 -z-10 h-[24rem] w-[24rem] rounded-full bg-emerald-300/[0.04] blur-[120px]"
        />

        {/* ── Hero ───────────────────────────────────────────────── */}
        <FadeIn>
          <BrandHero
            tenantName={tenant.name}
            tenantSlug={tenant.slug}
            publicUrl={publicUrl}
            primaryColor={tenant.primaryColor}
            allowed={allowed}
            planName={plan.name}
            whitelabelActive={!!tenant.hidePoweredBy && allowed}
          />
        </FadeIn>

        {/* ── Pro lock card (Free only) ─────────────────────────── */}
        {!allowed && (
          <FadeIn delay={1}>
            <LockedPreviewCard planName={plan.name} />
          </FadeIn>
        )}

        {/* ── Brand health insights ─────────────────────────────── */}
        <FadeIn delay={!allowed ? 2 : 1}>
          <BrandHealthSection health={health} />
        </FadeIn>

        {/* ── Existing BrandingForm — mounted untouched ─────────── */}
        <FadeIn delay={!allowed ? 3 : 2}>
          <BrandingForm
            disabled={!allowed}
            tenantSlug={tenant.slug}
            initial={{
              name: tenant.name,
              logoUrl: tenant.logoUrl ?? "",
              primaryColor: tenant.primaryColor,
              tagline: tenant.tagline ?? "",
              description: tenant.description ?? "",
              bookingHeadline: tenant.bookingHeadline ?? "",
            }}
          />
        </FadeIn>
      </div>
    </Shell>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────

function BrandHero({
  tenantName,
  tenantSlug,
  publicUrl,
  primaryColor,
  allowed,
  planName,
  whitelabelActive,
}: {
  tenantName: string;
  tenantSlug: string;
  publicUrl: string;
  primaryColor: string;
  allowed: boolean;
  planName: string;
  whitelabelActive: boolean;
}) {
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/55 via-surface to-surface"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full blur-3xl"
        style={{ backgroundColor: primaryColor, opacity: 0.14 }}
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
            <Palette className="h-3 w-3" strokeWidth={2} />
            Brand studio
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Brand Studio
          </h1>
          <p className="mt-0.5 max-w-2xl text-[12px] text-ink-muted">
            <span className="font-medium text-ink">{tenantName}</span> &middot; customize your
            public booking experience, identity, colors, and customer-facing presence.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {/* Plan status */}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] ring-1",
                allowed
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
                  : "bg-amber-50 text-amber-700 ring-amber-200/40",
              )}
            >
              {allowed ? (
                <>
                  <CheckCircle2 className="h-2.5 w-2.5" strokeWidth={2.25} />
                  Custom branding · {planName}
                </>
              ) : (
                <>
                  <Lock className="h-2.5 w-2.5" strokeWidth={2} />
                  Basic branding · {planName}
                </>
              )}
            </span>
            {whitelabelActive && (
              <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-violet-700 ring-1 ring-violet-200/40">
                <Sparkles className="h-2.5 w-2.5" strokeWidth={2.25} />
                White-label active
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[10px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm">
              <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: primaryColor }} />
              {primaryColor.toUpperCase()}
            </span>
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/u/${tenantSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
            Open public page
          </Link>
        </div>
      </div>

      {/* Public URL preview chip */}
      <div className="relative mt-4 rounded-xl border border-border/60 bg-surface/80 p-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <div className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
            <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[9px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Public booking URL
            </div>
            <code className="block truncate font-mono text-[12px] text-ink">{publicUrl}</code>
          </div>
          <Link
            href={publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2 text-[10.5px] font-semibold text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
          >
            Visit
            <ArrowUpRight className="h-3 w-3" strokeWidth={2.25} />
          </Link>
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── Locked preview card (replaces the old amber banner) ───────────

function LockedPreviewCard({ planName }: { planName: string }) {
  const proFeatures = [
    "Custom primary brand color",
    "Logo on every public surface",
    "Hide ZentroMeet (white-label)",
    "Tagline + booking headline",
    "Long-form description",
    "Calendar invite branding",
  ];
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-amber-50/30 via-surface to-surface"
    >
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full bg-amber-200/[0.20] blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2.5">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-50 to-surface text-amber-700 ring-1 ring-amber-200/40 shadow-sm">
            <Sparkles className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-amber-700 ring-1 ring-amber-200/40">
                <Lock className="h-2.5 w-2.5" strokeWidth={2} />
                Pro feature
              </span>
              <span className="text-[10px] font-medium text-ink-subtle">
                Currently on <span className="font-semibold text-ink">{planName}</span>
              </span>
            </div>
            <h3 className="mt-1 text-[13px] font-semibold tracking-tight text-ink">
              Make this workspace fully yours
            </h3>
            <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-ink-muted">
              Upgrade to edit identity, colors, and white-label — preview below is read-only until then.
            </p>
            <ul className="mt-2 grid gap-x-3 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
              {proFeatures.map((f) => (
                <li key={f} className="flex items-start gap-1 text-[10.5px] text-ink-muted">
                  <CheckCircle2 className="mt-[2px] h-2.5 w-2.5 shrink-0 text-amber-600" strokeWidth={2.5} />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <Link
          href="/dashboard/billing"
          className="zm-pulse-glow inline-flex shrink-0 items-center gap-1.5 self-start rounded-md bg-brand-accent px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_4px_14px_rgba(37,99,235,0.32)] transition-all duration-[200ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-[0_8px_22px_rgba(37,99,235,0.42)] sm:self-center"
        >
          <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
          Unlock branding
          <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
        </Link>
      </div>
    </PremiumCard>
  );
}

// ─── Brand health insights ─────────────────────────────────────────

type HealthRow = {
  icon: LucideIcon;
  label: string;
  detail: string;
  // Phase 18 brief: "helpful, premium, NOT nagging". We frame
  // missing fields as opportunities rather than failures.
  state: "complete" | "opportunity" | "locked";
};

function computeBrandHealth(input: {
  name: string;
  logoUrl: string | null;
  primaryColor: string;
  tagline: string | null;
  description: string | null;
  bookingHeadline: string | null;
  hidePoweredBy: boolean;
  whitelabelUnlocked: boolean;
}): HealthRow[] {
  const rows: HealthRow[] = [];

  rows.push({
    icon: Type,
    label: "Business name",
    detail: input.name
      ? `Public surfaces display "${input.name}".`
      : "Add a business name so customers know who they're booking.",
    state: input.name ? "complete" : "opportunity",
  });

  rows.push({
    icon: ImageIcon,
    label: "Logo",
    detail: input.logoUrl
      ? "Your logo renders on the public booking page header."
      : "Add a logo URL to show your mark above the booking flow.",
    state: input.logoUrl ? "complete" : "opportunity",
  });

  rows.push({
    icon: Palette,
    label: "Primary color",
    detail: contrastFeedback(input.primaryColor),
    state: "complete",
  });

  rows.push({
    icon: Type,
    label: "Tagline",
    detail: input.tagline
      ? `"${truncate(input.tagline, 64)}"`
      : "A one-line tagline appears beneath your business name.",
    state: input.tagline ? "complete" : "opportunity",
  });

  rows.push({
    icon: Type,
    label: "Booking headline",
    detail: input.bookingHeadline
      ? `"${truncate(input.bookingHeadline, 64)}"`
      : "Custom headline above your service list (optional).",
    state: input.bookingHeadline ? "complete" : "opportunity",
  });

  rows.push({
    icon: Sparkles,
    label: "White-label",
    detail: input.whitelabelUnlocked
      ? input.hidePoweredBy
        ? "ZentroMeet branding is hidden on the public booking page."
        : "Available on your plan — toggle 'Hide powered-by' to activate."
      : "Available on Pro plans — remove ZentroMeet branding entirely.",
    state: input.whitelabelUnlocked
      ? input.hidePoweredBy
        ? "complete"
        : "opportunity"
      : "locked",
  });

  return rows;
}

function contrastFeedback(hex: string): string {
  // Compute relative luminance and the contrast ratio against white.
  // Brief asks for "premium color contrast" feedback — we surface a
  // single sentence describing how the color sits visually.
  const l = relativeLuminance(hex);
  if (l === null) return "Configured.";
  // Contrast against white background (1.05) — most public surfaces
  // render the primary color on white, so this is the most relevant
  // comparison.
  const ratio = 1.05 / (l + 0.05);
  if (ratio >= 4.5) return `Strong contrast on white surfaces (${ratio.toFixed(1)}:1 — WCAG AA).`;
  if (ratio >= 3) return `Acceptable contrast on white (${ratio.toFixed(1)}:1 — meets large-text AA).`;
  return `Light tone — consider darkening for button text legibility (${ratio.toFixed(1)}:1).`;
}

function relativeLuminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function BrandHealthSection({ health }: { health: HealthRow[] }) {
  // Confidence score: % of unlockable rows actually complete.
  // Locked rows don't count against the operator — that's a plan
  // upgrade decision, not a "you forgot something."
  const unlockable = health.filter((h) => h.state !== "locked");
  const completeCount = unlockable.filter((h) => h.state === "complete").length;
  const totalUnlockable = unlockable.length || 1;
  const pct = Math.round((completeCount / totalUnlockable) * 100);
  const tone =
    pct >= 90
      ? { chip: "bg-emerald-50 text-emerald-700 ring-emerald-200/40", bar: "bg-gradient-to-r from-emerald-400 to-emerald-500", label: "Brand ready" }
      : pct >= 60
        ? { chip: "bg-brand-subtle text-brand-accent ring-brand-accent/15", bar: "bg-gradient-to-r from-brand-accent to-blue-500", label: "Almost there" }
        : pct >= 30
          ? { chip: "bg-amber-50 text-amber-700 ring-amber-200/40", bar: "bg-gradient-to-r from-amber-400 to-amber-500", label: "In progress" }
          : { chip: "bg-surface-inset text-ink-subtle ring-border/40", bar: "bg-gradient-to-r from-slate-300 to-slate-400", label: "Just starting" };

  return (
    <div>
      <PremiumCard className="relative overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        <span aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-56 w-56 rounded-full bg-brand-accent/[0.06] blur-3xl" />

        {/* Header with confidence score + completion bar */}
        <header className="relative flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex h-1.5 w-1.5 rounded-full bg-brand-accent" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                Brand quality
              </span>
            </div>
            <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
              What&rsquo;s shipping on your public page
            </h2>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">
              {completeCount} of {totalUnlockable} elements live — derived from your saved tenant data.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="text-right">
              <div className="text-[26px] font-semibold leading-none tabular-nums text-ink">
                {pct}
                <span className="ml-0.5 text-[12px] font-medium text-ink-subtle">%</span>
              </div>
              <span
                className={cn(
                  "mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] ring-1",
                  tone.chip,
                )}
              >
                {tone.label}
              </span>
            </div>
          </div>
        </header>

        {/* Confidence bar */}
        <div className="relative mt-3.5 h-1.5 overflow-hidden rounded-full bg-surface-inset">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              tone.bar,
            )}
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Insight rows */}
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {health.map((row) => {
            const Icon = row.icon;
            const iconWrapTone =
              row.state === "complete"
                ? "bg-gradient-to-br from-emerald-50 to-emerald-100/40 text-emerald-700 ring-emerald-200/50 shadow-[0_2px_8px_-2px_rgba(16,185,129,0.18)]"
                : row.state === "locked"
                  ? "bg-gradient-to-br from-amber-50 to-amber-100/40 text-amber-700 ring-amber-200/50 shadow-[0_2px_8px_-2px_rgba(245,158,11,0.16)]"
                  : "bg-gradient-to-br from-surface-inset to-surface text-ink-subtle ring-border/50";
            const stateLabel =
              row.state === "complete"
                ? "Live"
                : row.state === "locked"
                  ? "Pro"
                  : "Tip";
            const stateChipTone =
              row.state === "complete"
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
                : row.state === "locked"
                  ? "bg-amber-50 text-amber-700 ring-amber-200/40"
                  : "bg-brand-subtle text-brand-accent ring-brand-accent/15";
            return (
              <li
                key={row.label}
                className={cn(
                  "group relative overflow-hidden rounded-xl border border-border/60 bg-surface p-3 transition-all duration-[200ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                  "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[0_8px_18px_-12px_rgba(15,23,42,0.18)]",
                )}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={cn(
                      "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 transition-transform duration-200 group-hover:scale-105",
                      iconWrapTone,
                    )}
                  >
                    {row.state === "complete" ? (
                      <CheckCircle2 className="h-4 w-4" strokeWidth={2.25} />
                    ) : (
                      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-semibold tracking-tight text-ink">{row.label}</span>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ring-1",
                          stateChipTone,
                        )}
                      >
                        {stateLabel}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{row.detail}</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </PremiumCard>
    </div>
  );
}
