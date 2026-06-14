import type { Metadata } from "next";
import MarketingNav from "@/components/MarketingNav";
import Footer from "@/components/Footer";

// NOTE FOR REVIEWERS (not rendered): Product-accurate Terms scaffold.
// Must be reviewed by counsel and have bracketed [PLACEHOLDERS] (entity,
// address, governing law/jurisdiction, effective date) completed before
// public launch. Billing terms below intentionally match the implemented
// behavior: paid plans bill immediately, downgrades apply at period end,
// no automatic free trial.

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern your use of ZentroMeet.",
  alternates: { canonical: "/terms" },
  openGraph: { title: "Terms of Service — ZentroMeet" },
};

const UPDATED = "[EFFECTIVE DATE]";
const ENTITY = "[LEGAL ENTITY NAME]";
const ADDRESS = "[REGISTERED ADDRESS]";
const JURISDICTION = "[GOVERNING JURISDICTION]";
const SUPPORT_EMAIL = "support@zentromeet.com";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />
      <article className="mx-auto max-w-3xl px-6 py-16 text-slate-700">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Terms of Service</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated: {UPDATED}</p>

        <p className="mt-6">
          These Terms of Service (&ldquo;Terms&rdquo;) govern your access to
          and use of the ZentroMeet platform and websites (the
          &ldquo;Service&rdquo;), operated by {ENTITY}, {ADDRESS}. By creating
          an account or using the Service you agree to these Terms.
        </p>

        <Section title="1. The Service">
          ZentroMeet is a multi-tenant scheduling platform that lets
          businesses publish booking pages, manage availability and staff,
          connect Google/Microsoft calendars, take appointments, and send
          related communications.
        </Section>

        <Section title="2. Accounts & eligibility">
          You must provide accurate information, keep your credentials secure,
          and be authorized to bind the business you register. You are
          responsible for activity under your account and for your staff
          users.
        </Section>

        <Section title="3. Subscriptions, billing & cancellation">
          <ul className="list-disc space-y-1 pl-5">
            <li>A Free plan is available. Paid plans are billed in advance through Stripe on a monthly or yearly basis.</li>
            <li><strong>Paid plans bill immediately</strong> upon upgrade — there is no automatic free trial unless explicitly offered to you in writing.</li>
            <li>Upgrades take effect immediately; downgrades take effect at the end of the current billing period.</li>
            <li>You can cancel at any time; access continues until the end of the paid period. Except where required by law, payments are non-refundable.</li>
            <li>Prices and plan limits are shown on our pricing page and may change with notice for future billing periods.</li>
          </ul>
        </Section>

        <Section title="4. Acceptable use">
          You agree not to misuse the Service, including: violating law;
          sending spam or unlawful communications; infringing others&rsquo;
          rights; attempting to breach security or access other tenants&rsquo;
          data; or overloading or disrupting the Service.
        </Section>

        <Section title="5. Customer data & your responsibilities">
          You retain ownership of the data you and your customers submit. You
          are the controller of your customers&rsquo; personal data and are
          responsible for having a lawful basis to collect and process it and
          for honoring their privacy rights. Our handling of personal data is
          described in our{" "}
          <a className="text-brand-accent underline" href="/privacy">Privacy Policy</a>.
        </Section>

        <Section title="6. Third-party integrations">
          The Service integrates with third parties (Google, Microsoft,
          Stripe, and others). Your use of those services is subject to their
          terms, and we are not responsible for their availability or actions.
        </Section>

        <Section title="7. Intellectual property">
          The Service, including its software and content (excluding your
          data), is owned by {ENTITY} and its licensors. We grant you a
          limited, non-exclusive, non-transferable right to use the Service per
          these Terms.
        </Section>

        <Section title="8. Disclaimers">
          The Service is provided &ldquo;as is&rdquo; without warranties of any
          kind to the maximum extent permitted by law. We do not warrant that
          the Service will be uninterrupted or error-free.
        </Section>

        <Section title="9. Limitation of liability">
          To the maximum extent permitted by law, {ENTITY} will not be liable
          for indirect, incidental, special, or consequential damages, and our
          total liability is limited to the amounts you paid for the Service in
          the 12 months preceding the claim.
        </Section>

        <Section title="10. Termination">
          You may stop using the Service at any time. We may suspend or
          terminate accounts that violate these Terms or to protect the
          Service. On termination, your right to use the Service ends; data
          handling follows our Privacy Policy.
        </Section>

        <Section title="11. Governing law">
          These Terms are governed by the laws of {JURISDICTION}, without
          regard to conflict-of-laws rules.
        </Section>

        <Section title="12. Changes">
          We may update these Terms; material changes will be posted here with
          a new &ldquo;Last updated&rdquo; date. Continued use after changes
          means you accept them.
        </Section>

        <Section title="13. Contact">
          Questions about these Terms? Email{" "}
          <a className="text-brand-accent underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </Section>
      </article>
      <Footer />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <div className="mt-2 space-y-2 leading-relaxed">{children}</div>
    </section>
  );
}
