import Link from "next/link";
import type { Metadata } from "next";
import MarketingNav from "@/components/MarketingNav";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  // `absolute` bypasses the "%s — ZentroMeet" template so the SEO title is exact.
  title: { absolute: "Business Phone for Scheduling Businesses | ZentroMeet" },
  description:
    "Add a dedicated business phone number to ZentroMeet with call forwarding, click-to-call, call logs, and 1,000 US & Canada minutes included.",
  keywords: [
    "business phone",
    "appointment scheduling phone",
    "click-to-call",
    "call forwarding",
    "scheduling software",
    "service business phone",
  ],
  alternates: { canonical: "/business-phone" },
  openGraph: {
    title: "Business Phone for Scheduling Businesses | ZentroMeet",
    description:
      "A dedicated business number, call forwarding, click-to-call, and call logs — built into ZentroMeet. $29/month, 1,000 US & Canada minutes included.",
    url: "/business-phone",
  },
};

/** Inline phone-handset glyph (outline) — keeps the public site dependency-free. */
function PhoneIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" />
    </svg>
  );
}

const SECTIONS = [
  {
    title: "Dedicated business number",
    body: "Keep your personal number private and give clients a professional number to call.",
  },
  {
    title: "Forward calls to your phone",
    body: "Route business calls to your staff phone while keeping your business identity front and center.",
  },
  {
    title: "Click-to-call from ZentroMeet",
    body: "Call clients from inside ZentroMeet. Your phone rings first, then ZentroMeet connects the client.",
  },
  {
    title: "Call logs and usage",
    body: "Track call history and monthly usage from your dashboard.",
  },
  {
    title: "Built for scheduling businesses",
    body: "Connect calls with your scheduling workflow — appointments, reminders, clients, and team operations.",
  },
];

const INCLUDED = [
  "Dedicated business number",
  "Inbound call forwarding",
  "Click-to-call from ZentroMeet",
  "Call logs and usage",
  "Usage capped — no surprise overages",
];

const NOTES = ["Softphone coming soon", "No emergency (911) calling", "No international calling"];

export default function BusinessPhonePage() {
  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />

      {/* Hero */}
      <section className="mx-auto max-w-3xl px-6 pt-16 pb-12 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-accent text-white shadow-sm">
          <PhoneIcon className="h-7 w-7" />
        </div>
        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
          Business Phone for service businesses
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-slate-600">
          Give your business a dedicated phone number, forward calls to your team, and call clients from ZentroMeet —
          without exposing your personal number.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <span className="inline-flex items-center rounded-full bg-brand-accent px-3 py-1 text-sm font-medium text-white">
            $29/month add-on
          </span>
          <span className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-sm font-medium text-blue-700 ring-1 ring-blue-200">
            1,000 US &amp; Canada minutes included
          </span>
        </div>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href="/dashboard/login"
            className="rounded-md bg-brand-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Start using ZentroMeet →
          </Link>
          <Link
            href="/pricing"
            className="rounded-md border bg-white px-5 py-2.5 text-sm font-medium hover:bg-slate-50"
          >
            View pricing
          </Link>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Inbound forwarding + click-to-call today. Softphone coming soon.
        </p>
      </section>

      {/* Feature sections A–E */}
      <section className="mx-auto max-w-5xl px-6 pb-16">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {SECTIONS.map((s) => (
            <div key={s.title} className="rounded-xl border bg-white p-5 shadow-sm">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 text-brand-accent">
                <PhoneIcon className="h-5 w-5" />
              </span>
              <div className="mt-3 text-base font-medium text-slate-900">{s.title}</div>
              <p className="mt-2 text-sm text-slate-600">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="border-y bg-slate-50 py-16">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-slate-900">Simple add-on pricing</h2>
          <p className="mt-3 text-slate-600">One plan. No tiers, no surprises.</p>

          <div className="mx-auto mt-8 max-w-md rounded-2xl border bg-white p-6 text-left shadow-sm">
            <div className="flex items-baseline justify-between">
              <div className="text-base font-medium text-slate-900">Business Phone</div>
              <div className="text-2xl font-semibold text-slate-900">$29<span className="text-base font-normal text-slate-500">/month</span></div>
            </div>
            <p className="mt-1 text-sm text-slate-600">Includes 1,000 US &amp; Canada minutes/month.</p>
            <ul className="mt-5 space-y-2 text-sm text-slate-700">
              {INCLUDED.map((f) => (
                <li key={f} className="flex gap-2"><span className="text-green-600">✓</span>{f}</li>
              ))}
              {NOTES.map((n) => (
                <li key={n} className="flex gap-2 text-slate-500"><span aria-hidden>•</span>{n}</li>
              ))}
            </ul>
            <Link
              href="/dashboard/login"
              className="mt-6 block rounded-md bg-brand-accent px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-blue-700"
            >
              Start using ZentroMeet
            </Link>
            <p className="mt-2 text-center text-xs text-slate-500">Business Phone is added from your dashboard billing after sign-up.</p>
          </div>
        </div>
      </section>

      {/* Limitations — clear, not scary */}
      <section className="mx-auto max-w-3xl px-6 py-12">
        <div className="rounded-xl border bg-white p-5 text-sm text-slate-600 shadow-sm">
          <div className="font-medium text-slate-900">Good to know</div>
          <p className="mt-2">
            Business Phone is not an emergency calling service. Do not use it to call 911 or emergency numbers.
            International calling is not supported. Softphone is coming soon.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-3xl px-6 pb-20 text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-slate-900">
          Run your appointments and business calls from one platform.
        </h2>
        <Link
          href="/dashboard/login"
          className="mt-6 inline-flex rounded-md bg-brand-accent px-6 py-3 text-sm font-medium text-white hover:bg-blue-700"
        >
          Get started
        </Link>
      </section>

      <Footer />
    </div>
  );
}
