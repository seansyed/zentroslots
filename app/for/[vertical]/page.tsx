import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import MarketingNav from "@/components/MarketingNav";
import Footer from "@/components/Footer";
import { TEMPLATES, getTemplate } from "@/lib/templates";

const SLUG_TO_ID: Record<string, string> = {
  "tax-office":       "tax",
  "accounting":       "accounting",
  "medical-clinic":   "medical",
  "salon":            "salon",
  "coaching":         "coaching",
  "legal":            "legal",
  "agency":           "agency",
};

const VERTICAL_COPY: Record<string, { headline: string; subhead: string; pain: string[]; gain: string[] }> = {
  tax: {
    headline: "Scheduling for tax preparers, by tax preparers.",
    subhead:  "Take returns, consults, and 8879 sign-offs from one branded booking link.",
    pain:    ["Email-only booking", "No-show rate climbing in March", "Manual intake forms"],
    gain:    ["Branded booking page in 5 minutes", "Automatic Google Meet links", "Custom intake forms tied to each service"],
  },
  accounting: {
    headline: "Scheduling built for accounting firms.",
    subhead:  "Bookkeeping consults, payroll reviews, and audit prep — bookable in one click.",
    pain:    ["Scattered calendars across staff", "No central appointment view", "Repetitive prep questions"],
    gain:    ["One unified calendar across all CPAs", "Round-robin assignment", "Service-level intake forms"],
  },
  medical: {
    headline: "HIPAA-conscious scheduling for clinics.",
    subhead:  "New patients, follow-ups, and telehealth — one booking link, one intake form.",
    pain:    ["Front desk overload", "Telehealth links sent manually", "Patient no-shows"],
    gain:    ["Automatic Google Meet for telehealth", "24h + 1h reminders out of the box", "Per-service buffer time"],
  },
  salon: {
    headline: "Scheduling that fits a busy chair.",
    subhead:  "Cuts, color, nails — bookable from your website, Instagram, or anywhere.",
    pain:    ["Phone tag killing your day", "DM bookings get lost", "Walk-ins overlap appointments"],
    gain:    ["Public booking link works on any phone", "Per-stylist availability + buffer", "Cancel/reschedule without messaging"],
  },
  coaching: {
    headline: "Scheduling for coaches who charge for their time.",
    subhead:  "Discovery calls, sessions, and intensives — paid or free, all in one place.",
    pain:    ["Free Calendly is too basic", "Manual deposit collection", "Forgetting prep questions"],
    gain:    ["Stripe-ready paid sessions", "Service-specific intake forms", "Branded confirmation emails"],
  },
  legal: {
    headline: "Scheduling for solo and small-firm attorneys.",
    subhead:  "Initial consults, paid sessions, and follow-ups — all calendared, all tracked.",
    pain:    ["Free consults eating into billable time", "Manual conflict checks", "No CRM trail"],
    gain:    ["Per-service minimum notice rules", "Tied-in customer history + notes", "Audit log of every change"],
  },
  agency: {
    headline: "Scheduling for sales-led agencies.",
    subhead:  "Discovery calls, kickoffs, QBRs — round-robin across your team.",
    pain:    ["AEs fighting over the same slots", "Pipeline trapped in calendars", "Slow first-touch response"],
    gain:    ["Round-robin auto-assignment", "Embed on landing pages", "Slack alerts on every new booking"],
  },
};

export async function generateMetadata(props: {
  params: Promise<{ vertical: string }>;
}): Promise<Metadata> {
  const { vertical } = await props.params;
  const templateId = SLUG_TO_ID[vertical];
  const tpl = templateId ? getTemplate(templateId) : null;
  if (!tpl) return { title: "Not found" };
  return {
    title: `${tpl.label} scheduling software`,
    description: VERTICAL_COPY[templateId]?.subhead ?? tpl.blurb,
    openGraph: { title: `${tpl.label} scheduling software` },
  };
}

export function generateStaticParams() {
  return Object.keys(SLUG_TO_ID).map((vertical) => ({ vertical }));
}

export default async function VerticalLandingPage(props: {
  params: Promise<{ vertical: string }>;
}) {
  const { vertical } = await props.params;
  const templateId = SLUG_TO_ID[vertical];
  const tpl = templateId ? getTemplate(templateId) : null;
  const copy = templateId ? VERTICAL_COPY[templateId] : null;
  if (!tpl || !copy) notFound();

  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 pt-16 pb-12 text-center">
        <div
          className="inline-flex items-center gap-2 rounded-full border bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600"
          style={{ borderColor: tpl.primaryColor + "55" }}
        >
          <span aria-hidden>{tpl.emoji}</span> Built for {tpl.label.toLowerCase()}s
        </div>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
          {copy.headline}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-slate-600">{copy.subhead}</p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            href={`/dashboard/login?template=${templateId}`}
            className="rounded-md px-5 py-2.5 text-sm font-medium text-white"
            style={{ backgroundColor: tpl.primaryColor }}
          >
            Start free →
          </Link>
          <Link
            href="/pricing"
            className="rounded-md border bg-white px-5 py-2.5 text-sm font-medium hover:bg-slate-50"
          >
            See pricing
          </Link>
        </div>
        <div className="mt-3 text-xs text-slate-500">Free plan to start · no credit card · upgrade or cancel anytime</div>
      </section>

      {/* What you get */}
      <section className="border-y bg-slate-50 py-16">
        <div className="mx-auto max-w-5xl px-6">
          <div className="grid grid-cols-1 gap-12 md:grid-cols-2">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Sound familiar?</div>
              <ul className="mt-3 space-y-2">
                {copy.pain.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-sm text-slate-700">
                    <span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-red-400" aria-hidden />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">What you&rsquo;ll get</div>
              <ul className="mt-3 space-y-2">
                {copy.gain.map((g) => (
                  <li key={g} className="flex items-start gap-2 text-sm text-slate-700">
                    <span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tpl.primaryColor }} aria-hidden />
                    {g}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* What's included */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <h2 className="text-center text-2xl font-semibold tracking-tight">Includes the {tpl.label.toLowerCase()} template</h2>
        <p className="mt-2 text-center text-sm text-slate-600">
          Sign up, pick this template, take bookings in under five minutes.
        </p>
        <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tpl.services.map((s) => (
            <div key={s.name} className="rounded-xl border bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color ?? tpl.primaryColor }} aria-hidden />
                <div className="text-sm font-medium">{s.name}</div>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {s.durationMinutes} min{s.priceCents ? ` · $${(s.priceCents / 100).toFixed(0)}` : ""}
              </div>
            </div>
          ))}
        </div>
        {tpl.intakeForm && (
          <p className="mt-6 text-center text-xs text-slate-500">
            Plus a ready-to-use <strong>{tpl.intakeForm.name}</strong> intake form with {tpl.intakeForm.fields.length} fields.
          </p>
        )}
      </section>

      {/* Other verticals */}
      <section className="border-t bg-slate-50 py-12">
        <div className="mx-auto max-w-5xl px-6 text-center">
          <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Other industries we serve</div>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {TEMPLATES.filter((t) => t.id !== templateId).map((t) => {
              const slug = Object.entries(SLUG_TO_ID).find(([_, id]) => id === t.id)?.[0];
              if (!slug) return null;
              return (
                <Link
                  key={t.id}
                  href={`/for/${slug}`}
                  className="rounded-full border bg-white px-3 py-1 text-xs text-slate-700 hover:border-slate-400"
                >
                  {t.emoji} {t.label}
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
