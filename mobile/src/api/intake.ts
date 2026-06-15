/**
 * Intake-form network access.
 *
 * The field model + pure helpers live in @/lib/intake (dependency-free, so they
 * stay unit-testable). This module adds the one networked call and re-exports
 * the lib so existing call sites can keep importing from "@/api/intake".
 *
 *   • Definitions:  GET /api/public/services/<id>/intake-form  (public, unauth)
 *   • Answers:      POST /api/bookings  { ..., intakeResponses }  (object keyed by field.key)
 *   • Read-back:    GET /api/bookings/<id>/intake-responses  (role-gated, labeled)
 */

import { apiGet } from "./client";
import { normalizeFormFields, type IntakeForm } from "@/lib/intake";

export * from "@/lib/intake";

export const intakeApi = {
  /**
   * Fetch the active intake form for a service, or `null` when the service has
   * no form OR the tenant feature is off OR the form is inactive. This gate is
   * SYMMETRIC with the booking POST's validation gate: if this returns null,
   * the booking POST will not validate intake and a no-answers booking still
   * succeeds (back-compat for services without a form).
   *
   * The endpoint is public + unauthenticated; the shared client harmlessly
   * attaches the session. We canonicalize types + sort by `order` defensively
   * (the server already does both).
   */
  async getForm(serviceId: string): Promise<IntakeForm | null> {
    const res = await apiGet<{ form: IntakeForm | null }>(
      `/api/public/services/${serviceId}/intake-form`,
    );
    const form = res?.form ?? null;
    if (!form || !Array.isArray(form.fields)) return null;
    return {
      id: form.id,
      name: form.name,
      description: form.description ?? null,
      fields: normalizeFormFields(form.fields),
    };
  },
};
