/**
 * /quick-create — mobile-first booking creation sheet.
 *
 * Single-screen flow (no multi-page wizard — speed matters):
 *
 *   1. Customer       — search + recent + "new customer" inline
 *   2. Service        — tile grid, recently booked first
 *   3. Date strip     — 14-day forward
 *   4. Slot grid      — pulled from /api/slots once 1-3 are picked
 *   5. Confirm button — POSTs to /api/bookings, optimistically inserts
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
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "@/api/client";
import { appointmentsApi } from "@/api/appointments";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card, PressableCard } from "@/components/ui/Card";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Pill } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { useCustomers } from "@/hooks/useCustomers";
import { useProfile } from "@/hooks/useProfile";
import { useServices } from "@/hooks/useServices";
import { MonthCalendar } from "@/components/ui/MonthCalendar";
import { addDays, dayLabel, isoDateLocal, startOfDay } from "@/lib/dates";
import { queryKeys } from "@/lib/query";
import { track } from "@/lib/telemetry";
import { colors, layout, radius, spacing } from "@/theme";

import type { Customer } from "@/api/customers";
import type { Service } from "@/api/services";

// ─── Helpers ──────────────────────────────────────────────────────
// Date helpers live in @/lib/dates (Hermes-safe — no Intl timezone
// formatting; the previous Intl.DateTimeFormat path silently sent the wrong
// day on Hermes for operators east of UTC). The picked calendar day is sent
// literally as YYYY-MM-DD; the backend interprets it in the tenant timezone.

function formatTime(iso: string): string {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

// ─── Screen ───────────────────────────────────────────────────────

export default function QuickCreateScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const profileQ = useProfile();
  const timezone = profileQ.data?.timezone ?? "UTC";

  // Today (frozen for the session — calendar doesn't shift mid-flow)
  const today = React.useMemo(() => startOfDay(new Date()), []);

  // Form state
  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [manualName, setManualName] = React.useState("");
  const [manualEmail, setManualEmail] = React.useState("");
  const [service, setService] = React.useState<Service | null>(null);
  const [selectedDate, setSelectedDate] = React.useState<Date>(today);
  const [selectedSlot, setSelectedSlot] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

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
      if (!service) return [] as string[];
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

  // Telemetry breadcrumb when a date returns zero availability — gives
  // us a triage hook ("operator picked Sunday and saw nothing — was
  // Sunday truly off, or is it a routing bug?"). We log at warn
  // severity so it shows up in /settings/diagnostics > Warnings.
  React.useEffect(() => {
    if (!service || slotsQ.isLoading || !slotsQ.data) return;
    if (slotsQ.data.length === 0) {
      track("info", "Quick Create: no availability", "warn", {
        serviceId: service.id,
        serviceName: service.name,
        date: slotDateIso,
        timezone,
        weekday: new Date(slotDateIso + "T12:00:00").toLocaleDateString(undefined, {
          weekday: "long",
          timeZone: timezone,
        }),
      });
    }
  }, [service, slotsQ.data, slotsQ.isLoading, slotDateIso, timezone]);

  // Compatibility aliases — the JSX below was written against the old
  // local-state names. Mapping here avoids touching the render block.
  const slots = slotsQ.data ?? null;
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
        if (found.length > 0) {
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
      return appointmentsApi.create({
        serviceId: service.id,
        staffUserId: "auto",
        startAt: selectedSlot,
        clientName: name,
        clientEmail: email,
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

  const canSubmit = Boolean(service && selectedSlot && ((customer) || (manualName.trim() && manualEmail.trim())));

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
              <Avatar name={customer.name} size={40} />
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
                        <Avatar name={c.name} size={32} />
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

        {/* ── Step 3: Date — full month picker, horizon-aware ──────── */}
        <SectionFade delay={120} style={{ marginTop: spacing.xl }}>
          <StepLabel n={3} label="Date" complete={Boolean(selectedDate)} />
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

        {/* ── Step 4: Slot ─────────────────────────────────────────── */}
        <SectionFade delay={180} style={{ marginTop: spacing.xl }}>
          <StepLabel n={4} label="Time" complete={Boolean(selectedSlot)} />
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
          ) : (slots ?? []).length === 0 ? (
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
                {(slots ?? []).length} TIME{(slots ?? []).length === 1 ? "" : "S"} · {timezone}
              </AppText>
              <View style={styles.slotGrid}>
                {(slots ?? []).map((iso) => {
                  const active = iso === selectedSlot;
                  return (
                    <Pressable
                      key={iso}
                      onPress={() => {
                        void Haptics.selectionAsync().catch(() => {});
                        setSelectedSlot(iso);
                      }}
                      style={[styles.slotChip, active && styles.slotChipActive]}
                    >
                      <AppText
                        variant="bodyStrong"
                        style={{ color: active ? colors.inkOnBrand : colors.ink }}
                      >
                        {formatTime(iso)}
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
