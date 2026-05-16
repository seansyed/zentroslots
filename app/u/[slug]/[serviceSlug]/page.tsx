import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { serviceStaff, services, tenants, users } from "@/db/schema";
import BookingFlow from "@/components/BookingFlow";

export default async function PublicServicePage(props: {
  params: Promise<{ slug: string; serviceSlug: string }>;
  searchParams: Promise<{ staff?: string }>;
}) {
  const { slug, serviceSlug } = await props.params;
  const sp = await props.searchParams;

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.active) notFound();

  const service = await db.query.services.findFirst({
    where: and(eq(services.tenantId, tenant.id), eq(services.slug, serviceSlug)),
  });
  if (!service || service.isActive !== 1) notFound();

  // Find a staff member who delivers this service.
  // ?staff=<id> chooses a specific one; otherwise pick the first.
  const assignments = await db
    .select({ userId: serviceStaff.userId, name: users.name })
    .from(serviceStaff)
    .innerJoin(users, eq(users.id, serviceStaff.userId))
    .where(and(
      eq(serviceStaff.serviceId, service.id),
      eq(serviceStaff.tenantId, tenant.id)
    ));
  if (assignments.length === 0) notFound();

  const staff = sp.staff
    ? assignments.find((a) => a.userId === sp.staff) ?? assignments[0]
    : assignments[0];

  return (
    <div className="min-h-screen" style={{ background: "linear-gradient(180deg,#f8fafc,#fff)" }}>
      <div className="border-b" style={{ borderTop: `4px solid ${tenant.primaryColor}` }}>
        <div className="mx-auto max-w-2xl px-6 py-8">
          <a href={`/u/${tenant.slug}`} className="text-sm text-slate-500 hover:text-slate-700">
            ← {tenant.name}
          </a>
          <h1 className="mt-2 text-2xl font-semibold">{service.name}</h1>
          {service.description && (
            <p className="mt-1 text-sm text-slate-600">{service.description}</p>
          )}
          <div className="mt-2 text-xs text-slate-500">
            {service.durationMinutes} min{service.price > 0 && ` • $${(service.price / 100).toFixed(2)}`} • with {staff.name}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-6 pb-12">
        <BookingFlow
          serviceId={service.id}
          staffId={staff.userId}
          staffName={staff.name}
          durationMinutes={service.durationMinutes}
        />
      </div>
    </div>
  );
}
