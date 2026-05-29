# ZentroMeet Mobile

Production-grade React Native Expo TypeScript app that talks to the existing ZentroMeet API at `app.zentromeet.com`. **Standalone project** — does **not** touch `client/`, `server/`, `mobile/`, or `scheduling-saas/`.

## Stack

- **Expo SDK 52** (React Native 0.76 / React 18.3.1) — bare-router architecture via Expo Router 4
- **TypeScript strict mode**
- **Expo Router** — file-system routing (`app/` tree)
- **TanStack Query** — server cache
- **Zustand** — auth state
- **Axios** — HTTP client with cookie-replay interceptors
- **Pure StyleSheet** — typed theme tokens (no Tailwind / NativeWind)
- **Reanimated + Gesture Handler** — pre-installed for future micro-interactions

## Architecture

```
mobile/
├── app/                          # Expo Router file-system routes
│   ├── _layout.tsx               # Providers + auth gate + Stack
│   ├── login.tsx                 # Email/password + Google + Microsoft
│   └── (tabs)/
│       ├── _layout.tsx           # Bottom tabs: Home/Calendar/Bookings/Customers/Settings
│       ├── index.tsx             # Home (greeting + today's bookings)
│       ├── calendar.tsx          # Month grid + selected day timeline
│       ├── appointments.tsx      # Filterable booking timeline
│       ├── customers.tsx         # Placeholder for v1
│       └── settings.tsx          # Profile + workspace + sign out
├── src/
│   ├── api/                      # Axios client + endpoint modules
│   │   ├── client.ts             # Interceptors, cookie capture, ApiError
│   │   ├── auth.ts
│   │   ├── appointments.ts
│   │   ├── calendar.ts
│   │   ├── notifications.ts
│   │   └── profile.ts
│   ├── components/ui/            # Reusable primitives
│   │   ├── Avatar.tsx
│   │   ├── Button.tsx
│   │   ├── Card.tsx              # Card + PressableCard
│   │   ├── EmptyState.tsx
│   │   ├── Input.tsx
│   │   ├── LoadingState.tsx
│   │   ├── Pill.tsx              # Tonal badge
│   │   ├── ScreenContainer.tsx   # SafeArea + padding + scroll
│   │   ├── SectionHeader.tsx     # Eyebrow + title + action
│   │   └── Text.tsx              # AppText, typed variants
│   ├── hooks/
│   │   ├── useAuth.ts
│   │   ├── useAppointments.ts
│   │   ├── useNotifications.ts
│   │   └── useProfile.ts
│   ├── lib/
│   │   ├── env.ts                # Single source of runtime config
│   │   ├── format.ts             # Date/currency formatters
│   │   ├── query.ts              # TanStack QueryClient + key registry
│   │   └── storage.ts            # SecureStore wrapper (web-safe)
│   ├── store/
│   │   └── authStore.ts          # Zustand auth state
│   └── theme/
│       ├── colors.ts
│       ├── spacing.ts            # 8-pt scale
│       ├── typography.ts         # Public Sans scale
│       ├── shadows.ts            # iOS shadow* + Android elevation
│       ├── radius.ts
│       └── index.ts              # Barrel
├── assets/                       # Placeholders — replace with real brand
├── app.json
├── babel.config.js
├── metro.config.js
├── tsconfig.json
└── package.json
```

## Setup

```bash
cd mobile
npm install --legacy-peer-deps
npx expo prebuild     # only needed if you plan to build native binaries
```

### Run locally

```bash
npm start             # opens Expo Dev Tools — scan QR with Expo Go
npm run ios           # boots iOS simulator
npm run android       # boots Android emulator
npm run web           # browser preview
```

### Env

Copy `.env.example` → `.env` and override `EXPO_PUBLIC_API_BASE_URL` if you're pointing at staging. Production default is `https://app.zentromeet.com` (set in `app.json` → `extra.apiBaseUrl`).

## Auth flow

- **Email / password**: `POST /api/auth/login` → server returns user JSON + `Set-Cookie`. Our axios interceptor captures the cookie, stashes it in `expo-secure-store`, and replays it as `Cookie:` on every subsequent request.
- **Google / Microsoft**: `WebBrowser.openAuthSessionAsync()` opens the in-app browser at `/api/auth/oauth/{provider}/start?mobile=1`. The callback ends at `zentromeet://oauth/callback?token=…&userId=…&email=…`, which we parse and stash. *Note: requires the web app to add a `mobile=1` branch on the callback that issues a token + deep-links instead of setting a session cookie. That backend change is a follow-up — buttons are wired client-side and will error with a clear message until the callback lands.*

## Theme tokens

Everything visual reads from `src/theme/`. Add a new tonal pill? Add a key to `colors.ts` and a row to `PillTone` in `Pill.tsx`. Don't hardcode hex values inside components.

## Design language

Mirrors the web `scheduling-saas` Brand Studio:

- **Primary brand:** `#359df3`
- **Surfaces:** white + slate-50 / slate-100 inset
- **Typography:** Public Sans (system fallback until font assets are added)
- **Cards:** `rounded-xl` (18 px), layered soft shadow, white surface
- **Tabs:** 64 px tall, brand-tinted active state, hairline top border
- **Motion:** restrained — `transform: scale(0.985)` on press, no flashy springs

## Non-goals for v1

Explicitly **not** built in this iteration:

- AI / Copilot
- Executive analytics dashboards
- Billing flows (only the link out to web)
- Automation builder
- Admin / super-admin panels
- Massive desktop workflows ported 1:1

These will land as future phases — the foundation is structured so adding them is additive.

## Adding a screen

1. Create `app/<your-route>.tsx`. Wrap content in `<ScreenContainer>`.
2. Build the UI from `src/components/ui/*` primitives.
3. Add an API module in `src/api/` if you need new endpoints.
4. Add a hook in `src/hooks/` (TanStack Query) so the screen is declarative.
5. If you need a new tab, add it to `app/(tabs)/_layout.tsx`.

## Roadmap

- [x] **Phase 0** — bootstrap: theme, providers, bottom tabs, login, 5 starter screens
- [x] **Phase 1A** — mobile OAuth (Google + Microsoft via WebBrowser → deep link), real API integration (auth/me, bookings list), retry-aware error states + pull-to-refresh, Public Sans loading, haptic feedback on key interactions
- [ ] **Phase 1B** — booking detail drawer, reschedule + cancel actions
- [ ] **Phase 2** — push notifications (expo-notifications)
- [ ] **Phase 3** — customers CRM (search, segments, profile drawer)
- [ ] **Phase 4** — public-page sharing + QR + service picker
- [ ] **Phase 5** — analytics dashboard (light mobile spin of executive)
- [ ] **Phase 6** — offline mode + draft bookings + sync queue
