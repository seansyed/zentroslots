import type { Metadata } from "next";
import MarketingNav from "@/components/MarketingNav";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Features",
  description: "Public booking pages, custom branding, availability overrides, Google Meet, reminders, analytics.",
  openGraph: { title: "Features — ZentroMeet" },
};

const FEATURES = [
  { title: "Public booking pages", body: "Every workspace gets a branded URL: yourapp.com/u/your-slug. Mobile-optimized." },
  { title: "Custom branding", body: "Logo, primary color, tagline, description, and a custom booking-page headline." },
  { title: "Weekly availability + overrides", body: "Recurring rules per weekday, plus per-date overrides for vacations and split-day schedules." },
  { title: "Buffer time", body: "Configure pre- and post-meeting buffers per service. Slot math always respects them." },
  { title: "Cancel & reschedule", body: "Signed tokens in every email — clients act in one click, no login required." },
  { title: "Google Calendar + Meet", body: "Each confirmed booking creates a Google Meet event, adds attendees, sends the invite." },
  { title: "Reminders", body: "24-hour and 1-hour automatic reminders via a tiny cron script." },
  { title: "Multi-tenant security", body: "Strict tenant isolation, row-level checks, signed action tokens. No shared global data." },
  { title: "Analytics", body: "Bookings, conversion, top services, revenue estimates — simple, focused charts." },
];

export default function FeaturesPage() {
  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />
      <section className="mx-auto max-w-5xl px-6 py-16 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Everything you need to ship bookings</h1>
        <p className="mt-3 text-slate-600">Built for solo operators and teams of any size.</p>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border bg-white p-5 shadow-sm">
              <div className="text-base font-medium">{f.title}</div>
              <p className="mt-2 text-sm text-slate-600">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <Footer />
    </div>
  );
}
