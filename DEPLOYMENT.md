# Deployment — Scheduling SaaS

Production deployment guide. Pairs with [LAUNCH.md](./LAUNCH.md) (env + Stripe setup) and [OPERATIONS.md](./OPERATIONS.md) (running it).

## 1. Build artifact

```bash
npm install
npm run build
# Produces .next/ — the production bundle.
```

## 2. Runtime

Node 20+ recommended. Single process can scale to thousands of bookings/day per tenant. Multi-process: stick a reverse proxy in front and run several instances against the same Postgres.

### Quickstart (single instance)

```bash
NODE_ENV=production npm start
# Default port: 3001 (set in package.json). Override with PORT.
```

### PM2 (process supervisor)

```js
// ecosystem.config.js
module.exports = {
  apps: [{
    name: "scheduling-saas",
    script: "node_modules/next/dist/bin/next",
    args: "start -p 3001",
    instances: 2,                // adjust to CPU count
    exec_mode: "cluster",
    env: { NODE_ENV: "production" },
    max_memory_restart: "512M",
  }],
};
```

```bash
pm2 start ecosystem.config.js
pm2 save && pm2 startup   # auto-start on reboot
pm2 logs scheduling-saas  # tail JSON-line logs
```

### Docker (alternative)

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app/public ./public
COPY --from=build /app/db ./db
ENV NODE_ENV=production
EXPOSE 3001
CMD ["npx", "next", "start", "-p", "3001"]
```

## 3. Reverse proxy (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name app.example.com;

  ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Frame-Options DENY always;
  add_header X-Content-Type-Options nosniff always;

  # Embeds need to be iframable from any origin — strip X-Frame-Options
  # for /embed/* and rely on a CSP frame-ancestors policy instead.
  location /embed/ {
    add_header X-Frame-Options "";
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
  }

  client_max_body_size 5M;
}

# Redirect HTTP → HTTPS
server {
  listen 80;
  server_name app.example.com;
  return 301 https://$host$request_uri;
}
```

## 4. Database migrations

Migrations are plain SQL files in `db/migrations/`. Apply in order:

```bash
for f in db/migrations/*.sql; do
  echo "Applying $f"
  psql "$DATABASE_URL" -f "$f"
done
```

For zero-downtime rollouts, every migration in this project is **additive**: new tables and new nullable columns. You can deploy a new app version that ignores the new fields, then run the migration, then roll out the version that uses them.

## 5. Health checks

Wire your load balancer to `GET /api/health`:

- **200** when DB ping succeeds AND `bookings_no_overlap` EXCLUDE constraint is present
- **503** otherwise
- Response body includes per-check latency for trending

Recommended interval: 10 seconds, fail after 3 consecutive 503s.

## 6. Smoke test after deploy

```bash
# 1. Health
curl -sf https://app.example.com/api/health | jq

# 2. Marketing pages
for path in "" "pricing" "features" "about" "for/tax-office"; do
  curl -sfo /dev/null -w "%{http_code} /$path\n" https://app.example.com/$path
done

# 3. Sitemap + robots
curl -sf https://app.example.com/sitemap.xml | head -20
curl -sf https://app.example.com/robots.txt

# 4. Public booking page
curl -sf https://app.example.com/u/default >/dev/null && echo "✓ public profile"

# 5. Stripe webhook reachable (signature will fail but route should respond)
curl -X POST -i https://app.example.com/api/webhooks/stripe | head -5
```

## 7. Rollback

The previous build is preserved in your PM2 / container registry. If a deploy regresses:

```bash
pm2 reload scheduling-saas --update-env  # restart with cached env
# Or: redeploy the previous image tag
```

For DB: every migration is one direction. To roll back schema, write a manual reverse migration and apply it the same way.
