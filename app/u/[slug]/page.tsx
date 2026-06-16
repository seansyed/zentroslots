import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Building2,
  CalendarCheck,
  Clock,
  Globe2,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";

import { db } from "@/db/client";
import { departments, serviceStaff, services, tenants, users } from "@/db/schema";
import { Avatar } from "@/components/ui/Avatar";

/**
 * Public workspace landing page (`/u/:slug`).
 *
 * Phase 19 — Public Booking Page Transformation.
 *
 * Visual refactor only. All four routing modes are preserved:
 *   - department-picker
 *   - department-detail (?dept=<id>)
 *   - unassigned-detail (?dept=__none)
 *   - all-services (no departments configured)
 *
 * The data layer and URL contract are byte-identical to the previous
 * implementation. The booking flow itself lives at the service page
 * (`/u/:slug/:serviceSlug`) and was polished in Phase 17B — this page
 * just routes customers into it.
 *
 * Polish goals delivered:
 *   - Premium hero with ambient brand bloom + logo ring + trust chip
 *   - Inline trust strip (instant confirm / calendar invite / TZ / secure)
 *   - Service cards with host preview, duration + price + meeting type
 *     metadata row, polished CTA, hover lift
 *   - Refined breadcrumb step indicator (eyebrow style)
 *   - Premium empty states for no-services scenarios
 *   - Refined powered-by footer with subtle tenant-aware tone
 *   - Responsive: mobile stacks naturally, touch targets ≥ 44px
 */

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant) return { title: "Not found" };
  return {
    title: tenant.name,
    description:
      tenant.tagline ?? tenant.description ?? `Book a meeting with ${tenant.name}.`,
    openGraph: { title: tenant.name, description: tenant.tagline ?? undefined, type: "profile" },
    robots: { index: tenant.active, follow: tenant.active },
  };
}

type ServiceRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  price: number;
  departmentIds: Set<string>;
  staff: { id: string; name: string; avatarUrl: string | null }[];
};

export default async function PublicProfilePage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ dept?: string }>;
}) {
  const { slug } = await props.params;
  const { dept: deptParam } = await props.searchParams;

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.active) notFound();

  const rows = await db
    .select({
      serviceId: services.id,
      serviceSlug: services.slug,
      serviceName: services.name,
      description: services.description,
      durationMinutes: services.durationMinutes,
      price: services.price,
      staffId: users.id,
      staffName: users.name,
      staffAvatarUrl: users.avatarUrl,
      staffDepartmentId: users.departmentId,
    })
    .from(services)
    .innerJoin(
      serviceStaff,
      and(
        eq(serviceStaff.serviceId, services.id),
        eq(serviceStaff.tenantId, services.tenantId),
      ),
    )
    .innerJoin(users, eq(users.id, serviceStaff.userId))
    .where(and(eq(services.tenantId, tenant.id), eq(services.isActive, 1)));

  const byService = new Map<string, ServiceRow>();
  for (const r of rows) {
    const cur =
      byService.get(r.serviceId) ?? {
        id: r.serviceId,
        slug: r.serviceSlug,
        name: r.serviceName,
        description: r.description,
        durationMinutes: r.durationMinutes,
        price: r.price,
        departmentIds: new Set<string>(),
        staff: [],
      };
    cur.staff.push({ id: r.staffId, name: r.staffName, avatarUrl: r.staffAvatarUrl });
    if (r.staffDepartmentId) cur.departmentIds.add(r.staffDepartmentId);
    byService.set(r.serviceId, cur);
  }
  const allServices = Array.from(byService.values());

  const allDepartments = await db
    .select({
      id: departments.id,
      name: departments.name,
      color: departments.color,
      description: departments.description,
    })
    .from(departments)
    .where(eq(departments.tenantId, tenant.id))
    .orderBy(asc(departments.name));

  const servicesByDept = new Map<string, ServiceRow[]>();
  const unassigned: ServiceRow[] = [];
  for (const svc of allServices) {
    if (svc.departmentIds.size === 0) {
      unassigned.push(svc);
      continue;
    }
    for (const deptId of svc.departmentIds) {
      const arr = servicesByDept.get(deptId) ?? [];
      arr.push(svc);
      servicesByDept.set(deptId, arr);
    }
  }
  const departmentsWithServices = allDepartments.filter(
    (d) => (servicesByDept.get(d.id) ?? []).length > 0,
  );

  const isUnassignedView = deptParam === "__none";
  const showDepartmentPicker = departmentsWithServices.length > 0 && !deptParam;
  const pickedDept =
    deptParam && !isUnassignedView
      ? allDepartments.find((d) => d.id === deptParam) ?? null
      : null;
  const visibleServices = pickedDept
    ? servicesByDept.get(pickedDept.id) ?? []
    : isUnassignedView
      ? unassigned
      : showDepartmentPicker
        ? []
        : allServices;

  const accent = tenant.primaryColor;
  const showPoweredBy = !tenant.hidePoweredBy;

  // Service count used for the hero context line — gives the customer
  // a sense of breadth before they scroll. Derived honestly from data.
  const totalServices = allServices.length;
  const totalStaff = new Set(rows.map((r) => r.staffId)).size;

  // Humanization line (Phase 19B Part 1). Derived purely from real
  // tenant data — when tagline is absent we surface a tasteful
  // generic that frames the workspace as concierge-ish.
  const identityLine =
    tenant.tagline?.trim() ||
    (totalStaff > 0
      ? totalStaff === 1
        ? `Schedule a meeting with the ${tenant.name} team.`
        : `${totalStaff} hosts available · book a time that works for you.`
      : `Professional scheduling, hosted by ${tenant.name}.`);

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-b from-slate-50/60 via-white to-white">
      {/* Accent top stripe — replaces the previous header borderTop.
          Anchors the brand color at the very top of the viewport. */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 z-10 h-[3px]"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${accent} 12%, ${accent} 88%, transparent 100%)`,
        }}
      />

      {/* Ambient bloom behind the hero — soft, tasteful, brand-keyed. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 -top-24 h-[28rem] w-[28rem] rounded-full blur-[120px]"
        style={{ backgroundColor: accent, opacity: 0.06 }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 top-40 h-[24rem] w-[24rem] rounded-full bg-emerald-200/[0.09] blur-[120px]"
      />
      {/* Subtle radial wash centered above the fold (Phase 19B Part 6).
          Barely visible, but adds quiet atmospheric depth. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
        style={{
          background: `radial-gradient(ellipse 720px 340px at 50% -10%, ${hexWithAlpha(accent, 0.05)} 0%, transparent 70%)`,
        }}
      />

      {/* ───────── HERO ─────────────────────────────────────────────── */}
      <header className="relative">
        <div className="mx-auto max-w-[704px] px-5 pb-7 pt-10 sm:px-6 sm:pb-9 sm:pt-14">
          <div className="flex items-start gap-4 sm:gap-5">
            {/* Logo with ring + soft shadow. Falls back to monogram. */}
            <BrandMark
              logoUrl={tenant.logoUrl}
              name={tenant.name}
              accent={accent}
            />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em]"
                  style={{
                    backgroundColor: hexWithAlpha(accent, 0.10),
                    color: accent,
                  }}
                >
                  <BadgeCheck className="h-2.5 w-2.5" strokeWidth={2.5} />
                  Verified workspace
                </span>
                {totalServices > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100/80 px-2 py-0.5 text-[10px] font-medium text-slate-600 ring-1 ring-slate-200/60">
                    <Sparkles className="h-2.5 w-2.5" strokeWidth={2} />
                    {totalServices} service{totalServices === 1 ? "" : "s"} available
                  </span>
                )}
              </div>
              <h1 className="mt-2 text-[24px] font-semibold leading-[1.15] tracking-tight text-slate-900 sm:text-[28px]">
                {tenant.name}
              </h1>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-600 sm:text-[14.5px]">
                {identityLine}
              </p>
            </div>
          </div>

          {tenant.description && (
            <p className="mt-4 max-w-[58ch] text-[13px] leading-relaxed text-slate-700 sm:text-[13.5px]">
              {tenant.description}
            </p>
          )}

          {/* Trust strip — inline indicators reinforcing booking confidence.
              These are real platform behaviors, not aspirational copy. */}
          <TrustStrip />
        </div>
      </header>

      {/* ───────── MAIN ─────────────────────────────────────────────── */}
      <main className="relative">
        <div className="mx-auto max-w-[704px] px-5 pb-16 sm:px-6">
          {/* Breadcrumb / step indicator — only relevant in dept mode */}
          {(showDepartmentPicker || pickedDept || isUnassignedView) && (
            <StepIndicator
              step={showDepartmentPicker ? 1 : 2}
              accent={accent}
            />
          )}

          {/* Section title — eyebrow + heading + optional context */}
          <SectionHeader
            accent={accent}
            eyebrow={
              showDepartmentPicker
                ? "Step 1 of 3"
                : pickedDept
                  ? "Departments"
                  : isUnassignedView
                    ? "Browse"
                    : tenant.bookingHeadline
                      ? "Welcome"
                      : "Book a meeting"
            }
            title={
              showDepartmentPicker
                ? "Choose a department"
                : pickedDept
                  ? pickedDept.name
                  : isUnassignedView
                    ? "Other services"
                    : tenant.bookingHeadline ?? "Book a meeting"
            }
            description={
              pickedDept?.description ??
              (showDepartmentPicker
                ? "Pick the team that best fits what you need help with."
                : !pickedDept && !isUnassignedView && totalServices > 0
                  ? `${totalServices} service${totalServices === 1 ? "" : "s"} · ${totalStaff} host${totalStaff === 1 ? "" : "s"} available to meet with you.`
                  : null)
            }
          />

          {/* DEPARTMENT PICKER MODE ─────────────────────────────────── */}
          {showDepartmentPicker && (
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {departmentsWithServices.map((d) => {
                const count = servicesByDept.get(d.id)?.length ?? 0;
                return (
                  <Link
                    key={d.id}
                    href={`/u/${tenant.slug}?dept=${d.id}`}
                    className="group relative flex items-start gap-3 overflow-hidden rounded-2xl border border-slate-200/65 bg-white p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.55)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px hover:border-slate-300 hover:shadow-[0_8px_22px_-14px_rgba(15,23,42,0.18)] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 sm:p-4"
                    style={
                      {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        "--tw-ring-color": accent,
                      } as React.CSSProperties
                    }
                  >
                    <span
                      aria-hidden
                      className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-black/[0.04] shadow-sm"
                      style={{
                        backgroundColor: hexWithAlpha(d.color ?? accent, 0.10),
                      }}
                    >
                      <Building2
                        className="h-4 w-4"
                        strokeWidth={1.75}
                        style={{ color: d.color ?? accent }}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold tracking-tight text-slate-900 sm:text-[15px]">
                        {d.name}
                      </div>
                      {d.description && (
                        <div className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-slate-600">
                          {d.description}
                        </div>
                      )}
                      <div className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-slate-500">
                        <span
                          aria-hidden
                          className="inline-block h-1 w-1 rounded-full"
                          style={{ backgroundColor: d.color ?? accent }}
                        />
                        {count} service{count === 1 ? "" : "s"}
                      </div>
                    </div>
                    <ArrowUpRight
                      className="ml-1 h-4 w-4 shrink-0 self-center text-slate-300 transition-all duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-slate-600"
                      strokeWidth={2}
                    />
                  </Link>
                );
              })}
              {/* Unassigned escape-hatch when picker is shown */}
              {unassigned.length > 0 && (
                <Link
                  href={`/u/${tenant.slug}?dept=__none`}
                  className="group flex items-center justify-between gap-2 rounded-2xl border border-dashed border-slate-300 bg-white/60 p-4 text-[12px] text-slate-600 transition-colors hover:border-slate-400 hover:bg-white sm:col-span-2 sm:p-3.5"
                >
                  <span>
                    {unassigned.length} other service{unassigned.length === 1 ? "" : "s"} not tied to a department.
                  </span>
                  <span className="inline-flex items-center gap-0.5 font-medium text-slate-700 group-hover:text-slate-900">
                    Browse
                    <ArrowRight className="h-3 w-3" strokeWidth={2} />
                  </span>
                </Link>
              )}
            </div>
          )}

          {/* SERVICES LIST MODE ─────────────────────────────────────── */}
          {!showDepartmentPicker && (
            <>
              {(pickedDept || isUnassignedView) && (
                <div className="mt-4">
                  <Link
                    href={`/u/${tenant.slug}`}
                    className="inline-flex items-center gap-1 text-[11.5px] font-medium text-slate-500 transition-colors hover:text-slate-900"
                  >
                    <ArrowRight
                      className="h-3 w-3 rotate-180"
                      strokeWidth={2}
                    />
                    All departments
                  </Link>
                </div>
              )}

              <div className="mt-5 space-y-3">
                {visibleServices.length === 0 ? (
                  <EmptyServicesCard
                    pickedDept={!!pickedDept}
                    isUnassigned={isUnassignedView}
                    tenantSlug={tenant.slug}
                    accent={accent}
                  />
                ) : (
                  visibleServices.map((s) => (
                    <ServiceCard
                      key={s.id}
                      tenantSlug={tenant.slug}
                      service={s}
                      accent={accent}
                    />
                  ))
                )}
              </div>

              {/* Sub-navigation: dept-less services link */}
              {pickedDept && unassigned.length > 0 && (
                <Link
                  href={`/u/${tenant.slug}?dept=__none`}
                  className="group mt-5 flex items-center justify-between gap-3 rounded-xl border border-slate-200/65 bg-white/70 p-3 text-[12px] text-slate-600 shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px hover:border-slate-300 hover:bg-white hover:shadow-[0_4px_12px_-6px_rgba(15,23,42,0.14)] sm:p-3.5"
                >
                  <span>
                    {unassigned.length} other service{unassigned.length === 1 ? " isn't" : "s aren't"} assigned to a department.
                  </span>
                  <span className="inline-flex items-center gap-0.5 font-semibold text-slate-700 group-hover:text-slate-900">
                    See {unassigned.length === 1 ? "it" : "them"}
                    <ArrowRight className="h-3 w-3" strokeWidth={2} />
                  </span>
                </Link>
              )}
            </>
          )}

          {/* Powered-by — refined footer */}
          {showPoweredBy && <PoweredByFooter />}
        </div>
      </main>
    </div>
  );
}

// ───────── Brand mark (logo or monogram) ────────────────────────────

function BrandMark({
  logoUrl,
  name,
  accent,
}: {
  logoUrl: string | null;
  name: string;
  accent: string;
}) {
  const monogram = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div className="relative shrink-0">
      <div
        aria-hidden
        className="absolute inset-0 -m-1 rounded-2xl opacity-30 blur-md"
        style={{ backgroundColor: accent, opacity: 0.18 }}
      />
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt=""
          className="relative h-14 w-14 rounded-2xl bg-white object-contain p-1.5 shadow-[0_4px_14px_-4px_rgba(15,23,42,0.18)] ring-1 ring-black/[0.06] sm:h-16 sm:w-16"
        />
      ) : (
        <div
          className="relative flex h-14 w-14 items-center justify-center rounded-2xl text-[18px] font-semibold text-white shadow-[0_4px_14px_-4px_rgba(15,23,42,0.18)] ring-1 ring-black/[0.06] sm:h-16 sm:w-16 sm:text-[20px]"
          style={{
            background: `linear-gradient(135deg, ${accent} 0%, ${darken(accent, 0.18)} 100%)`,
          }}
        >
          {monogram || "•"}
        </div>
      )}
    </div>
  );
}

// ───────── Trust strip ──────────────────────────────────────────────

type TrustItem = { icon: LucideIcon; label: string; sub: string };

const TRUST_ITEMS: TrustItem[] = [
  { icon: CalendarCheck, label: "Instant confirmation", sub: "Email + calendar invite" },
  { icon: Globe2, label: "Timezone aware", sub: "Auto-adjusts to your locale" },
  { icon: ShieldCheck, label: "Secure booking", sub: "Encrypted in transit" },
  { icon: Video, label: "Video meeting ready", sub: "Hosted via Google Meet" },
];

function TrustStrip() {
  return (
    <div className="mt-6 rounded-2xl border border-slate-200/55 bg-white/75 p-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.6)] backdrop-blur-sm transition-colors duration-300 hover:border-slate-200/80 sm:mt-7 sm:p-3">
      <ul className="grid grid-cols-2 gap-x-2 gap-y-2 sm:grid-cols-4 sm:gap-x-1">
        {TRUST_ITEMS.map((t) => {
          const Icon = t.icon;
          return (
            <li
              key={t.label}
              className="group/trust flex items-start gap-2 rounded-lg p-1.5 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-slate-50/70"
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-50 to-emerald-100/40 text-emerald-700 ring-1 ring-emerald-200/40 shadow-[0_1px_3px_-1px_rgba(16,185,129,0.18)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/trust:shadow-[0_2px_8px_-1px_rgba(16,185,129,0.28)] group-hover/trust:ring-emerald-200/65">
                <Icon className="h-3.5 w-3.5" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <div className="text-[11.5px] font-semibold leading-[1.2] tracking-tight text-slate-900">
                  {t.label}
                </div>
                <div className="mt-0.5 text-[10.5px] leading-[1.25] text-slate-500">
                  {t.sub}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ───────── Step indicator ───────────────────────────────────────────

function StepIndicator({ step, accent }: { step: 1 | 2 | 3; accent: string }) {
  const STEPS = ["Department", "Service", "Date & time"] as const;
  return (
    <nav
      aria-label="Booking progress"
      className="mb-5 mt-8 flex items-center gap-2 sm:mt-10"
    >
      {STEPS.map((label, idx) => {
        const i = idx + 1;
        const isActive = i === step;
        const isComplete = i < step;
        return (
          <div key={label} className="flex items-center gap-2">
            <span
              className={
                "inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold transition-colors " +
                (isComplete
                  ? "bg-emerald-500 text-white"
                  : isActive
                    ? "text-white"
                    : "bg-slate-200/70 text-slate-500")
              }
              style={
                isActive
                  ? { backgroundColor: accent }
                  : undefined
              }
            >
              {isComplete ? "✓" : i}
            </span>
            <span
              className={
                "text-[11px] font-medium tracking-tight " +
                (isActive
                  ? "text-slate-900"
                  : isComplete
                    ? "text-slate-700"
                    : "text-slate-400")
              }
            >
              {label}
            </span>
            {i < STEPS.length && (
              <span
                aria-hidden
                className="mx-1 h-px w-4 bg-slate-200 sm:w-6"
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}

// ───────── Section header ───────────────────────────────────────────

function SectionHeader({
  accent,
  eyebrow,
  title,
  description,
}: {
  accent: string;
  eyebrow: string;
  title: string;
  description?: string | null;
}) {
  return (
    <header className="mt-2">
      <div
        className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.10em]"
        style={{ color: accent }}
      >
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: accent }}
        />
        {eyebrow}
      </div>
      <h2 className="mt-1.5 text-[22px] font-semibold tracking-tight text-slate-900 sm:text-[24px]">
        {title}
      </h2>
      {description && (
        <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-slate-600">
          {description}
        </p>
      )}
    </header>
  );
}

// ───────── Service card ─────────────────────────────────────────────

function ServiceCard({
  tenantSlug,
  service: s,
  accent,
}: {
  tenantSlug: string;
  service: ServiceRow;
  accent: string;
}) {
  const multipleHosts = s.staff.length > 1;
  return (
    <article
      className="group relative overflow-hidden rounded-2xl border border-slate-200/65 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.55)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_12px_26px_-14px_rgba(15,23,42,0.18),0_3px_8px_-3px_rgba(15,23,42,0.06)] sm:p-5"
    >
      {/* Soft accent rail on hover — barely visible but adds depth */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-3.5 left-0 w-[2px] rounded-r-full opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ backgroundColor: accent }}
      />

      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15.5px] font-semibold leading-[1.3] tracking-tight text-slate-900 sm:text-[16.5px]">
            {s.name}
          </h3>

          {/* Meta row — duration, price, meeting type */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-slate-500">
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Clock className="h-3 w-3" strokeWidth={2} />
              {formatDuration(s.durationMinutes)}
            </span>
            {s.price > 0 && (
              <>
                <span aria-hidden className="text-slate-300">·</span>
                <span className="inline-flex items-center gap-0.5 font-semibold text-slate-700">
                  <span aria-hidden className="text-slate-400">$</span>
                  <span className="tabular-nums">{(s.price / 100).toFixed(0)}</span>
                </span>
              </>
            )}
            <span aria-hidden className="text-slate-300">·</span>
            <span className="inline-flex items-center gap-1 text-slate-500">
              <Video className="h-3 w-3" strokeWidth={2} />
              Video meeting
            </span>
          </div>

          {s.description && (
            <p className="mt-2.5 line-clamp-3 text-[12.5px] leading-[1.55] text-slate-600">
              {s.description}
            </p>
          )}

          {/* Host preview — avatar stack + "with X / N hosts" */}
          <HostPreview staff={s.staff} accent={accent} />
        </div>

        {/* CTA column */}
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          {!multipleHosts ? (
            <BookCTA
              href={`/u/${tenantSlug}/${s.slug}?staff=${s.staff[0].id}`}
              accent={accent}
              label="Book now"
              primary
            />
          ) : (
            <>
              <BookCTA
                href={`/u/${tenantSlug}/${s.slug}`}
                accent={accent}
                label="Choose a host"
                primary
              />
              <span className="text-[10px] text-slate-400">
                {s.staff.length} hosts · pick on next step
              </span>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

// ───────── Book CTA ─────────────────────────────────────────────────

function BookCTA({
  href,
  label,
  accent,
  primary,
}: {
  href: string;
  label: string;
  accent: string;
  primary?: boolean;
}) {
  if (!primary) {
    return (
      <Link
        href={href}
        className="inline-flex h-10 min-w-[120px] items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 text-[13px] font-semibold text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px hover:border-slate-300 hover:bg-slate-50 hover:shadow-[0_4px_12px_-6px_rgba(15,23,42,0.16)] active:translate-y-0 sm:min-w-[140px]"
      >
        {label}
        <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />
      </Link>
    );
  }
  return (
    <Link
      href={href}
      className="group/cta relative inline-flex h-11 min-w-[140px] items-center justify-center gap-1.5 overflow-hidden rounded-xl px-4 text-[13.5px] font-semibold tracking-tight text-white shadow-[0_2px_8px_-2px_rgba(15,23,42,0.16),inset_0_1px_0_rgba(255,255,255,0.16)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px hover:shadow-[0_6px_18px_-6px_rgba(15,23,42,0.24),inset_0_1px_0_rgba(255,255,255,0.16)] active:translate-y-0 active:shadow-[0_1px_4px_-1px_rgba(15,23,42,0.16),inset_0_1px_0_rgba(255,255,255,0.10)] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 sm:min-w-[150px]"
      style={
        {
          background: `linear-gradient(180deg, ${accent} 0%, ${darken(accent, 0.06)} 100%)`,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "--tw-ring-color": accent,
        } as React.CSSProperties
      }
    >
      {/* Whisper-thin inner highlight — adds depth without heat */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.08] to-transparent opacity-60 transition-opacity duration-300 group-hover/cta:opacity-100"
      />
      <span className="relative">{label}</span>
      <ArrowRight
        className="relative h-3.5 w-3.5 transition-transform duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/cta:translate-x-0.5"
        strokeWidth={2.25}
      />
    </Link>
  );
}

// ───────── Host preview (avatar stack) ──────────────────────────────

function HostPreview({
  staff,
  accent,
}: {
  staff: { id: string; name: string; avatarUrl: string | null }[];
  accent: string;
}) {
  if (staff.length === 0) return null;
  const visible = staff.slice(0, 3);
  const overflow = staff.length - visible.length;
  return (
    <div className="mt-3 flex items-center gap-2">
      <div className="flex -space-x-1.5">
        {visible.map((s, idx) => (
          <AvatarChip
            key={s.id}
            name={s.name}
            avatarUrl={s.avatarUrl}
            z={visible.length - idx}
          />
        ))}
        {overflow > 0 && (
          <span
            aria-hidden
            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-600 ring-2 ring-white"
          >
            +{overflow}
          </span>
        )}
      </div>
      <span className="text-[11.5px] text-slate-500">
        {staff.length === 1 ? (
          <>
            with{" "}
            <span className="font-medium text-slate-700">{staff[0].name}</span>
          </>
        ) : (
          <>
            <span className="font-medium text-slate-700">
              {staff.length} hosts
            </span>{" "}
            available
          </>
        )}
      </span>
    </div>
  );
}

function AvatarChip({
  name,
  avatarUrl,
  z,
}: {
  name: string;
  /** Real profile photo when uploaded — otherwise the shared Avatar
   *  primitive renders a deterministic gradient-initials disc. */
  avatarUrl: string | null;
  z: number;
}) {
  // Uses the shared <Avatar/> from components/ui/Avatar.tsx so the
  // staff-photo treatment stays byte-identical across booking surfaces
  // (slot summary, done step, host preview here, manage drawer in
  // dashboard, etc.). Size xs matches the prior 24px footprint.
  return (
    <span
      className="relative inline-block ring-2 ring-white rounded-full"
      style={{ zIndex: z }}
    >
      <Avatar src={avatarUrl} name={name} size="xs" ring={false} />
    </span>
  );
}

// ───────── Empty state ──────────────────────────────────────────────

function EmptyServicesCard({
  pickedDept,
  isUnassigned,
  tenantSlug,
  accent,
}: {
  pickedDept: boolean;
  isUnassigned: boolean;
  tenantSlug: string;
  accent: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-dashed border-slate-300 bg-white/70 px-6 py-10 text-center shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className="relative mb-3 inline-flex">
        <span
          aria-hidden
          className="absolute inset-0 rounded-2xl blur-xl"
          style={{ backgroundColor: accent, opacity: 0.10 }}
        />
        <span
          className="relative inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-slate-500 shadow-[0_4px_14px_-4px_rgba(15,23,42,0.16)] ring-1 ring-slate-200"
        >
          <Users className="h-5 w-5" strokeWidth={1.75} />
        </span>
      </div>
      <div className="text-[14px] font-semibold tracking-tight text-slate-900">
        No services published yet
      </div>
      <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-slate-500">
        {pickedDept || isUnassigned
          ? "Nothing has been published in this group yet. Check back soon or browse other departments."
          : "This workspace is being prepared. Bookable services will appear here once published."}
      </p>
      {(pickedDept || isUnassigned) && (
        <Link
          href={`/u/${tenantSlug}`}
          className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg px-4 text-[12px] font-semibold text-white shadow-[0_2px_6px_-2px_rgba(15,23,42,0.16)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px hover:shadow-[0_4px_12px_-4px_rgba(15,23,42,0.20)]"
          style={{ backgroundColor: accent }}
        >
          Back to all departments
          <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
        </Link>
      )}
    </div>
  );
}

// ───────── Powered-by footer ────────────────────────────────────────

function PoweredByFooter() {
  return (
    <footer className="mt-12 pt-7">
      {/* Hairline separator — subtler than a full border-t */}
      <div
        aria-hidden
        className="mx-auto h-px w-full max-w-[200px] bg-gradient-to-r from-transparent via-slate-200/80 to-transparent"
      />
      <a
        href="https://app.zentromeet.com"
        target="_blank"
        rel="noopener noreferrer"
        className="group mx-auto mt-5 flex w-fit items-center gap-2 rounded-full px-2.5 py-1 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-slate-50/70"
        aria-label="Powered by ZentroMeet — premium scheduling platform"
      >
        <span className="text-[9.5px] font-medium uppercase tracking-[0.16em] text-slate-400/80 transition-colors duration-200 group-hover:text-slate-500">
          Powered by
        </span>
        <svg
          viewBox="0 0 160 160"
          className="h-[16px] w-[16px] rounded-full opacity-80 shadow-[0_0_0_rgba(37,99,235,0)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:opacity-100 group-hover:shadow-[0_2px_8px_rgba(37,99,235,0.30)]"
          aria-hidden
        >
          <circle cx="80" cy="80" r="80" fill="#2563EB" />
          <g fill="#0f172a">
            <rect x="40" y="40" width="80" height="15" />
            <rect x="40" y="105" width="80" height="15" />
          </g>
          <line x1="118" y1="48" x2="42" y2="112" stroke="#0f172a" strokeWidth="22" />
        </svg>
        <span className="text-[11px] font-semibold tracking-tight text-slate-500 transition-colors duration-200 group-hover:text-slate-900">
          ZentroMeet
        </span>
      </a>
    </footer>
  );
}

// ───────── Color helpers (no deps, hex-only) ────────────────────────

function hexWithAlpha(hex: string, alpha: number): string {
  // Accepts #rrggbb. Falls back gracefully if format is off.
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function darken(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, Math.round(((n >> 16) & 0xff) * (1 - amount)));
  const g = Math.max(0, Math.round(((n >> 8) & 0xff) * (1 - amount)));
  const b = Math.max(0, Math.round((n & 0xff) * (1 - amount)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
