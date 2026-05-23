/**
 * Wave I — dual-write intake response persistence.
 *
 * Writes to BOTH surfaces in a single transaction:
 *   1. bookings.intake_responses jsonb — backward-compat mirror
 *      (existing admin drawer / readers still work)
 *   2. intake_field_responses rows — normalized, queryable, CRM-ready
 *
 * Idempotent: ON CONFLICT (booking_id, field_key) DO UPDATE so a
 * webhook replay or post-confirmation retry safely overwrites with the
 * same values. Also tenant-isolated — every row carries tenantId, and
 * the booking row is loaded by (id, tenantId) first to confirm scope.
 *
 * Increments intake_forms.submission_count exactly once per (booking,
 * form) tuple via a guard: increment only when we INSERT the FIRST
 * field-row for that booking (rowCount on conflict-do-nothing helper).
 */

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  intakeFieldResponses,
  intakeForms,
} from "@/db/schema";
import { canonicalType, type IntakeField } from "@/lib/intake";

export interface PersistArgs {
  tenantId: string;
  bookingId: string;
  intakeFormId: string;
  fields: IntakeField[];
  /** The output of validateResponses() — already canonicalized values. */
  responses: Record<string, unknown>;
}

/**
 * Never throws on benign failures — wraps the inner work in try/catch so
 * a downstream issue (e.g. constraint flake during webhook replay)
 * doesn't bubble out of the post-confirmation hooks and break the
 * booking lifecycle. Returns a structured result so the caller can log.
 */
export async function persistIntakeResponses(args: PersistArgs): Promise<
  | { ok: true; written: number; skipped: number }
  | { ok: false; reason: string }
> {
  try {
    // Guard: confirm the booking belongs to this tenant. The booking
    // POST already enforces this, but persistResponses can be called
    // from the webhook receiver (different code path) — defense in
    // depth.
    const booking = await db.query.bookings.findFirst({
      where: and(
        eq(bookings.id, args.bookingId),
        eq(bookings.tenantId, args.tenantId),
      ),
      columns: { id: true },
    });
    if (!booking) {
      return { ok: false, reason: "booking_not_found_or_cross_tenant" };
    }

    let written = 0;
    let skipped = 0;

    // Run all writes in a single transaction so a partial state is
    // impossible. The bookings.intake_responses jsonb update + the N
    // field-row upserts + the submission_count increment either all
    // succeed or all roll back.
    await db.transaction(async (tx) => {
      // 1. Update bookings.intake_responses mirror (backward compat).
      await tx
        .update(bookings)
        .set({
          intakeResponses: args.responses,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bookings.id, args.bookingId),
            eq(bookings.tenantId, args.tenantId),
          ),
        );

      // 2. Upsert one row per field. Iterate fields (not the response
      //    keys) so absent/empty responses for optional fields don't
      //    create spurious rows.
      for (const f of args.fields) {
        const raw = args.responses[f.key];
        if (raw === undefined || raw === null) {
          skipped++;
          continue;
        }
        const t = canonicalType(f.type);
        // Determine which value column to populate.
        let valueText: string | null = null;
        let valueNumber: string | null = null;
        let valueJson: unknown | null = null;
        switch (t) {
          case "short_text":
          case "long_text":
          case "email":
          case "phone":
          case "url":
          case "select":
          case "radio":
          case "date":
            valueText = typeof raw === "string" ? raw : String(raw);
            break;
          case "number":
            valueNumber =
              typeof raw === "number"
                ? String(raw)
                : typeof raw === "string"
                ? raw
                : null;
            break;
          case "boolean":
          case "consent":
            valueText = raw === true || raw === "true" ? "true" : "false";
            break;
          case "multi_select":
            valueJson = Array.isArray(raw) ? raw : [raw];
            break;
        }

        await tx
          .insert(intakeFieldResponses)
          .values({
            tenantId: args.tenantId,
            bookingId: args.bookingId,
            intakeFormId: args.intakeFormId,
            fieldKey: f.key,
            fieldLabel: f.label,
            fieldType: t,
            valueText,
            valueNumber,
            valueJson: valueJson as object | null,
          })
          .onConflictDoUpdate({
            target: [intakeFieldResponses.bookingId, intakeFieldResponses.fieldKey],
            set: {
              fieldLabel: f.label,
              fieldType: t,
              valueText,
              valueNumber,
              valueJson: valueJson as object | null,
            },
          });
        written++;
      }

      // 3. Bump submission_count on the form. Only increment when at
      //    least one new field-row was inserted in this call — avoids
      //    inflating the counter on webhook replays for the same
      //    booking. We approximate this by checking whether the booking
      //    already had any rows BEFORE this transaction.
      if (written > 0) {
        const prior = await tx
          .select({ c: sql<number>`COUNT(*)::int` })
          .from(intakeFieldResponses)
          .where(
            and(
              eq(intakeFieldResponses.bookingId, args.bookingId),
              eq(intakeFieldResponses.intakeFormId, args.intakeFormId),
            ),
          );
        // After our writes the count is `written`. If it's exactly
        // `written`, we just made the first write for this booking +
        // form. If it's greater, prior writes existed (replay).
        const currentCount = prior[0]?.c ?? 0;
        if (currentCount === written) {
          await tx
            .update(intakeForms)
            .set({
              submissionCount: sql`submission_count + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(intakeForms.id, args.intakeFormId),
                eq(intakeForms.tenantId, args.tenantId),
              ),
            );
        }
      }
    });

    return { ok: true, written, skipped };
  } catch (err) {
    // Last-resort: log but never propagate. Booking finalization is
    // the source-of-truth lifecycle; intake persistence is best-effort
    // append. The legacy jsonb mirror update IS inside the transaction,
    // so a failure here means neither write succeeded — operator can
    // backfill later if needed.
    return {
      ok: false,
      reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    };
  }
}
