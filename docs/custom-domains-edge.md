# Custom Domains — Edge Operator Runbook (Phase 15C)

This is the operator-side checklist for activating the Cloudflare TLS
edge that backs the in-app **Custom Domains** Command Center.

The application code is fully deployed:

- DB schema (migrations `0038` + `0039`) — lifecycle columns + CF id
- `lib/domains.ts` — DNS verification + hostname → tenant resolver
- `lib/cloudflare-hostnames.ts` — CF API client (create / delete / refresh)
- `middleware.ts` — Node-runtime hostname routing
- `/api/tenant/domains*` — full CRUD + `/verify` + `/refresh`
- `scripts/sync-domain-ssl.ts` — background reconciler (cron)
- `/dashboard/settings/domain` — Command Center UI

What follows is the ops side that lives outside the codebase.

---

## 1 — Env vars (production)

Add to `/var/www/scheduling-saas/.env`:

```bash
# Cloudflare edge — Phase 15C
CLOUDFLARE_API_TOKEN=cf_***                  # required; see §2
CLOUDFLARE_ZONE_ID=***                       # required; zone that owns edge.zentromeet.com
CLOUDFLARE_ACCOUNT_ID=***                    # optional; future analytics
CLOUDFLARE_CUSTOM_HOSTNAME_FALLBACK=edge.zentromeet.com
CLOUDFLARE_ORIGIN_SERVER=app.zentromeet.com  # optional; for log sanity
```

After adding, restart with env reload:

```bash
pm2 restart scheduling-saas --update-env
```

The platform automatically picks up:

- `CNAME_TARGET` resolves to `CLOUDFLARE_CUSTOM_HOSTNAME_FALLBACK`
- TXT prefix stays at `_zentromeet-verify` (override via `DOMAINS_TXT_PREFIX` if needed)

If any required CF var is missing, the code degrades gracefully:
verification still works at the DNS layer, `ssl_status` stays at
`"pending"`, and the operator UI surfaces a 503 from the CF wrapper.
**No fake `"active"` state is ever written.**

---

## 2 — Cloudflare API token

Create the token under **Cloudflare → My Profile → API Tokens → Create
Token → Custom Token**:

| Scope | Permission |
| --- | --- |
| Zone → SSL and Certificates | Edit |
| Zone → Zone | Read |
| Zone → SSL and Certificates → Custom Hostnames | Edit |

Restrict to the zone that hosts `edge.zentromeet.com`. Save the token
into `CLOUDFLARE_API_TOKEN`.

---

## 3 — Cloudflare zone setup (one-time)

In the zone that owns `edge.zentromeet.com`:

1. **DNS** → create an A record:
   ```
   edge        A    35.83.95.42    Proxied (orange cloud)
   ```
2. **SSL/TLS → Edge Certificates** → set:
   - **Always Use HTTPS**: On
   - **Minimum TLS Version**: 1.2
   - **TLS 1.3**: On
   - **HTTP/2**: On
   - **HTTP/3 (QUIC)**: On
3. **SSL/TLS → Custom Hostnames** → confirm the feature is enabled
   (Business plan or above). Set fallback origin to
   `edge.zentromeet.com`.

---

## 4 — Nginx origin config (additive — DO NOT replace existing)

The existing nginx config for `app.zentromeet.com` stays untouched.
Add a new server block that accepts any `Host` header and proxies to
the Next.js process. **Append** to a new file, e.g.
`/etc/nginx/sites-available/zentromeet-custom-hostnames`:

```nginx
# Phase 15C — accept any custom hostname proxied via Cloudflare.
# All canonical hosts (app.zentromeet.com) are handled by the existing
# server block; this is the fallback that catches everything else.
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name _;

    # Cert presented to the upstream layer. Cloudflare terminates the
    # public TLS for the customer's hostname; this cert just needs to
    # be valid for edge.zentromeet.com (origin pull). Reuse the existing
    # Let's Encrypt cert from certbot.
    ssl_certificate     /etc/letsencrypt/live/app.zentromeet.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.zentromeet.com/privkey.pem;

    # Forward real client identity through to Next so middleware can
    # read the custom hostname from the Host header.
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;

    # WebSocket + HTTP/2 upgrade safety
    proxy_http_version 1.1;
    proxy_set_header   Upgrade    $http_upgrade;
    proxy_set_header   Connection "upgrade";

    # Optional: harden against direct origin probes by accepting only
    # Cloudflare IP ranges (refresh via cron, see Cloudflare docs).
    # include /etc/nginx/cloudflare-ranges.conf;
    # deny all;

    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_read_timeout 60s;
    }
}
```

Then:

```bash
sudo ln -sf /etc/nginx/sites-available/zentromeet-custom-hostnames \
            /etc/nginx/sites-enabled/zentromeet-custom-hostnames
sudo nginx -t   # validates without applying
sudo systemctl reload nginx
```

The existing `app.zentromeet.com` server block has explicit
`server_name app.zentromeet.com` and continues to win for that
hostname. The `server_name _;` block above only catches unmatched
hosts (the custom domains).

---

## 5 — Cron — background SSL sync

Reconciles ssl_status from Cloudflare every 5 minutes. Edit
`/etc/cron.d/zentromeet-domains`:

```cron
# Phase 15C — Cloudflare SSL reconciler
*/5 * * * * ubuntu cd /var/www/scheduling-saas && \
            /usr/bin/node --experimental-strip-types \
            scripts/sync-domain-ssl.ts \
            >> /var/log/zm/sync-domain-ssl.log 2>&1
```

Ensure the log dir exists:

```bash
sudo mkdir -p /var/log/zm
sudo chown ubuntu:ubuntu /var/log/zm
```

---

## 6 — Deployment order (do this exactly once per env)

1. `git pull` on EC2
2. Apply migration `0039_tenant_domain_cloudflare.sql`:
   ```bash
   psql "$DATABASE_URL" -f db/migrations/0039_tenant_domain_cloudflare.sql
   ```
3. Add the env vars from §1 and run `pm2 restart scheduling-saas --update-env`
4. Deploy the new build (already done as part of Phase 15C deploy)
5. Add the nginx server block from §4 and reload nginx
6. Install the cron job from §5
7. Run a smoke test (see §7)

---

## 7 — Final production validation checklist

| # | Check | Expected |
| --- | --- | --- |
| 1 | `curl -I https://app.zentromeet.com/` | 200 (existing routing unaffected) |
| 2 | `curl -I https://app.zentromeet.com/u/your-slug` | 200 (slug route still works) |
| 3 | Dashboard → Settings → Custom Domains | Loads, hero KPIs render |
| 4 | Add `book.example.com` via UI | Returns `status="pending"` + DNS instructions |
| 5 | Add records in your DNS provider | TXT + CNAME visible to `dig` |
| 6 | Click Verify | `status="verified"`, `cf_hostname_id` populated, audit row written |
| 7 | Check `/api/tenant/audit-logs` (or DB) | Rows for `domain.added`, `domain.verified` |
| 8 | Wait 1–10 minutes, click Re-check | `ssl_status="active"`, `activated_at` set |
| 9 | `curl -I https://book.example.com/` | 200, served by Cloudflare edge with valid cert |
| 10 | Cookie a different tenant | `book.example.com` still resolves the ORIGINAL tenant (no cross-tenant leak) |
| 11 | Delete the domain via UI | CF custom hostname removed, audit row written, `https://book.example.com/` stops resolving |
| 12 | `tail -f /var/log/zm/sync-domain-ssl.log` | 5-min sweep entries logging reconciliation summary |
| 13 | `pm2 logs scheduling-saas --err` | No new errors related to domains |

If a check fails, the most common causes are:

- **CF token scope** — token needs `Custom Hostnames` edit on the
  specific zone, not just account-level
- **Edge A record not proxied** — orange cloud must be ON
- **nginx default server** — make sure `server_name _;` doesn't
  shadow the canonical block (it shouldn't — that has its own
  explicit name)
- **Custom hostname feature not enabled** — Cloudflare Business plan
  or above required for Custom Hostnames

---

## 8 — Rollback (if anything goes wrong)

The change is fully additive. To roll back:

1. Comment out `CLOUDFLARE_API_TOKEN` in `.env` → all new
   verifications stay at the DNS layer with `ssl_status="pending"`.
   Existing domains keep resolving via middleware.
2. Disable the cron in `/etc/cron.d/zentromeet-domains`.
3. Remove the `zentromeet-custom-hostnames` nginx file, `nginx -t`,
   reload.
4. Migration `0039` is non-destructive — leave it applied.

No data loss in any rollback path.
