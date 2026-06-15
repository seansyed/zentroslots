/**
 * IntakeFields — dynamic renderer for a service's intake form on mobile.
 *
 * Mirrors the web renderer (components/booking/IntakeStep.tsx) across all 12
 * canonical field types, using RN controls + the app's design system. It is a
 * pure controlled component: the parent owns `values`/`errors` and gets changes
 * via `onChange(key, value)`. No business logic, no network — the server stays
 * authoritative for validation.
 *
 * Field order is taken as-given (the API already sorts by `order`). Required
 * fields are marked with a "*". Help text + per-field errors render below each
 * control.
 */

import * as React from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";

import { Input } from "./Input";
import { AppText } from "./Text";
import { colors, radius, spacing } from "@/theme";

import type { IntakeField } from "@/api/intake";

export function IntakeFields({
  fields,
  values,
  errors,
  onChange,
}: {
  fields: IntakeField[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <View style={{ gap: spacing.lg }}>
      {fields.map((field) => (
        <FieldRow
          key={field.key}
          field={field}
          value={values[field.key]}
          error={errors[field.key]}
          onChange={(v) => onChange(field.key, v)}
        />
      ))}
    </View>
  );
}

function FieldLabel({ field }: { field: IntakeField }) {
  return (
    <AppText variant="smallStrong" color="muted" style={styles.label}>
      {field.label.toUpperCase()}
      {field.required ? <AppText style={{ color: colors.danger }}> *</AppText> : null}
    </AppText>
  );
}

function FieldFooter({ field, error }: { field: IntakeField; error?: string }) {
  if (error) {
    return (
      <AppText variant="caption" color="danger" style={styles.footer}>
        {error}
      </AppText>
    );
  }
  if (field.helpText) {
    return (
      <AppText variant="caption" color="subtle" style={styles.footer}>
        {field.helpText}
      </AppText>
    );
  }
  return null;
}

function FieldRow({
  field,
  value,
  error,
  onChange,
}: {
  field: IntakeField;
  value: unknown;
  error?: string;
  onChange: (v: unknown) => void;
}) {
  // ── Text-like inputs reuse the shared Input (which renders its own label +
  //    error). The rest render a label/footer around a custom control. ──
  switch (field.type) {
    case "short_text":
    case "long_text":
    case "email":
    case "phone":
    case "url":
    case "number":
    case "date": {
      const keyboardType =
        field.type === "email"
          ? "email-address"
          : field.type === "phone"
            ? "phone-pad"
            : field.type === "number"
              ? "numeric"
              : field.type === "url"
                ? "url"
                : field.type === "date"
                  ? "numbers-and-punctuation"
                  : "default";
      const placeholder =
        field.placeholder ?? (field.type === "date" ? "YYYY-MM-DD" : undefined);
      return (
        <Input
          label={`${field.label}${field.required ? " *" : ""}`}
          value={value == null ? "" : String(value)}
          onChangeText={onChange}
          error={error ?? null}
          hint={!error ? field.helpText : undefined}
          placeholder={placeholder}
          keyboardType={keyboardType as never}
          autoCapitalize={field.type === "email" || field.type === "url" ? "none" : "sentences"}
          autoCorrect={field.type === "email" || field.type === "url" ? false : undefined}
          multiline={field.type === "long_text"}
        />
      );
    }

    case "select":
    case "radio": {
      const selected = typeof value === "string" ? value : null;
      return (
        <View>
          <FieldLabel field={field} />
          <View style={styles.chipWrap}>
            {(field.options ?? []).map((opt) => {
              const active = selected === opt;
              return (
                <Pressable
                  key={opt}
                  onPress={() => onChange(active ? "" : opt)}
                  style={[styles.chip, active && styles.chipActive]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`${field.label}: ${opt}`}
                >
                  <AppText
                    variant="small"
                    style={{ color: active ? colors.inkOnBrand : colors.ink }}
                  >
                    {opt}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
          <FieldFooter field={field} error={error} />
        </View>
      );
    }

    case "multi_select": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <View>
          <FieldLabel field={field} />
          <View style={styles.chipWrap}>
            {(field.options ?? []).map((opt) => {
              const active = selected.includes(opt);
              return (
                <Pressable
                  key={opt}
                  onPress={() =>
                    onChange(
                      active ? selected.filter((s) => s !== opt) : [...selected, opt],
                    )
                  }
                  style={[styles.chip, active && styles.chipActive]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: active }}
                  accessibilityLabel={`${field.label}: ${opt}`}
                >
                  <AppText
                    variant="small"
                    style={{ color: active ? colors.inkOnBrand : colors.ink }}
                  >
                    {opt}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
          <FieldFooter field={field} error={error} />
        </View>
      );
    }

    case "boolean":
    case "consent": {
      const checked = value === true;
      const text =
        field.type === "consent" ? field.consentText ?? field.label : field.label;
      return (
        <View>
          <Pressable
            onPress={() => onChange(!checked)}
            style={styles.checkRow}
            accessibilityRole="checkbox"
            accessibilityState={{ checked }}
            accessibilityLabel={text}
          >
            <View style={[styles.checkbox, checked && styles.checkboxOn]}>
              {checked ? (
                <AppText style={{ color: colors.inkOnBrand, fontSize: 13, fontWeight: "700" }}>
                  ✓
                </AppText>
              ) : null}
            </View>
            <View style={{ flex: 1 }}>
              <AppText variant="small" style={{ color: colors.ink }}>
                {text}
                {field.required ? <AppText style={{ color: colors.danger }}> *</AppText> : null}
              </AppText>
              {field.type === "consent" && field.consentLinkUrl ? (
                <AppText
                  variant="caption"
                  style={{ color: colors.brand, marginTop: 2 }}
                  onPress={() => {
                    if (field.consentLinkUrl) {
                      void Linking.openURL(field.consentLinkUrl).catch(() => {});
                    }
                  }}
                >
                  {field.consentLinkLabel ?? "Read more"}
                </AppText>
              ) : null}
            </View>
          </Pressable>
          <FieldFooter field={field} error={error} />
        </View>
      );
    }

    default:
      return null;
  }
}

const styles = StyleSheet.create({
  label: {
    marginBottom: spacing.xs,
    letterSpacing: 0.3,
  },
  footer: {
    marginTop: spacing.xs,
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceInset,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  chipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    marginTop: 1,
  },
  checkboxOn: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
});
