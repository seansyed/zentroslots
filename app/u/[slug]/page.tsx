import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { departments, serviceStaff, services, tenants, users } from "@/db/schema";

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant) return { title: "Not found" };
  return {
    title: tenant.name,
    description: tenant.tagline ?? tenant.description ?? `Book a meeting with ${tenant.name}.`,
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
  departmentId: string | null;
  staff: { id: string; name: string }[];
};

export default async function PublicProfilePage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ dept?: string }>;
}) {
  const { slug } = await props.params;
  const { dept: deptParam } = await props.searchParams;

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.active) notFound();

  // One denormalized query: every (service × assigned staff) pair. We
  // collapse to one row per service in JS — same approach as before but
  // now we also carry departmentId for the new department-first flow.
  const rows = await db
    .select({
      serviceId: services.id,
      serviceSlug: services.slug,
      serviceName: services.name,
      description: services.description,
      durationMinutes: services.durationMinutes,
      price: services.price,
      departmentId: services.departmentId,
      staffId: users.id,
      staffName: users.name,
    })
    .from(services)
    .innerJoin(serviceStaff, and(
      eq(serviceStaff.serviceId, services.id),
      eq(serviceStaff.tenantId, services.tenantId)
    ))
    .innerJoin(users, eq(users.id, serviceStaff.userId))
    .where(and(eq(services.tenantId, tenant.id), eq(services.isActive, 1)));

  const byService = new Map<string, ServiceRow>();
  for (const r of rows) {
    const cur = byService.get(r.serviceId) ?? {
      id: r.serviceId,
      slug: r.serviceSlug,
      name: r.serviceName,
      description: r.description,
      durationMinutes: r.durationMinutes,
      price: r.price,
      departmentId: r.departmentId,
      staff: [],
    };
    cur.staff.push({ id: r.staffId, name: r.staffName });
    byService.set(r.serviceId, cur);
  }
  const allServices = Array.from(byService.values());

  // Load departments and figure out which ones have bookable services.
  // We only surface the department picker when there's something to
  // route into — otherwise it just adds friction.
  const allDepartments = await db
    .select({ id: departments.id, name: departments.name, color: departments.color, description: departments.description })
    .from(departments)
    .where(eq(departments.tenantId, tenant.id))
    .orderBy(asc(departments.name));

  const servicesByDept = new Map<string, ServiceRow[]>();
  const unassigned: ServiceRow[] = [];
  for (const svc of allServices) {
    if (svc.departmentId) {
      const arr = servicesByDept.get(svc.departmentId) ?? [];
      arr.push(svc);
      servicesByDept.set(svc.departmentId, arr);
    } else {
      unassigned.push(svc);
    }
  }
  const departmentsWithServices = allDepartments.filter((d) => (servicesByDept.get(d.id) ?? []).length > 0);

  // Decide what view to render. Four modes:
  //   - department-picker  (departments exist + ?dept not set + at least one dept has services)
  //   - department-detail  (?dept set to a real id)
  //   - unassigned-detail  (?dept=__none — services with no department)
  //   - all-services       (no departments configured at all)
  const isUnassignedView = deptParam === "__none";
  const showDepartmentPicker = departmentsWithServices.length > 0 && !deptParam;
  const pickedDept = deptParam && !isUnassignedView
    ? allDepartments.find((d) => d.id === deptParam) ?? null
    : null;
  const visibleServices = pickedDept
    ? (servicesByDept.get(pickedDept.id) ?? [])
    : isUnassignedView
      ? unassigned
      : showDepartmentPicker
        ? [] // department picker mode — services hidden
        : allServices; // no departments configured → show everything

  const accent = tenant.primaryColor;
  const showPoweredBy = !tenant.hidePoweredBy;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      {/* Tenant header */}
      <header
        className="border-b border-slate-200 bg-white/80 backdrop-blur"
        style={{ borderTop: `4px solid ${accent}` }}
      >
        <div className="mx-auto max-w-3xl px-6 py-8">
          <div className="flex items-center gap-4">
            {tenant.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={tenant.logoUrl} alt="" className="h-12 w-12 rounded-lg object-contain" />
            )}
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{tenant.name}</h1>
              {tenant.tagline && <div className="mt-0.5 text-sm text-slate-600">{tenant.tagline}</div>}
            </div>
          </div>
          {tenant.description && (
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-700">{tenant.description}</p>
          )}
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto max-w-3xl px-6 py-10">
        {/* Breadcrumb / step indicator — only relevant in dept mode */}
        {(showDepartmentPicker || pickedDept || isUnassignedView) && (
          <nav className="mb-6 flex items-center gap-2 text-xs text-slate-500" aria-label="Booking progress">
            <span className={showDepartmentPicker ? "font-semibold text-slate-900" : "text-slate-400"}>
              1. Department
            </span>
            <span aria-hidden>›</span>
            <span className={(pickedDept || isUnassignedView) ? "font-semibold text-slate-900" : "text-slate-400"}>
              2. Service
            </span>
            <span aria-hidden>›</span>
            <span className="text-slate-400">3. Date & time</span>
          </nav>
        )}

        <h2 className="text-lg font-medium tracking-tight" style={{ color: accent }}>
          {showDepartmentPicker
            ? "Choose a department"
            : pickedDept
              ? `${pickedDept.name}`
              : isUnassignedView
                ? "Other services"
                : tenant.bookingHeadline ?? "Book a meeting"}
        </h2>
        {pickedDept?.description && (
          <p className="mt-1 text-sm text-slate-600">{pickedDept.description}</p>
        )}

        {/* DEPARTMENT PICKER MODE ─────────────────────────────── */}
        {showDepartmentPicker && (
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {departmentsWithServices.map((d) => {
              const count = servicesByDept.get(d.id)?.length ?? 0;
              return (
                <Link
                  key={d.id}
                  href={`/u/${tenant.slug}?dept=${d.id}`}
                  className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2"
                  style={{
                    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                    "--tw-ring-color": accent,
                  } as React.CSSProperties}
                >
                  <span
                    aria-hidden
                    className="mt-1 h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: d.color ?? accent }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-base font-medium text-slate-900">{d.name}</div>
                    {d.description && (
                      <div className="mt-0.5 line-clamp-2 text-xs text-slate-600">{d.description}</div>
                    )}
                    <div className="mt-2 text-xs text-slate-500">
                      {count} service{count === 1 ? "" : "s"}
                    </div>
                  </div>
                  <span
                    aria-hidden
                    className="ml-2 self-center text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500"
                  >
                    →
                  </span>
                </Link>
              );
            })}
          </div>
        )}

        {/* SERVICES LIST MODE (dept selected OR no-dept fallback) ── */}
        {!showDepartmentPicker && (
          <>
            {(pickedDept || isUnassignedView) && (
              <div className="mt-3">
                <Link
                  href={`/u/${tenant.slug}`}
                  className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
                >
                  ← All departments
                </Link>
              </div>
            )}

            <div className="mt-5 space-y-3">
              {visibleServices.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 p-8 text-center text-sm text-slate-500">
                  No services published{pickedDept ? " in this department" : ""} yet.
                </div>
              )}

              {visibleServices.map((s) => (
                <article
                  key={s.id}
                  className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <h3 className="text-base font-medium text-slate-900">{s.name}</h3>
                    <div className="shrink-0 text-xs text-slate-500">
                      <span className="tabular-nums">{s.durationMinutes} min</span>
                      {s.price > 0 && (
                        <>
                          <span className="mx-1">·</span>
                          <span className="font-medium text-slate-700">${(s.price / 100).toFixed(0)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {s.description && (
                    <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{s.description}</p>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    {s.staff.length === 1 ? (
                      // Single-staff service: skip the "with X" framing.
                      // Just one prominent action.
                      <Link
                        href={`/u/${tenant.slug}/${s.slug}?staff=${s.staff[0].id}`}
                        className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2"
                        style={{
                          backgroundColor: accent,
                          /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                          "--tw-ring-color": accent,
                        } as React.CSSProperties}
                      >
                        Book now →
                      </Link>
                    ) : (
                      s.staff.map((staff) => (
                        <Link
                          key={staff.id}
                          href={`/u/${tenant.slug}/${s.slug}?staff=${staff.id}`}
                          className="inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:opacity-90"
                          style={{ backgroundColor: accent }}
                        >
                          Book with {staff.name.split(" ")[0]}
                        </Link>
                      ))
                    )}
                  </div>
                </article>
              ))}
            </div>

            {/* When dept is selected but there are also dept-less services,
                offer a way to reach them — otherwise they're orphaned. */}
            {pickedDept && unassigned.length > 0 && (
              <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                {unassigned.length} other service{unassigned.length === 1 ? " isn't" : "s aren't"} assigned to a department.{" "}
                <Link href={`/u/${tenant.slug}?dept=__none`} className="font-medium underline">
                  See {unassigned.length === 1 ? "it" : "them"}
                </Link>
              </div>
            )}
          </>
        )}

        {/* Powered-by — visible unless tenant pays to hide it. */}
        {showPoweredBy && (
          <footer className="mt-12 border-t border-slate-200 pt-4 text-center text-[11px] text-slate-400">
            Powered by Scheduling SaaS
          </footer>
        )}
      </main>
    </div>
  );
}
