import ClientPortalShell from "@/components/client/ClientPortalShell";
import { requireClientPortalContext } from "../_lib/guard";

export const dynamic = "force-dynamic";

export default async function ClientMessagesPage(props: {
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
      title="Messages"
    >
      <ComingSoonCard
        title="Direct messages coming soon"
        body={`Two-way messaging with ${tenant.name} isn't open yet. For now, replies to your booking confirmation emails reach them directly.`}
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
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h2 className="mt-4 text-base font-semibold tracking-tight text-slate-900">{title}</h2>
      <p className="mt-1 max-w-md mx-auto text-sm text-slate-600">{body}</p>
    </div>
  );
}

// Take a hex color and return a very-light tint (mix with white). Used
// for soft icon backgrounds without needing a real palette generator.
function hexToTint(hex: string): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return "#eef2ff";
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  // 90% white + 10% color.
  const blend = (c: number) => Math.round(c * 0.1 + 255 * 0.9);
  return `rgb(${blend(r)}, ${blend(g)}, ${blend(b)})`;
}
