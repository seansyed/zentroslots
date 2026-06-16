/**
 * /share — "Share booking link" modal.
 *
 * Replaces the old Home "Share" quick action that wrongly opened Settings. Shows
 * the signed-in user's REAL, already-existing public booking links built from
 * authoritative slugs (profile.tenant.slug + service.slug) + the public base URL
 * — never invented, never carrying internal IDs/tokens:
 *
 *   • USER / WORKSPACE PAGE  → {base}/u/{tenantSlug}      (lists active services)
 *   • DIRECT SERVICE LINKS   → {base}/u/{tenantSlug}/{serviceSlug}  (active only)
 *
 * Each link gets Copy / Share / Open / QR. If the workspace has no public slug
 * or is inactive, we show a focused setup state (finish on the web dashboard)
 * and emit NO link rather than a dead URL.
 */

import * as React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { IconButton } from "@/components/ui/IconButton";
import { LinkShareCard } from "@/components/ui/LinkShareCard";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { useProfile } from "@/hooks/useProfile";
import { useServices } from "@/hooks/useServices";
import { env } from "@/lib/env";
import { hasSlug, serviceBookingUrl, tenantBookingUrl } from "@/lib/bookingLinks";
import { openLink } from "@/lib/share";
import { colors, layout, spacing } from "@/theme";

import type { Service } from "@/api/services";

function priceLabel(s: Service): string {
  const parts = [`${s.durationMinutes}m`];
  if (s.price && s.price > 0) parts.push(`$${(s.price / 100).toFixed(0)}`);
  return parts.join(" · ");
}

export default function ShareScreen() {
  const router = useRouter();
  const profileQ = useProfile();
  const servicesQ = useServices();

  const profile = profileQ.data;
  const tenant = profile?.tenant ?? null;
  // Public availability gate — mirrors app/u/[slug]/page.tsx (404s inactive
  // tenants), so a link would dead-end otherwise.
  const publicReady = Boolean(tenant && hasSlug(tenant.slug) && tenant.active !== false);

  const tenantUrl = publicReady ? tenantBookingUrl(env.apiBaseUrl, tenant!.slug) : null;

  // Only active services with a slug are shareable (paused/inactive never).
  const shareableServices = React.useMemo<Service[]>(() => {
    if (!publicReady) return [];
    return (servicesQ.data?.active ?? []).filter((s) => hasSlug(s.slug));
  }, [publicReady, servicesQ.data]);

  const loading = profileQ.isLoading || (publicReady && servicesQ.isLoading && !servicesQ.data);

  return (
    <ScreenContainer padding={false} edges={["top"]}>
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
          Share booking link
        </AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {loading ? (
          <View style={{ gap: spacing.md }}>
            <Shimmer.Card height={150} />
            <Shimmer.Card height={120} />
            <Shimmer.Card height={120} />
          </View>
        ) : !publicReady ? (
          // ── Focused setup state — no dead links ───────────────────
          <SectionFade>
            <Card variant="outline" style={{ alignItems: "center", paddingVertical: spacing.xl }}>
              <View style={styles.setupIcon}>
                <Ionicons name="globe-outline" size={26} color={colors.brand} />
              </View>
              <AppText variant="h4" align="center" style={{ marginTop: spacing.md }}>
                Your booking page isn't live yet
              </AppText>
              <AppText
                variant="small"
                color="muted"
                align="center"
                style={{ marginTop: spacing.xs, paddingHorizontal: spacing.lg }}
              >
                {tenant && tenant.active === false
                  ? "Your workspace is currently inactive, so its public booking page won't load. Reactivate it on the web dashboard, then share from here."
                  : "Finish setting up your public booking page on the web dashboard. Once it's live, your shareable links appear here automatically."}
              </AppText>
              <Button
                label="Open web dashboard"
                variant="primary"
                size="md"
                style={{ marginTop: spacing.lg }}
                leftIcon={<Ionicons name="open-outline" size={16} color={colors.inkOnBrand} />}
                onPress={() => void openLink(`${env.apiBaseUrl.replace(/\/+$/, "")}/dashboard`)}
              />
            </Card>
          </SectionFade>
        ) : (
          <>
            {/* ── Workspace / user booking page ─────────────────────── */}
            <SectionFade>
              <AppText variant="eyebrow" color="brand" style={{ marginBottom: spacing.sm }}>
                Your booking page
              </AppText>
              <LinkShareCard
                title={tenant!.name}
                subtitle="All your bookable services"
                url={tenantUrl!}
                defaultShowQr
              />
            </SectionFade>

            {/* ── Direct service links ──────────────────────────────── */}
            <SectionFade delay={80} style={{ marginTop: spacing.xl }}>
              <AppText variant="eyebrow" color="brand" style={{ marginBottom: spacing.sm }}>
                Direct service links
              </AppText>
              {shareableServices.length === 0 ? (
                <Card variant="outline">
                  <AppText
                    variant="small"
                    color="muted"
                    align="center"
                    style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.md }}
                  >
                    No active services to share yet. Activate a service (Settings → Services)
                    and it'll get its own shareable link here.
                  </AppText>
                </Card>
              ) : (
                <View style={{ gap: spacing.md }}>
                  {shareableServices.map((s) => (
                    <LinkShareCard
                      key={s.id}
                      title={s.name}
                      subtitle={priceLabel(s)}
                      url={serviceBookingUrl(env.apiBaseUrl, tenant!.slug, s.slug as string)}
                    />
                  ))}
                </View>
              )}
            </SectionFade>
          </>
        )}

        <View style={{ height: spacing["3xl"] }} />
      </ScrollView>
    </ScreenContainer>
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
  setupIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.brandSubtle,
  },
});
