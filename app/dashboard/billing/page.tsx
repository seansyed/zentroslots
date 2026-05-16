import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { getTenantUsage } from "@/lib/quotas";
import { getPlan, PLANS, formatPrice, isUnlimited } from "@/lib/plans";
import { isStripeConfigured } from "@/lib/stripe";
import BillingActions from "@/components/BillingActions";
import Shell from "@/components/dashboard/Shell";

export default async function BillingPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const usage = await getTenantUsage(user.tenantId);
  const current = getPlan(tenant.currentPlan);
  const stripeOn = isStripeConfigured();
  const isAdmin = user.role === "admin";

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Billing"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Billing" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Billing &amp; plan</h1>
      <p className="mt-1 text-sm text-ink-muted">{tenant.name} • Current plan: <span className="font-medium capitalize">{current.name}</span></p>

      {!stripeOn && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Stripe is not configured on this server. Plan changes are read-only until <code>STRIPE_SECRET_KEY</code> and price IDs are set in <code>.env</code>.
        </div>
      )}

      {tenant.subscriptionStatus === "trialing" && tenant.trialEnd && (
        <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          Free trial ends {new Date(tenant.trialEnd).toLocaleDateString()}.
        </div>
      )}

      {/* Usage meters */}
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Meter label="Staff seats" used={usage.staff.used} limit={usage.staff.limit} />
        <Meter label="Bookings this month" used={usage.bookingsThisMonth.used} limit={usage.bookingsThisMonth.limit} />
      </div>

      {/* Plan grid */}
      <h2 className="mt-10 text-lg font-medium">Plans</h2>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Object.values(PLANS).map((p) => {
          const isCurrent = p.id === current.id;
          return (
            <div
              key={p.id}
              className={
                "flex flex-col rounded-xl border bg-white p-5 shadow-sm " +
                (isCurrent ? "ring-2 ring-brand-accent" : "")
              }
            >
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">{p.name}</div>
              <div className="mt-1 text-2xl font-semibold">{formatPrice(p)}</div>
              <p className="mt-2 text-sm text-slate-600">{p.description}</p>
              <ul className="mt-4 space-y-1 text-sm text-slate-700">
                {p.features.map((f) => (
                  <li key={f}>• {f}</li>
                ))}
              </ul>
              <div className="mt-auto pt-5">
                <BillingActions
                  planId={p.id}
                  isCurrent={isCurrent}
                  isAdmin={isAdmin}
                  hasSubscription={Boolean(tenant.stripeSubscriptionId)}
                  stripeOn={stripeOn}
                />
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-6 text-xs text-slate-500">
        Need an invoice or to change payment method? Open the billing portal from any paid plan card.
      </p>
    </Shell>
  );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const unlimited = isUnlimited(limit);
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const danger = pct >= 90;
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
        <div className="text-sm text-slate-700">
          {used} {unlimited ? "" : `/ ${limit}`}
        </div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
        {unlimited ? (
          <div className="h-full w-1/3 bg-green-300" />
        ) : (
          <div
            className={"h-full rounded-full " + (danger ? "bg-red-500" : "bg-brand-accent")}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {unlimited && <div className="mt-1 text-xs text-green-700">Unlimited</div>}
    </div>
  );
}
