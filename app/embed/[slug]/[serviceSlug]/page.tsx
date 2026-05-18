import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { serviceStaff, services, tenants, users } from "@/db/schema";
import BookingFlow from "@/components/BookingFlow";
import EmbedPixel from "@/components/EmbedPixel";

// Iframe-safe embed page. Strips chrome so the host site can size it
// inside an iframe with its own layout. Tenant accent color comes from
// branding so the widget visually matches the parent site.
export default async function EmbedPage(props: {
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

  const assignments = await db
    .select({ userId: serviceStaff.userId, name: users.name })
    .from(serviceStaff)
    .innerJoin(users, eq(users.id, serviceStaff.userId))
    .where(and(eq(serviceStaff.serviceId, service.id), eq(serviceStaff.tenantId, tenant.id)));

  // Service exists but no one is assigned to deliver it. Render a
  // friendly "not bookable" panel instead of a hard 404 — the tenant's
  // marketing site already linked here, so a blunt 404 looks broken.
  if (assignments.length === 0) {
    return (
      <div
        className="min-h-screen bg-surface"
        style={{ "--color-accent": tenant.primaryColor } as React.CSSProperties}
      >
        <div className="border-t-4 border-brand-accent">
          <div className="mx-auto max-w-2xl px-4 py-10 text-center">
            <div className="text-sm font-semibold text-ink">{tenant.name}</div>
            <h1 className="mt-2 text-xl font-semibold text-ink">{service.name} isn&rsquo;t accepting bookings right now</h1>
            <p className="mt-2 text-sm text-ink-muted">
              No staff member is currently assigned to deliver this service. Please contact {tenant.name} directly.
            </p>
            {!tenant.hidePoweredBy && (
              <div className="mt-8 text-[10px] text-ink-subtle">Powered by Scheduling SaaS</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const staff = sp.staff
    ? assignments.find((a) => a.userId === sp.staff) ?? assignments[0]
    : assignments[0];

  return (
    <div
      className="min-h-screen bg-surface"
      style={{ "--color-accent": tenant.primaryColor } as React.CSSProperties}
    >
      <div className="border-t-4 border-brand-accent">
        <div className="mx-auto max-w-2xl px-4 py-6">
          <div className="flex items-center gap-3">
            {tenant.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={tenant.logoUrl} alt="" className="h-10 w-10 rounded object-contain" />
            )}
            <div>
              <div className="text-sm font-semibold text-ink">{tenant.name}</div>
              <div className="text-xs text-ink-muted">{service.name} · {service.durationMinutes} min</div>
            </div>
          </div>
          <EmbedPixel slug={slug} serviceSlug={serviceSlug} />
          <BookingFlow
            serviceId={service.id}
            staffId={staff.userId}
            staffName={staff.name}
            durationMinutes={service.durationMinutes}
            accentColor={tenant.primaryColor}
            tenantName={tenant.name}
          />
          {!tenant.hidePoweredBy && (
            <div className="mt-6 border-t border-border pt-3 text-center text-[10px] text-ink-subtle">
              Powered by Scheduling SaaS
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Iframe-friendly: don't include any layout chrome above this page.
export const dynamic = "force-dynamic";
