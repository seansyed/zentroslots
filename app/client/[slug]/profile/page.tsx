import ClientPortalShell from "@/components/client/ClientPortalShell";
import { requireClientPortalContext } from "../_lib/guard";

export const dynamic = "force-dynamic";

export default async function ClientProfilePage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const { tenant, customer } = await requireClientPortalContext(slug);

  return (
    <ClientPortalShell
      tenant={{
        slug: tenant.slug,
        name: tenant.name,
        logoUrl: tenant.logoUrl,
        primaryColor: tenant.primaryColor,
        hidePoweredBy: tenant.hidePoweredBy,
      }}
      customer={{ name: customer.name, email: customer.email }}
      title="Profile"
    >
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Your information
        </div>
        <p className="mt-1 text-xs text-slate-500">
          This is the contact info {tenant.name} has on file. To change it, message them
          or update during your next booking.
        </p>

        <dl className="mt-4 space-y-3 text-sm">
          <Row k="Name" v={customer.name} />
          <Row k="Email" v={customer.email} />
          <Row k="Phone" v={customer.phone ?? "—"} />
          <Row k="Status" v={<span className="capitalize">{customer.status}</span>} />
          <Row
            k="Member since"
            v={customer.createdAt.toISOString().slice(0, 10)}
          />
        </dl>
      </section>

      <section className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Communication preferences
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          Per-channel opt-out and reminder frequency controls are coming in a later release.
        </p>
      </section>
    </ClientPortalShell>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-2 last:border-0 last:pb-0">
      <dt className="text-xs uppercase tracking-wider text-slate-500">{k}</dt>
      <dd className="text-right text-sm text-slate-900">{v}</dd>
    </div>
  );
}
