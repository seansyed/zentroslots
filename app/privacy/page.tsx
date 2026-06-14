import type { Metadata } from "next";
import MarketingNav from "@/components/MarketingNav";
import Footer from "@/components/Footer";

// NOTE FOR REVIEWERS (not rendered): This Privacy Policy is a complete,
// product-accurate scaffold but is NOT a substitute for legal advice.
// Before public launch, counsel must review it and fill the bracketed
// [PLACEHOLDERS] (legal entity, address, governing jurisdiction,
// effective date). The Google API Limited Use section is required for
// Google OAuth verification — do not remove it.

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How ZentroMeet collects, uses, protects, and lets you delete your data.",
  alternates: { canonical: "/privacy" },
  openGraph: { title: "Privacy Policy — ZentroMeet" },
};

const UPDATED = "[EFFECTIVE DATE]";
const ENTITY = "[LEGAL ENTITY NAME]";
const ADDRESS = "[REGISTERED ADDRESS]";
const PRIVACY_EMAIL = "privacy@zentromeet.com";
const SUPPORT_EMAIL = "support@zentromeet.com";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />
      <article className="mx-auto max-w-3xl px-6 py-16 text-slate-700">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Privacy Policy</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated: {UPDATED}</p>

        <p className="mt-6">
          This Privacy Policy explains how {ENTITY} (&ldquo;ZentroMeet&rdquo;,
          &ldquo;we&rdquo;, &ldquo;us&rdquo;) collects, uses, shares, and
          protects information when you use the ZentroMeet scheduling
          platform and related websites (the &ldquo;Service&rdquo;).
        </p>

        <Section title="1. Who we are">
          ZentroMeet is operated by {ENTITY}, {ADDRESS}. For privacy questions
          contact us at <a className="text-brand-accent underline" href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>.
        </Section>

        <Section title="2. Information we collect">
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Account &amp; workspace data:</strong> name, email, password (stored only as a salted hash), business name, time zone, branding, and settings.</li>
            <li><strong>Booking data:</strong> appointments, services, availability, and the contact details (name, email, phone, and any intake-form answers) that the people who book with our customers provide.</li>
            <li><strong>Calendar data:</strong> when you connect Google or Microsoft, we access free/busy and event data needed to check conflicts and create/update/cancel events for your bookings (see Section 5).</li>
            <li><strong>Payment data:</strong> subscription and booking payments are processed by Stripe. We do not store full card numbers; we retain Stripe identifiers and billing status.</li>
            <li><strong>Usage &amp; device data:</strong> log data, IP address, and analytics (Google Analytics 4) to operate and improve the Service.</li>
            <li><strong>Cookies:</strong> a strictly-necessary session cookie for authentication, and analytics cookies where enabled.</li>
          </ul>
        </Section>

        <Section title="3. How we use information">
          To provide and secure the Service; create, change, and cancel bookings; check calendar availability; send transactional emails (confirmations, reminders, password resets, billing notices); process payments; provide support; detect abuse and fraud; comply with law; and improve the product. We do not sell personal information.
        </Section>

        <Section title="4. Legal bases (where applicable)">
          We process personal data to perform our contract with you, for our legitimate interests in operating the Service, to comply with legal obligations, and with consent where required (e.g. certain analytics cookies).
        </Section>

        <Section title="5. Google API Limited Use disclosure">
          <p>
            ZentroMeet&rsquo;s use and transfer of information received from
            Google APIs adheres to the{" "}
            <a className="text-brand-accent underline" href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>,
            including the Limited Use requirements.
          </p>
          <p className="mt-3">
            We request only the Google Calendar scopes needed to read
            free/busy availability and to create, update, and delete the
            calendar events associated with your bookings. Google user data
            is used solely to provide and improve these scheduling features.
            We do <strong>not</strong> use Google user data for advertising,
            do <strong>not</strong> sell it, do <strong>not</strong> transfer
            it to others except as necessary to provide the Service or as
            required by law, and do <strong>not</strong> allow humans to read
            it except with your consent, for security/abuse handling, to
            comply with law, or where the data is aggregated/anonymized. The
            same principles apply to data accessed via Microsoft Graph
            (Outlook Calendar).
          </p>
        </Section>

        <Section title="6. How we share information">
          We share data with service providers (sub-processors) who act on our
          instructions: Amazon Web Services (hosting, email via SES), Stripe
          (payments), Google and Microsoft (calendar integrations you
          connect), and Cloudflare (custom-domain edge, where used). We may
          disclose information to comply with law or to protect rights and
          safety. If we undergo a merger or acquisition, data may transfer as
          part of that transaction.
        </Section>

        <Section title="7. Customer (tenant) responsibilities">
          When a business uses ZentroMeet to take bookings, that business is
          the controller of its customers&rsquo; personal data and ZentroMeet
          acts as a processor on its behalf. Businesses are responsible for
          having a lawful basis to collect and process their customers&rsquo;
          information.
        </Section>

        <Section title="8. Data retention">
          We retain account and booking data for as long as your account is
          active and as needed to provide the Service, then for a limited
          period to meet legal, accounting, and dispute-resolution
          obligations. Calendar OAuth tokens are encrypted at rest and removed
          when you disconnect the integration or delete your account.
        </Section>

        <Section title="9. Your rights & account/data deletion">
          <p>
            Depending on your location you may have rights to access, correct,
            export, or delete your personal data, and to object to or restrict
            certain processing.
          </p>
          <p className="mt-3">
            <strong>Deleting your account and data:</strong> you can request
            deletion of your ZentroMeet account and associated personal data
            at any time by emailing{" "}
            <a className="text-brand-accent underline" href={`mailto:${SUPPORT_EMAIL}?subject=Account%20deletion%20request`}>{SUPPORT_EMAIL}</a>{" "}
            from your account email, or via your workspace settings where
            available. On verified request we delete or anonymize your
            personal data within 30 days, except data we must retain by law.
            Disconnecting Google/Microsoft removes the stored calendar tokens
            immediately.
          </p>
        </Section>

        <Section title="10. Security">
          We use industry-standard measures including encryption in transit
          (TLS), encryption at rest for sensitive secrets such as calendar
          tokens, hashed passwords, scoped multi-tenant access controls, and
          audit logging. No method of transmission or storage is 100% secure.
        </Section>

        <Section title="11. International transfers">
          We may process and store information in countries other than where
          you live, including the United States. Where required we use
          appropriate safeguards for such transfers.
        </Section>

        <Section title="12. Children">
          The Service is not directed to children under 16, and we do not
          knowingly collect their personal data.
        </Section>

        <Section title="13. Changes">
          We may update this policy from time to time. Material changes will be
          posted here with a new &ldquo;Last updated&rdquo; date.
        </Section>

        <Section title="14. Contact">
          Questions? Email <a className="text-brand-accent underline" href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a> or write to {ENTITY}, {ADDRESS}.
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
