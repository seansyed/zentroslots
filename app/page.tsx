import Link from "next/link";
import MarketingNav from "@/components/MarketingNav";
import Footer from "@/components/Footer";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 pt-16 pb-20 text-center">
        <div className="inline-flex rounded-full border bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
          Scheduling, done right
        </div>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
          Book meetings without the back-and-forth.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-slate-600">
          A multi-tenant scheduling platform with custom branding, Google Meet, and
          enterprise-grade availability rules. Set it up in five minutes.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            href="/dashboard/login"
            className="rounded-md bg-brand-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
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
        <div className="mt-3 text-xs text-slate-500">14-day free trial on paid plans · no credit card required</div>
      </section>

      {/* Logo strip placeholder */}
      <section className="border-y bg-slate-50 py-8">
        <div className="mx-auto max-w-5xl px-6 text-center text-xs uppercase tracking-wider text-slate-400">
          Trusted by teams that hate scheduling email threads
        </div>
      </section>

      {/* Feature grid */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-3">
          <Feature title="Set hours once" body="Weekly availability + one-off overrides for vacations, holidays, and split-day schedules." />
          <Feature title="Public booking page" body="Branded URL per workspace. Color, logo, tagline — your business, your look." />
          <Feature title="Google Meet built-in" body="Every confirmed booking auto-creates a Google Meet event and emails the invite." />
          <Feature title="Multi-tenant from day one" body="Run multiple workspaces, isolated data, strict tenant boundaries." />
          <Feature title="Cancel & reschedule" body="Signed token links in every email — no logins, no friction." />
          <Feature title="Analytics that matter" body="Bookings, conversion, top services, revenue estimates. Simple charts." />
        </div>
      </section>

      {/* Testimonials placeholder */}
      <section className="border-y bg-slate-50 py-16">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <div className="text-3xl font-medium text-slate-700">
            “We replaced four Calendly seats with one workspace.”
          </div>
          <div className="mt-3 text-sm text-slate-500">— Real testimonial coming soon</div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-3xl px-6 py-20 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">Ready to stop emailing about meetings?</h2>
        <p className="mt-3 text-slate-600">Sign up free. Upgrade only when you outgrow it.</p>
        <Link
          href="/dashboard/login"
          className="mt-6 inline-flex rounded-md bg-brand-accent px-6 py-3 text-sm font-medium text-white hover:bg-blue-700"
        >
          Get started free
        </Link>
      </section>

      <Footer />
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div className="text-base font-medium text-slate-900">{title}</div>
      <p className="mt-2 text-sm text-slate-600">{body}</p>
    </div>
  );
}

