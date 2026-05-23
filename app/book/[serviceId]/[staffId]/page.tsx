import { db } from "@/db/client";
import { serviceStaff, services, tenants, users } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import BookingFlow from "@/components/BookingFlow";

export default async function BookingPage(props: {
  params: Promise<{ serviceId: string; staffId: string }>;
}) {
  const { serviceId, staffId } = await props.params;

  const [service, staff] = await Promise.all([
    db.query.services.findFirst({ where: eq(services.id, serviceId) }),
    db.query.users.findFirst({ where: eq(users.id, staffId) }),
  ]);

  if (!service || service.isActive !== 1 || !staff) notFound();
  // Cross-tenant guard: refuse to render a service/staff pair from
  // different tenants.
  if (service.tenantId !== staff.tenantId) notFound();

  // Staff must deliver this service (within the tenant).
  const link = await db.query.serviceStaff.findFirst({
    where: and(
      eq(serviceStaff.serviceId, service.id),
      eq(serviceStaff.userId, staff.id),
      eq(serviceStaff.tenantId, service.tenantId)
    ),
  });
  if (!link) notFound();

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, service.tenantId),
  });
  if (!tenant || !tenant.active) notFound();

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <a href="/book" className="text-sm text-slate-500 hover:text-slate-700">
        ← All services
      </a>

      <div className="mt-4">
        <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
          {tenant.name}
        </div>
        <div className="mt-1 text-sm text-slate-500">{staff.name}</div>
        <h1 className="text-2xl font-semibold">{service.name}</h1>
        {service.description && (
          <p className="mt-1 text-sm text-slate-600">{service.description}</p>
        )}
        <div className="mt-2 text-xs text-slate-500">
          {service.durationMinutes} min
          {service.price > 0 && ` • $${(service.price / 100).toFixed(2)}`}
        </div>
      </div>

      <BookingFlow
        serviceId={service.id}
        staffId={staff.id}
        staffName={staff.name}
        staffAvatarUrl={staff.avatarUrl}
        durationMinutes={service.durationMinutes}
      />
    </div>
  );
}
