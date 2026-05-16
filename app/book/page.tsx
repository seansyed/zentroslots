import { db } from "@/db/client";
import { serviceStaff, services, tenants, users } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import Link from "next/link";

// NOTE: This is a public directory page that lists all active services
// across all tenants. In a true production multi-tenant deployment this
// page would be replaced by per-tenant subdomains (`acme.app.com/book`).
// For MVP it remains a flat directory; each card shows the workspace name
// so the booker knows who they're booking with.
export default async function ServicesIndexPage() {
  const rows = await db
    .select({
      id: services.id,
      tenantId: services.tenantId,
      name: services.name,
      description: services.description,
      durationMinutes: services.durationMinutes,
      price: services.price,
      staffName: users.name,
      staffId: users.id,
      tenantName: tenants.name,
    })
    .from(services)
    .innerJoin(serviceStaff, and(
      eq(serviceStaff.serviceId, services.id),
      eq(serviceStaff.tenantId, services.tenantId)
    ))
    .innerJoin(users, eq(users.id, serviceStaff.userId))
    .innerJoin(tenants, eq(tenants.id, services.tenantId))
    .where(and(eq(services.isActive, 1), eq(tenants.active, true)));

  // Group: service → list of staff
  const grouped = new Map<
    string,
    {
      id: string;
      tenantName: string;
      name: string;
      description: string | null;
      durationMinutes: number;
      price: number;
      staff: { id: string; name: string }[];
    }
  >();
  for (const r of rows) {
    const cur = grouped.get(r.id) ?? {
      id: r.id,
      tenantName: r.tenantName,
      name: r.name,
      description: r.description,
      durationMinutes: r.durationMinutes,
      price: r.price,
      staff: [],
    };
    cur.staff.push({ id: r.staffId, name: r.staffName });
    grouped.set(r.id, cur);
  }

  const list = Array.from(grouped.values());

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Book a meeting</h1>
      <p className="mt-1 text-sm text-slate-600">Pick a service to continue.</p>

      <div className="mt-8 space-y-3">
        {list.length === 0 && (
          <div className="rounded border border-dashed bg-white p-8 text-center text-sm text-slate-500">
            No services available yet.
          </div>
        )}

        {list.map((s) => (
          <div key={s.id} className="rounded-lg border bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
                  {s.tenantName}
                </div>
                <div className="text-lg font-medium">{s.name}</div>
                {s.description && (
                  <div className="mt-1 text-sm text-slate-600">{s.description}</div>
                )}
                <div className="mt-2 text-xs text-slate-500">
                  {s.durationMinutes} min
                  {s.price > 0 && ` • $${(s.price / 100).toFixed(2)}`}
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {s.staff.map((staff) => (
                <Link
                  key={staff.id}
                  href={`/book/${s.id}/${staff.id}`}
                  className="rounded-md bg-brand-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Book with {staff.name}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
