/**
 * ScreenContainer — outer wrapper for every screen.
 *
 * Standardizes:
 *   • SafeAreaView with edges configurable per screen
 *   • Background color
 *   • Horizontal + vertical gutter
 *   • Optional ScrollView vs plain View
 *
 * If a screen needs full-bleed (e.g. calendar grid), pass
 * `padding={false}` and handle paddings internally.
 */

import * as React from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewProps,
  type ViewProps,
} from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";

import { colors, layout } from "@/theme";

type Props = {
  children: React.ReactNode;
  /** Disable the SafeAreaView wrap when a parent handles it. */
  edges?: Edge[];
  /** Wrap children in a ScrollView. Default false — most screens have their own list. */
  scrollable?: boolean;
  /** Whether to apply default horizontal+vertical padding. */
  padding?: boolean;
  /** Pull-to-refresh control passthrough. */
  refreshControl?: ScrollViewProps["refreshControl"];
  /** Add keyboard avoidance — set on screens with forms (login). */
  keyboardAvoiding?: boolean;
  contentContainerStyle?: ScrollViewProps["contentContainerStyle"];
  /**
   * Viewport-anchored overlay — rendered as an absolute-positioned sibling
   * of the inner content (NOT a child of the ScrollView). Use this for
   * elements that must stay pinned regardless of scroll position: FABs,
   * snackbars, persistent action sheets, etc.
   *
   * Why this matters: when `scrollable=true`, a child with
   * `position: absolute` would normally anchor to the ScrollView's
   * contentContainer, which means it scrolls AWAY with the content. Passing
   * it via `floatingOverlay` instead makes it anchor to the SafeAreaView,
   * so it stays glued to the viewport.
   *
   * The overlay wrapper uses `pointerEvents="box-none"` so empty regions
   * of the overlay still pass touches through to the underlying scroll
   * content — only the overlay's actual children intercept taps.
   */
  floatingOverlay?: React.ReactNode;
} & Omit<ViewProps, "children">;

export function ScreenContainer({
  children,
  edges = ["top"],
  scrollable = false,
  padding = true,
  refreshControl,
  keyboardAvoiding = false,
  contentContainerStyle,
  floatingOverlay,
  style,
  ...rest
}: Props) {
  const padStyle = padding ? styles.padded : null;

  const inner = scrollable ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
        styles.scrollContent,
        padStyle,
        // Reserve room so a viewport-anchored FAB never overlaps the last row
        // of content when scrolled to the bottom (screenshot feedback).
        floatingOverlay ? styles.fabClearance : null,
        contentContainerStyle,
      ]}
      refreshControl={refreshControl}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, padStyle, style]} {...rest}>
      {children}
    </View>
  );

  const wrapped = keyboardAvoiding ? (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {inner}
    </KeyboardAvoidingView>
  ) : (
    inner
  );

  return (
    <SafeAreaView style={styles.root} edges={edges}>
      {/* Wrap inner + overlay in a relatively-positioned flex container so
          floating children can use `position: absolute; bottom: X` and
          anchor to this frame (viewport-sized) instead of the scroll
          content. */}
      <View style={styles.flex}>
        {wrapped}
        {floatingOverlay ? (
          <View
            pointerEvents="box-none"
            style={StyleSheet.absoluteFill}
          >
            {floatingOverlay}
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.surfaceSubtle,
  },
  flex: { flex: 1 },
  padded: {
    paddingHorizontal: layout.screenPaddingX,
    paddingVertical: layout.screenPaddingY,
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: layout.screenPaddingY * 2,
  },
  // Extra bottom room when a FAB overlay is present (FAB ≈ 60dp + ~76dp offset).
  fabClearance: {
    paddingBottom: 120,
  },
});
