/**
 * Per-occurrence override merge logic.
 *
 * Pure. The materializer calls applyOverride() to get the effective
 * (startAt, staffUserId, shouldSkip) for an occurrence. Series-level
 * defaults flow through unchanged when the override is empty.
 */
import type { OccurrenceOverride } from "./types";

export type Effective = {
  /** UTC start. Override.startAt wins if present. */
  startAt: Date;
  /** Override.staffUserId wins if present (and only if present — null
   *  on the override means "use series default", not "no staff"). */
  staffUserId: string | null;
  /** True iff this occurrence should NOT materialize a booking. */
  shouldSkip: boolean;
};

export function applyOverride(args: {
  seriesStartAt: Date;
  seriesStaffUserId: string | null;
  override: OccurrenceOverride | null | undefined;
}): Effective {
  const ov = args.override ?? {};
  return {
    startAt: ov.startAt ? new Date(ov.startAt) : args.seriesStartAt,
    staffUserId: ov.staffUserId ?? args.seriesStaffUserId,
    shouldSkip: Boolean(ov.skip),
  };
}

/** Pure shape-check — used by the override API to ensure admin can't
 *  inject arbitrary keys into the jsonb column. */
export function sanitizeOverride(raw: unknown): OccurrenceOverride {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: OccurrenceOverride = {};
  if (typeof r.startAt === "string") out.startAt = r.startAt;
  if (typeof r.staffUserId === "string") out.staffUserId = r.staffUserId;
  if (typeof r.skip === "boolean") out.skip = r.skip;
  if (typeof r.note === "string") out.note = r.note.slice(0, 500);
  return out;
}
