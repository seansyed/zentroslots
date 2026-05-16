# Production Deploy — AWS Lightsail + PM2 + Nginx + Let's Encrypt

Copy-paste runbook. Execute one phase at a time. **If any command fails, STOP and report the exact error before continuing.**

Architecture:
```
Internet → Nginx :80/:443 → Next.js (localhost:3001) → RDS Postgres
                                                     → SMTP / Resend / Postmark
                                                     → Stripe API (outbound)
                                                     → Google OAuth (outbound)
```

Placeholders to fill in once at the top of your session, then reuse:
- `YOUR_DOMAIN` — e.g. `app.example.com`
- `YOUR_GITHUB_REPO` — e.g. `git@github.com:you/scheduling-saas.git`
- `YOUR_RDS_HOST` — RDS Postgres hostname
- `YOUR_RDS_PASSWORD` — never type this where it gets logged

---

## Phase 0 — AWS pre-flight (do in AWS console first)

### 0.1 Lightsail instance
- **Region:** pick closest to your users
- **Blueprint:** Linux → **Ubuntu 22.04 LTS**
- **Plan:** start with 2GB RAM ($10/mo) — enough for low-traffic launch
- **Name:** `scheduling-saas-prod`
- Create. Wait until it's "Running".

### 0.2 Static IP
- Lightsail → Networking → **Create static IP** → attach to the instance.
- This is the IP that DNS will point at. **Never delete it** — Lightsail charges if it's detached and the cost is small if attached.

### 0.3 RDS Postgres
- RDS → **Create database** → PostgreSQL **16+** (the app uses `btree_gist`; 16 ships with it)
- Instance type: `db.t4g.micro` (free-tier eligible to start)
- Storage: 20 GB, gp3
- **Disable public access**. We'll connect via VPC peering (Lightsail → AWS VPC).
- Create a strong master password and **save it in a password manager**, not in plain text anywhere
- After creation, copy the **endpoint** — that's `YOUR_RDS_HOST`

### 0.4 Lightsail → VPC peering (for RDS connectivity)
- Lightsail → Account → Advanced → **VPC peering** for the region → enable
- This lets the Lightsail instance reach RDS over private networking

### 0.5 RDS security group
- Add an inbound rule allowing Postgres (5432) from the Lightsail static IP

### 0.6 DNS (do at your registrar)
- Add an **A record** for `YOUR_DOMAIN` pointing at the **Lightsail static IP**
- TTL: 300s while you're testing; raise to 3600 after launch
- Wait for propagation before requesting SSL (Phase 8)

### 0.7 Lightsail firewall
- Lightsail → Networking → Firewall, ensure these are open:
  - **TCP 22** — SSH (consider restricting to your IP)
  - **TCP 80** — HTTP (needed for Let's Encrypt challenge)
  - **TCP 443** — HTTPS
- **Do not** open 3001 — that's the local Next.js port and Nginx is the only thing that should reach it.

### 0.8 Snapshots
- Lightsail → instance → Snapshots → enable **automatic daily snapshots**
- Retain 7 days minimum. Cheap insurance.

---

## Phase 1 — SSH in + discovery

From your local machine:
```bash
ssh -i <path-to-lightsail-key>.pem ubuntu@<lightsail-static-ip>
```

Once in, run these discovery commands and **report the output** before continuing:
```bash
pwd
whoami
hostname
node -v 2>/dev/null || echo "no node"
npm -v 2>/dev/null || echo "no npm"
pm2 -v 2>/dev/null || echo "no pm2"
nginx -v 2>&1 | head -1 || echo "no nginx"
free -h
df -h /
```

Expected at this point: no Node, no PM2, no Nginx. We're going to install them next.

---

## Phase 2 — System deps + Node 22 + PM2

Always backup before editing system config:
```bash
sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak 2>/dev/null || true
```

Update + install base tools:
```bash
sudo apt update
sudo apt install -y nginx git curl unzip ufw
nginx -v
git --version
```

Install Node 22 via NodeSource (only if `node -v` did not return `v22.x`):
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # expect v22.x
npm -v
```

Install PM2:
```bash
sudo npm install -g pm2
pm2 -v
```

---

## Phase 3 — Application user + directory

Don't run the app as `root`. Create a dedicated user.

```bash
sudo adduser --system --group --shell /bin/bash --home /home/scheduling scheduling
sudo mkdir -p /var/www/scheduling-saas
sudo chown scheduling:scheduling /var/www/scheduling-saas
```

---

## Phase 4 — Clone the repo

You said the source code will live in a **new GitHub repo**. Before you can clone on the server, push the local commit:

**From your Windows dev machine** (in PowerShell):
```powershell
cd C:\Trae\ZentroBizApp-EC2\ZentroBizProduction\scheduling-saas
# Create the GitHub repo first in the browser (private). Then:
git remote add origin <YOUR_GITHUB_REPO>
git push -u origin main
```

The repo is already initialized with branch `main` and a clean first commit (`92b8036`). Verify on GitHub that `.env` is **not** in the file list before continuing.

**On the Lightsail server**, switch to the `scheduling` user and clone:
```bash
sudo -u scheduling bash
cd /var/www/scheduling-saas
git clone <YOUR_GITHUB_REPO> .
ls -la   # should show package.json, app/, db/, etc.
```

If the repo is private, use **SSH** for git: generate a key on the server, add it as a Deploy Key on GitHub.

---

## Phase 5 — Environment configuration

**As the `scheduling` user**, create the env file. Never paste secrets into chat — type them in the editor.

```bash
nano /var/www/scheduling-saas/.env
```

Fill in (placeholders only):
```
# Required
DATABASE_URL=postgresql://USER:PASS@YOUR_RDS_HOST:5432/scheduling_saas?sslmode=require
JWT_SECRET=                              # generate with: openssl rand -base64 32
APP_BASE_URL=https://YOUR_DOMAIN

# Recommended (paid features)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_PRO=
STRIPE_PRICE_TEAM=

# Recommended (Google Meet on bookings)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://YOUR_DOMAIN/api/google/callback

# Recommended (real email)
EMAIL_FROM=Scheduling SaaS <no-reply@YOUR_DOMAIN>
RESEND_API_KEY=                          # or POSTMARK_TOKEN, or SMTP_HOST/USER/PASS
# SMTP fallback (used only if RESEND/POSTMARK are unset):
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_USER=
# SMTP_PASS=

# Optional
SUPER_ADMIN_EMAILS=                      # comma-separated, for /admin access
SENTRY_DSN=                              # optional: enables Sentry adapter in lib/logger.ts
```

Save (`Ctrl+O`, `Enter`, `Ctrl+X`). Verify presence without printing contents:
```bash
ls -la /var/www/scheduling-saas/.env
wc -l /var/www/scheduling-saas/.env       # should be > 0
```

Lock it down:
```bash
chmod 600 /var/www/scheduling-saas/.env
```

---

## Phase 6 — Install + build

```bash
cd /var/www/scheduling-saas
npm install
```

If install fails: **STOP and report the exact error**. Don't `--force`.

Build:
```bash
npm run build
```

If build fails: **STOP and report the failing file**. We do not bypass build errors.

---

## Phase 7 — Database migrations

The app has 11 additive migrations in `db/migrations/`. Apply in order:

```bash
cd /var/www/scheduling-saas
for f in db/migrations/*.sql; do
  echo "→ Applying $f"
  PGPASSWORD="<YOUR_RDS_PASSWORD>" psql "postgresql://USER@YOUR_RDS_HOST:5432/scheduling_saas?sslmode=require" -f "$f"
done
```

**The EXCLUDE constraint must exist.** Verify:
```bash
PGPASSWORD="<...>" psql "..." -c "SELECT conname FROM pg_constraint WHERE conname = 'bookings_no_overlap';"
```
Expect one row. If missing: STOP. The app's correctness depends on this constraint.

Verify `btree_gist` extension is installed (RDS Postgres 16 ships with it but it must be enabled per database):
```bash
PGPASSWORD="<...>" psql "..." -c "SELECT extname FROM pg_extension WHERE extname = 'btree_gist';"
```

---

## Phase 8 — Start with PM2

```bash
cd /var/www/scheduling-saas
pm2 start npm --name scheduling-saas -- start
pm2 status                      # expect "online"
pm2 logs scheduling-saas --lines 50    # watch for startup errors, then Ctrl+C
```

If you see "DATABASE_URL is not set" or similar: stop, fix `.env`, then `pm2 restart scheduling-saas`.

Persist across reboots:
```bash
pm2 save
pm2 startup systemd -u scheduling --hp /home/scheduling
```
PM2 prints a command — **run the exact command it printed** (it's `sudo`-prefixed).

Verify the app is reachable locally:
```bash
curl -s http://localhost:3001/api/health | head -c 200
```
Expect: `{"ok":true,...}`. If 503: check `pm2 logs` — usually DB connectivity or migrations not yet applied.

---

## Phase 9 — Nginx reverse proxy

Backup first:
```bash
sudo cp -an /etc/nginx/sites-available /etc/nginx/sites-available.bak.$(date +%Y%m%d)
```

Create site config:
```bash
sudo nano /etc/nginx/sites-available/scheduling-saas
```

Paste (replace `YOUR_DOMAIN`):
```nginx
server {
    listen 80;
    listen [::]:80;
    server_name YOUR_DOMAIN;

    # ACME challenge for Let's Encrypt — keep on plain HTTP
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Health check is publicly fine on HTTP — saves a TLS handshake
    location = /api/health {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        access_log off;
    }

    # Embed pages need to be iframable from any origin — don't add X-Frame-Options
    location /embed/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 60s;
    }

    client_max_body_size 5M;
}
```

Enable + validate + reload:
```bash
sudo ln -s /etc/nginx/sites-available/scheduling-saas /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t                 # MUST output "syntax is ok" and "test is successful"
sudo systemctl reload nginx
```

Sanity check the chain:
```bash
curl -sv http://YOUR_DOMAIN/api/health 2>&1 | tail -10
```
Expect `HTTP/1.1 200` + JSON body. If 502: PM2 isn't running. If 404: nginx site link is wrong.

---

## Phase 10 — DNS verification

Before requesting SSL, the domain **must** resolve to the static IP:
```bash
dig +short YOUR_DOMAIN          # expect <lightsail static IP>
```

If empty or wrong, fix DNS at your registrar and wait. Don't request a cert before DNS propagates — Let's Encrypt rate-limits failed challenges.

---

## Phase 11 — SSL via Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_DOMAIN --redirect --agree-tos -m you@example.com --non-interactive
```

`--redirect` modifies the nginx config to force HTTPS. Certbot edits the file in place; verify it still validates:
```bash
sudo nginx -t
```

Renewal cron is installed automatically. Verify:
```bash
sudo certbot renew --dry-run
```

---

## Phase 12 — Production smoke test

From your machine (not the server):
```bash
# Health
curl -sf https://YOUR_DOMAIN/api/health | jq

# Marketing
for path in "" "pricing" "features" "about" "for/tax-office"; do
  curl -sfo /dev/null -w "%{http_code} /$path\n" https://YOUR_DOMAIN/$path
done

# Sitemap + robots
curl -sf https://YOUR_DOMAIN/sitemap.xml | head -20
curl -sf https://YOUR_DOMAIN/robots.txt
```

Then in a browser:
- [ ] `/` — landing page
- [ ] `/dashboard/login` — sign up as a new admin
- [ ] Complete onboarding → see checklist on `/dashboard`
- [ ] `/dashboard/calendar` — drag-drop works
- [ ] `/dashboard/appointments` — list renders
- [ ] `/u/<your-slug>` — public booking page
- [ ] Book a slot in incognito → confirmation page shows
- [ ] Check email arrives with `.ics` attachment
- [ ] Cancel-link in email → opens `/cancel/<token>` and works

Watch logs during smoke test:
```bash
pm2 logs scheduling-saas --lines 100
```

---

## Phase 13 — Reminder cron

The app's reminders need a system cron. As the `scheduling` user:
```bash
crontab -e
```
Add:
```
*/15 * * * * cd /var/www/scheduling-saas && /usr/bin/node node_modules/.bin/tsx scripts/send-reminders.ts >> /var/log/scheduling-saas-reminders.log 2>&1
```

Log file location requires write perms; if `/var/log/...` fails, put it under `/home/scheduling/reminders.log` instead.

Smoke-test by running it manually once:
```bash
cd /var/www/scheduling-saas
npm run reminders:send
```
Look for `[reminders] done`.

---

## Phase 14 — Backups (automated)

Lightsail snapshots cover the OS volume; RDS handles its own automated backups (verify in RDS console → Maintenance & backups). Beyond that, dump SQL nightly so you can restore to any environment:

```bash
sudo nano /etc/cron.daily/scheduling-saas-db-dump
```
```sh
#!/bin/sh
set -e
TS=$(date +%Y%m%d-%H%M)
DEST=/var/backups/scheduling-saas
mkdir -p "$DEST"
PGPASSWORD="<...>" pg_dump "postgresql://USER@YOUR_RDS_HOST:5432/scheduling_saas?sslmode=require" \
  --format=custom --file="$DEST/db-$TS.dump"
find "$DEST" -type f -name "db-*.dump" -mtime +30 -delete
```
```bash
sudo chmod +x /etc/cron.daily/scheduling-saas-db-dump
sudo /etc/cron.daily/scheduling-saas-db-dump   # test once
ls -lh /var/backups/scheduling-saas
```

Optional: `s3 sync` the dumps to S3 (cheap insurance, off-box).

---

## Phase 15 — Stripe webhook

In the Stripe dashboard:
- Webhooks → Add endpoint → `https://YOUR_DOMAIN/api/webhooks/stripe`
- Events: `checkout.session.completed`, `customer.subscription.created/updated/deleted`
- Copy the signing secret → set `STRIPE_WEBHOOK_SECRET` in `.env`
- Reload: `pm2 restart scheduling-saas`
- Send a test event → check `pm2 logs` for the receipt

---

## Phase 16 — Final report template

Once everything's green, drop this in a runbook/postmortem-ready note:

```
Domain:           https://YOUR_DOMAIN
Lightsail IP:     X.X.X.X
RDS endpoint:     YOUR_RDS_HOST
App version:      92b8036  (initial commit)
PM2 status:       online
Nginx status:     active
SSL:              Let's Encrypt, auto-renewing
Health:           200 (DB Xms, EXCLUDE Xms)
Migrations:       0000 → 0011 applied
Reminder cron:    every 15 min
Backup cron:      nightly, 30-day retention
Snapshots:        Lightsail daily, 7-day retention; RDS automated 7-day PITR
```

---

## Common failure modes & quick fixes

| Symptom | Fix |
|---|---|
| `pm2 logs` shows "DATABASE_URL is not set" | `.env` not present or PM2 started before file existed. Edit `.env`, `pm2 restart scheduling-saas` |
| 502 from nginx | App not running. `pm2 status` to confirm. Restart if needed. |
| 503 from `/api/health` with `bookings_no_overlap: false` | Migration didn't apply. Re-run Phase 7. **App correctness depends on this constraint** — don't proceed past it. |
| Let's Encrypt "DNS problem" | DNS hasn't propagated. `dig +short YOUR_DOMAIN` from the server. Wait. |
| Stripe webhook returns 400 | Signature mismatch. Re-copy signing secret from Stripe dashboard. |
| Bookings work but no email | `pm2 logs` for `[email:fail]`. Check provider key or fall back to SMTP. |
| Calendar drag-drop returns 409 | Expected when slot was just taken — the EXCLUDE constraint is doing its job. |

---

## What this runbook deliberately doesn't do

- **No CI/CD.** First deploy is manual; set up GitHub Actions later when you've validated the flow.
- **No autoscaling.** Single Lightsail instance is enough for most launches. Scale horizontally by adding a second instance + load balancer once you outgrow it.
- **No Redis.** The app is single-instance MVP-grade by design; the rate limiter, polling, and audit are all in-process.
- **No Outlook / Teams / Zoom OAuth.** Provider scaffolds exist (`services.video_provider`) but real OAuth requires Microsoft Graph + Zoom Marketplace apps. Add when needed.

For ongoing ops, see [OPERATIONS.md](./OPERATIONS.md) and [INCIDENT.md](./INCIDENT.md) in this directory.
