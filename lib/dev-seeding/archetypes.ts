/**
 * Tenant archetypes — vertical-specific behavioral patterns.
 *
 * Each archetype defines:
 *   - business name templates + slug stems
 *   - service catalog (name + duration + price)
 *   - staff size range
 *   - daily booking rate (mean, stdev)
 *   - growth profile (curve over 90d)
 *   - churn risk multiplier
 *   - plan distribution
 *
 * The simulation engine picks one archetype per generated tenant
 * and uses it to drive every downstream metric — so a CPA firm has
 * tax-season spikes, a salon has weekend density, a coach has low
 * volume but high revenue per booking, etc.
 *
 * Real businesses don't all look the same. Neither should the
 * simulated ones.
 */

export type Archetype = {
  id: string;
  /** Vertical label shown in admin UI. */
  label: string;
  /** Names to randomize from. Picked via RNG, suffixed with a 2-digit id. */
  nameStems: readonly string[];
  /** Default plan distribution. Sum to 1.0. */
  planMix: { free: number; pro: number; business: number };
  /** Service catalog. */
  services: ReadonlyArray<{
    name: string;
    durationMin: number;
    /** Cents. 0 = unpaid service. */
    priceCents: number;
  }>;
  /** Staff count range. */
  staff: { min: number; max: number };
  /** Daily booking rate (mean + stdev). */
  bookingsPerDay: { mean: number; stdev: number };
  /** Growth profile across 90d: 'flat' | 'climbing' | 'declining' | 'seasonal'. */
  growth: "flat" | "climbing" | "declining" | "seasonal";
  /** Churn risk multiplier — 1.0 baseline, >1 = higher likely-to-churn. */
  churnMultiplier: number;
  /** Probability of OAuth-style connected tools (calendar). */
  oauthAdoption: number;
};

export const ARCHETYPES: readonly Archetype[] = [
  {
    id: "cpa",
    label: "CPA / Tax Office",
    nameStems: [
      "Summit Tax Group",
      "Heritage CPA",
      "Pinewood Accounting",
      "Riverstone Tax Advisors",
      "Capstone Bookkeeping",
      "Crestline Tax Pros",
    ],
    planMix: { free: 0.2, pro: 0.55, business: 0.25 },
    services: [
      { name: "Individual Tax Prep", durationMin: 60, priceCents: 35000 },
      { name: "Business Tax Filing", durationMin: 90, priceCents: 75000 },
      { name: "Quarterly Review", durationMin: 45, priceCents: 22500 },
      { name: "Free Consultation", durationMin: 30, priceCents: 0 },
    ],
    staff: { min: 3, max: 8 },
    bookingsPerDay: { mean: 14, stdev: 5 },
    growth: "seasonal",
    churnMultiplier: 0.7,
    oauthAdoption: 0.85,
  },
  {
    id: "law",
    label: "Law Firm",
    nameStems: [
      "Whitfield & Lane",
      "Holloway Legal",
      "Marston Counsel",
      "Aldridge Law Group",
      "Brennan Partners",
      "Caldwell & Reeves",
    ],
    planMix: { free: 0.1, pro: 0.5, business: 0.4 },
    services: [
      { name: "Initial Consultation", durationMin: 30, priceCents: 0 },
      { name: "Estate Planning", durationMin: 90, priceCents: 50000 },
      { name: "Contract Review", durationMin: 60, priceCents: 35000 },
      { name: "Deposition Prep", durationMin: 120, priceCents: 75000 },
    ],
    staff: { min: 4, max: 12 },
    bookingsPerDay: { mean: 9, stdev: 3 },
    growth: "climbing",
    churnMultiplier: 0.6,
    oauthAdoption: 0.9,
  },
  {
    id: "medspa",
    label: "Med Spa",
    nameStems: [
      "Lumen Aesthetics",
      "Sable Skin & Wellness",
      "Mirella Med Spa",
      "Vera Aesthetic Studio",
      "Bloom & Glow",
      "Velora Wellness",
    ],
    planMix: { free: 0.15, pro: 0.6, business: 0.25 },
    services: [
      { name: "Hydrafacial", durationMin: 45, priceCents: 18500 },
      { name: "Botox Consultation", durationMin: 30, priceCents: 0 },
      { name: "Microneedling", durationMin: 75, priceCents: 35000 },
      { name: "Laser Hair Removal — Session", durationMin: 30, priceCents: 12000 },
      { name: "Chemical Peel", durationMin: 60, priceCents: 25000 },
    ],
    staff: { min: 2, max: 6 },
    bookingsPerDay: { mean: 22, stdev: 7 },
    growth: "climbing",
    churnMultiplier: 1.0,
    oauthAdoption: 0.75,
  },
  {
    id: "salon",
    label: "Hair & Beauty Salon",
    nameStems: [
      "Saffron Salon",
      "The Cutting Studio",
      "Maven Hair Co.",
      "Bristle & Bloom",
      "Tangerine Beauty Bar",
      "Indigo Style House",
    ],
    planMix: { free: 0.4, pro: 0.45, business: 0.15 },
    services: [
      { name: "Haircut & Style", durationMin: 60, priceCents: 8500 },
      { name: "Color Service", durationMin: 120, priceCents: 18000 },
      { name: "Blowout", durationMin: 45, priceCents: 5500 },
      { name: "Bridal Trial", durationMin: 90, priceCents: 15000 },
    ],
    staff: { min: 2, max: 5 },
    bookingsPerDay: { mean: 28, stdev: 9 },
    growth: "flat",
    churnMultiplier: 1.3,
    oauthAdoption: 0.55,
  },
  {
    id: "consultant",
    label: "Independent Consultant",
    nameStems: [
      "Halberd Strategy",
      "Northbound Advisors",
      "Atelier 9",
      "Greenrock Consulting",
      "Hollow Pine Studio",
      "Marble Lane Partners",
    ],
    planMix: { free: 0.5, pro: 0.4, business: 0.1 },
    services: [
      { name: "Discovery Call", durationMin: 30, priceCents: 0 },
      { name: "Strategy Session", durationMin: 60, priceCents: 25000 },
      { name: "Workshop Half-Day", durationMin: 240, priceCents: 150000 },
    ],
    staff: { min: 1, max: 2 },
    bookingsPerDay: { mean: 4, stdev: 2 },
    growth: "climbing",
    churnMultiplier: 1.5,
    oauthAdoption: 0.7,
  },
  {
    id: "agency",
    label: "Creative / Marketing Agency",
    nameStems: [
      "Foundry & Field",
      "Tangent Creative",
      "Kindling Studio",
      "Outcrop Agency",
      "Lighthouse & Co.",
      "Westbound Creative",
    ],
    planMix: { free: 0.2, pro: 0.55, business: 0.25 },
    services: [
      { name: "Project Kickoff", durationMin: 60, priceCents: 0 },
      { name: "Brand Strategy Session", durationMin: 90, priceCents: 45000 },
      { name: "Quarterly Review", durationMin: 60, priceCents: 22500 },
      { name: "Creative Brief", durationMin: 45, priceCents: 15000 },
    ],
    staff: { min: 3, max: 9 },
    bookingsPerDay: { mean: 7, stdev: 3 },
    growth: "flat",
    churnMultiplier: 1.1,
    oauthAdoption: 0.85,
  },
  {
    id: "clinic",
    label: "Medical / Dental Clinic",
    nameStems: [
      "Harborlight Family Dental",
      "Cedar Health Clinic",
      "Meadowbrook Pediatrics",
      "Northgate Dental",
      "Riverbend Family Practice",
      "Hillside Medical Group",
    ],
    planMix: { free: 0.05, pro: 0.5, business: 0.45 },
    services: [
      { name: "Routine Cleaning", durationMin: 45, priceCents: 12000 },
      { name: "Annual Checkup", durationMin: 30, priceCents: 18000 },
      { name: "Consultation", durationMin: 30, priceCents: 0 },
      { name: "Procedure Follow-up", durationMin: 45, priceCents: 9500 },
    ],
    staff: { min: 5, max: 14 },
    bookingsPerDay: { mean: 32, stdev: 10 },
    growth: "flat",
    churnMultiplier: 0.5,
    oauthAdoption: 0.95,
  },
  {
    id: "coach",
    label: "Coach / Trainer",
    nameStems: [
      "Stride Coaching",
      "Compass Performance",
      "Anchor Wellness Coaching",
      "Pivot Career Coaching",
      "Lift Athletic Coaching",
      "Bluebird Mindset",
    ],
    planMix: { free: 0.55, pro: 0.35, business: 0.1 },
    services: [
      { name: "Intro Session", durationMin: 30, priceCents: 0 },
      { name: "Weekly Session", durationMin: 60, priceCents: 12500 },
      { name: "Intensive Block (3hr)", durationMin: 180, priceCents: 45000 },
    ],
    staff: { min: 1, max: 1 },
    bookingsPerDay: { mean: 5, stdev: 2 },
    growth: "climbing",
    churnMultiplier: 1.4,
    oauthAdoption: 0.6,
  },
] as const;

/** Look up by id. */
export function archetypeById(id: string): Archetype | undefined {
  return ARCHETYPES.find((a) => a.id === id);
}

/** Daily booking multiplier from the archetype's growth profile.
 *  daysFromOldest = 0 means 90 days ago; daysFromOldest = 90 means today. */
export function growthMultiplier(growth: Archetype["growth"], daysFromOldest: number): number {
  const t = Math.min(1, Math.max(0, daysFromOldest / 90));
  switch (growth) {
    case "flat":
      return 1;
    case "climbing":
      // Linear from 0.45 → 1.15
      return 0.45 + 0.7 * t;
    case "declining":
      return 1.2 - 0.6 * t;
    case "seasonal":
      // Bell-curve around day 60 (about 30 days ago) — mimics tax-season-ish spike
      return 0.6 + 0.9 * Math.exp(-Math.pow((t - 0.66) * 3, 2));
  }
}
