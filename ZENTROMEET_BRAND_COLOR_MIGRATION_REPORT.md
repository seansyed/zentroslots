# ZentroMeet Brand-Color Migration → #2563EB

**Date:** 2026-06-16 · **Scope:** visual platform-brand only (no logic/booking/auth/billing/schema changes). Android **versionCode 13→14**, iOS **buildNumber 9→10**.

## Old → new
- **Old platform primary:** `#359df3` (+ derived shades `#1f8de8` hover, `#ecf6ff`/`#ebf5ff` subtle, `#5cb1f5` dark, `#2789e0`/`#1d7bd1` mobile hover/pressed) and ~200 `rgba(53,157,243,*)` utilities.
- **New platform primary:** **`#2563EB`** (Tailwind blue 600). `#2563eb` was already partially adopted (DB tenant default, platform emails, `DEFAULT_ACCENT`) — those were left as-is.

## Canonical palette (anchored at 600)
`50 #EFF6FF · 100 #DBEAFE · 200 #BFDBFE · 300 #93C5FD · 400 #60A5FA · 500 #3B82F6 · 600 #2563EB · 700 #1D4ED8 · 800 #1E40AF · 900 #1E3A8A · 950 #172554`. rgba: `37,99,235` (600), `59,130,246` (500 dark).

## Web — central tokens
`app/globals.css` is the single source (Tailwind `brand.*` → `var(--color-accent*)`): light `--color-accent #2563EB`, hover `#1D4ED8`, subtle `#EFF6FF`, ring `rgba(37,99,235,.18)`, `--shadow-glow`; dark `--color-accent #3B82F6`, hover `#2563EB`, ring/glow `rgba(59,130,246,.28)`; brand animations (`zm-pulse-glow`, `zm-border-sweep`). `tailwind.config.ts` gradient rgba updated. All other web brand usage (~50 component/page files) was the old brand hex / `rgb(53,157,243)` in inline gradients/shadows/rings → migrated to the new values via a scoped literal replace of only `#359df3` and `53,157,243` (uniquely the platform brand). Platform logo SVGs (`public/zentromeet-mark.svg`, `zentromeet-wordmark.svg`, `MarketingNav` inline mark) + public-booking page brand marks updated.

## Public website / Web dashboard
All platform CTAs, active-nav, focus rings, selected cards/slots, badges, KPI glows, logos now resolve to `#2563EB` (light) / `#3B82F6` (dark) through the central token. Dashboard always uses the platform token (never tenant).

## Public booking fallback + tenant overrides
Two-tier system confirmed intact: tenant `primaryColor` is injected as `style={{"--color-accent": tenantColor}}` / passed as `accentColor` on `/u/[slug]` + `/embed`, with the platform color only the **fallback**. The migration only changed the fallback literals (`"#359df3" → "#2563EB"`) in the override paths (TenantIntelligenceClient, EmbedSnippetsClient, IntegrationsClient, IntakeStep, embed/demo, public/embed/v1.js, notifyReconnect). **Stored tenant colors are never touched**; a tenant with a custom color still renders it; the `/^#[0-9a-fA-F]{6}$/` guard still gates invalid values to the new fallback. DB default `tenants.primaryColor` was already `#2563eb`.

## Mobile theme
`mobile/src/theme/colors.ts` (central): `brand #2563EB`, `brandHover #1D4ED8`, `brandPressed #1E40AF`, `brandSubtle #EFF6FF`, `brandAccent #2563EB`, `info`/`infoSubtle`/`infoInk` retuned. `shadows.ts` brandGlow/brandHalo + `usePushNotifications` LED tint → `#2563EB`. The ~24 components that consume `colors.brand*` inherit automatically (no per-file edits). The bundled logo PNG is untouched.

## Android / iOS / iPad
`mobile/app.json`: `primaryColor`, `android.adaptiveIcon.backgroundColor`, and `expo-notifications` color → `#2563EB`; `splash.backgroundColor` kept `#f5faff` (intentional light neutral); PNG artwork untouched. `expo prebuild --clean` regenerates `android/.../colors.xml` (colorPrimary + adaptive-icon background) + the notification color from app.json — verified in the gate. iOS/iPad use the same RN theme + `primaryColor` tint (shared theme → iPad inherits).

## Emails / PDFs / Charts
Platform emails already used `#2563eb` (verify-only: `lib/email.ts`, forgot-password, admin-notify). No PDF/invoice or OG-image-generation templates exist (social preview uses the now-updated wordmark SVG). Charts: the **principal** ZentroMeet series → `#2563EB`; the other 7 data-series hues in `RevenueCharts` and the positive/warning ternary branches (`#059669`/`#d97706`) are **preserved distinct**.

## Semantic + provider colors (preserved)
Unchanged: success (#10b981 / green utilities), warning (#f59e0b / amber), error+cancelled (#ef4444 / red), pending (amber), `lib/status-colors.ts` status maps; mobile decorative accents (violet/emerald/amber/sky/rose/slate); Google/Microsoft/Stripe/Zoom/Apple provider colors; neutral ink/surface/border tokens. The replace only matched the unique brand hex/rgb, so semantic/provider colors were structurally untouchable.

## Contrast (WCAG)
`#2563EB` on white ≈ **5.17:1** (AA for normal text); white on `#2563EB` ≈ 5.17:1 (AA for button labels) — a **contrast improvement** over the old `#359df3` (~2.6:1, which failed AA for white-on-brand CTAs). Hover/small-text use `#1D4ED8` (700, ~6.9:1). Dark mode uses `#3B82F6` (500, ~5.0:1 on `#0b1220`) with dark-ink foreground. Focus rings retained (`--color-accent-ring` + 4px glow).

## Old-color remnants
**None** in functional source — a grep audit for `359df3 / 1f8de8 / 5cb1f5 / 2789e0 / 1d7bd1 / ecf6ff / ebf5ff / 92,177,245 / 53,157,243` across app/, components/, lib/, public/, mobile/src, mobile/app, app.json, tailwind.config returns empty. Intentionally retained: none (the chart principal series + Avatar brand-gradient stops were migrated to `#2563EB`). Historical `.md` docs were left as records.

## FINAL REPORT
```
NEW PRIMARY COLOR:     #2563EB (Tailwind blue 600)
WEB TOKENS:            app/globals.css --color-accent (light #2563EB / dark #3B82F6) + scale; tailwind brand.* routes via var
PUBLIC WEBSITE:        nav/hero/CTAs/logos/footer → #2563EB (via token + SVG marks)
WEB DASHBOARD:         active-nav/buttons/focus/selected/badges/glows → #2563EB; dark #3B82F6
PUBLIC BOOKING FALLBACK: platform fallback #2563EB; tenant color authoritative when set
TENANT OVERRIDES:      preserved — only fallback literals changed; stored tenant colors untouched; guard intact
MOBILE THEME:          colors.ts brand #2563EB (+ shades); shadows + notification LED; consumers inherit
ANDROID:              app.json primaryColor + adaptiveIcon background + notification color → #2563EB; prebuild colors.xml verified; splash neutral kept; artwork untouched
IOS:                  primaryColor tint + shared RN theme → #2563EB
IPAD:                inherits the shared mobile theme
SEMANTIC COLORS:      success/warning/error/cancelled/pending + provider colors PRESERVED
CONTRAST:            #2563EB on white ~5.17:1 (AA); white-on-brand AA (improvement); 700 for small/hover; dark 500
TESTS:               +8 (web brand-color ×4: token=#2563EB, no remnant, tailwind routes via var, tenant fallback; mobile theme-brand ×4: brand=#2563EB, shades, no old value, semantic preserved)
WEB TYPECHECK:       PASS
WEB BUILD:           OK
FULL BACKEND SUITE:  742/742 (no regression)
MOBILE TYPECHECK:    PASS
MOBILE TESTS:        62/62
EXPO DOCTOR:         18/18
ANDROID EXPORT:      OK
IOS EXPORT:          OK
ANDROID PREBUILD:    OK — generated colors.xml: colorPrimary/iconBackground/notification = #2563EB
ANDROID VERSION CODE: 14 (was 13)
IOS BUILD NUMBER:     10 (was 9)
COMMIT:              [pending]
PUSHED:              [pending]
WEB DEPLOYED:        [pending — backup + health]
PRODUCTION HEALTH:   [pending]
CODEMAGIC BUILD:     OPERATOR ACTION — start android-preview on main (versionCode 14)
APK:                 produced by the Codemagic build (versionCode 14)
DEVICE QA:           PENDING — verify #2563EB on installed app; tenant override still renders tenant color; semantic colors unchanged
STATUS:              implemented + validated; web deploy + operator Codemagic remain
```

## Rollback
Revert the brand-migration commit (single commit: globals.css + tailwind + colors.ts + shades + app.json + the scoped recolor + tests) and redeploy web; for mobile, the prior versionCode-13 build remains installable. No schema/data change to undo (tenant colors were never modified).
