import type { IntakeField } from "@/lib/intake";

/**
 * Industry templates. Applying a template auto-creates services, an
 * intake form, departments, and color theming so a new tenant goes
 * from signup → accepting bookings in under five minutes.
 *
 * The optional metadata fields (bestFor, bookingStyle, automationExamples,
 * defaultHours, iconName, accentTone) power the premium onboarding
 * wizard's template gallery. They are non-breaking additions — existing
 * callers that only need {services, departments, intakeForm} continue
 * to work unchanged.
 */

export type TemplateService = {
  name: string;
  description?: string;
  durationMinutes: number;
  priceCents?: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  color?: string;
  minNoticeMinutes?: number;
  maxAdvanceDays?: number;
};

export type TemplateDepartment = { name: string; color?: string };

/** Industry-aware weekly defaults used by the wizard's hours step. */
export type TemplateDefaultHours = {
  /** Sun=0 … Sat=6 (matches `availability.dayOfWeek`). */
  days: number[];
  /** HH:MM, 24h. */
  start: string;
  end: string;
  /** Plain-English summary shown to the user. */
  summary: string;
};

/** Closed-set tonal accent class set (kept in sync with Card tokens). */
export type TemplateAccentTone = "brand" | "emerald" | "violet" | "rose" | "amber" | "sky";

export type IndustryTemplate = {
  id: string;
  label: string;
  /** Emoji kept for back-compat; new UI prefers Lucide via `iconName`. */
  emoji: string;
  /** Lucide icon name to import in the wizard. */
  iconName?:
    | "Calculator" | "Stethoscope" | "Scissors" | "Target" | "Scale"
    | "Briefcase" | "Receipt" | "HeartHandshake" | "Dumbbell";
  blurb: string;
  primaryColor: string;
  accentTone?: TemplateAccentTone;
  services: TemplateService[];
  departments?: TemplateDepartment[];
  intakeForm?: { name: string; fields: IntakeField[] };

  // ── Premium onboarding metadata (additive) ─────────────────────
  /** 2–4 plain-English use-case labels for the "Best for" chip row. */
  bestFor?: string[];
  /** One-line booking-experience description (shown on the card). */
  bookingStyle?: string;
  /** 2–3 representative automation patterns to nudge upgrades later. */
  automationExamples?: string[];
  /** Industry-aware default weekly hours. */
  defaultHours?: TemplateDefaultHours;
};

export const TEMPLATES: IndustryTemplate[] = [
  {
    id: "tax",
    label: "Tax Office",
    emoji: "📊",
    iconName: "Calculator",
    blurb: "Returns, consultations, S-corp filings.",
    primaryColor: "#0d9488",
    accentTone: "emerald",
    bestFor: ["Tax preparers", "EAs", "CPAs"],
    bookingStyle: "Mix of free consults + paid filings",
    automationExamples: [
      "Auto-send intake checklist 24h before",
      "Follow up if no docs received",
      "Tax-season blackout dates",
    ],
    defaultHours: {
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "18:00",
      summary: "Most tax offices: Mon–Fri, 9 AM–6 PM (extended in tax season).",
    },
    services: [
      { name: "Free 15-min consult", durationMinutes: 15, color: "#0d9488", bufferAfterMin: 5 },
      { name: "Individual return (1040)", durationMinutes: 60, priceCents: 18000, color: "#2563eb", bufferAfterMin: 10 },
      { name: "Business return (1120/1065)", durationMinutes: 90, priceCents: 45000, color: "#7c3aed", bufferAfterMin: 15 },
    ],
    departments: [
      { name: "Individual returns", color: "#2563eb" },
      { name: "Business returns",   color: "#7c3aed" },
    ],
    intakeForm: {
      name: "Tax intake",
      fields: [
        { key: "filing_status",   label: "Filing status",         type: "select", required: true,
          options: ["Single", "Married Filing Jointly", "Married Filing Separately", "Head of Household"] },
        { key: "has_dependents",  label: "Do you have dependents?", type: "radio", required: true, options: ["Yes", "No"] },
        { key: "has_business",    label: "Self-employed / business income?", type: "radio", required: false, options: ["Yes", "No"] },
        { key: "preferred_method",label: "Preferred contact method", type: "select", required: false,
          options: ["Phone", "Email", "Video call"] },
        { key: "notes",           label: "Anything we should know?", type: "textarea", required: false },
      ],
    },
  },
  {
    id: "medical",
    label: "Medical Clinic",
    emoji: "🩺",
    iconName: "Stethoscope",
    blurb: "Visits, follow-ups, telehealth.",
    primaryColor: "#0891b2",
    accentTone: "sky",
    bestFor: ["Primary care", "Specialty clinics", "Telehealth"],
    bookingStyle: "New-patient + recurring follow-ups",
    automationExamples: [
      "Same-day reminder + intake review",
      "Auto-resend missed-visit recovery",
      "Telehealth link 10 min before",
    ],
    defaultHours: {
      days: [1, 2, 3, 4, 5],
      start: "08:30",
      end: "17:00",
      summary: "Most clinics: Mon–Fri, 8:30 AM–5 PM with lunch buffers.",
    },
    services: [
      { name: "New patient visit", durationMinutes: 45, color: "#0891b2", minNoticeMinutes: 60 },
      { name: "Follow-up visit",   durationMinutes: 20, color: "#2563eb", minNoticeMinutes: 60 },
      { name: "Telehealth consult", durationMinutes: 20, color: "#7c3aed", minNoticeMinutes: 30 },
    ],
    departments: [
      { name: "Primary care", color: "#0891b2" },
      { name: "Telehealth",   color: "#7c3aed" },
    ],
    intakeForm: {
      name: "Patient intake",
      fields: [
        { key: "dob",          label: "Date of birth",       type: "date",     required: true },
        { key: "phone",        label: "Phone",               type: "phone",    required: true },
        { key: "is_new",       label: "Are you a new patient?", type: "radio", required: true, options: ["Yes", "No"] },
        { key: "reason",       label: "Reason for visit",    type: "textarea", required: true },
        { key: "consent",      label: "Telehealth consent",  type: "checkbox", required: false,
          options: ["I consent to a telehealth visit when offered"] },
      ],
    },
  },
  {
    id: "salon",
    label: "Salon / Spa",
    emoji: "💇",
    iconName: "Scissors",
    blurb: "Hair, nails, skin, services.",
    primaryColor: "#db2777",
    accentTone: "rose",
    bestFor: ["Stylists", "Estheticians", "Nail techs"],
    bookingStyle: "Service menu with paid deposits",
    automationExamples: [
      "Confirmation 24h prior",
      "Loyalty re-book nudge after 4 weeks",
      "Review request after appointment",
    ],
    defaultHours: {
      days: [2, 3, 4, 5, 6],
      start: "10:00",
      end: "19:00",
      summary: "Most salons: Tue–Sat, 10 AM–7 PM (closed Sunday/Monday).",
    },
    services: [
      { name: "Haircut",       durationMinutes: 45, priceCents: 6000,  color: "#db2777" },
      { name: "Color + style", durationMinutes: 120, priceCents: 18000, color: "#c026d3", bufferAfterMin: 10 },
      { name: "Manicure",      durationMinutes: 30, priceCents: 3500,  color: "#7c3aed" },
    ],
    departments: [
      { name: "Hair", color: "#db2777" },
      { name: "Nails", color: "#7c3aed" },
    ],
    intakeForm: {
      name: "Salon intake",
      fields: [
        { key: "first_visit",   label: "First time with us?", type: "radio", required: true, options: ["Yes", "No"] },
        { key: "preferred_stylist", label: "Preferred stylist", type: "text", required: false },
        { key: "allergies",     label: "Allergies / sensitivities", type: "textarea", required: false },
      ],
    },
  },
  {
    id: "coaching",
    label: "Coaching",
    emoji: "🎯",
    iconName: "Target",
    blurb: "Discovery calls, coaching, group sessions.",
    primaryColor: "#ea580c",
    accentTone: "amber",
    bestFor: ["Executive coaches", "Business strategists", "Career"],
    bookingStyle: "Discovery → paid program",
    automationExamples: [
      "Discovery-call follow-up email",
      "Pre-session prep questionnaire",
      "Series-progress check-ins",
    ],
    defaultHours: {
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "17:00",
      summary: "Most coaches: Mon–Fri, 9 AM–5 PM.",
    },
    services: [
      { name: "Discovery call",      durationMinutes: 30, color: "#ea580c", minNoticeMinutes: 60 },
      { name: "Coaching session",    durationMinutes: 60, priceCents: 15000, color: "#2563eb" },
      { name: "Strategy intensive",  durationMinutes: 90, priceCents: 30000, color: "#7c3aed", bufferAfterMin: 15 },
    ],
    intakeForm: {
      name: "Coaching intake",
      fields: [
        { key: "goal", label: "What do you want to accomplish?", type: "textarea", required: true },
        { key: "timeline", label: "Timeline", type: "select", required: false,
          options: ["This month", "This quarter", "This year", "Not sure yet"] },
        { key: "budget", label: "Comfortable budget range", type: "select", required: false,
          options: ["< $500", "$500–$2,000", "$2,000–$10,000", "$10,000+"] },
      ],
    },
  },
  {
    id: "legal",
    label: "Legal Consultation",
    emoji: "⚖️",
    iconName: "Scale",
    blurb: "Consultations, intake, paid sessions.",
    primaryColor: "#1e40af",
    accentTone: "brand",
    bestFor: ["Solo attorneys", "Boutique firms", "Mediators"],
    bookingStyle: "Free consult → paid retainer",
    automationExamples: [
      "Conflict-check questionnaire pre-call",
      "Engagement letter delivery",
      "Matter-status follow-ups",
    ],
    defaultHours: {
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "17:00",
      summary: "Most law offices: Mon–Fri, 9 AM–5 PM.",
    },
    services: [
      { name: "Initial consultation (free)", durationMinutes: 30, color: "#1e40af", minNoticeMinutes: 120 },
      { name: "Paid consultation",           durationMinutes: 60, priceCents: 25000, color: "#7c3aed" },
    ],
    intakeForm: {
      name: "Legal intake",
      fields: [
        { key: "matter_type", label: "Matter type", type: "select", required: true,
          options: ["Family", "Business", "Real estate", "Immigration", "Other"] },
        { key: "urgency", label: "Urgency", type: "select", required: true,
          options: ["Within a week", "Within a month", "Not urgent"] },
        { key: "summary", label: "Brief summary", type: "textarea", required: true },
      ],
    },
  },
  {
    id: "agency",
    label: "Agency / Consulting",
    emoji: "📈",
    iconName: "Briefcase",
    blurb: "Sales calls, kickoffs, reviews.",
    primaryColor: "#7c3aed",
    accentTone: "violet",
    bestFor: ["Marketing agencies", "Consultancies", "B2B sales"],
    bookingStyle: "Sales pipeline cadence",
    automationExamples: [
      "Pre-call brief delivered automatically",
      "Post-meeting recap + next steps",
      "QBR reminders every 90 days",
    ],
    defaultHours: {
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "18:00",
      summary: "Most agencies: Mon–Fri, 9 AM–6 PM.",
    },
    services: [
      { name: "Sales call",       durationMinutes: 30, color: "#7c3aed" },
      { name: "Project kickoff",  durationMinutes: 60, color: "#2563eb" },
      { name: "Quarterly review", durationMinutes: 60, color: "#0d9488" },
    ],
    departments: [
      { name: "Sales", color: "#7c3aed" },
      { name: "Delivery", color: "#2563eb" },
    ],
  },
  {
    id: "accounting",
    label: "Accounting Firm",
    emoji: "🧾",
    iconName: "Receipt",
    blurb: "Bookkeeping, payroll, audit prep.",
    primaryColor: "#0d9488",
    accentTone: "emerald",
    bestFor: ["CPAs", "Bookkeepers", "Payroll specialists"],
    bookingStyle: "Recurring monthly engagements",
    automationExamples: [
      "Month-end close prep nudges",
      "Doc-upload reminders",
      "Year-end engagement letters",
    ],
    defaultHours: {
      days: [1, 2, 3, 4, 5],
      start: "08:00",
      end: "17:00",
      summary: "Most accounting firms: Mon–Fri, 8 AM–5 PM.",
    },
    services: [
      { name: "Bookkeeping consult", durationMinutes: 45, color: "#0d9488" },
      { name: "Payroll review",      durationMinutes: 30, color: "#0891b2" },
      { name: "Audit prep",          durationMinutes: 60, priceCents: 20000, color: "#7c3aed" },
    ],
  },
  // ── New templates (added in the premium UX rewrite) ───────────────
  {
    id: "therapy",
    label: "Therapy Practice",
    emoji: "🧠",
    iconName: "HeartHandshake",
    blurb: "Counseling, intake, recurring sessions.",
    primaryColor: "#7c3aed",
    accentTone: "violet",
    bestFor: ["Therapists", "Counselors", "Social workers"],
    bookingStyle: "Recurring weekly sessions",
    automationExamples: [
      "Same-day pre-session check-in",
      "Recurring weekly auto-scheduling",
      "Sliding-scale intake form",
    ],
    defaultHours: {
      days: [1, 2, 3, 4, 5],
      start: "10:00",
      end: "19:00",
      summary: "Most practices: Mon–Fri, 10 AM–7 PM (evening hours common).",
    },
    services: [
      { name: "15-min phone consult", durationMinutes: 15, color: "#0d9488" },
      { name: "Intake session",       durationMinutes: 60, priceCents: 18000, color: "#7c3aed", bufferAfterMin: 10 },
      { name: "Therapy session",      durationMinutes: 50, priceCents: 15000, color: "#2563eb", bufferAfterMin: 10 },
    ],
    intakeForm: {
      name: "Therapy intake",
      fields: [
        { key: "reason",       label: "What brings you in?",   type: "textarea", required: true },
        { key: "insurance",    label: "Insurance",             type: "text",     required: false },
        { key: "modality",     label: "Preferred modality",    type: "select",   required: false,
          options: ["In person", "Telehealth", "Either"] },
      ],
    },
  },
  {
    id: "fitness",
    label: "Fitness / Personal Training",
    emoji: "💪",
    iconName: "Dumbbell",
    blurb: "1-on-1 sessions, classes, packages.",
    primaryColor: "#ea580c",
    accentTone: "amber",
    bestFor: ["Personal trainers", "Studios", "Group classes"],
    bookingStyle: "Package + recurring slots",
    automationExamples: [
      "Pre-session warm-up reminder",
      "Package-low replenishment nudge",
      "Streak / milestone celebration",
    ],
    defaultHours: {
      days: [1, 2, 3, 4, 5, 6],
      start: "06:00",
      end: "20:00",
      summary: "Most trainers: Mon–Sat, 6 AM–8 PM (early/late peak hours).",
    },
    services: [
      { name: "Intro session (free)",      durationMinutes: 30, color: "#0d9488" },
      { name: "1-on-1 training",           durationMinutes: 60, priceCents: 8000, color: "#ea580c" },
      { name: "Group class",               durationMinutes: 45, priceCents: 2500, color: "#7c3aed" },
    ],
    intakeForm: {
      name: "Fitness intake",
      fields: [
        { key: "goal",         label: "Primary goal",           type: "select",   required: true,
          options: ["Weight loss", "Strength", "General fitness", "Rehab", "Other"] },
        { key: "injuries",     label: "Injuries / limitations", type: "textarea", required: false },
      ],
    },
  },
];

export function getTemplate(id: string): IndustryTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
