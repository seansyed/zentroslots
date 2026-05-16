import type { IntakeField } from "@/lib/intake";

/**
 * Industry templates. Applying a template auto-creates services, an
 * intake form, departments, and color theming so a new tenant goes
 * from signup → accepting bookings in under five minutes.
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

export type IndustryTemplate = {
  id: string;
  label: string;
  emoji: string;
  blurb: string;
  primaryColor: string;
  services: TemplateService[];
  departments?: TemplateDepartment[];
  intakeForm?: { name: string; fields: IntakeField[] };
};

export const TEMPLATES: IndustryTemplate[] = [
  {
    id: "tax",
    label: "Tax Office",
    emoji: "📊",
    blurb: "Returns, consultations, S-corp filings.",
    primaryColor: "#0d9488",
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
    blurb: "Visits, follow-ups, telehealth.",
    primaryColor: "#0891b2",
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
    blurb: "Hair, nails, skin, services.",
    primaryColor: "#db2777",
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
    blurb: "Discovery calls, coaching, group sessions.",
    primaryColor: "#ea580c",
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
    blurb: "Consultations, intake, paid sessions.",
    primaryColor: "#1e40af",
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
    blurb: "Sales calls, kickoffs, reviews.",
    primaryColor: "#7c3aed",
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
    blurb: "Bookkeeping, payroll, audit prep.",
    primaryColor: "#0d9488",
    services: [
      { name: "Bookkeeping consult", durationMinutes: 45, color: "#0d9488" },
      { name: "Payroll review",      durationMinutes: 30, color: "#0891b2" },
      { name: "Audit prep",          durationMinutes: 60, priceCents: 20000, color: "#7c3aed" },
    ],
  },
];

export function getTemplate(id: string): IndustryTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
