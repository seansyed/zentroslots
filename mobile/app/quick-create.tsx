/**
 * /quick-create — mobile-first booking creation sheet.
 *
 * Single-screen flow (no multi-page wizard — speed matters):
 *
 *   1. Customer       — search + recent + "new customer" inline
 *   2. Service        — tile grid, recently booked first
 *   3. Service details — dynamic intake fields (only when the service has a form)
 *   4. Date           — full month picker (MonthCalendar), horizon-aware; accepts
 *                       an optional ?date= handoff from the Calendar tab
 *   5. Slot grid      — pulled from /api/slots once the above are picked
 *   6. Confirm button — POSTs to /api/bookings, optimistically inserts
 *                       into appointments cache, haptic success + back
 *
 * Goal: <15 seconds from FAB tap to confirmed booking.
 *
 * Everything is local-state — no Zustand. The screen unmounts on close
 * and the next open is fresh. Caches are invalidated on success so
 * Home / Appointments / Calendar all pick up the new row.
 */

import * as React from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "@/api/client";
import { appointmentsApi } from "@/api/appointments";
import {
  intakeApi,
  validateIntakeResponses,
  buildIntakePayload,
  seedIntakeDefaults,
} from "@/api/intake";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card, PressableCard } from "@/components/ui/Card";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { IntakeFields } from "@/components/ui/IntakeFields";
import { Pill } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { useCustomers } from "@/hooks/useCustomers";
import { useProfile } from "@/hooks/useProfile";
import { useServices } from "@/hooks/useServices";
import { MonthCalendar } from "@/components/ui/MonthCalendar";
import { addDays, dayLabel, isoDateLocal, parseInitialDate, startOfDay } from "@/lib/dates";
import { queryKeys } from "@/lib/query";
import { track } from "@/lib/telemetry";
import { colors, layout, radius, spacing } from "@/theme";

import type { Customer } from "@/api/customers";
import type { Service } from "@/api/services";

// ─── Helpers ──────────────────────────────────────────────────────
// Date helpers live in @/lib/dates (Hermes-safe — no Intl timezone
// formatting). The picked calendar day is sent literally as YYYY-MM-DD; the
// backend interprets it in the tenant timezone. Slot TIME labels are NOT
// formatted here either — they come pre-formatted from the server in the
// authoritative timezone (formatting UTC instants in the DEVICE timezone was
// the cause of out-of-hours "2 AM" slots). See appointmentsApi.slots.

// ─── Screen ───────────────────────────────────────────────────────

export default function QuickCreateScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const profileQ = useProfile();
  // Book in the BUSINESS timezone, not the operator's personal profile tz
  // (which can be the UTC default). This drives the /api/slots request + the
  // slot the operator taps, so "4:30 PM" means 4:30 PM at the business — not
  // 4:30 PM UTC (which stored as 16:30 UTC = 9:30 AM in the business zone).
  const timezone =
    profileQ.data?.tenant?.timezone || profileQ.data?.timezone || "UTC";

  // Optional ?date=YYYY-MM-DD handoff from the Calendar tab (tap a day → +).
  const { date: dateParam } = useLocalSearchParams<{ date?: string }>();

  // Today (frozen for the session — calendar doesn't shift mid-flow)
  const today = React.useMemo(() => startOfDay(new Date()), []);

  // Form state
  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [manualName, setManualName] = React.useState("");
  const [manualEmail, setManualEmail] = React.useState("");
  const [service, setService] = React.useState<Service | null>(null);
  // Pre-select the date passed from Calendar (clamped to >= today; per-service
  // horizon is enforced once a service is picked). Lazy init = one-shot, so it
  // never fights the user's subsequent date taps.
  const [selectedDate, setSelectedDate] = React.useState<Date>(() =>
    parseInitialDate(typeof dateParam === "string" ? dateParam : undefined, today),
  );
  const [selectedSlot, setSelectedSlot] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  // Service-template intake answers + per-field validation errors. Keyed by
  // field.key (the server contract). Cleared when the SERVICE changes (rule:
  // changing the service clears fields that no longer apply); preserved across
  // date/time navigation for the same service.
  const [intakeValues, setIntakeValues] = React.useState<Record<string, unknown>>({});
  const [intakeErrors, setIntakeErrors] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Data
  const customersQ = useCustomers({ q: debouncedSearch || undefined });
  const servicesQ = useServices();
  // Cache the active list once at render — keeps the JSX readable and
  // avoids `?.active ?? []` repeated three times below.
  const activeServices = servicesQ.data?.active ?? [];

  // Diagnostic breadcrumb: distinguish the three empty-state shapes
  // so /settings/diagnostics shows the real reason post-hoc. We log
  // once per query state transition rather than on every render.
  React.useEffect(() => {
    if (!servicesQ.data || servicesQ.isLoading) return;
    if (activeServices.length === 0) {
      const reason = !servicesQ.data.hasAny
        ? "no_services_in_tenant"
        : servicesQ.data.allInactive
          ? "all_services_inactive"
          : "unknown_empty";
      track("info", `Quick Create: services empty (${reason})`, "warn", {
        total: servicesQ.data.all.length,
        active: servicesQ.data.active.length,
      });
    }
  }, [servicesQ.data, servicesQ.isLoading, activeServices.length]);

  // ── Real availability ─────────────────────────────────────────
  //
  // SCHEDULING AUTHORITY LIVES SERVER-SIDE. The mobile NEVER computes
  // slots — it fetches from /api/slots with the SAME engine the
  // production booking flow uses. We send `staffUserId=any` so the
  // backend fans out across every staff member assigned to this
  // service, calls getAvailableSlots() per staff, and unions the
  // results. Working hours, blackouts, vacations, buffers, existing
  // bookings, calendar events, group sessions, min-notice and
  // max-advance — ALL are enforced inside getAvailableSlots(). The
  // mobile is a thin renderer of that authoritative set.
  //
  // The matching booking POST uses staffUserId="auto" so the routing
  // engine picks the concrete staff at submit time — the union view
  // is just the visibility layer that lets the operator pick a time
  // before knowing who will fulfill it.
  //
  // Date is normalized to the TENANT's timezone via isoDateInZone
  // (not the device's local TZ) so a Sunday in PST stays a Sunday in
  // EST/UTC/etc. — matches what BookingFlow.tsx does on the web.
  // Send the PICKED calendar day literally (Hermes-safe; no Intl tz
  // conversion). The backend interprets it in the tenant/staff timezone.
  const slotDateIso = React.useMemo(() => isoDateLocal(selectedDate), [selectedDate]);

  // Booking horizon: clamp date navigation to the service's maxAdvanceDays
  // (server truth). Null/0 → open-ended forward nav (MonthCalendar bounds the
  // UI). We use this ONLY to disable out-of-range days, never to filter slots.
  const maxDate = React.useMemo(() => {
    const days = service?.maxAdvanceDays ?? null;
    return days && days > 0 ? addDays(today, days) : null;
  }, [service?.maxAdvanceDays, today]);

  const slotsQ = useQuery({
    queryKey: ["slots", service?.id ?? null, slotDateIso, timezone] as const,
    queryFn: async () => {
      if (!service) {
        return { slots: [], timezone, display: [] };
      }
      return appointmentsApi.slots({
        serviceId: service.id,
        staffUserId: "any",
        date: slotDateIso,
        timezone,
      });
    },
    enabled: Boolean(service),
    staleTime: 30_000,        // slots can flip the moment someone else books
    gcTime: 5 * 60_000,
  });

  // ── Service-template intake form ──────────────────────────────────
  //
  // SERVER IS AUTHORITATIVE. A service may link an active intake form
  // (services.intakeFormId). When it does, the booking POST validates the
  // configured fields (e.g. a required "Filing Status" for a tax service) and
  // rejects with 400 if they're missing. We fetch the SAME render-ready form
  // the public web booking uses and collect answers below; mobile never
  // defines its own field model. When the service has no form (or the feature
  // is off), this returns null and booking behaves exactly as before.
  const intakeFormQ = useQuery({
    queryKey: ["intake-form", service?.id ?? null] as const,
    queryFn: () => (service ? intakeApi.getForm(service.id) : Promise.resolve(null)),
    enabled: Boolean(service),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
  const intakeForm = intakeFormQ.data ?? null;
  const hasIntake = Boolean(intakeForm && intakeForm.fields.length > 0);

  // Clear answers + errors whenever the SERVICE changes — stale answers from a
  // different service must never carry over (and would 400 server-side).
  React.useEffect(() => {
    setIntakeValues({});
    setIntakeErrors({});
  }, [service?.id]);

  // Seed defaults once the form for the current service arrives. User-entered
  // values win (spread prev last) so this never clobbers in-progress input.
  React.useEffect(() => {
    if (!intakeForm) return;
    const defaults = seedIntakeDefaults(intakeForm.fields);
    if (Object.keys(defaults).length === 0) return;
    setIntakeValues((prev) => ({ ...defaults, ...prev }));
  }, [intakeForm]);

  // Live client-side validation (mirror of the server validator). Drives the
  // submit gate so the operator can't confirm with a missing required field.
  const intakeOk = React.useMemo(
    () => !hasIntake || Object.keys(validateIntakeResponses(intakeForm!.fields, intakeValues)).length === 0,
    [hasIntake, intakeForm, intakeValues],
  );

  const setIntakeValue = React.useCallback((key: string, value: unknown) => {
    setIntakeValues((prev) => ({ ...prev, [key]: value }));
    setIntakeErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // Telemetry breadcrumb when a date returns zero availability — gives
  // us a triage hook ("operator picked Sunday and saw nothing — was
  // Sunday truly off, or is it a routing bug?"). We log at warn
  // severity so it shows up in /settings/diagnostics > Warnings.
  React.useEffect(() => {
    if (!service || slotsQ.isLoading || !slotsQ.data) return;
    if (slotsQ.data.slots.length === 0) {
      track("info", "Quick Create: no availability", "warn", {
        serviceId: service.id,
        serviceName: service.name,
        date: slotDateIso,
        timezone: slotsQ.data.timezone,
      });
    }
  }, [service, slotsQ.data, slotsQ.isLoading, slotDateIso, timezone]);

  // Render data: server-formatted display rows + the authoritative tz. We
  // NEVER format slot instants on-device (that device-tz bug produced the
  // out-of-hours "2 AM" slots) — the label comes from the server.
  const slotRows = slotsQ.data?.display ?? [];
  const slotTimezone = slotsQ.data?.timezone ?? timezone;
  const slotsLoading = slotsQ.isLoading;
  const slotsError = slotsQ.error
    ? slotsQ.error instanceof Error
      ? slotsQ.error.message
      : "Couldn't load availability"
    : null;

  // Reset slot + any in-flight "next opening" scan when date/service changes.
  React.useEffect(() => {
    setSelectedSlot(null);
    setNextOpening(null);
    setScanning(false);
    scanSeq.current++; // cancels a scan still running for the old date
  }, [selectedDate, service]);

  // ── "Find next opening" scan ──────────────────────────────────────
  // When a day is empty, probe forward (up to 60 days, respecting the
  // horizon) for the first day that has availability. Pure-server truth —
  // each probe is the same /api/slots call. Surfaces a one-tap jump so the
  // operator isn't stuck guessing which day is open.
  const [nextOpening, setNextOpening] = React.useState<Date | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const scanSeq = React.useRef(0);

  const findNextOpening = React.useCallback(async () => {
    if (!service) return;
    const seq = ++scanSeq.current;
    setScanning(true);
    setNextOpening(null);
    try {
      const horizonDays = service.maxAdvanceDays && service.maxAdvanceDays > 0
        ? service.maxAdvanceDays
        : 60;
      const span = Math.min(horizonDays, 60);
      for (let i = 1; i <= span; i++) {
        if (seq !== scanSeq.current) return; // superseded by a newer scan
        const probe = addDays(selectedDate, i);
        if (maxDate && probe.getTime() > maxDate.getTime()) break;
        const found = await appointmentsApi.slots({
          serviceId: service.id,
          staffUserId: "any",
          date: isoDateLocal(probe),
          timezone,
        });
        if (seq !== scanSeq.current) return;
        if (found.slots.length > 0) {
          setNextOpening(probe);
          return;
        }
      }
      setNextOpening(null);
    } finally {
      if (seq === scanSeq.current) setScanning(false);
    }
  }, [service, selectedDate, maxDate, timezone]);

  // Filter customers: prefer the search result, otherwise show recent (by lastAppointmentAt)
  const customerOptions = React.useMemo(() => {
    const list = customersQ.data ?? [];
    if (debouncedSearch) return list.slice(0, 8);
    return list
      .slice()
      .sort((a, b) => {
        const aT = a.lastAppointmentAt ? new Date(a.lastAppointmentAt).getTime() : 0;
        const bT = b.lastAppointmentAt ? new Date(b.lastAppointmentAt).getTime() : 0;
        return bT - aT;
      })
      .slice(0, 6);
  }, [customersQ.data, debouncedSearch]);

  // Submit
  const createMutation = useMutation({
    mutationFn: async () => {
      if (!service) throw new Error("Pick a service");
      if (!selectedSlot) throw new Error("Pick a time");
      const name = customer?.name ?? manualName.trim();
      const email = customer?.email ?? manualEmail.trim();
      if (!name || !email) throw new Error("Enter customer name and email");

      // Validate + assemble service-template answers (client mirror of the
      // server validator). On any error, surface it under the field and stop —
      // the server would reject it anyway.
      let intakeResponses: Record<string, unknown> | undefined;
      if (intakeForm && intakeForm.fields.length > 0) {
        const errs = validateIntakeResponses(intakeForm.fields, intakeValues);
        if (Object.keys(errs).length > 0) {
          setIntakeErrors(errs);
          throw new Error("Please complete the required service details.");
        }
        const payload = buildIntakePayload(intakeForm.fields, intakeValues);
        intakeResponses = Object.keys(payload).length > 0 ? payload : undefined;
      }

      return appointmentsApi.create({
        serviceId: service.id,
        staffUserId: "auto",
        startAt: selectedSlot,
        clientName: name,
        clientEmail: email,
        intakeResponses,
      });
    },
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      // Invalidate everything that surfaces bookings.
      void queryClient.invalidateQueries({ queryKey: queryKeys.appointments() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
      router.back();
    },
    onError: (err) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      // Slot raced — someone else booked it between fetch and confirm. Clear
      // the selection, refresh availability, and prompt for another time
      // (the server is authoritative; we never force a conflicting insert).
      if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
        setSelectedSlot(null);
        void slotsQ.refetch();
        setError("That time was just taken — please pick another.");
        return;
      }
      const msg =
        err instanceof ApiError ? err.message :
        err instanceof Error ? err.message : "Couldn't create booking";
      setError(msg);
    },
  });

  // NOTE: intake validity is intentionally NOT part of canSubmit. Mirroring the
  // web booking flow, the Confirm button stays active so pressing it runs
  // validation and surfaces per-field errors ("Filing status is required")
  // directly under each field — a disabled button would hide WHICH field is
  // missing. The mutation still blocks submit on any intake error (and the
  // server re-validates), so an incomplete booking is never created.
  const canSubmit = Boolean(
    service &&
    selectedSlot &&
    (customer || (manualName.trim() && manualEmail.trim())),
  );

  // Dynamic step numbering: the "Service details" step only exists when the
  // selected service has an intake form (or we're loading/erroring one), so
  // Date/Time renumber to keep the sequence contiguous.
  const showDetails = Boolean(service) && (intakeFormQ.isLoading || hasIntake || intakeFormQ.isError);
  const stepDate = showDetails ? 4 : 3;
  const stepTime = showDetails ? 5 : 4;

  return (
    <ScreenContainer padding={false} edges={["top"]}>
      {/* Header */}
      <View style={styles.topBar}>
        <IconButton
          icon="close"
          accessibilityLabel="Close"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            if (router.canGoBack()) router.back();
            else router.replace("/(tabs)");
          }}
        />
        <AppText variant="bodyStrong" style={styles.topTitle} numberOfLines={1}>
          New booking
        </AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* ── Step 1: Customer ─────────────────────────────────────── */}
        <SectionFade>
          <StepLabel n={1} label="Customer" complete={Boolean(customer || (manualName && manualEmail))} />
          {customer ? (
            <PressableCard
              padding={spacing.md}
              onPress={() => {
                void Haptics.selectionAsync().catch(() => {});
                setCustomer(null);
              }}
              style={styles.selectedRow}
            >
              <Avatar name={customer.name} uri={customer.imageUrl} size={40} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="bodyStrong" numberOfLines={1}>{customer.name}</AppText>
                <AppText variant="small" color="muted" numberOfLines={1}>{customer.email}</AppText>
              </View>
              <Ionicons name="close-circle" size={20} color={colors.inkSubtle} />
            </PressableCard>
          ) : (
            <>
              <Input
                placeholder="Search customers, or enter a new email…"
                value={search}
                onChangeText={setSearch}
                autoCapitalize="none"
                autoCorrect={false}
                containerStyle={{ marginBottom: spacing.sm }}
              />
              {customersQ.isLoading && !customersQ.data ? (
                <View style={{ gap: spacing.sm }}>
                  <Shimmer.Card height={56} />
                  <Shimmer.Card height={56} />
                </View>
              ) : customerOptions.length === 0 ? (
                <Card variant="outline">
                  <AppText variant="small" color="muted" align="center" style={{ paddingVertical: spacing.lg }}>
                    No matches. Enter the customer's name + email below to create a new booking.
                  </AppText>
                  <View style={{ gap: spacing.sm }}>
                    <Input
                      placeholder="Customer name"
                      value={manualName}
                      onChangeText={setManualName}
                    />
                    <Input
                      placeholder="customer@email.com"
                      value={manualEmail}
                      onChangeText={setManualEmail}
                      autoCapitalize="none"
                      keyboardType="email-address"
                    />
                  </View>
                </Card>
              ) : (
                <View style={{ gap: spacing.xs }}>
                  {customerOptions.map((c) => (
                    <PressableCard
                      key={c.id}
                      padding={spacing.sm}
                      variant="outline"
                      onPress={() => {
                        void Haptics.selectionAsync().catch(() => {});
                        setCustomer(c);
                        setManualName("");
                        setManualEmail("");
                      }}
                    >
                      <View style={styles.customerRow}>
                        <Avatar name={c.name} uri={c.imageUrl} size={32} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <AppText variant="bodyStrong" numberOfLines={1}>{c.name}</AppText>
                          <AppText variant="caption" color="muted" numberOfLines={1}>{c.email}</AppText>
                        </View>
                        {c.totalBookings > 0 ? (
                          <Pill tone="neutral">{c.totalBookings} bookings</Pill>
                        ) : null}
                      </View>
                    </PressableCard>
                  ))}
                </View>
              )}
            </>
          )}
        </SectionFade>

        {/* ── Step 2: Service ──────────────────────────────────────── */}
        <SectionFade delay={60} style={{ marginTop: spacing.xl }}>
          <StepLabel n={2} label="Service" complete={Boolean(service)} />
          {servicesQ.isLoading && !servicesQ.data ? (
            <View style={styles.serviceGrid}>
              <Shimmer.Card height={72} />
              <Shimmer.Card height={72} />
              <Shimmer.Card height={72} />
              <Shimmer.Card height={72} />
            </View>
          ) : activeServices.length === 0 ? (
            // Three-state empty UI — distinguishes "no rows at all" from
            // "rows exist but everything is paused" from "we got nothing
            // back from the server, which on /api/services means either
            // unauth'd or genuinely empty". The right message helps the
            // operator self-recover instead of being stuck.
            <Card variant="outline">
              {servicesQ.data?.allInactive ? (
                <View style={{ paddingVertical: spacing.lg, alignItems: "center" }}>
                  <Ionicons name="pause-circle-outline" size={26} color={colors.warningInk} />
                  <AppText
                    variant="bodyStrong"
                    align="center"
                    style={{ marginTop: spacing.sm }}
                  >
                    All services are paused
                  </AppText>
                  <AppText
                    variant="small"
                    color="muted"
                    align="center"
                    style={{ marginTop: 4, paddingHorizontal: spacing.lg }}
                  >
                    You have {servicesQ.data.all.length} service
                    {servicesQ.data.all.length === 1 ? "" : "s"} on file,
                    but none are active. Activate at least one on the web
                    to take bookings.
                  </AppText>
                </View>
              ) : servicesQ.data && !servicesQ.data.hasAny ? (
                <View style={{ paddingVertical: spacing.lg, alignItems: "center" }}>
                  <Ionicons name="briefcase-outline" size={26} color={colors.inkSubtle} />
                  <AppText
                    variant="bodyStrong"
                    align="center"
                    style={{ marginTop: spacing.sm }}
                  >
                    No services yet
                  </AppText>
                  <AppText
                    variant="small"
                    color="muted"
                    align="center"
                    style={{ marginTop: 4, paddingHorizontal: spacing.lg }}
                  >
                    Create your first service on the web — it'll show up
                    here automatically.
                  </AppText>
                </View>
              ) : (
                // Defensive third branch: data is undefined despite the
                // query being settled — usually auth degraded mid-flight.
                // Surface a tap-to-retry instead of a silent "no services".
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync().catch(() => {});
                    void servicesQ.refetch();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Reload services"
                  style={{ paddingVertical: spacing.lg, alignItems: "center" }}
                >
                  <Ionicons name="refresh-outline" size={22} color={colors.brand} />
                  <AppText
                    variant="bodyStrong"
                    align="center"
                    style={{ marginTop: spacing.sm }}
                  >
                    Couldn't load services
                  </AppText>
                  <AppText
                    variant="small"
                    color="brand"
                    align="center"
                    style={{ marginTop: 4 }}
                  >
                    Tap to try again
                  </AppText>
                </Pressable>
              )}
            </Card>
          ) : (
            <View style={styles.serviceGrid}>
              {activeServices.slice(0, 8).map((s) => {
                const active = service?.id === s.id;
                return (
                  <PressableCard
                    key={s.id}
                    padding={spacing.md}
                    variant={active ? "plain" : "outline"}
                    onPress={() => {
                      void Haptics.selectionAsync().catch(() => {});
                      // Diagnostic — snapshot the EXACT duration the
                      // user is seeing at the moment of selection. If
                      // the slot fetch later returns timings that
                      // don't line up with this duration, we can prove
                      // mobile + backend disagreed at this instant.
                      track("info", `Quick Create: service picked (${s.name})`, "info", {
                        serviceId: s.id,
                        name: s.name,
                        durationMinutes: s.durationMinutes,
                        active: Boolean(s.isActive),
                      });
                      setService(s);
                    }}
                    style={[styles.serviceTile, active && styles.serviceTileActive]}
                  >
                    <View
                      style={[
                        styles.serviceDot,
                        { backgroundColor: s.color || colors.brand },
                      ]}
                    />
                    <AppText variant="smallStrong" numberOfLines={1} style={{ marginTop: 4 }}>
                      {s.name}
                    </AppText>
                    <AppText variant="micro" color="subtle" style={{ marginTop: 2 }}>
                      {s.durationMinutes}m
                      {s.price && s.price > 0 ? ` · $${(s.price / 100).toFixed(0)}` : ""}
                    </AppText>
                  </PressableCard>
                );
              })}
            </View>
          )}
        </SectionFade>

        {/* ── Step 3 (conditional): Service details — dynamic intake ─── */}
        {showDetails ? (
          <SectionFade delay={100} style={{ marginTop: spacing.xl }}>
            <StepLabel n={3} label="Details" complete={hasIntake && intakeOk} />
            {intakeFormQ.isLoading ? (
              <View style={{ gap: spacing.sm }}>
                <Shimmer.Card height={56} />
                <Shimmer.Card height={56} />
              </View>
            ) : intakeFormQ.isError ? (
              <Card style={styles.errorBanner}>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Ionicons name="cloud-offline-outline" size={18} color={colors.dangerInk} />
                  <AppText
                    variant="small"
                    style={{ color: colors.dangerInk, marginLeft: spacing.sm, flex: 1 }}
                  >
                    Couldn't load the service form. Required details may be missing.
                  </AppText>
                </View>
                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync().catch(() => {});
                    void intakeFormQ.refetch();
                  }}
                  style={styles.retryBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading service details"
                >
                  <Ionicons name="refresh" size={14} color={colors.brand} />
                  <AppText variant="smallStrong" style={{ color: colors.brand, marginLeft: 6 }}>
                    Retry
                  </AppText>
                </Pressable>
              </Card>
            ) : intakeForm ? (
              <Card variant="outline">
                {intakeForm.description ? (
                  <AppText variant="small" color="muted" style={{ marginBottom: spacing.md }}>
                    {intakeForm.description}
                  </AppText>
                ) : null}
                <IntakeFields
                  fields={intakeForm.fields}
                  values={intakeValues}
                  errors={intakeErrors}
                  onChange={setIntakeValue}
                />
              </Card>
            ) : null}
          </SectionFade>
        ) : null}

        {/* ── Step: Date — full month picker, horizon-aware ─────────── */}
        <SectionFade delay={120} style={{ marginTop: spacing.xl }}>
          <StepLabel n={stepDate} label="Date" complete={Boolean(selectedDate)} />
          <MonthCalendar
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            minDate={today}
            maxDate={maxDate}
            today={today}
          />
          {service?.maxAdvanceDays && service.maxAdvanceDays > 0 ? (
            <AppText variant="micro" color="subtle" style={{ marginTop: spacing.sm, textAlign: "center" }}>
              Bookable up to {service.maxAdvanceDays} days ahead
            </AppText>
          ) : null}
        </SectionFade>

        {/* ── Step: Slot ───────────────────────────────────────────── */}
        <SectionFade delay={180} style={{ marginTop: spacing.xl }}>
          <StepLabel n={stepTime} label="Time" complete={Boolean(selectedSlot)} />
          {!service ? (
            <Card variant="outline">
              <AppText variant="small" color="muted" align="center" style={{ paddingVertical: spacing.lg }}>
                Pick a service first to see available times.
              </AppText>
            </Card>
          ) : slotsLoading ? (
            <View style={styles.slotGrid}>
              {Array.from({ length: 8 }).map((_, i) => (
                <Shimmer key={i} width="22%" height={42} borderRadius={radius.md} />
              ))}
            </View>
          ) : slotsError ? (
            <Card style={styles.errorBanner}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Ionicons name="cloud-offline-outline" size={18} color={colors.dangerInk} />
                <AppText variant="small" style={{ color: colors.dangerInk, marginLeft: spacing.sm, flex: 1 }}>
                  {slotsError}
                </AppText>
              </View>
              <Pressable
                onPress={() => {
                  void Haptics.selectionAsync().catch(() => {});
                  void slotsQ.refetch();
                }}
                style={styles.retryBtn}
                accessibilityRole="button"
                accessibilityLabel="Retry loading times"
              >
                <Ionicons name="refresh" size={14} color={colors.brand} />
                <AppText variant="smallStrong" style={{ color: colors.brand, marginLeft: 6 }}>Retry</AppText>
              </Pressable>
            </Card>
          ) : slotRows.length === 0 ? (
            <Card variant="outline">
              <View style={{ paddingVertical: spacing.md, alignItems: "center" }}>
                <Ionicons name="calendar-outline" size={24} color={colors.inkSubtle} />
                <AppText variant="bodyStrong" align="center" style={{ marginTop: spacing.sm }}>
                  No openings on {dayLabel(selectedDate)}
                </AppText>
                {scanning ? (
                  <AppText variant="small" color="muted" align="center" style={{ marginTop: 4 }}>
                    Searching for the next available day…
                  </AppText>
                ) : nextOpening ? (
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync().catch(() => {});
                      setSelectedDate(nextOpening);
                      setNextOpening(null);
                    }}
                    style={styles.nextOpeningBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Jump to next opening, ${dayLabel(nextOpening)}`}
                  >
                    <Ionicons name="arrow-forward-circle" size={16} color={colors.inkOnBrand} />
                    <AppText variant="smallStrong" style={{ color: colors.inkOnBrand, marginLeft: 6 }}>
                      Next opening: {dayLabel(nextOpening)}
                    </AppText>
                  </Pressable>
                ) : (
                  <>
                    <AppText variant="small" color="muted" align="center" style={{ marginTop: 4, paddingHorizontal: spacing.lg }}>
                      Pick another date, or search ahead. If days stay empty, this
                      service may have no bookable staff or working hours — set
                      them in Settings → Working Hours.
                    </AppText>
                    <Pressable
                      onPress={() => {
                        void Haptics.selectionAsync().catch(() => {});
                        void findNextOpening();
                      }}
                      style={styles.nextOpeningBtn}
                      accessibilityRole="button"
                      accessibilityLabel="Find next opening"
                    >
                      <Ionicons name="search" size={15} color={colors.inkOnBrand} />
                      <AppText variant="smallStrong" style={{ color: colors.inkOnBrand, marginLeft: 6 }}>
                        Find next opening
                      </AppText>
                    </Pressable>
                  </>
                )}
              </View>
            </Card>
          ) : (
            <>
              <AppText variant="micro" color="subtle" style={{ marginBottom: spacing.sm }}>
                {slotRows.length} TIME{slotRows.length === 1 ? "" : "S"} · {slotTimezone}
              </AppText>
              <View style={styles.slotGrid}>
                {slotRows.map((row) => {
                  const active = row.start === selectedSlot;
                  return (
                    <Pressable
                      key={row.start}
                      onPress={() => {
                        void Haptics.selectionAsync().catch(() => {});
                        setSelectedSlot(row.start);
                      }}
                      style={[styles.slotChip, active && styles.slotChipActive]}
                    >
                      <AppText
                        variant="bodyStrong"
                        style={{ color: active ? colors.inkOnBrand : colors.ink }}
                      >
                        {row.label}
                      </AppText>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}
        </SectionFade>

        {/* Error */}
        {error ? (
          <SectionFade delay={220} style={{ marginTop: spacing.lg }}>
            <Card style={styles.errorBanner}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Ionicons name="alert-circle" size={18} color={colors.dangerInk} />
                <AppText
                  variant="small"
                  style={{ color: colors.dangerInk, marginLeft: spacing.sm, flex: 1 }}
                >
                  {error}
                </AppText>
              </View>
            </Card>
          </SectionFade>
        ) : null}

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Sticky confirm */}
      <View style={styles.stickyActions}>
        <Button
          label={
            createMutation.isPending
              ? "Creating…"
              : canSubmit
                ? "Confirm booking"
                : "Fill all steps"
          }
          variant="primary"
          size="lg"
          fullWidth
          disabled={!canSubmit || createMutation.isPending}
          loading={createMutation.isPending}
          onPress={() => createMutation.mutate()}
          leftIcon={
            !createMutation.isPending && canSubmit ? (
              <Ionicons name="checkmark" size={18} color={colors.inkOnBrand} />
            ) : undefined
          }
        />
      </View>
    </ScreenContainer>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────

function StepLabel({ n, label, complete }: { n: number; label: string; complete: boolean }) {
  return (
    <View style={styles.stepLabelRow}>
      <View
        style={[
          styles.stepNumber,
          complete && { backgroundColor: colors.success },
        ]}
      >
        {complete ? (
          <Ionicons name="checkmark" size={12} color={colors.inkOnBrand} />
        ) : (
          <AppText
            variant="micro"
            style={{ color: colors.inkOnBrand, fontWeight: "700" }}
          >
            {n}
          </AppText>
        )}
      </View>
      <AppText variant="smallStrong" color="muted" style={{ letterSpacing: 0.3 }}>
        {label.toUpperCase()}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surfaceSubtle,
    borderBottomColor: colors.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  topTitle: {
    flex: 1,
    textAlign: "center",
    marginHorizontal: spacing.md,
  },
  scroll: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.lg,
    paddingBottom: spacing["3xl"],
  },
  stepLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  stepNumber: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  selectedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  customerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  serviceGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  serviceTile: {
    flexBasis: "48%",
    flexGrow: 1,
    alignItems: "flex-start",
  },
  serviceTileActive: {
    backgroundColor: colors.brandSubtle,
    borderColor: colors.brand,
    borderWidth: 1,
  },
  serviceDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    marginTop: spacing.sm,
    paddingVertical: 6,
  },
  nextOpeningBtn: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.brand,
  },
  slotGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  slotChip: {
    minWidth: "22%",
    flexGrow: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceInset,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    alignItems: "center",
    justifyContent: "center",
  },
  slotChipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  errorBanner: {
    backgroundColor: colors.dangerSubtle,
    borderColor: colors.dangerInk,
    borderWidth: StyleSheet.hairlineWidth,
  },
  stickyActions: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    backgroundColor: colors.surface,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
