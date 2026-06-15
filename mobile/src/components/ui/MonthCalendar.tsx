/**
 * MonthCalendar — full-month date picker with horizon-aware navigation.
 *
 * Replaces the old 14-day horizontal strip in New Booking. Shows a real
 * month grid with prev/next-month chevrons, a Today shortcut, disabled past
 * days, and disabled days beyond the booking horizon (service.maxAdvanceDays).
 * Phone + tablet friendly (7-column grid scales to width). All date math is
 * Hermes-safe (src/lib/dates.ts) — no Intl timezone formatting.
 */

import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { AppText } from "@/components/ui/Text";
import {
  addMonths,
  isBeforeDay,
  isSameDay,
  isSameMonth,
  monthLabel,
  monthMatrix,
  startOfMonth,
  weekdayLabels,
} from "@/lib/dates";
import { colors, radius, spacing } from "@/theme";

type Props = {
  selectedDate: Date;
  onSelectDate: (d: Date) => void;
  /** Earliest selectable day (inclusive) — usually today. */
  minDate: Date;
  /** Latest selectable day (inclusive) — usually today + horizon. Null = open. */
  maxDate?: Date | null;
  today: Date;
  weekStartsOn?: 0 | 1;
};

export function MonthCalendar({
  selectedDate,
  onSelectDate,
  minDate,
  maxDate,
  today,
  weekStartsOn = 0,
}: Props) {
  const [viewMonth, setViewMonth] = React.useState<Date>(() => startOfMonth(selectedDate));

  // Keep the visible month in sync if the selection jumps elsewhere
  // (e.g. "Find next opening" lands in a future month).
  React.useEffect(() => {
    if (!isSameMonth(viewMonth, selectedDate)) setViewMonth(startOfMonth(selectedDate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  const weeks = React.useMemo(() => monthMatrix(viewMonth, weekStartsOn), [viewMonth, weekStartsOn]);
  const labels = React.useMemo(() => weekdayLabels(weekStartsOn), [weekStartsOn]);

  const canPrev = !isSameMonth(viewMonth, minDate) && !isBeforeDay(viewMonth, startOfMonth(minDate));
  const canNext = !maxDate || isBeforeDay(viewMonth, startOfMonth(maxDate));

  function step(n: number) {
    void Haptics.selectionAsync().catch(() => {});
    setViewMonth((m) => addMonths(m, n));
  }

  function dayDisabled(d: Date): boolean {
    if (isBeforeDay(d, minDate)) return true;
    if (maxDate && isBeforeDay(maxDate, d)) return true;
    return false;
  }

  return (
    <View style={styles.root}>
      {/* Header: ‹  June 2026  ›  + Today */}
      <View style={styles.header}>
        <Pressable
          onPress={() => canPrev && step(-1)}
          disabled={!canPrev}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          style={[styles.navBtn, !canPrev && styles.navBtnDisabled]}
        >
          <Ionicons name="chevron-back" size={18} color={canPrev ? colors.ink : colors.inkSubtle} />
        </Pressable>

        <View style={styles.headerCenter}>
          <AppText variant="bodyStrong">{monthLabel(viewMonth)}</AppText>
        </View>

        <View style={styles.headerRight}>
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync().catch(() => {});
              setViewMonth(startOfMonth(today));
              onSelectDate(today);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Jump to today"
            style={styles.todayBtn}
          >
            <AppText variant="smallStrong" style={{ color: colors.brand }}>Today</AppText>
          </Pressable>
          <Pressable
            onPress={() => canNext && step(1)}
            disabled={!canNext}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Next month"
            style={[styles.navBtn, !canNext && styles.navBtnDisabled]}
          >
            <Ionicons name="chevron-forward" size={18} color={canNext ? colors.ink : colors.inkSubtle} />
          </Pressable>
        </View>
      </View>

      {/* Weekday labels */}
      <View style={styles.weekRow}>
        {labels.map((l) => (
          <View key={l} style={styles.cell}>
            <AppText variant="micro" color="subtle" style={{ letterSpacing: 0.3 }}>
              {l.toUpperCase()}
            </AppText>
          </View>
        ))}
      </View>

      {/* Day grid */}
      {weeks.map((week, wi) => (
        <View key={wi} style={styles.weekRow}>
          {week.map(({ date, inMonth }) => {
            const disabled = dayDisabled(date);
            const selected = isSameDay(date, selectedDate);
            const isToday = isSameDay(date, today);
            return (
              <Pressable
                key={date.toISOString()}
                disabled={disabled}
                onPress={() => {
                  void Haptics.selectionAsync().catch(() => {});
                  onSelectDate(date);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled }}
                accessibilityLabel={date.toDateString()}
                style={styles.cell}
              >
                <View style={[styles.dayPill, selected && styles.dayPillSelected]}>
                  <AppText
                    variant="small"
                    style={{
                      color: selected
                        ? colors.inkOnBrand
                        : disabled
                          ? colors.inkSubtle
                          : inMonth
                            ? colors.ink
                            : colors.inkSubtle,
                      fontWeight: selected || isToday ? "700" : "400",
                      opacity: disabled ? 0.4 : inMonth ? 1 : 0.5,
                    }}
                  >
                    {date.getDate()}
                  </AppText>
                  {isToday && !selected ? <View style={styles.todayDot} /> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
  },
  headerCenter: { flex: 1, alignItems: "center" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  navBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: "center", justifyContent: "center",
    backgroundColor: colors.surfaceInset,
  },
  navBtnDisabled: { opacity: 0.4 },
  todayBtn: { paddingHorizontal: spacing.sm, paddingVertical: 4 },
  weekRow: { flexDirection: "row" },
  cell: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 3 },
  dayPill: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: "center", justifyContent: "center",
  },
  dayPillSelected: { backgroundColor: colors.brand },
  todayDot: {
    position: "absolute", bottom: 5,
    width: 4, height: 4, borderRadius: 2, backgroundColor: colors.brand,
  },
});
