# ZentroMeet Mobile — Web Preview Deployment

The Expo/React Native app deployed as a static web bundle for browser-based QA. No Expo dev mode needed on your PC; testers open a URL.

## 🌐 Live URL

**`https://app.zentromeet.com/mobile/`**

Works on any browser — desktop, tablet, phone. The bundle calls the production API at `https://app.zentromeet.com` for everything, so all booking + auth flows are real.

## 🚀 Redeploy after code changes

From `mobile/`:

```bash
npm run web:deploy
```

That single command:
1. Tars up your local source (excludes `node_modules`, `dist`, `.expo`)
2. Uploads to the EC2 scheduling-saas host
3. `npm install` only if `package-lock.json` changed (saves ~15s on iter rebuilds)
4. Runs `expo export --platform web` (uses Node 18 LTS via nvm on EC2 — local Node 24 is incompatible with Expo SDK 52)
5. rsyncs `dist/` into `/var/www/zentromeet-mobile-web/`
6. Smoke-tests the public URL

Typical run: ~45 seconds end-to-end.

## 🔑 Logging in for QA

Use any **demo tenant user** — credentials from `docs/operations/demo-tenant.md`:

| Email | Tenant | Password |
|---|---|---|
| `admin@docs-demo.zentromeet.demo` | Primary demo workspace | `DemoZentro2026!` |
| `sarah.johnson@docs-demo.zentromeet.demo` | Staff | `DemoZentro2026!` |

Email + password login uses the production `/api/auth/login` cookie session — works on web.

## 📋 What works vs degrades on web

| Feature | Web | Native |
|---|---|---|
| Email/password login | ✅ | ✅ |
| Appointments list | ✅ | ✅ |
| Booking detail | ✅ | ✅ |
| Reschedule modal | ✅ | ✅ |
| Cancel booking | ✅ | ✅ |
| Customer search | ✅ | ✅ |
| Calendar view | ✅ | ✅ |
| Settings | ✅ | ✅ |
| Responsive layout (mobile/tablet/desktop) | ✅ | n/a |
| OAuth (Google/Microsoft) | ⚠️ degrades — opens in new window but `zentromeet://` deep link fails. Use password auth. | ✅ |
| Push notifications | ⚠️ degrades — `expo-notifications` no-ops gracefully | ✅ |
| Haptics | ⚠️ degrades — `expo-haptics` no-ops gracefully | ✅ |
| SecureStore | ⚠️ degrades — falls back to localStorage via try/catch (see `useAuth.ts`) | ✅ |

## 🏗️ Infrastructure

```
Browser
   │
   ▼
Cloudflare  (CDN)
   │
   ▼
nginx @ 35.83.95.42
   │
   ├──  location /mobile/        →  alias /var/www/zentromeet-mobile-web/
   │                                + try_files SPA fallback to /mobile/index.html
   │
   └──  location /               →  proxy_pass 127.0.0.1:3001 (Next.js scheduling-saas)
```

- Nginx config: `/etc/nginx/sites-available/scheduling-saas` (symlinked from `sites-enabled/`)
- Static files: `/var/www/zentromeet-mobile-web/` (~7.5 MB)
- Build workspace (transient): `/var/www/zentromeet-mobile-build/`
- TLS: existing Let's Encrypt cert for `app.zentromeet.com`

## 🛠️ Why the build workflow looks the way it does

**Why build on the EC2 not locally?**  
Expo SDK 52 + Node 24 (your local Node) hits a known `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` error because `expo-modules-core@2.2.3` ships `src/index.ts` as `main`. Node 18 LTS on the EC2 doesn't have this issue.

**Why does the build script patch `app.json`?**  
Three of the config plugins (`expo-font`, `expo-secure-store`, `expo-web-browser`) crash the Expo CLI bundler on Node 18+ because they ship as ESM but the plugin loader tries to `require()` them as CJS. The patch removes them from the plugins array (they still work at runtime as imported modules — they just don't need to participate in the config-plugin pipeline). Your committed `app.json` stays untouched; the patch is applied only on the EC2 build copy.

**Why `experiments.baseUrl: "/mobile"`?**  
This is the only way to tell Expo Router that the deployed bundle lives at a subpath. Every asset reference (`<script src=…>`, `<link href=…>`, Expo Router internal navigation) gets prefixed with `/mobile/`. Native builds ignore this setting.

## 🔧 Manual steps (if you ever need them)

### One-time EC2 setup (already done)
```bash
ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42

# Install nvm + Node 18
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR=$HOME/.nvm
. "$NVM_DIR/nvm.sh"
nvm install 18

# Create dirs
sudo mkdir -p /var/www/zentromeet-mobile-build /var/www/zentromeet-mobile-web
sudo chown -R ubuntu:ubuntu /var/www/zentromeet-mobile-build /var/www/zentromeet-mobile-web

# Nginx: add the mobile block (already in place)
# location /mobile/ {
#     alias /var/www/zentromeet-mobile-web/;
#     try_files $uri $uri/ /mobile/index.html;
#     add_header Cache-Control "public, max-age=604800";
# }
# location = /mobile { return 301 /mobile/; }
```

### Rollback
The old build is preserved at `/var/www/zentromeet-mobile-build/dist/` until the next `npm run web:deploy`. To revert quickly:
```bash
ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42
sudo systemctl reload nginx   # if you just need to drop cache
# Or restore from a known-good tarball:
# sudo tar xzf /var/www/zentromeet-mobile-web-backup.tgz -C /var/www/zentromeet-mobile-web/
```

### Disable the web preview
Remove the nginx location block + reload:
```bash
sudo sed -i '/# ZentroMeet mobile web preview/,/^    }$/d; /location = \/mobile/,/^    }$/d' \
  /etc/nginx/sites-enabled/scheduling-saas
sudo nginx -t && sudo systemctl reload nginx
```

The static files at `/var/www/zentromeet-mobile-web/` stay on disk — `rm -rf` them if you want a clean wipe.

## 🐛 Troubleshooting

**"My change isn't showing up" after `web:deploy`**  
Cloudflare may be caching the old bundle. The bundle filename has a content hash (`entry-3b89bef58e….js`) so a new bundle automatically has a new URL — only `index.html` is cacheable in a way that matters. Force-refresh your browser (Ctrl+Shift+R) or wait ~60s for Cloudflare's edge TTL.

**Page loads but shows empty white screen**  
Open DevTools → Console. Likely a Metro bundle runtime error. Check:
- `EXPO_PUBLIC_API_BASE_URL` is set to `https://app.zentromeet.com` (look at `extra.apiBaseUrl` in app.json — it is)
- Network tab: any 401s? That's expected if not logged in
- Network tab: any CORS errors hitting `/api/*`? Shouldn't happen — same origin

**`web:deploy` fails with `ssh: connection refused`**  
SSH key path or host wrong. Set env vars:
```bash
SSH_KEY=~/.ssh/AATSKeyPair.pem SSH_HOST=ubuntu@35.83.95.42 npm run web:deploy
```

**Build fails with `Cannot use import statement outside a module`**  
A new Expo plugin was added to `app.json` that has the ESM/CJS mismatch. Add its name to the `keep` list inside `scripts/deploy-web.sh`'s app.json patch step.

**`/mobile/login` returns 404 in the browser**  
nginx SPA fallback isn't matching. SSH in + check `sudo nginx -T | grep -A 5 'location /mobile/'`. The `try_files $uri $uri/ /mobile/index.html;` line must be present.

## 🔍 Smoke checks

```bash
# Quick health
curl -s -o /dev/null -w '%{http_code}\n' https://app.zentromeet.com/mobile/

# All routes return 200
for p in / /favicon.ico /index.html /login /appointments/x; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://app.zentromeet.com/mobile$p")" "$p"
done

# Verify bundle is the latest
curl -s https://app.zentromeet.com/mobile/index.html | grep -oP 'entry-[a-f0-9]+\.js'

# Bundle size (should be ~2.5 MB)
curl -sI https://app.zentromeet.com/mobile/_expo/static/js/web/entry-*.js | grep -i 'content-length'
```
