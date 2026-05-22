/**
 * Human-readable RRULE summary for customer-facing surfaces.
 *
 * Scope: produces a short English sentence describing the cadence
 * of a recurring series (e.g. "Every Monday", "Every 2 weeks on Tue
 * & Thu", "Monthly"). NOT a full RFC 5545 parser — only the
 * properties ZentroMeet's `recurrence` engine actually emits
 * (FREQ + INTERVAL + BYDAY). Unfamiliar inputs fall back to the
 * safe label "Recurring".
 *
 * Why hand-rolled: pulling in a full rrule library (~30KB) for one
 * read-only string is overkill on a customer-facing page that
 * already weighs every byte. The engine canonicalizes RRULEs before
 * persistence; the formats we'll ever encounter here are bounded.
 *
 * Always returns a string — never throws.
 */

const DAY_LABELS: Record<string, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
};

const FREQ_LABELS: Record<string, { singular: string; plural: string }> = {
  DAILY:   { singular: "day",   plural: "days" },
  WEEKLY:  { singular: "week",  plural: "weeks" },
  MONTHLY: { singular: "month", plural: "months" },
  YEARLY:  { singular: "year",  plural: "years" },
};

function parseParts(rrule: string): Map<string, string> {
  // Tolerant of the optional "RRULE:" prefix and whitespace.
  const body = rrule.replace(/^RRULE:/i, "").trim();
  const out = new Map<string, string>();
  for (const seg of body.split(/[;]+/).filter(Boolean)) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    out.set(seg.slice(0, eq).toUpperCase().trim(), seg.slice(eq + 1).trim());
  }
  return out;
}

export function summarizeRRule(rrule: string): string {
  if (!rrule) return "Recurring";
  const parts = parseParts(rrule);

  const freq = (parts.get("FREQ") ?? "WEEKLY").toUpperCase();
  const interval = Math.max(1, Number(parts.get("INTERVAL") ?? "1"));
  const byDay = (parts.get("BYDAY") ?? "")
    .split(",")
    .map((s) => s.toUpperCase().trim())
    .filter((s) => s in DAY_LABELS);

  const freqMeta = FREQ_LABELS[freq];
  if (!freqMeta) return "Recurring";

  // ── Weekly: most common path. Always carry day-of-week context. ──
  if (freq === "WEEKLY") {
    const days = byDay.length > 0 ? byDay.map((d) => DAY_LABELS[d]).join(" & ") : null;
    if (interval === 1) {
      return days ? `Every ${days}` : "Weekly";
    }
    return days
      ? `Every ${interval} weeks on ${days}`
      : `Every ${interval} weeks`;
  }

  // ── Daily / Monthly / Yearly ──
  const unit = interval === 1 ? freqMeta.singular : `${interval} ${freqMeta.plural}`;
  const base = interval === 1
    ? capitalize(freq === "DAILY" ? "Daily" : freq === "MONTHLY" ? "Monthly" : "Yearly")
    : `Every ${unit}`;

  // For non-weekly with explicit BYDAY (rare but possible), append it.
  if (byDay.length > 0) {
    return `${base} on ${byDay.map((d) => DAY_LABELS[d]).join(" & ")}`;
  }
  return base;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}
