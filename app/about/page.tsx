import type { Metadata } from "next";
import MarketingNav from "@/components/MarketingNav";
import { Footer } from "@/app/page";

export const metadata: Metadata = {
  title: "About",
  description: "We build a multi-tenant scheduling platform that gets out of your way.",
};

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />
      <section className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-4xl font-semibold tracking-tight">About</h1>
        <p className="mt-4 text-lg text-slate-700">
          We&rsquo;re building a scheduling platform that takes the rough edges out of multi-tenant booking — without the
          enterprise tax.
        </p>
        <p className="mt-4 text-slate-700">
          Every workspace is fully isolated, every action is auditable, and every booking is one click away from a
          Google Meet link. No queues, no microservices, no surprise outages.
        </p>
        <h2 className="mt-10 text-xl font-medium">Our principles</h2>
        <ul className="mt-3 space-y-2 text-slate-700">
          <li>• Boring stack, clean code.</li>
          <li>• Multi-tenant from day one, not bolted on later.</li>
          <li>• Stripe-grade billing, even on the free plan.</li>
          <li>• Mobile-friendly by default.</li>
        </ul>
      </section>
      <Footer />
    </div>
  );
}
