import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { customers, tenants } from "@/db/schema";
import {
  signClientSession,
  setClientSessionCookie,
  verifyClientMagicLink,
} from "@/lib/client-auth";
import { audit } from "@/lib/audit";

// Magic-link consumer. The link in the email points here with ?token=...
// We verify the JWT, look up the customer fresh from the DB (in case
// they were deleted between link issuance and click), set the session
// cookie, and redirect to the portal home.
//
// Server component — sets cookies before redirect (allowed by Next 15
// when called from a server context, including page render).

export const dynamic = "force-dynamic";

export default async function ClientAuthVerifyPage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ token?: string; redirect?: string }>;
}) {
  const { slug } = await props.params;
  const sp = await props.searchParams;

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.active) {
    return <FailedScreen tenantName={null} reason="Workspace not found." slug={slug} />;
  }

  const token = (sp.token ?? "").trim();
  if (!token) {
    return <FailedScreen tenantName={tenant.name} reason="Missing or invalid link." slug={slug} />;
  }

  const payload = await verifyClientMagicLink(token);
  if (!payload || payload.tenantId !== tenant.id) {
    return <FailedScreen tenantName={tenant.name} reason="This link is expired or invalid." slug={slug} />;
  }

  // Re-fetch the customer to confirm they still exist and to pick up
  // the canonical-cased email + customer id.
  const customer = await db.query.customers.findFirst({
    where: and(
      eq(customers.tenantId, tenant.id),
      sql`lower(${customers.email}) = ${payload.email.toLowerCase()}`
    ),
  });
  if (!customer) {
    return <FailedScreen tenantName={tenant.name} reason="No customer record matches this link." slug={slug} />;
  }

  const sessionToken = await signClientSession({
    email: customer.email,
    tenantId: tenant.id,
    customerId: customer.id,
  });
  await setClientSessionCookie(sessionToken);

  audit({
    tenantId: tenant.id,
    action: "client.session.start",
    entityType: "customer",
    entityId: customer.id,
    metadata: { email: customer.email },
  });

  // Validate the optional redirect — must stay within this tenant's portal.
  const safeRedirect = isSafeRedirect(sp.redirect, slug) ? sp.redirect! : `/client/${slug}`;
  redirect(safeRedirect);
}

function isSafeRedirect(target: string | undefined, slug: string): boolean {
  if (!target) return false;
  // Only relative paths starting with /client/<this slug>/ are accepted.
  return target.startsWith(`/client/${slug}`) && !target.includes("://") && !target.startsWith("//");
}

function FailedScreen({
  tenantName,
  reason,
  slug,
}: {
  tenantName: string | null;
  reason: string;
  slug: string;
}) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-12">
        <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-6 w-6 text-red-600">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4M12 16v.01" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="mt-4 text-lg font-semibold text-slate-900">
            Sign-in didn&rsquo;t work
          </h1>
          <p className="mt-1 text-sm text-slate-600">{reason}</p>
          <a
            href={`/client/${slug}/login`}
            className="mt-6 inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Request a new link
          </a>
          {tenantName && (
            <div className="mt-3 text-[11px] text-slate-400">{tenantName}</div>
          )}
        </div>
      </main>
    </div>
  );
}
