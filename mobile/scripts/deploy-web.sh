#!/usr/bin/env bash
#
# deploy-web.sh — One-shot redeploy of the Expo Web preview to
# app.zentromeet.com/mobile.
#
# Runs locally on your dev machine; uploads the source tarball to the
# scheduling-saas EC2, builds it there (using Node 20 LTS via nvm —
# local Node v24 doesn't work with Expo SDK 52), then rsyncs the
# generated dist/ into the nginx-served directory.
#
# Idempotent. Safe to run as many times as you like.
#
# Usage:
#   bash scripts/deploy-web.sh
# or via npm script:
#   npm run web:deploy
#
# Prereqs:
#   - SSH key at ~/.ssh/AATSKeyPair.pem (the scheduling-saas key)
#   - tar, scp, ssh available locally
#   - EAS-style app.json with `experiments.baseUrl = "/mobile"` (already set)

set -euo pipefail

# ─── Config ─────────────────────────────────────────────────────
SSH_KEY="${SSH_KEY:-$HOME/.ssh/AATSKeyPair.pem}"
SSH_HOST="${SSH_HOST:-ubuntu@35.83.95.42}"
REMOTE_BUILD_DIR="${REMOTE_BUILD_DIR:-/var/www/zentromeet-mobile-build}"
REMOTE_WEB_DIR="${REMOTE_WEB_DIR:-/var/www/zentromeet-mobile-web}"
PUBLIC_URL="${PUBLIC_URL:-https://app.zentromeet.com/mobile/}"

# ─── Locate project root ────────────────────────────────────────
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$HERE/.." && pwd)"
cd "$PROJECT_ROOT"

echo "› Source: $PROJECT_ROOT"
echo "› Remote: $SSH_HOST:$REMOTE_BUILD_DIR  →  $REMOTE_WEB_DIR"
echo "› Public: $PUBLIC_URL"
echo

# ─── Stage 1: tar the source ────────────────────────────────────
echo "[1/5] Packing source (excluding node_modules / dist / .expo) …"
TARBALL="/tmp/zentromeet-mobile-src.tgz"
tar czf "$TARBALL" \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.expo' \
  --exclude='*.log' \
  -C "$(dirname "$PROJECT_ROOT")" \
  "$(basename "$PROJECT_ROOT")"
echo "      $(ls -la "$TARBALL" | awk '{print $5, $NF}')"

# ─── Stage 2: ship to EC2 ───────────────────────────────────────
echo "[2/5] Uploading to $SSH_HOST …"
scp -i "$SSH_KEY" -q "$TARBALL" "$SSH_HOST:/tmp/"

# ─── Stage 3-5: extract + npm install + build on EC2 ────────────
# Single SSH call so we don't pay the latency 5 times.
echo "[3/5] Extracting + installing on EC2 …"
echo "[4/5] Building Expo Web bundle (~30s) …"
echo "[5/5] Syncing dist/ to nginx-served dir …"

ssh -i "$SSH_KEY" "$SSH_HOST" bash -se <<REMOTE
set -euo pipefail
export NVM_DIR=\$HOME/.nvm
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
nvm use 18 >/dev/null

# Fresh extract — old artifacts gone.
rm -rf "$REMOTE_BUILD_DIR/dist" "$REMOTE_BUILD_DIR/app" "$REMOTE_BUILD_DIR/src" \
       "$REMOTE_BUILD_DIR/assets" "$REMOTE_BUILD_DIR/scripts"
mkdir -p "$REMOTE_BUILD_DIR"
tar xzf /tmp/zentromeet-mobile-src.tgz -C "$REMOTE_BUILD_DIR" --strip-components=1

cd "$REMOTE_BUILD_DIR"

# Only reinstall deps if package-lock changed (saves ~15s on iter rebuilds).
if [ ! -d node_modules ] || ! diff -q package-lock.json node_modules/.package-lock-snapshot 2>/dev/null; then
  echo "    › node_modules dirty — reinstalling"
  npm install --legacy-peer-deps --no-audit --no-fund >/tmp/npm.log 2>&1 || { tail -10 /tmp/npm.log; exit 1; }
  cp package-lock.json node_modules/.package-lock-snapshot
fi

# app.json plugins must be patched for the web build (expo-web-browser,
# expo-secure-store, expo-font config plugins crash the bundler on Node 18+).
# Their runtime imports still work — we just skip the config-plugin step.
node -e "
const fs = require('fs');
const j = JSON.parse(fs.readFileSync('app.json','utf8'));
j.expo.plugins = j.expo.plugins.filter(p => {
  const name = Array.isArray(p) ? p[0] : p;
  return name === 'expo-router' || name === 'expo-notifications';
});
fs.writeFileSync('app.json', JSON.stringify(j, null, 2));
"

node_modules/.bin/expo export --platform web --output-dir dist >/tmp/expo-build.log 2>&1 \
  || { tail -15 /tmp/expo-build.log; exit 1; }

rsync -a --delete "$REMOTE_BUILD_DIR/dist/" "$REMOTE_WEB_DIR/"
du -sh "$REMOTE_WEB_DIR" | awk '{print "    › published " \$1}'
REMOTE

# ─── Smoke ──────────────────────────────────────────────────────
echo
echo "› Smoke …"
code=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_URL")
echo "    $code  $PUBLIC_URL"
if [ "$code" != "200" ]; then
  echo "  ✗ public URL did not return 200 — check Cloudflare cache + nginx"
  exit 1
fi

echo
echo "✓ Deploy complete."
echo "  Open: $PUBLIC_URL"
