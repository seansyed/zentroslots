import ClientPortalShell from "@/components/client/ClientPortalShell";
import { requireClientPortalContext } from "../_lib/guard";

export const dynamic = "force-dynamic";

export default async function ClientNotificationsPage(props: {
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
      title="Notifications"
    >
      <ComingSoonCard
        title="In-portal notifications coming soon"
        body={`We'll surface confirmations, reminders, and reschedule alerts here. For now, watch your email inbox at ${customer.email}.`}
        accent={tenant.primaryColor}
      />
    </ClientPortalShell>
  );
}

function ComingSoonCard({
  title,
  body,
  accent,
}: {
  title: string;
  body: string;
  accent: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <div
        className="mx-auto flex h-12 w-12 items-center justify-center rounded-full"
        style={{ backgroundColor: hexToTint(accent) }}
        aria-hidden
      >
        <svg viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" className="h-6 w-6">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" />
        </svg>
      </div>
      <h2 className="mt-4 text-base font-semibold tracking-tight text-slate-900">{title}</h2>
      <p className="mt-1 max-w-md mx-auto text-sm text-slate-600">{body}</p>
    </div>
  );
}

function hexToTint(hex: string): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return "#eef2ff";
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const blend = (c: number) => Math.round(c * 0.1 + 255 * 0.9);
  return `rgb(${blend(r)}, ${blend(g)}, ${blend(b)})`;
}
