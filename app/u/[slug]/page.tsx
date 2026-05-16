import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { serviceStaff, services, tenants, users } from "@/db/schema";

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

export default async function PublicProfilePage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
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
    })
    .from(services)
    .innerJoin(serviceStaff, and(
      eq(serviceStaff.serviceId, services.id),
      eq(serviceStaff.tenantId, services.tenantId)
    ))
    .innerJoin(users, eq(users.id, serviceStaff.userId))
    .where(and(eq(services.tenantId, tenant.id), eq(services.isActive, 1)));

  const byService = new Map<string, {
    id: string; slug: string; name: string; description: string | null;
    durationMinutes: number; price: number; staff: { id: string; name: string }[];
  }>();
  for (const r of rows) {
    const cur = byService.get(r.serviceId) ?? {
      id: r.serviceId,
      slug: r.serviceSlug,
      name: r.serviceName,
      description: r.description,
      durationMinutes: r.durationMinutes,
      price: r.price,
      staff: [],
    };
    cur.staff.push({ id: r.staffId, name: r.staffName });
    byService.set(r.serviceId, cur);
  }
  const list = Array.from(byService.values());

  return (
    <div className="min-h-screen" style={{ background: "linear-gradient(180deg,#f8fafc,#fff)" }}>
      <div
        className="border-b"
        style={{ borderTop: `4px solid ${tenant.primaryColor}` }}
      >
        <div className="mx-auto max-w-3xl px-6 py-10">
          <div className="flex items-center gap-4">
            {tenant.logoUrl && (
              <img src={tenant.logoUrl} alt="" className="h-12 w-12 rounded object-contain" />
            )}
            <div>
              <h1 className="text-2xl font-semibold">{tenant.name}</h1>
              {tenant.tagline && <div className="text-sm text-slate-600">{tenant.tagline}</div>}
            </div>
          </div>
          {tenant.description && (
            <p className="mt-3 text-sm text-slate-700">{tenant.description}</p>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-6 py-10">
        <h2 className="text-lg font-medium" style={{ color: tenant.primaryColor }}>
          {tenant.bookingHeadline ?? "Book a meeting"}
        </h2>

        <div className="mt-4 space-y-3">
          {list.length === 0 && (
            <div className="rounded border border-dashed bg-white p-8 text-center text-sm text-slate-500">
              No services published yet.
            </div>
          )}
          {list.map((s) => (
            <div key={s.id} className="rounded-lg border bg-white p-5 shadow-sm">
              <div className="text-lg font-medium">{s.name}</div>
              {s.description && (
                <div className="mt-1 text-sm text-slate-600">{s.description}</div>
              )}
              <div className="mt-2 text-xs text-slate-500">
                {s.durationMinutes} min{s.price > 0 && ` • $${(s.price / 100).toFixed(2)}`}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {s.staff.map((staff) => (
                  <Link
                    key={staff.id}
                    href={`/u/${tenant.slug}/${s.slug}?staff=${staff.id}`}
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
                    style={{ backgroundColor: tenant.primaryColor }}
                  >
                    Book with {staff.name}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Reviews placeholder — kept tiny so the page doesn't look broken */}
        <div className="mt-8 rounded-lg border border-dashed bg-white p-6 text-center text-xs text-slate-400">
          Reviews coming soon.
        </div>
      </div>
    </div>
  );
}
