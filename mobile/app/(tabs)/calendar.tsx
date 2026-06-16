/**
 * Calendar tab — Phase 2A redesign + Phase 2C Week view.
 *
 * Three modes via SegmentedTabs:
 *
 *   • Month   — 5-week grid with event-count dots + selected day's
 *               bookings rendered below using AppointmentRow.
 *   • Week    — horizontal 7-day picker + hour-rail timeline for the
 *               selected day, with a red NOW marker that auto-positions
 *               itself on the current time. Operators use this to see
 *               "what does my day look like, hour by hour."
 *   • Agenda  — 14-day forward-looking scrollable list, grouped by day
 *               with a date pill rail on the left. Empty days are
 *               compressed so the timeline doesn't have gaps.
 *
 * All three share the same data fetch and benefit from the same accent
 * stripe + status color story as the rest of the app. Swipe gestures
 * on Month switch months; Agenda is a single vertical scroll. Week view
 * is keyed off `selected` so picking a day in Month mode carries over.
 *
 * No new backend endpoints. The current bookings hook drives all views.
 */

import * as React from "react";
import {
  Dimensions,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { AppointmentRow } from "@/components/ui/AppointmentRow";
import { Card, PressableCard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { QuickCreateFAB } from "@/components/ui/QuickCreateFAB";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { useAppointments } from "@/hooks/useAppointments";
import { apptStartMinutes, apptTime } from "@/lib/appointmentTime";
import { isoDateLocal, isSameMonth, monthLabel } from "@/lib/dates";
import { formatDateLong } from "@/lib/format";
import { colors, radius, shadows, spacing } from "@/theme";

import type { Appointment } from "@/api/appointments";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfDay(d: Date): Date {
  const n = new Date(d);
  n.setHours(0, 0, 0, 0);
  return n;
}
function startOfWeek(d: Date): Date {
  const n = startOfDay(d);
  n.setDate(n.getDate() - n.getDay());
  return n;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function isSameDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

type CalendarMode = "month" | "week" | "agenda";

// Week-view timeline geometry
const WEEK_DAY_HOUR_START = 7;   // 7am
const WEEK_DAY_HOUR_END = 21;    // 9pm
const WEEK_HOUR_HEIGHT = 56;     // px per hour

// Compute a column index for each appointment so overlapping rows render
// side-by-side instead of stacking on top of one another. Algorithm:
//   1. Sort by start time.
//   2. For each event, scan active "lanes" (last endAt per lane). Reuse the
//      first lane whose last endAt ≤ this event's start; else open a new lane.
//   3. Stamp each event with its lane index + the total lanes used by the
//      cluster it belongs to. The render uses lane/totalLanes to compute
//      left + width inside the timeline.
type LaneAssignment = { laneIndex: number; clusterLanes: number };

function assignOverlapLanes(rows: Appointment[]): Map<string, LaneAssignment> {
  const out = new Map<string, LaneAssignment>();
  const sorted = rows
    .slice()
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  // Greedy lane packing per cluster. A cluster is a chain of overlaps.
  // We track the cluster's first row's index in `sorted` so we can rewrite
  // clusterLanes on every row in the cluster after we know the max lane used.
  let clusterStart = 0;
  let clusterEnd = 0; // ms — latest endAt seen in the current cluster
  const lanes: number[] = []; // endAt ms per lane
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]!;
    const start = new Date(row.startAt).getTime();
    const end = new Date(row.endAt).getTime();
    const realEnd = Number.isFinite(end) && end > start ? end : start + 30 * 60_000;

    if (start >= clusterEnd) {
      // New cluster — finalize the old one.
      for (let j = clusterStart; j < i; j++) {
        const prior = sorted[j]!;
        const a = out.get(prior.id);
        if (a) a.clusterLanes = lanes.length || 1;
      }
      clusterStart = i;
      lanes.length = 0;
      clusterEnd = realEnd;
    } else if (realEnd > clusterEnd) {
      clusterEnd = realEnd;
    }

    let lane = lanes.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lanes.push(realEnd);
      lane = lanes.length - 1;
    } else {
      lanes[lane] = realEnd;
    }
    out.set(row.id, { laneIndex: lane, clusterLanes: lanes.length });
  }
  // Finalize last cluster.
  for (let j = clusterStart; j < sorted.length; j++) {
    const a = out.get(sorted[j]!.id);
    if (a) a.clusterLanes = lanes.length || 1;
  }
  return out;
}

export default function CalendarScreen() {
  const router = useRouter();
  const today = React.useMemo(() => startOfDay(new Date()), []);
  const [mode, setMode] = React.useState<CalendarMode>("month");
  const [anchor, setAnchor] = React.useState(today);
  const [selected, setSelected] = React.useState(today);

  // Month mode needs a 5-week grid from the Sunday of the anchor week.
  const gridStart = React.useMemo(() => startOfWeek(anchor), [anchor]);
  const gridDays = React.useMemo(
    () => Array.from({ length: 35 }, (_, i) => addDays(gridStart, i)),
    [gridStart],
  );

  // Agenda mode: today + 14 days forward.
  const agendaStart = today;
  const agendaEnd = React.useMemo(() => addDays(today, 14), [today]);

  // Week mode: Sunday→Saturday around the selected day so the strip picker
  // always lines up to the calendar week.
  const weekStart = React.useMemo(() => startOfWeek(selected), [selected]);
  const weekEnd = React.useMemo(() => addDays(weekStart, 7), [weekStart]);

  // Pull a window that covers whichever mode is active.
  const fetchFrom =
    mode === "month" ? gridStart : mode === "week" ? weekStart : agendaStart;
  const fetchTo =
    mode === "month"
      ? addDays(gridDays[gridDays.length - 1]!, 1)
      : mode === "week"
        ? weekEnd
        : agendaEnd;

  const { data, isLoading, isError, isFetching, refetch } = useAppointments({
    from: fetchFrom.toISOString(),
    to: fetchTo.toISOString(),
    limit: 200,
  });

  const eventsByDate = React.useMemo(() => {
    const map: Record<string, Appointment[]> = {};
    for (const a of data?.rows ?? []) {
      // Bucket by the LOCAL calendar day (Hermes-safe), consistent with the
      // grid cells, the selected-day lookup, and the FAB ?date= handoff — so
      // the highlighted day, its listed bookings, and New Booking all agree
      // (the old UTC .slice(0,10) was off-by-one for operators east of UTC).
      const k = isoDateLocal(new Date(a.startAt));
      (map[k] ||= []).push(a);
    }
    return map;
  }, [data]);

  // Sort each day's bookings by start time
  React.useMemo(() => {
    for (const k of Object.keys(eventsByDate)) {
      eventsByDate[k]!.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
    }
  }, [eventsByDate]);

  function dayKey(d: Date): string {
    return isoDateLocal(d);
  }

  const selectedRows = eventsByDate[dayKey(selected)] ?? [];

  function shiftMonth(delta: number) {
    void Haptics.selectionAsync().catch(() => {});
    const n = new Date(anchor);
    n.setMonth(n.getMonth() + delta);
    setAnchor(n);
  }

  function goToday() {
    void Haptics.selectionAsync().catch(() => {});
    setAnchor(today);
    setSelected(today);
  }

  function pickDay(d: Date) {
    void Haptics.selectionAsync().catch(() => {});
    setSelected(d);
  }

  return (
    <ScreenContainer
      scrollable
      // FAB anchored to the viewport (not the scroll content) — see
      // ScreenContainer.floatingOverlay docs.
      floatingOverlay={<QuickCreateFAB date={isoDateLocal(selected)} />}
    >
      {/* ── Compact page header (non-Home tab pattern) ──────────────
          Title = "Schedule", subtitle = current month label, trailing =
          month-flip arrows when in month view. Bell + avatar handled
          inside PageHeader.

          Negative horizontal margins cancel out the parent ScrollView's
          screen padding so the hairline divider spans full-bleed. The
          PageHeader's own paddingHorizontal then controls left/right
          inset for its content. Same pattern as Customers tab. */}
      <View style={{ marginHorizontal: -spacing.lg, marginTop: -spacing.md }}>
      <PageHeader
        title="Schedule"
        subtitle={
          mode === "month"
            ? "Tap a day to view its bookings"
            : mode === "week"
              ? "Week view"
              : "Up next"
        }
      />
      </View>

      {/* ── View switcher ────────────────────────────────────────── */}
      <SectionFade delay={60} style={{ marginTop: spacing.md }}>
        <SegmentedTabs
          value={mode}
          onChange={(v) => setMode(v)}
          options={[
            { value: "month", label: "Month" },
            { value: "week", label: "Week" },
            { value: "agenda", label: "Agenda" },
          ]}
        />
      </SectionFade>

      {mode === "month" ? (
        <MonthView
          today={today}
          anchor={anchor}
          gridDays={gridDays}
          eventsByDate={eventsByDate}
          selected={selected}
          onPickDay={pickDay}
          onPrevMonth={() => shiftMonth(-1)}
          onNextMonth={() => shiftMonth(1)}
          onToday={goToday}
          selectedRows={selectedRows}
          isLoading={isLoading && !data}
          isError={isError}
          onTapBooking={(id) => router.push(`/appointments/${id}`)}
        />
      ) : mode === "week" ? (
        <WeekView
          today={today}
          weekStart={weekStart}
          selected={selected}
          onPickDay={pickDay}
          eventsByDate={eventsByDate}
          selectedRows={selectedRows}
          isLoading={isLoading && !data}
          isFetching={isFetching}
          isError={isError}
          onRetry={() => void refetch()}
          onTapBooking={(id) => router.push(`/appointments/${id}`)}
        />
      ) : (
        <AgendaView
          today={today}
          agendaEnd={agendaEnd}
          eventsByDate={eventsByDate}
          isLoading={isLoading && !data}
          isError={isError}
          onTapBooking={(id) => router.push(`/appointments/${id}`)}
        />
      )}

      <View style={{ height: spacing["3xl"] + 60 }} />
    </ScreenContainer>
  );
}

// ─── Month mode ──────────────────────────────────────────────────

// Inter-cell gap (px) AND inter-row gap (px). Kept small so the grid
// reads as a unified surface, not a table of disconnected tiles.
const MONTH_GAP = 4;

function MonthView({
  today,
  anchor,
  gridDays,
  eventsByDate,
  selected,
  onPickDay,
  onPrevMonth,
  onNextMonth,
  onToday,
  selectedRows,
  isLoading,
  isError,
  onTapBooking,
}: {
  today: Date;
  anchor: Date;
  gridDays: Date[];
  eventsByDate: Record<string, Appointment[]>;
  selected: Date;
  onPickDay: (d: Date) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
  selectedRows: Appointment[];
  isLoading: boolean;
  isError: boolean;
  onTapBooking: (id: string) => void;
}) {
  // Measure the grid container so cell width math is exact (no
  // percentage-+-fixed-gap rounding error that previously clipped the
  // Saturday column at certain widths). We hand each cell an explicit
  // pixel width and pixel height — Flexbox just stacks them.
  const [containerW, setContainerW] = React.useState(0);
  const cellSize = React.useMemo(() => {
    if (containerW <= 0) return { w: 0, h: 0 };
    // 7 cells per row, 6 inter-cell gaps. floor to avoid sub-pixel
    // overflow on Android browsers that round up.
    const w = Math.floor((containerW - MONTH_GAP * 6) / 7);
    // Slightly squarer than 1:1 so 6 rows fit comfortably on phones
    // without dwarfing the bookings list beneath the grid.
    const h = Math.round(w * 1.05);
    return { w, h };
  }, [containerW]);

  return (
    <>
      {/* Month header — the clear, single source of month context + navigation
          (prev/next + a Today shortcut). Browses any month freely; the general
          Calendar is NOT clamped to the service booking horizon. */}
      <View style={[styles.monthHeader, { marginTop: spacing.lg }]}>
        <NavBtn icon="chevron-back" onPress={onPrevMonth} />
        <View style={styles.monthHeaderCenter}>
          <AppText variant="h4" numberOfLines={1} style={{ textAlign: "center" }}>
            {monthLabel(anchor)}
          </AppText>
          {!isSameMonth(anchor, today) ? (
            <Pressable
              onPress={onToday}
              hitSlop={8}
              style={styles.todayPill}
              accessibilityRole="button"
              accessibilityLabel="Jump to today"
            >
              <AppText variant="micro" style={{ color: colors.brand, fontWeight: "700" }}>
                Today
              </AppText>
            </Pressable>
          ) : null}
        </View>
        <NavBtn icon="chevron-forward" onPress={onNextMonth} />
      </View>

      {/* Weekday labels — sized to match the grid cells exactly so
          "Sat" sits squarely above the last column. */}
      <View
        style={[styles.weekRow, { marginTop: spacing.md }]}
        onLayout={(e) => setContainerW(e.nativeEvent.layout.width)}
      >
        {WEEKDAYS.map((d, i) => (
          <View
            key={d}
            style={{
              width: cellSize.w || undefined,
              flex: cellSize.w ? undefined : 1,
              marginRight: i < WEEKDAYS.length - 1 ? MONTH_GAP : 0,
            }}
          >
            <AppText
              variant="micro"
              color="subtle"
              align="center"
              style={styles.weekLabel}
            >
              {d.toUpperCase()}
            </AppText>
          </View>
        ))}
      </View>

      {/* Grid — rendered only after we've measured. Until then, the
          weekday-label row above is the layout signal. Avoids a
          janky first-frame where percentage cells would wrap. */}
      <SectionFade delay={100}>
        <View style={styles.grid}>
          {cellSize.w > 0
            ? gridDays.map((d, idx) => {
                const inMonth = d.getMonth() === anchor.getMonth();
                const isToday = isSameDate(d, today);
                const isSelected = isSameDate(d, selected);
                const events = eventsByDate[isoDateLocal(d)] ?? [];
                const eventCount = events.length;
                const col = idx % 7;
                const row = Math.floor(idx / 7);
                // Build up to 3 colored dots representing the status mix.
                const dotColors = events.slice(0, 3).map((e) => {
                  switch (e.status) {
                    case "confirmed": return colors.success;
                    case "pending": return colors.warning;
                    case "cancelled":
                    case "no_show": return colors.danger;
                    case "completed": return colors.inkSubtle;
                    default: return colors.brand;
                  }
                });

                return (
                  <PressableCard
                    key={d.toISOString()}
                    variant="outline"
                    padding={0}
                    onPress={() => onPickDay(d)}
                    style={[
                      styles.dayCell,
                      {
                        width: cellSize.w,
                        height: cellSize.h,
                        marginRight: col < 6 ? MONTH_GAP : 0,
                        marginBottom: row < 4 ? MONTH_GAP : 0,
                      },
                      isSelected && styles.dayCellSelected,
                      isToday && !isSelected && styles.dayCellToday,
                    ]}
                  >
                    <AppText
                      variant="bodyStrong"
                      style={{
                        color: isSelected
                          ? colors.inkOnBrand
                          : !inMonth
                            ? colors.inkSubtle
                            : isToday
                              ? colors.brand
                              : colors.ink,
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {d.getDate()}
                    </AppText>
                    {eventCount > 0 ? (
                      <View style={styles.dotRow}>
                        {dotColors.map((c, i) => (
                          <View
                            key={i}
                            style={[
                              styles.dot,
                              { backgroundColor: isSelected ? colors.inkOnBrand : c },
                            ]}
                          />
                        ))}
                        {eventCount > 3 ? (
                          <AppText
                            style={{
                              fontSize: 8,
                              color: isSelected ? colors.inkOnBrand : colors.inkSubtle,
                              marginLeft: 2,
                            }}
                          >
                            +
                          </AppText>
                        ) : null}
                      </View>
                    ) : null}
                  </PressableCard>
                );
              })
            : null}
        </View>
      </SectionFade>

      {/* Selected day */}
      <SectionFade delay={160} style={{ marginTop: spacing.xl }}>
        <SectionHeader
          eyebrow={isSameDate(selected, today) ? "Today" : "Selected"}
          title={formatDateLong(selected)}
          description={
            selectedRows.length === 0
              ? "Nothing scheduled."
              : `${selectedRows.length} booking${selectedRows.length === 1 ? "" : "s"}.`
          }
        />
        {isError ? (
          <Card>
            <AppText variant="bodyStrong" color="danger">Couldn't load calendar</AppText>
          </Card>
        ) : isLoading ? (
          <View style={{ gap: spacing.sm }}>
            <Shimmer.Card height={84} />
            <Shimmer.Card height={84} />
          </View>
        ) : selectedRows.length === 0 ? (
          <Card variant="outline">
            <EmptyState
              icon={<Ionicons name="calendar-outline" size={26} color={colors.brand} />}
              title="Open day"
              body="Nothing on the books for this date yet."
            />
          </Card>
        ) : (
          <DayTimeline rows={selectedRows} onTap={onTapBooking} />
        )}
      </SectionFade>
    </>
  );
}

// ─── Week mode ────────────────────────────────────────────────────

function WeekView({
  today,
  weekStart,
  selected,
  onPickDay,
  eventsByDate,
  selectedRows,
  isLoading,
  isFetching,
  isError,
  onRetry,
  onTapBooking,
}: {
  today: Date;
  weekStart: Date;
  selected: Date;
  onPickDay: (d: Date) => void;
  eventsByDate: Record<string, Appointment[]>;
  selectedRows: Appointment[];
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  onRetry: () => void;
  onTapBooking: (id: string) => void;
}) {
  // Build the 7-day strip from weekStart so the picker matches the
  // calendar week (Sunday→Saturday). Each tile shows weekday + day
  // number and a tiny dot when there are bookings.
  const weekDays = React.useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  // Live "now" tick — drives the red marker. Updates every minute so
  // the marker drifts naturally; we never re-fetch on the tick.
  const [nowTick, setNowTick] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = setInterval(() => setNowTick(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const selectedIsToday = isSameDate(selected, today);
  const totalHours = WEEK_DAY_HOUR_END - WEEK_DAY_HOUR_START;
  const timelineHeight = totalHours * WEEK_HOUR_HEIGHT;

  // Position of NOW marker (only meaningful when selected day is today)
  const nowOffset = React.useMemo(() => {
    const h = nowTick.getHours();
    const m = nowTick.getMinutes();
    return (h - WEEK_DAY_HOUR_START + m / 60) * WEEK_HOUR_HEIGHT;
  }, [nowTick]);
  const nowVisible =
    selectedIsToday && nowOffset >= 0 && nowOffset <= timelineHeight;

  // Auto-scroll to NOW (or 9am if not today) on mount + when selection changes
  const scrollRef = React.useRef<ScrollView>(null);
  React.useEffect(() => {
    if (!scrollRef.current) return;
    const target = selectedIsToday
      ? Math.max(0, nowOffset - 80)
      : Math.max(0, (9 - WEEK_DAY_HOUR_START) * WEEK_HOUR_HEIGHT - 40);
    // Defer one frame so layout has settled.
    const t = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: target, animated: true });
    }, 60);
    return () => clearTimeout(t);
    // We deliberately only re-scroll when the selected date changes,
    // not on every NOW tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.toDateString()]);

  // Horizontal pan on the day-strip area shifts the selected day by ±7
  // days so operators can flip weeks without hunting for a button. We
  // require ≥15px horizontal travel before activating, and fail on any
  // meaningful vertical drift, so this composes cleanly with the
  // timeline ScrollView below.
  const shiftWeek = React.useCallback(
    (delta: number) => {
      const next = addDays(selected, delta);
      void Haptics.selectionAsync().catch(() => {});
      onPickDay(next);
    },
    [selected, onPickDay],
  );
  const weekPan = React.useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-15, 15])
        .failOffsetY([-14, 14])
        .onEnd((e) => {
          if (Math.abs(e.translationX) < 60) return;
          // Swipe right → previous week (matches OS natural-scroll idiom).
          const delta = e.translationX > 0 ? -7 : 7;
          runOnJS(shiftWeek)(delta);
        }),
    [shiftWeek],
  );

  return (
    <>
      {/* ── 7-day strip picker ─────────────────────────────────── */}
      <SectionFade delay={100} style={{ marginTop: spacing.lg }}>
        <GestureDetector gesture={weekPan}>
          <View style={styles.weekStrip}>
            {weekDays.map((d) => {
            const isSel = isSameDate(d, selected);
            const isTod = isSameDate(d, today);
            const count = (eventsByDate[isoDateLocal(d)] ?? []).length;
            return (
              <Pressable
                key={d.toISOString()}
                onPress={() => onPickDay(d)}
                style={[
                  styles.weekStripCell,
                  isSel && styles.weekStripCellSelected,
                  isTod && !isSel && styles.weekStripCellToday,
                ]}
                accessibilityRole="button"
                accessibilityLabel={`${d.toLocaleDateString(undefined, { weekday: "long" })} ${d.getDate()}, ${count} bookings`}
              >
                <AppText
                  variant="micro"
                  style={{
                    color: isSel ? colors.inkOnBrand : colors.inkSubtle,
                    letterSpacing: 0.4,
                  }}
                >
                  {d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 3).toUpperCase()}
                </AppText>
                <AppText
                  variant="bodyStrong"
                  style={{
                    color: isSel
                      ? colors.inkOnBrand
                      : isTod
                        ? colors.brand
                        : colors.ink,
                    fontVariant: ["tabular-nums"],
                    marginTop: 2,
                  }}
                >
                  {d.getDate()}
                </AppText>
                {count > 0 ? (
                  <View
                    style={[
                      styles.weekStripDot,
                      { backgroundColor: isSel ? colors.inkOnBrand : colors.brand },
                    ]}
                  />
                ) : (
                  <View style={styles.weekStripDotPlaceholder} />
                )}
              </Pressable>
            );
          })}
          </View>
        </GestureDetector>
      </SectionFade>

      {/* ── Selected day timeline ──────────────────────────────── */}
      <SectionFade delay={160} style={{ marginTop: spacing.lg }}>
        <View style={styles.weekDayHeader}>
          <View style={{ flex: 1 }}>
            <AppText variant="eyebrow" color="brand">
              {selectedIsToday ? "Today" : "Day view"}
            </AppText>
            <AppText variant="h2" style={{ marginTop: 2 }}>
              {formatDateLong(selected)}
            </AppText>
            <AppText
              variant="small"
              color="muted"
              style={{ marginTop: 2 }}
            >
              {selectedRows.length === 0
                ? "Nothing scheduled."
                : `${selectedRows.length} booking${selectedRows.length === 1 ? "" : "s"} · ${WEEK_DAY_HOUR_START}am – ${WEEK_DAY_HOUR_END - 12}pm window`}
            </AppText>
          </View>
        </View>

        {isError ? (
          <Card>
            <View style={{ alignItems: "center", paddingVertical: spacing.lg, gap: spacing.sm }}>
              <Ionicons name="cloud-offline-outline" size={26} color={colors.danger} />
              <AppText variant="bodyStrong" color="danger">Couldn't load week</AppText>
              <Pressable onPress={onRetry} style={styles.weekRetry}>
                <AppText variant="smallStrong" style={{ color: colors.brand }}>
                  Retry
                </AppText>
              </Pressable>
            </View>
          </Card>
        ) : isLoading ? (
          <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
            <Shimmer.Card height={84} />
            <Shimmer.Card height={84} />
            <Shimmer.Card height={84} />
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            style={[styles.weekTimelineWrap, { maxHeight: 560 }]}
            contentContainerStyle={{
              height: timelineHeight + spacing.lg,
              position: "relative",
            }}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
          >
            {/* Hour rail */}
            {Array.from({ length: totalHours + 1 }, (_, i) => {
              const hour = WEEK_DAY_HOUR_START + i;
              const top = i * WEEK_HOUR_HEIGHT;
              const label =
                hour === 12
                  ? "12pm"
                  : hour === 0
                    ? "12am"
                    : hour < 12
                      ? `${hour}am`
                      : `${hour - 12}pm`;
              return (
                <View key={hour} style={[styles.weekHourRow, { top }]}>
                  <AppText
                    variant="micro"
                    style={styles.weekHourLabel}
                  >
                    {label}
                  </AppText>
                  <View style={styles.weekHourLine} />
                </View>
              );
            })}

            {/* Booking cards — overlap-aware lane layout. We compute lane
                geometry in pixels rather than percentage so RN's strict
                style typings stay happy. Screen width is the simple
                upper bound; lanes split the available timeline column. */}
            {(() => {
              const lanes = assignOverlapLanes(selectedRows);
              const screenW = Dimensions.get("window").width;
              // Timeline wrapper has horizontal padding (spacing.sm × 2)
              // and the 46px hour rail on the left; right gutter is 8px.
              const screenPad = spacing.md * 2; // ScreenContainer side pad
              const timelineInnerW = Math.max(
                240,
                screenW - screenPad - 46 /* rail */ - 8 /* right gutter */,
              );
              return selectedRows.map((row) => {
                const start = new Date(row.startAt);
                const end = new Date(row.endAt);
                // Position by the VIEWER-tz minute-of-day (from the server label)
                // so the lane matches the displayed time — never device-local.
                const startMin = apptStartMinutes(row);
                const rawMin = Math.round((end.getTime() - start.getTime()) / 60_000);
                const duration = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 30;
                const top =
                  (startMin / 60 - WEEK_DAY_HOUR_START) * WEEK_HOUR_HEIGHT;
                if (top < -WEEK_HOUR_HEIGHT || top > timelineHeight) return null;
                const height = Math.max(
                  28,
                  (duration / 60) * WEEK_HOUR_HEIGHT - 4,
                );
                const tone =
                  row.status === "confirmed"
                    ? colors.success
                    : row.status === "pending"
                      ? colors.warning
                      : row.status === "cancelled" || row.status === "no_show"
                        ? colors.danger
                        : row.status === "completed"
                          ? colors.inkSubtle
                          : colors.brand;
                const timeLabel = apptTime(row);
                const lane = lanes.get(row.id) ?? { laneIndex: 0, clusterLanes: 1 };
                const totalLanes = Math.max(1, lane.clusterLanes);
                const laneWidth = timelineInnerW / totalLanes;
                const leftPx = 46 + lane.laneIndex * laneWidth;
                const widthPx = Math.max(60, laneWidth - 2);
                return (
                  <Pressable
                    key={row.id}
                    onPress={() => {
                      void Haptics.selectionAsync().catch(() => {});
                      onTapBooking(row.id);
                    }}
                    style={[
                      styles.weekEvent,
                      {
                        top,
                        height,
                        left: leftPx,
                        right: undefined,
                        width: widthPx,
                        borderLeftColor: tone,
                        backgroundColor:
                          row.status === "cancelled" || row.status === "no_show"
                            ? colors.surfaceInset
                            : colors.surface,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`${timeLabel} ${row.clientName} ${row.serviceName}`}
                  >
                    <AppText
                      variant="smallStrong"
                      numberOfLines={1}
                      style={{ color: colors.ink, fontVariant: ["tabular-nums"] }}
                    >
                      {timeLabel} · {row.clientName}
                    </AppText>
                    <AppText
                      variant="micro"
                      color="muted"
                      numberOfLines={1}
                      style={{ marginTop: 1 }}
                    >
                      {row.serviceName}
                      {row.staffName ? ` · ${row.staffName}` : ""}
                    </AppText>
                  </Pressable>
                );
              });
            })()}

            {/* NOW marker — pulse the dot so "right now" reads at a glance */}
            {nowVisible ? (
              <PulsingNowMarker top={nowOffset} />
            ) : null}
          </ScrollView>
        )}

        {/* Subtle refreshing footer when we're refetching but already have data */}
        {isFetching && !isLoading ? (
          <View style={{ alignItems: "center", paddingTop: spacing.sm }}>
            <AppText variant="micro" color="subtle">
              Updating week…
            </AppText>
          </View>
        ) : null}
      </SectionFade>
    </>
  );
}

// referenced to keep Platform import used (RN web stripping warning)
void Platform;

// ─── PulsingNowMarker ─────────────────────────────────────────────

function PulsingNowMarker({ top }: { top: number }) {
  // Two shared values: a calm continuous pulse on the dot's outer ring,
  // and a subtle opacity drift on the bar itself so the marker reads as
  // "live" without feeling busy.
  const pulse = useSharedValue(0);
  React.useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse]);

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.6 * pulse.value }],
    opacity: 0.55 * (1 - pulse.value),
  }));
  const barStyle = useAnimatedStyle(() => ({
    opacity: 0.75 + 0.25 * pulse.value,
  }));

  return (
    <View
      pointerEvents="none"
      style={[styles.nowLine, { top }]}
    >
      <View style={styles.nowDotWrap}>
        <Animated.View style={[styles.nowRing, ringStyle]} />
        <View style={styles.nowDot} />
      </View>
      <Animated.View style={[styles.nowBar, barStyle]} />
    </View>
  );
}

// ─── Day timeline (used inside Month + Agenda) ────────────────────

function DayTimeline({
  rows,
  onTap,
}: {
  rows: Appointment[];
  onTap: (id: string) => void;
}) {
  return (
    <View style={{ gap: spacing.sm }}>
      {rows.map((row) => (
        <AppointmentRow key={row.id} appt={row} onPress={() => onTap(row.id)} />
      ))}
    </View>
  );
}

// ─── Agenda mode ─────────────────────────────────────────────────

function AgendaView({
  today,
  agendaEnd,
  eventsByDate,
  isLoading,
  isError,
  onTapBooking,
}: {
  today: Date;
  agendaEnd: Date;
  eventsByDate: Record<string, Appointment[]>;
  isLoading: boolean;
  isError: boolean;
  onTapBooking: (id: string) => void;
}) {
  const days = React.useMemo(() => {
    const out: { date: Date; rows: Appointment[] }[] = [];
    for (let d = new Date(today); d <= agendaEnd; d = addDays(d, 1)) {
      const k = isoDateLocal(d);
      const rows = eventsByDate[k] ?? [];
      if (rows.length > 0) out.push({ date: new Date(d), rows });
    }
    return out;
  }, [today, agendaEnd, eventsByDate]);

  if (isError) {
    return (
      <SectionFade delay={120} style={{ marginTop: spacing.lg }}>
        <Card>
          <AppText variant="bodyStrong" color="danger">Couldn't load agenda</AppText>
        </Card>
      </SectionFade>
    );
  }

  if (isLoading) {
    return (
      <SectionFade delay={120} style={{ marginTop: spacing.lg }}>
        <View style={{ gap: spacing.md }}>
          <Shimmer.Card height={84} />
          <Shimmer.Card height={84} />
          <Shimmer.Card height={84} />
        </View>
      </SectionFade>
    );
  }

  if (days.length === 0) {
    return (
      <SectionFade delay={120} style={{ marginTop: spacing.xl }}>
        <Card variant="outline">
          <EmptyState
            icon={<Ionicons name="calendar-clear-outline" size={26} color={colors.brand} />}
            title="A clear two weeks ahead"
            body="Once customers book, they'll line up here in chronological order."
          />
        </Card>
      </SectionFade>
    );
  }

  return (
    <View style={{ marginTop: spacing.xl, gap: spacing.xl }}>
      {days.map((d, idx) => (
        <SectionFade key={d.date.toISOString()} delay={120 + idx * 50}>
          <AgendaDayGroup
            date={d.date}
            rows={d.rows}
            isToday={isSameDate(d.date, today)}
            onTap={onTapBooking}
          />
        </SectionFade>
      ))}
    </View>
  );
}

function AgendaDayGroup({
  date,
  rows,
  isToday,
  onTap,
}: {
  date: Date;
  rows: Appointment[];
  isToday: boolean;
  onTap: (id: string) => void;
}) {
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  const day = date.getDate();
  const monthName = date.toLocaleDateString(undefined, { month: "short" });
  return (
    <View style={styles.agendaGroup}>
      {/* Left rail — date pill */}
      <View style={styles.agendaRail}>
        <View style={[styles.agendaDatePill, isToday && styles.agendaDatePillToday]}>
          <AppText
            variant="micro"
            style={{
              color: isToday ? colors.inkOnBrand : colors.inkSubtle,
              letterSpacing: 0.4,
            }}
          >
            {weekday.toUpperCase()}
          </AppText>
          <AppText
            variant="h2"
            style={{
              color: isToday ? colors.inkOnBrand : colors.ink,
              fontVariant: ["tabular-nums"],
              marginTop: 2,
            }}
          >
            {day}
          </AppText>
          <AppText
            variant="micro"
            style={{
              color: isToday ? colors.inkOnBrand : colors.inkMuted,
              letterSpacing: 0.4,
            }}
          >
            {monthName.toUpperCase()}
          </AppText>
        </View>
        {/* Vertical connector */}
        <View style={styles.agendaConnector} />
      </View>

      {/* Bookings column */}
      <View style={{ flex: 1, gap: spacing.sm }}>
        {rows.map((row) => (
          <AppointmentRow key={row.id} appt={row} onPress={() => onTap(row.id)} />
        ))}
      </View>
    </View>
  );
}

// ─── NavBtn ──────────────────────────────────────────────────────

function NavBtn({
  icon,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
}) {
  return (
    <PressableCard
      variant="outline"
      padding={0}
      onPress={onPress}
      style={styles.navBtn}
    >
      <Ionicons name={icon} size={18} color={colors.ink} />
    </PressableCard>
  );
}

// ─── Styles ──────────────────────────────────────────────────────

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  navBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.sm,
  },
  weekRow: {
    flexDirection: "row",
    // Tightened from spacing.sm — visually pairs the row header with
    // the grid below it without losing the breathing room.
    marginBottom: 6,
  },
  weekLabel: {
    letterSpacing: 0.5,
  },
  monthHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  monthHeaderCenter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  todayPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.brandSubtle,
  },
  /** Wrap container — sizing is driven entirely by per-cell explicit
   *  pixel widths + marginRight/marginBottom. No `gap` here because
   *  RN's `gap` + percentage widths mis-renders Saturday on certain
   *  screen sizes (the original bug). */
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  /** Width + height are applied inline from the measured container.
   *  Keep the visual chrome here — radius, alignment, gap-between-
   *  number-and-dots, vertical padding. */
  dayCell: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    gap: 3,
    paddingVertical: spacing.xs,
  },
  dayCellToday: {
    borderColor: colors.brand,
    borderWidth: 1.5,
  },
  dayCellSelected: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  dotRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  agendaGroup: {
    flexDirection: "row",
    gap: spacing.md,
  },
  agendaRail: {
    width: 62,
    alignItems: "center",
  },
  agendaDatePill: {
    width: 62,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceInset,
    alignItems: "center",
    justifyContent: "center",
  },
  agendaDatePillToday: {
    backgroundColor: colors.brand,
  },
  agendaConnector: {
    flex: 1,
    width: 2,
    backgroundColor: colors.borderSubtle,
    marginTop: 6,
    borderRadius: 1,
  },
  // ── Week view ─────────────────────────────────────────────────
  weekStrip: {
    flexDirection: "row",
    gap: 6,
  },
  weekStripCell: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: 2,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  weekStripCellToday: {
    borderColor: colors.brand,
    borderWidth: 1.5,
  },
  weekStripCellSelected: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  weekStripDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginTop: 6,
  },
  weekStripDotPlaceholder: {
    width: 5,
    height: 5,
    marginTop: 6,
  },
  weekDayHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginBottom: spacing.md,
  },
  weekTimelineWrap: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    overflow: "hidden",
  },
  weekHourRow: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    height: 1,
  },
  weekHourLabel: {
    width: 40,
    color: colors.inkSubtle,
    letterSpacing: 0.3,
    textAlign: "right",
    paddingRight: 6,
    fontVariant: ["tabular-nums"],
  },
  weekHourLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
  },
  weekEvent: {
    position: "absolute",
    left: 46,
    right: spacing.sm,
    borderRadius: radius.md,
    borderLeftWidth: 3,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    ...shadows.sm,
  },
  weekRetry: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.brandSubtle,
  },
  // NOW marker — red horizontal line with a dot on the hour rail
  nowLine: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    height: 0,
  },
  nowDotWrap: {
    marginLeft: 42,
    width: 12,
    height: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  nowRing: {
    position: "absolute",
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.danger,
  },
  nowDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.danger,
  },
  nowBar: {
    flex: 1,
    height: 2,
    backgroundColor: colors.danger,
    borderRadius: 1,
    marginLeft: 2,
    opacity: 0.85,
  },
});
