/**
 * Template resolver with strict hierarchy:
 *   1. Service-level template (tenantId + serviceId + type + enabled)
 *   2. Tenant-wide template  (tenantId + type + enabled, serviceId IS NULL)
 *   3. System fallback       (existing renderers in lib/email.ts)
 *
 * (1) and (2) come from the DB. (3) preserves byte-identical behavior
 * for tenants that haven't customized anything — zero migration burden,
 * zero behavior change on rollout.
 *
 * Pure (no DB) helpers live in ./template-types.ts so tests + UI can
 * import them without touching the DB client.
 */

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { communicationTemplates } from "@/db/schema";
import type { BookingForEmail } from "@/lib/email";
import { renderVariables, type TemplateContext } from "./variables";
import {
  systemFallbackFor,
  TEMPLATE_TYPES,
  templateStarterFor,
  type TemplateType,
  type ResolvedTemplate,
} from "./template-types";

// Re-export for backward compatibility with callers that imported these
// from ./templates before the split.
export { TEMPLATE_TYPES, systemFallbackFor, templateStarterFor };
export type { TemplateType, ResolvedTemplate };

export type ResolveArgs = {
  tenantId: string;
  serviceId?: string | null;
  templateType: TemplateType;
  context: TemplateContext;
  systemFallbackPayload: BookingForEmail;
};

/**
 * Resolves a template through the 3-step hierarchy and renders it with
 * the given context. Always returns something usable — never throws on
 * a missing template (system fallback always exists).
 */
export async function resolveAndRenderTemplate(args: ResolveArgs): Promise<ResolvedTemplate> {
  // (1) Service-level override.
  if (args.serviceId) {
    const svcRow = await db.query.communicationTemplates.findFirst({
      where: and(
        eq(communicationTemplates.tenantId, args.tenantId),
        eq(communicationTemplates.serviceId, args.serviceId),
        eq(communicationTemplates.templateType, args.templateType),
        eq(communicationTemplates.enabled, true)
      ),
    });
    if (svcRow) {
      return renderRow(svcRow, args.context, "service");
    }
  }

  // (2) Tenant-wide default.
  const tenantRow = await db.query.communicationTemplates.findFirst({
    where: and(
      eq(communicationTemplates.tenantId, args.tenantId),
      isNull(communicationTemplates.serviceId),
      eq(communicationTemplates.templateType, args.templateType),
      eq(communicationTemplates.enabled, true)
    ),
  });
  if (tenantRow) {
    return renderRow(tenantRow, args.context, "tenant");
  }

  // (3) System fallback — delegates to the original renderers. Matches
  // current behavior byte-for-byte for tenants that never customize.
  return systemFallbackFor(args.templateType, args.systemFallbackPayload);
}

function renderRow(
  row: typeof communicationTemplates.$inferSelect,
  context: TemplateContext,
  source: "service" | "tenant"
): ResolvedTemplate {
  return {
    subject: renderVariables(row.subject ?? "", context),
    html: renderVariables(row.htmlContent ?? "", context),
    text: renderVariables(row.textContent ?? "", context),
    source,
    templateId: row.id,
  };
}
