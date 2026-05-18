/**
 * Parse + serialize a minimal RFC 5545 RRULE string.
 *
 * Grammar we recognize (case-insensitive keys, comma-separated parts):
 *   FREQ=(DAILY|WEEKLY|MONTHLY)
 *   INTERVAL=<int >= 1>            (default 1)
 *   BYDAY=<SU|MO|TU|WE|TH|FR|SA>(,<...>)*
 *   UNTIL=<YYYYMMDDTHHMMSSZ or YYYYMMDD>
 *   COUNT=<int >= 1>
 *
 * Example: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=20"
 *
 * Pure — no DB, no Date math beyond parsing UNTIL. The expander
 * (expandSeries.ts) does the actual occurrence math against a
 * timezone + anchor.
 */

import { FREQUENCIES, WEEKDAYS, type Frequency, type RecurrenceRule, type Weekday } from "./types";

export class RecurrenceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceParseError";
  }
}

export function parseRecurrenceRule(input: string): RecurrenceRule {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new RecurrenceParseError("Empty recurrence rule");
  }
  // RFC 5545 allows a leading "RRULE:" prefix — accept it.
  const cleaned = input.replace(/^RRULE:/i, "").trim();
  const parts = cleaned.split(";").map((p) => p.trim()).filter(Boolean);

  const map: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) throw new RecurrenceParseError(`Bad rule part: ${p}`);
    const key = p.slice(0, eq).toUpperCase();
    const value = p.slice(eq + 1);
    map[key] = value;
  }

  const freqRaw = map.FREQ?.toUpperCase();
  if (!freqRaw || !(FREQUENCIES as readonly string[]).includes(freqRaw)) {
    throw new RecurrenceParseError(`Unsupported FREQ: ${map.FREQ}`);
  }
  const freq = freqRaw as Frequency;

  const interval = map.INTERVAL ? Number(map.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new RecurrenceParseError(`Invalid INTERVAL: ${map.INTERVAL}`);
  }

  let byday: Weekday[] | undefined;
  if (map.BYDAY) {
    const days = map.BYDAY.split(",").map((d) => d.trim().toUpperCase()) as Weekday[];
    for (const d of days) {
      if (!(WEEKDAYS as readonly string[]).includes(d)) {
        throw new RecurrenceParseError(`Invalid BYDAY token: ${d}`);
      }
    }
    byday = days;
  }

  let until: Date | undefined;
  if (map.UNTIL) {
    const parsed = parseRecurrenceDate(map.UNTIL);
    if (!parsed) throw new RecurrenceParseError(`Invalid UNTIL: ${map.UNTIL}`);
    until = parsed;
  }

  let count: number | undefined;
  if (map.COUNT) {
    count = Number(map.COUNT);
    if (!Number.isInteger(count) || count < 1) {
      throw new RecurrenceParseError(`Invalid COUNT: ${map.COUNT}`);
    }
  }

  if (until && count) {
    throw new RecurrenceParseError("UNTIL and COUNT are mutually exclusive");
  }

  return { freq, interval, byday, until, count };
}

export function serializeRecurrenceRule(rule: RecurrenceRule): string {
  const parts: string[] = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byday && rule.byday.length > 0) parts.push(`BYDAY=${rule.byday.join(",")}`);
  if (rule.until) parts.push(`UNTIL=${formatRecurrenceDate(rule.until)}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  return parts.join(";");
}

// ─── UNTIL date parsing ────────────────────────────────────────────────

/** RFC 5545 allows two date forms: basic-date (YYYYMMDD) or basic
 *  datetime UTC (YYYYMMDDTHHMMSSZ). We tolerate ISO-8601 too. */
function parseRecurrenceDate(s: string): Date | null {
  const trimmed = s.trim();
  // YYYYMMDDTHHMMSSZ
  let m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(trimmed);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    return new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se))
    );
  }
  // YYYYMMDD (treat as end-of-day UTC for inclusive matching)
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 23, 59, 59));
  }
  // Tolerant ISO-8601 fallback.
  const iso = new Date(trimmed);
  if (!Number.isNaN(iso.getTime())) return iso;
  return null;
}

function formatRecurrenceDate(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    pad(d.getUTCFullYear(), 4) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}
