import ClientPortalShell from "@/components/client/ClientPortalShell";
import ProfileForm from "./ProfileForm";
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
      <ProfileForm
        slug={tenant.slug}
        accent={tenant.primaryColor}
        initial={{
          name: customer.name,
          email: customer.email,
          phone: customer.phone ?? "",
          status: customer.status,
        }}
      />

      <section className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Communication preferences
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          Per-channel opt-out and reminder-frequency controls are coming in a later release.
        </p>
        <div className="mt-2 text-[11px] text-slate-400">
          Member since {customer.createdAt.toISOString().slice(0, 10)}
        </div>
      </section>
    </ClientPortalShell>
  );
}
