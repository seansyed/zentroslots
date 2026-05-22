import ClientPortalShell from "@/components/client/ClientPortalShell";
import { TimeText } from "@/components/client/TimeText";
import ProfileForm from "./ProfileForm";
import CommPrefsCard from "./CommPrefsCard";
import { normalizePrefs } from "@/lib/client-prefs";
import { requireClientPortalContext } from "../_lib/guard";

export const dynamic = "force-dynamic";

export default async function ClientProfilePage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const { tenant, customer } = await requireClientPortalContext(slug);

  const prefs = normalizePrefs(customer.commPrefs);

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

      <div className="mt-5">
        <CommPrefsCard slug={tenant.slug} accent={tenant.primaryColor} initial={prefs} />
      </div>

      <div className="mt-4 text-[11px] text-slate-400">
        Member since{" "}
        <TimeText iso={customer.createdAt.toISOString()} format="MMMM yyyy" />
      </div>
    </ClientPortalShell>
  );
}
