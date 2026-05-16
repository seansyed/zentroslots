import Link from "next/link";
import type { Metadata } from "next";
import MarketingNav from "@/components/MarketingNav";
import { Footer } from "@/app/page";
import { PLANS, formatPrice } from "@/lib/plans";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Simple, predictable pricing. Free tier, 14-day trial on paid plans, no credit card to start.",
  openGraph: { title: "Pricing — Scheduling SaaS" },
};

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />
      <section className="mx-auto max-w-5xl px-6 py-16 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Simple, predictable pricing</h1>
        <p className="mt-3 text-slate-600">Start free. Upgrade when you grow. Cancel anytime.</p>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Object.values(PLANS).map((p) => (
            <div
              key={p.id}
              className={
                "flex flex-col rounded-2xl border bg-white p-6 shadow-sm " +
                (p.id === "pro" ? "ring-2 ring-brand-accent" : "")
              }
            >
              {p.id === "pro" && (
                <div className="mb-3 inline-flex w-fit rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">
                  Most popular
                </div>
              )}
              <div className="text-sm font-medium uppercase tracking-wider text-slate-500">{p.name}</div>
              <div className="mt-1 text-3xl font-semibold">{formatPrice(p)}</div>
              <p className="mt-2 text-sm text-slate-600">{p.description}</p>
              <ul className="mt-5 space-y-2 text-sm text-slate-700">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2"><span className="text-green-600">✓</span>{f}</li>
                ))}
              </ul>
              <div className="mt-auto pt-6">
                <Link
                  href="/dashboard/login"
                  className={
                    "block rounded-md px-4 py-2 text-center text-sm font-medium " +
                    (p.id === "free" || p.id === "enterprise"
                      ? "border bg-white hover:bg-slate-50"
                      : "bg-brand-accent text-white hover:bg-blue-700")
                  }
                >
                  {p.id === "free" ? "Sign up free" :
                   p.id === "enterprise" ? "Contact sales" :
                   "Start 14-day trial"}
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t bg-slate-50 py-16">
        <div className="mx-auto max-w-3xl px-6">
          <h2 className="text-2xl font-semibold">FAQ</h2>
          <div className="mt-6 space-y-6">
            <Faq q="Can I switch plans?" a="Yes. Upgrades take effect immediately. Downgrades happen at the end of the billing period." />
            <Faq q="Is there a free trial?" a="Pro and Team include a 14-day trial — no credit card needed to start." />
            <Faq q="What happens if I exceed my plan limits?" a="Workspaces see a friendly upsell on the booking endpoint. Existing bookings are never deleted." />
            <Faq q="Do you support Outlook?" a="Not yet — Google Meet is built-in. Outlook is on the roadmap." />
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <div>
      <div className="text-sm font-medium text-slate-900">{q}</div>
      <p className="mt-1 text-sm text-slate-600">{a}</p>
    </div>
  );
}
