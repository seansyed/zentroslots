import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { getClientSession } from "@/lib/client-auth";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function ClientLoginPage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ invalid?: string }>;
}) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const linkExpired = sp.invalid === "1";

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.active) {
    // Mirror the 404 the public booking page gives — don't confirm the
    // slug exists.
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
        <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-12 text-center text-sm text-slate-500">
          Workspace not found.
        </main>
      </div>
    );
  }

  // Already signed in? Send them straight to the portal.
  const session = await getClientSession();
  if (session && session.tenantId === tenant.id) {
    redirect(`/client/${slug}`);
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <header
        className="border-b border-slate-200 bg-white/80 backdrop-blur"
        style={{ borderTop: `4px solid ${tenant.primaryColor}` }}
      >
        <div className="mx-auto max-w-md px-6 py-8">
          <div className="flex items-center gap-3">
            {tenant.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={tenant.logoUrl} alt="" className="h-10 w-10 rounded-lg object-contain" />
            )}
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-slate-900">
                {tenant.name}
              </h1>
              <div className="text-xs text-slate-500">Client portal</div>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-md px-6 py-10">
        {linkExpired && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            That sign-in link is expired or invalid. Enter your email below and we&rsquo;ll send a fresh one.
          </div>
        )}
        <LoginForm slug={slug} accentColor={tenant.primaryColor} />
        {!tenant.hidePoweredBy && (
          <footer className="mt-10 border-t border-slate-200 pt-4 text-center text-[11px] text-slate-400">
            Powered by ZentroMeet
          </footer>
        )}
      </main>
    </div>
  );
}
