# Scheduling SaaS — MVP

Calendly-style booking app. Next.js 15 + TypeScript + Drizzle + Postgres.

## Features

- Public booking pages (pick service → date → time → confirm)
- Staff/admin dashboard with JWT auth (cookie session)
- Weekly availability editor
- Slot computation with buffer + double-book protection (DB exclusion constraint)
- Google Calendar OAuth + automatic event creation with Google Meet link
- All times stored in UTC, rendered in the viewer's timezone

## Stack

- Next.js 15 (App Router) + React 19
- TypeScript
- Drizzle ORM + Postgres (`postgres` driver)
- Tailwind CSS
- `jose` (JWT) + `bcryptjs` (password hashing)
- `date-fns` + `date-fns-tz`
- `googleapis` (Calendar API)

## Setup

```bash
cd scheduling-saas
npm install
cp .env.example .env       # then fill it in
npm run db:generate        # generate migration from schema
npm run db:migrate         # apply to your Postgres

# Then apply the overlap constraint:
psql "$DATABASE_URL" -f db/migrations/0001_overlap_constraint.sql

npm run dev                # http://localhost:3001
```

## Environment variables

| Var | What |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Random 32-byte secret (`openssl rand -base64 32`) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3001/api/google/callback` in dev |
| `APP_BASE_URL` | Used for OAuth redirects, e.g. `http://localhost:3001` |

### Google Cloud setup

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com).
2. Enable **Google Calendar API**.
3. OAuth consent screen → external → add yourself as a test user.
4. Credentials → Create OAuth client ID → Web application.
   - Authorized redirect URI: `http://localhost:3001/api/google/callback`
5. Paste the client id + secret into `.env`.

## First-time flow

1. Visit `/dashboard/login` and sign up as a **staff** user. Use your real timezone.
2. Click **Connect Google Calendar** on the dashboard.
3. Click **Edit availability** and set your weekly hours.
4. Open a `psql` shell and insert a service + link it to your staff user:

   ```sql
   -- Replace <STAFF_USER_ID> with the staff row's id.
   INSERT INTO services (name, duration_minutes, buffer_before, buffer_after)
   VALUES ('30-min intro', 30, 5, 5)
   RETURNING id;

   INSERT INTO service_staff (service_id, user_id)
   VALUES ('<SERVICE_ID>', '<STAFF_USER_ID>');
   ```

   (An admin UI for services is intentionally out of MVP scope — DB inserts are fine.)
5. Visit `/book` → pick the service → pick your staff member → book a slot in a different browser/incognito.
6. Check Google Calendar for the new event with a Meet link.

## Project structure

```
scheduling-saas/
├── app/
│   ├── api/
│   │   ├── auth/        (signup, login, logout, me)
│   │   ├── services/    (GET, POST)
│   │   ├── availability/(GET, PUT)
│   │   ├── slots/       (GET)
│   │   ├── bookings/    (GET, POST)
│   │   └── google/      (connect, callback)
│   ├── book/            (public booking pages)
│   ├── dashboard/       (auth-gated staff/admin pages)
│   └── page.tsx         (landing)
├── components/          (BookingFlow, AvailabilityEditor)
├── db/
│   ├── client.ts        (Drizzle + postgres-js)
│   ├── schema.ts        (tables + relations + types)
│   └── migrations/      (generated + the EXCLUDE constraint)
├── lib/
│   ├── auth.ts          (JWT, cookies, requireRole)
│   ├── availability.ts  (getAvailableSlots)
│   ├── google.ts        (OAuth + Calendar event creation)
│   └── validation.ts    (Zod schemas)
└── README.md
```

## How double-booking is prevented

Two layers:

1. **App layer** — `POST /api/bookings` recomputes `getAvailableSlots` and refuses if the slot isn't in the result.
2. **DB layer** — `bookings_no_overlap` exclusion constraint (`tstzrange` + GiST). If two requests race past layer 1, Postgres raises `23P01` on the second, which we surface as `409 Slot just taken`.

## What's intentionally not built (MVP scope)

- Outlook / Microsoft Graph
- Zoom / Teams (Google Meet is free via `conferenceData`)
- Email reminders (Google sends the invite email; no separate reminder system)
- Webhooks / two-way calendar sync
- Multi-tenant (single workspace)
- Rate limiting (add when needed)
- Service CRUD UI (insert via SQL for now)

When you outgrow inline Google calls, drop in Inngest or Trigger.dev — no infra to run. When you need multi-tenant, add a `tenant_id` column to every table and a row-level security policy keyed off `auth.uid()`.
