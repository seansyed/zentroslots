import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, customers, intakeForms, serviceStaff, services, tenants, users } from "@/db/schema";
import { sql, asc } from "drizzle-orm";
import { validateResponses, type IntakeField } from "@/lib/intake";
import { errorResponse, getSession, HttpError, isManagerial } from "@/lib/auth";
import { loadTenantFeatures } from "@/lib/features";
import { assertResourcesShareTenant } from "@/lib/tenant";
import { createBookingSchema } from "@/lib/validation";
import { getAvailableSlots } from "@/lib/availability";
import { onBookingCreated, revalidateBeforeBooking } from "@/lib/calendar/sync";
import { triggerAutomation } from "@/lib/communications/engine";
import { enqueueBookingPush } from "@/lib/push/enqueue";
import { validateBookingRules } from "@/lib/booking-rules/validateBookingRules";
import { assignStaff } from "@/lib/routing/assignStaff";
import { simulateAssignment } from "@/lib/routing/simulate";
import { recordAssignment } from "@/lib/routing/recordAssignment";
import { assertCanCreateBooking } from "@/lib/quotas";
import { audit, ipFromHeaders } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { notify } from "@/lib/notify";
import { postTenantWebhook } from "@/lib/outbound";
import { getStripe, isStripeConfigured } from "@/lib/stripe";
import { createPendingPaymentBooking } from "@/lib/billing/paymentLifecycle";
import {
  createTenantVaultCheckout,
  resolveTenantVaultRoute,
} from "@/lib/billing/tenantVaultBooking";
import { persistIntakeResponses } from "@/lib/intake/persistResponses";

// List bookings — strictly scoped to the caller's tenant.
// Staff see their own, admins see the whole tenant.
// Optional ?status= filter (one of: pending|confirmed|cancelled|completed|no_show).
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new HttpError(401, "Unauthorized");

    const ninetyDaysAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 90);
    const statusFilter = req.nextUrl.searchParams.get("status");
    const validStatuses = ["pending", "confirmed", "cancelled", "completed", "no_show"] as const;

    // Pagination: cursor = ISO timestamp of the previous page's last startAt.
    // Stable + index-aligned (bookings_staff_start_idx / bookings_tenant_idx).
    const cursorParam = req.nextUrl.searchParams.get("cursor");
    const limit = Math.max(1, Math.min(200, Number(req.nextUrl.searchParams.get("limit") ?? "50")));
    const cursorAt = cursorParam ? new Date(cursorParam) : null;

    const conds = [
      eq(bookings.tenantId, session.tenantId),
      gte(bookings.startAt, ninetyDaysAgo),
    ];
    if (!isManagerial(session.role)) {
      conds.push(eq(bookings.staffUserId, session.sub));
    }
    if (statusFilter && (validStatuses as readonly string[]).includes(statusFilter)) {
      conds.push(eq(bookings.status, statusFilter as typeof validStatuses[number]));
    }
    if (cursorAt && !Number.isNaN(cursorAt.getTime())) {
      conds.push(lt(bookings.startAt, cursorAt));
    }

    const rows = await db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        endAt: bookings.endAt,
        status: bookings.status,
        clientName: bookings.clientName,
        clientEmail: bookings.clientEmail,
        notes: bookings.notes,
        meetLink: bookings.meetLink,
        serviceId: bookings.serviceId,
        staffUserId: bookings.staffUserId,
        tenantId: bookings.tenantId,
      })
      .from(bookings)
      .where(and(...conds))
      .orderBy(desc(bookings.startAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1].startAt.toISOString() : null;

    return NextResponse.json({ rows: page, nextCursor });
  } catch (err) {
    return errorResponse(err);
  }
}

// Public booking creation. Tenant is inferred from the service; staff
// is verified to belong to the same tenant AND to deliver the service.
export async function POST(req: NextRequest) {
  try {
    // Rate limit by IP — 20 bookings per minute per IP. Friendly enough for
    // legit traffic, kills naive script abuse.
    const ip = ipFromHeaders(req.headers) ?? "anon";
    const rl = rateLimit({ key: `booking:${ip}`, capacity: 20, refillTokens: 20, windowMs: 60_000 });
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many requests — please slow down." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }

    const body = createBookingSchema.parse(await req.json());

    const startAt = new Date(body.startAt);
    if (Number.isNaN(startAt.getTime())) throw new HttpError(400, "Invalid startAt");

    const service = await db.query.services.findFirst({ where: eq(services.id, body.serviceId) });
    if (!service || service.isActive !== 1) throw new HttpError(404, "Service not found");

    // ─── Booking rules (additive, evaluated outside the engine) ─────────
    const now = new Date();
    if (service.minNoticeMinutes && service.minNoticeMinutes > 0) {
      const earliest = new Date(now.getTime() + service.minNoticeMinutes * 60_000);
      if (startAt < earliest) {
        throw new HttpError(409, `This service requires at least ${service.minNoticeMinutes} minutes notice.`);
      }
    }
    if (service.maxAdvanceDays && service.maxAdvanceDays > 0) {
      const latest = new Date(now.getTime() + service.maxAdvanceDays * 24 * 60 * 60_000);
      if (startAt > latest) {
        throw new HttpError(409, `This service can only be booked up to ${service.maxAdvanceDays} days ahead.`);
      }
    }

    // ─── Booking rules (additive, evaluated BEFORE insert) ──────────────
    // The legacy services.minNoticeMinutes / services.maxAdvanceDays
    // checks above keep firing for byte-identical pre-feature behavior
    // (rule #11). The new engine layers on top — most-restrictive wins.
    // When a booking_rules row exists, its caps / cooldown / blackouts /
    // business hours are enforced too. Caller-friendly 409 with the
    // engine's message.
    const tentativeEnd = new Date(startAt.getTime() + service.durationMinutes * 60_000);
    const ruleResult = await validateBookingRules({
      tenantId: service.tenantId,
      serviceId: service.id,
      // locationId not always set on the request today — schema-ready
      // for when location-pinned rules apply.
      locationId: null,
      clientEmail: body.clientEmail,
      startAt,
      endAt: tentativeEnd,
    });
    if (!ruleResult.ok) {
      throw new HttpError(409, ruleResult.error.message);
    }

    // ─── Auto assignment ────────────────────────────────────────────────
    // staffUserId === "auto" → the customer didn't pick a staff member.
    // We first ask the routing engine (round_robin / least_busy /
    // priority / weighted). If no rule exists, or the rule says
    // "manual", we fall through to the LEGACY pickRoundRobinStaff path
    // — byte-identical behavior for tenants who haven't configured
    // routing (rule #13). The engine never throws; any internal error
    // becomes ok:false with a reason and triggers the legacy path.
    let staffUserId: string = body.staffUserId;
    let routingReason: string | null = null;
    let routingMode: string | null = null;
    if (staffUserId === "auto") {
      // Compute the end time tentatively for eligibility — service
      // duration is known. The booking insert below recomputes from
      // the same source.
      const tentativeEnd = new Date(startAt.getTime() + service.durationMinutes * 60_000);
      const assigned = await assignStaff({
        tenantId: service.tenantId,
        serviceId: service.id,
        startAt,
        endAt: tentativeEnd,
      });
      if (assigned.ok) {
        staffUserId = assigned.staffId;
        routingMode = assigned.mode;
        routingReason = assigned.reason;
      } else {
        // Engine declined — typically because no rule is configured.
        // Fall through to the legacy round-robin path. Same SQL,
        // same selection logic that's been in production all along.
        const picked = await pickRoundRobinStaff(service.tenantId, service.id);
        if (!picked) throw new HttpError(404, "No staff available to deliver this service");
        staffUserId = picked;
        routingMode = "legacy_round_robin";
        routingReason = assigned.reason;
      }
    }

    const staff = await db.query.users.findFirst({ where: eq(users.id, staffUserId) });
    if (!staff) throw new HttpError(404, "Staff not found");

    // Both must live in the same tenant.
    const tenantId = assertResourcesShareTenant(service, staff);

    // Plan quota: refuse if the workspace exceeded its monthly bookings.
    await assertCanCreateBooking(tenantId);

    // Staff must actually deliver this service.
    const link = await db.query.serviceStaff.findFirst({
      where: and(
        eq(serviceStaff.serviceId, service.id),
        eq(serviceStaff.userId, staff.id),
        eq(serviceStaff.tenantId, tenantId)
      ),
    });
    if (!link) throw new HttpError(404, "Staff does not deliver this service");

    // Re-validate the slot is still available. The DB exclusion
    // constraint is the real backstop, but this is the cheap check.
    const date = toYmdInTimezone(startAt, staff.timezone);
    const slots = await getAvailableSlots({
      serviceId: service.id,
      staffUserId: staff.id,
      date,
      timezone: staff.timezone,
    });
    if (!slots.includes(startAt.toISOString())) {
      throw new HttpError(409, "Slot no longer available");
    }

    const endAt = new Date(startAt.getTime() + service.durationMinutes * 60_000);

    // ─── Paid-booking pre-check (0030 + Wave H Phase 3) ─────────────────
    // If the service has a price, route to one of:
    //   • Wave H tenant vault   (tenant.use_tenant_payment_providers=true)
    //   • Legacy platform Stripe (the default — byte-identical behavior)
    //   • Strict 503 (tenant opted in but didn't finish provider setup)
    // The actual divert happens AFTER we've validated intake responses
    // (below) so a bad intake form short-circuits without ever creating
    // a checkout session OR a pending_payment row.

    // ─── Tenant feature flags ──────────────────────────────────────────
    // Pulled once and reused below for intake + Google Meet gates so
    // we don't hit the cache twice in the hot path.
    const features = await loadTenantFeatures(tenantId);

    // ─── Intake form validation (if service has one attached) ──────────
    // When intakeForms is OFF at the tenant level, skip validation
    // entirely — the customer never saw the form on the public page
    // (gated symmetrically in the public booking GET), and the
    // service-level attachment becomes a no-op.
    let normalisedResponses: Record<string, unknown> | null = null;
    // Hoisted to outer scope so the post-insert dual-write hook can
    // see the form id + fields to persist normalized responses (Wave I).
    let intakeFormForPersist: { id: string; fields: IntakeField[] } | null = null;
    if (service.intakeFormId && features.intakeForms) {
      const form = await db.query.intakeForms.findFirst({
        where: and(eq(intakeForms.id, service.intakeFormId), eq(intakeForms.tenantId, tenantId)),
      });
      if (form && form.isActive) {
        try {
          normalisedResponses = validateResponses(
            (form.fields as IntakeField[]) ?? [],
            body.intakeResponses ?? {}
          );
          intakeFormForPersist = {
            id: form.id,
            fields: (form.fields as IntakeField[]) ?? [],
          };
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : "Invalid intake response");
        }
      }
    }

    // ─── DIVERT: paid booking → Wave H tenant vault OR legacy Stripe ───
    if (service.price > 0) {
      // Wave H Phase 3 — route resolution. Returns:
      //   • tenant_vault     → use the tenant's own provider creds
      //   • legacy_platform  → fall through to platform Stripe path
      //   • strict_no_provider → 503 (tenant opted in but didn't finish setup)
      //
      // The route resolver evaluates PHASE3_KILL_SWITCH on every call so a
      // hot env flip rolls back instantly (no rebuild).
      const route = await resolveTenantVaultRoute({ tenantId, mode: "live" });

      if (route.kind === "strict_no_provider") {
        throw new HttpError(
          503,
          "Payments are not yet configured for this workspace. Please contact support.",
        );
      }

      if (route.kind === "tenant_vault") {
        // Wave H path. createTenantVaultCheckout does:
        //   1. INSERT pending_payment row with payment_provider_id stamped
        //   2. Decrypt creds + dispatch to adapter.createCheckout()
        //   3. Persist provider session id back onto the booking
        //   4. Audit booking.payment.checkout_created
        // On adapter failure it auto-marks the booking payment_failed
        // so the slot releases immediately.
        const appBase = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
        // Currency: Wave H services carry no explicit currency yet —
        // services.currency lands in Phase 5. For now we use the
        // tenant's provider default currency snapshot OR fall back to
        // USD. This is acceptable because the tenant configures their
        // provider in the currency they actually charge in.
        const currency = (
          (route.provider.capabilities?.defaultCurrency as string | undefined) ?? "usd"
        ).toLowerCase();

        const result = await createTenantVaultCheckout({
          tenantId,
          providerId: route.provider.id,
          servicePrice: service.price,
          serviceCurrency: currency,
          serviceDescription: `${service.name} — ${service.durationMinutes} min with ${staff.name}`,
          customerEmail: body.clientEmail,
          appBaseUrl: appBase,
          ipAddress: ip === "anon" ? null : ip,
          pendingArgs: {
            tenantId,
            serviceId: service.id,
            staffUserId: staff.id,
            clientName: body.clientName,
            clientEmail: body.clientEmail,
            startAt,
            endAt,
            notes: body.notes,
            intakeResponses: normalisedResponses,
            assignmentMode: body.staffUserId === "auto" ? "auto" : "direct",
          },
        });
        if (!result.ok) {
          if (result.reason === "slot_held") {
            throw new HttpError(409, "Another customer is checking out for this slot — try another time");
          }
          if (result.reason === "slot_taken") {
            throw new HttpError(409, "Slot just taken — pick another");
          }
          if (result.reason === "provider_disabled") {
            throw new HttpError(503, "Payment provider is temporarily unavailable. Please try again.");
          }
          if (result.reason === "adapter_error") {
            throw new HttpError(502, "Payment provider unavailable — please try again");
          }
          throw new HttpError(500, "Could not reserve slot");
        }
        // Wave I — dual-write intake responses to normalized table.
        // Best-effort: failure here doesn't break the booking (the
        // jsonb mirror on bookings.intake_responses is the source of
        // truth for legacy readers; normalized is enhancement).
        if (intakeFormForPersist && normalisedResponses) {
          await persistIntakeResponses({
            tenantId,
            bookingId: result.booking.id,
            intakeFormId: intakeFormForPersist.id,
            fields: intakeFormForPersist.fields,
            responses: normalisedResponses,
          }).catch(() => null);
        }
        // createTenantVaultCheckout built the success/cancel URLs
        // internally using the freshly-allocated booking id, so the
        // provider's checkout session sends the customer to the right
        // /booking/confirmed?booking=<actual-id> path. (The page itself
        // is Phase 5; until then customers see a 404 but their booking
        // IS confirmed via the webhook — they also receive an email.)
        return NextResponse.json({
          ...result.booking,
          checkoutUrl: result.checkoutUrl,
          requiresPayment: true,
          paymentRoute: "tenant_vault",
        });
      }
      // Otherwise route.kind === 'legacy_platform' — fall through to the
      // existing Stripe path below.
    }

    const requiresPayment = service.price > 0 && isStripeConfigured();
    if (requiresPayment) {
      const pending = await createPendingPaymentBooking({
        tenantId,
        serviceId: service.id,
        staffUserId: staff.id,
        clientName: body.clientName,
        clientEmail: body.clientEmail,
        startAt,
        endAt,
        notes: body.notes,
        intakeResponses: normalisedResponses,
        assignmentMode: body.staffUserId === "auto" ? "auto" : "direct",
      });
      if (!pending.ok) {
        if (pending.reason === "slot_held") {
          throw new HttpError(409, "Another customer is checking out for this slot — try another time");
        }
        if (pending.reason === "slot_taken") {
          throw new HttpError(409, "Slot just taken — pick another");
        }
        throw new HttpError(500, "Could not reserve slot");
      }

      // Create the Stripe checkout session with an idempotency key
      // derived from the booking id — a double-click can't duplicate.
      let checkoutUrl: string | null = null;
      try {
        const stripe = await getStripe();
        const appBase = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
        const session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  product_data: {
                    name: service.name,
                    description: `${service.durationMinutes} minutes with ${staff.name}`,
                  },
                  unit_amount: service.price,
                },
                quantity: 1,
              },
            ],
            customer_email: body.clientEmail,
            success_url: `${appBase}/booking/confirmed?booking=${pending.booking.id}`,
            cancel_url: `${appBase}/booking/cancelled?booking=${pending.booking.id}`,
            // Source-of-truth metadata for the webhook handler.
            metadata: {
              booking_id: pending.booking.id,
              tenant_id: tenantId,
              service_id: service.id,
              kind: "booking_payment",
            },
            // Stripe Checkout sessions expire automatically. Match our
            // soft-hold so the customer can't pay after the slot was
            // released by the cleanup cron.
            expires_at: Math.floor(
              (pending.booking.paymentHoldExpiresAt?.getTime() ?? Date.now() + 30 * 60_000) / 1000
            ),
          },
          { idempotencyKey: `booking-checkout:${pending.booking.id}` }
        );
        checkoutUrl = session.url;

        // Persist the session id back onto the booking so the webhook
        // can find it.
        await db
          .update(bookings)
          .set({ stripeSessionId: session.id, updatedAt: new Date() })
          .where(eq(bookings.id, pending.booking.id));
      } catch (err) {
        // If Stripe is misconfigured / down, the booking row remains
        // pending_payment. The cleanup cron will expire it after the
        // hold window. We surface a 502 so the UI can retry.
        console.error("[booking] Stripe checkout creation failed:", err);
        throw new HttpError(502, "Payment provider unavailable — please try again");
      }

      // Wave I — dual-write intake responses to normalized table.
      if (intakeFormForPersist && normalisedResponses) {
        await persistIntakeResponses({
          tenantId,
          bookingId: pending.booking.id,
          intakeFormId: intakeFormForPersist.id,
          fields: intakeFormForPersist.fields,
          responses: normalisedResponses,
        }).catch(() => null);
      }

      // Return the pending booking + the checkout URL. NO post-confirmation
      // hooks fire yet — those run in the webhook after payment settles.
      return NextResponse.json({
        ...pending.booking,
        checkoutUrl,
        requiresPayment: true,
      });
    }

    // ─── FREE booking path (unchanged) ────────────────────────────────
    //
    // Wave E — pre-commit external-calendar revalidation.
    //
    // Closes the race window between the slot grid load (cache-backed
    // freebusy) and this insert. If an external event was created
    // between the customer seeing the grid and clicking book, this
    // fresh provider read catches the conflict and 409s the request.
    //
    // Bounded timeout (3s) inside the helper means a slow Graph/Google
    // response falls back to "permit booking" — protecting the booking
    // flow from provider hiccups. The Wave A reconnect-email path
    // catches the rare post-insert conflicts.
    try {
      const reval = await revalidateBeforeBooking({
        userId: staff.id,
        startAt,
        endAt,
      });
      if (!reval.ok) {
        return NextResponse.json(
          {
            error: "external_conflict",
            message:
              "This slot was just booked on the host's calendar. Please pick another time.",
          },
          { status: 409 },
        );
      }
    } catch (e) {
      // Revalidation itself failing is non-fatal — better to let the
      // booking through than block on a freebusy outage. Same fail-
      // open philosophy as the existing freebusy fallback.
      console.error("[bookings] revalidateBeforeBooking failed (continuing):", e);
    }

    let row;
    try {
      [row] = await db
        .insert(bookings)
        .values({
          tenantId,
          serviceId: service.id,
          staffUserId: staff.id,
          clientName: body.clientName,
          clientEmail: body.clientEmail,
          startAt,
          endAt,
          notes: body.notes,
          status: "confirmed",
          intakeResponses: normalisedResponses,
          assignmentMode: body.staffUserId === "auto" ? "auto" : "direct",
        })
        .returning();
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "23P01") throw new HttpError(409, "Slot just taken — pick another");
      throw e;
    }

    // Wave I — dual-write intake responses to normalized table.
    if (intakeFormForPersist && normalisedResponses) {
      await persistIntakeResponses({
        tenantId,
        bookingId: row.id,
        intakeFormId: intakeFormForPersist.id,
        fields: intakeFormForPersist.fields,
        responses: normalisedResponses,
      }).catch(() => null);
    }

    // External calendar sync. Routes through the orchestrator which:
    //   - skips when staff has no active connection (returns early)
    //   - encrypts/decrypts tokens via lib/crypto.ts
    //   - logs the attempt to calendar_sync_logs (ok/failed/skipped)
    //   - flips connection status to 'needs_reconnect' on auth failure
    //   - updates bookings.externalEventId + meetLink on success
    // ALWAYS best-effort — wrapped in try/catch so the booking commits
    // regardless of the calendar provider's state. Meet link gating
    // applies only when the service is video-enabled.
    // Wave C — Teams meeting support. A service flagged
    // `videoProvider === "teams"` requests a Teams join URL from
    // Microsoft Graph alongside the Outlook event; orchestrator
    // routes to the staff's Microsoft connection if one exists.
    // `googleMeet` feature flag still gates Meet specifically because
    // a workspace may want to allow video bookings overall but disable
    // Meet auto-creation; Teams reuses the same flag since both are
    // tenant-level "auto-create video link" toggles.
    const wantVideo =
      (service.videoProvider === "google_meet" || service.videoProvider === "teams") &&
      features.googleMeet;

    // ── Fire-and-forget calendar sync + confirmation email ──────────
    //
    // We deliberately DO NOT `await` the calendar sync. Microsoft
    // Graph and (occasionally) Google can take 5–60s on cold
    // App Registrations or under throttling. The customer is staring
    // at a "Confirming…" spinner during that whole window; their
    // browser/proxy times out around 30–60s and they retry, which
    // hammers Graph with duplicate event creates (each retry passes
    // the same clientRequestId but Graph's idempotency is best-
    // effort — we've seen 3+ duplicate Outlook events from a single
    // logical create when the round-trip exceeds 30s).
    //
    // Architectural correctness:
    //   • The booking row is already committed in the DB above with
    //     status='confirmed' — the customer's slot is locked in.
    //   • onBookingCreated() persists externalEventId + meetLink
    //     directly to the booking row when Graph responds, so the
    //     confirmation page's polling + the eventual email pickup
    //     converge on the right data without us holding the response.
    //   • triggerAutomation() reads the booking row fresh at send
    //     time, so chaining it AFTER the calendar sync means the
    //     email body includes the Teams/Meet link even though we've
    //     already returned to the customer.
    //   • The drift scanner cron repairs any sync that never
    //     completed (network blip, etc.) within 30 min.
    //
    // The orchestrator NEVER throws (catches its own errors and
    // writes to calendar_sync_logs), so the .catch() below only
    // fires on truly unexpected failures.
    void onBookingCreated({
      booking: row,
      staff,
      serviceName: service.name,
      videoConference: wantVideo,
      videoProviderHint: service.videoProvider,
    })
      .then((result) => {
        if (result.status === "ok" && result.eventId) {
          // Persist the orchestrator's results to the booking row so
          // future reads (status poll, email render, dashboard view)
          // see the externalEventId + meetLink.
          return db
            .update(bookings)
            .set({
              externalEventId: result.eventId,
              externalEventProvider: result.provider,
              ...(result.provider === "google" ? { googleEventId: result.eventId } : {}),
              ...(result.meetLink ? { meetLink: result.meetLink } : {}),
              updatedAt: new Date(),
            })
            .where(eq(bookings.id, row.id));
        }
        return undefined;
      })
      .then(() =>
        // Confirmation email routed through the central automation
        // engine, which handles: customer-pref gate, idempotency,
        // template resolution (service → tenant → system fallback),
        // variable rendering, .ics attachment, and structured
        // delivery logging. Runs AFTER the calendar sync update so
        // the email template renders with the live meet_link.
        triggerAutomation({
          tenantId,
          bookingId: row.id,
          eventType: "appointment.created",
          attachIcs: true,
        }),
      )
      .catch((bgErr) => {
        // Defense in depth: even though the orchestrator + automation
        // engine both catch their own errors internally, log here so
        // a stack-trace surface remains for ops without throwing on
        // the now-detached promise (which would unhandledRejection).
        console.error("Booking post-create background chain failed:", bgErr);
      });

    // Best-effort customer upsert — make every public booking promote
    // the client to a first-class CRM record. Wrapped in try/catch so a
    // failure NEVER blocks the booking; we already returned the row.
    try {
      const customerId = await upsertCustomer({
        tenantId,
        name: row.clientName,
        email: row.clientEmail,
      });
      if (customerId) {
        await db
          .update(bookings)
          .set({ customerId })
          .where(eq(bookings.id, row.id));
      }
    } catch (cErr) {
      console.error("Customer upsert failed (booking kept):", cErr);
    }

    // Routing stats — fire and forget. Only relevant when the engine
    // actually picked (auto + non-legacy paths). Never blocks anything.
    if (body.staffUserId === "auto" && routingMode && routingMode !== "legacy_round_robin") {
      try {
        await recordAssignment({ tenantId, staffId: staff.id });
      } catch (rErr) {
        console.error("Routing recordAssignment failed (booking kept):", rErr);
      }
    }

    // Best-effort in-app notification for the assigned staff. Never throws.
    notify({
      tenantId,
      userId: staff.id,
      kind: "booking.created",
      title: `New booking: ${row.clientName}`,
      body: `${service.name} on ${row.startAt.toISOString()}`,
      link: "/dashboard/appointments",
      metadata: { bookingId: row.id, clientEmail: row.clientEmail },
    });

    // Best-effort outbound webhook (Slack-compatible). Never throws.
    postTenantWebhook({
      tenantId,
      text: `📅 New booking: ${row.clientName} — ${service.name} with ${staff.name} on ${row.startAt.toISOString()}`,
      metadata: { event: "booking.created", bookingId: row.id, clientEmail: row.clientEmail },
    });

    // Best-effort audit. Never throws.
    audit({
      tenantId,
      action: "booking.create",
      entityType: "booking",
      entityId: row.id,
      actorLabel: `${row.clientName} <${row.clientEmail}>`,
      metadata: {
        serviceId: service.id,
        staffId: staff.id,
        startAt: row.startAt.toISOString(),
        // Routing transparency: which mode picked, and the engine's
        // reason. Surfaces in the Settings → Routing audit view.
        routingMode: routingMode ?? "direct",
        routingReason: routingReason,
      },
      ipAddress: ip === "anon" ? null : ip,
    });

    // Phase 15H — fire-and-forget candidate-pool capture for engine-
    // driven assignments. Runs simulate against the same window to
    // record the full eligibility breakdown (eligible/skipped + per-
    // candidate reason). The simulate call is read-only and the
    // catch swallows any failure — the booking is already inserted
    // and audited, so this is pure observability for the Routing
    // Intelligence Center's decisions feed. Doubles routing work
    // per auto-booking; acceptable given typical volumes (<100/day
    // for most tenants).
    if (body.staffUserId === "auto" && routingMode && routingMode !== "legacy_round_robin") {
      void (async () => {
        try {
          const sim = await simulateAssignment({
            tenantId,
            serviceId: service.id,
            startAt: row.startAt,
            endAt: row.endAt,
          });
          audit({
            tenantId,
            action: "routing.decision_detail",
            entityType: "booking",
            entityId: row.id,
            actorLabel: `${row.clientName} <${row.clientEmail}>`,
            metadata: {
              bookingId: row.id,
              serviceId: service.id,
              startAt: row.startAt.toISOString(),
              routingMode: routingMode,
              pickedStaffId: staff.id,
              // Compact projection — only the fields the decisions
              // feed renders. Keeps audit_logs.metadata lean.
              candidates: sim.candidates.map((c) => ({
                staffId: c.staffId,
                staffName: c.staffName,
                status: c.status,
                reasonCode: c.reasonCode,
              })),
            },
            ipAddress: ip === "anon" ? null : ip,
          });
        } catch (rErr) {
          console.error("Routing decision_detail capture failed (booking kept):", rErr);
        }
      })();
    }

    // Push notification fan-out — Phase 1C. Fire-and-forget so a
    // push enqueue failure never delays the API response. The
    // assigned staff's push_tokens get a booking_created event;
    // worker scripts/run-push-deliveries.ts delivers within ~60s.
    void enqueueBookingPush({
      tenantId,
      booking: row,
      serviceName: service.name,
      event: "booking_created",
    });

    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Pick the staff member who delivers this service AND has the oldest
 * most-recent booking — simple round-robin without persistent counters.
 * Returns null if no staff is assigned to the service.
 */
async function pickRoundRobinStaff(tenantId: string, serviceId: string): Promise<string | null> {
  // SELECT s.user_id, MAX(b.start_at) AS last_at
  // FROM service_staff s
  // LEFT JOIN bookings b ON b.staff_user_id = s.user_id AND b.status='confirmed'
  // WHERE s.service_id = ? AND s.tenant_id = ?
  // GROUP BY s.user_id ORDER BY last_at NULLS FIRST LIMIT 1
  const rows = await db.execute(sql`
    SELECT s.user_id, MAX(b.start_at) AS last_at
    FROM service_staff s
    LEFT JOIN bookings b
      ON b.staff_user_id = s.user_id
     AND b.status = 'confirmed'
     AND b.tenant_id = s.tenant_id
    WHERE s.service_id = ${serviceId} AND s.tenant_id = ${tenantId}
    GROUP BY s.user_id
    ORDER BY last_at ASC NULLS FIRST
    LIMIT 1
  `);
  const first = (rows as unknown as Array<{ user_id?: string }>)[0];
  return first?.user_id ?? null;
}

function toYmdInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Find a customer by (tenant, lower(email)) or create one. Returns the
 * customer id. Designed for the booking-create hook: caller wraps in
 * try/catch so failure never blocks the booking.
 */
async function upsertCustomer(args: {
  tenantId: string;
  name: string;
  email: string;
}): Promise<string | null> {
  const existing = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(
      sql`${customers.tenantId} = ${args.tenantId} AND lower(${customers.email}) = lower(${args.email})`
    )
    .limit(1);
  if (existing[0]) {
    // Optionally update the name if it changed (last-write-wins for casual rename).
    if (existing[0].name !== args.name) {
      await db
        .update(customers)
        .set({ name: args.name, updatedAt: new Date() })
        .where(eq(customers.id, existing[0].id));
    }
    return existing[0].id;
  }
  try {
    const [row] = await db
      .insert(customers)
      .values({
        tenantId: args.tenantId,
        name: args.name,
        email: args.email,
      })
      .returning();
    return row.id;
  } catch {
    // Race: another insert won the unique constraint; re-read and return.
    const second = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        sql`${customers.tenantId} = ${args.tenantId} AND lower(${customers.email}) = lower(${args.email})`
      )
      .limit(1);
    return second[0]?.id ?? null;
  }
}
