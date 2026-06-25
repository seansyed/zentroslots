#!/usr/bin/env bash
# =============================================================================
# check-16kb-alignment.sh
# -----------------------------------------------------------------------------
# Verifies that every 64-bit native shared library (.so) packaged inside an
# Android App Bundle (.aab) or APK has its ELF LOAD segments aligned to at
# least 16 KB (16384 bytes). This is exactly what Google Play's
#   "Your app does not support 16 KB memory page sizes"
# check enforces: on a 16 KB-page device the dynamic loader can only map a
# library whose loadable segments are 16 KB-aligned.
#
# Scope: the requirement is 64-bit-only (arm64-v8a, x86_64), because 16 KB
# pages are a 64-bit feature. 32-bit libraries (armeabi-v7a, x86) are EXEMPT
# and correctly remain 4 KB-aligned, so they are reported but never fail.
#
# Usage:
#   scripts/check-16kb-alignment.sh path/to/app-release.aab
#   scripts/check-16kb-alignment.sh path/to/app-release.apk
#
# Exit codes:
#   0  all .so are >= 16 KB aligned (or the archive has no native code)
#   1  at least one .so is NOT 16 KB aligned  -> would be REJECTED by Play
#   2  usage / tooling error (could not inspect)
#
# Tooling: prefers llvm-readelf (shipped with NDK 27), falls back to the
# system readelf (binutils) and finally llvm-objdump/objdump. On a Codemagic
# linux_x2 image at least one of these is always present after `expo prebuild`
# has provisioned the NDK.
# =============================================================================
set -euo pipefail

ARCHIVE="${1:-}"
PAGE=16384

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "ERROR: pass a path to an existing .aab or .apk file" >&2
  echo "Usage: $0 path/to/app-release.aab" >&2
  exit 2
fi

# --- locate an ELF-inspection tool ------------------------------------------
READELF=""
for cand in "$(command -v llvm-readelf 2>/dev/null || true)" \
            "$(command -v readelf 2>/dev/null || true)"; do
  if [ -n "$cand" ]; then READELF="$cand"; break; fi
done
if [ -z "$READELF" ]; then
  for base in "${ANDROID_NDK_HOME:-}" "${ANDROID_NDK_ROOT:-}" \
              "${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}/ndk"; do
    [ -n "$base" ] && [ -d "$base" ] || continue
    f=$(find "$base" -name "llvm-readelf" -type f 2>/dev/null | sort | tail -1 || true)
    if [ -n "$f" ]; then READELF="$f"; break; fi
  done
fi
OBJDUMP="$(command -v llvm-objdump 2>/dev/null || command -v objdump 2>/dev/null || true)"

if [ -z "$READELF" ] && [ -z "$OBJDUMP" ]; then
  echo "ERROR: no readelf/llvm-readelf/objdump available to inspect .so alignment" >&2
  exit 2
fi

# --- unpack -----------------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -qo "$ARCHIVE" -d "$TMP"

# AAB stores libs under base/lib/<abi>/*.so ; APK under lib/<abi>/*.so
mapfile -t SOS < <(find "$TMP" -type f -name "*.so" -path "*/lib/*" | sort)

if [ "${#SOS[@]}" -eq 0 ]; then
  echo "No native .so libraries found under lib/ in $(basename "$ARCHIVE")."
  echo "Nothing to align — trivially 16 KB compatible."
  exit 0
fi

# --- inspect each library ---------------------------------------------------
# Returns the minimum LOAD-segment alignment (in bytes) for one .so.
min_load_align() {
  local so="$1" min=0 a d
  if [ -n "$READELF" ]; then
    # readelf -lW: program headers, one LOAD per line, Align is the last column
    # (hex, e.g. 0x4000 / 0x10000 for 16 KB+, 0x1000 for 4 KB).
    while read -r a; do
      [ -n "$a" ] || continue
      d=$(( a ))                 # bash parses 0x.. hex directly
      if [ "$min" -eq 0 ] || [ "$d" -lt "$min" ]; then min="$d"; fi
    done < <("$READELF" -lW "$so" 2>/dev/null | awk '$1=="LOAD"{print $NF}')
  else
    # objdump -p prints "... align 2**N" on each LOAD line.
    while read -r d; do
      [ -n "$d" ] || continue
      if [ "$min" -eq 0 ] || [ "$d" -lt "$min" ]; then min="$d"; fi
    done < <("$OBJDUMP" -p "$so" 2>/dev/null | awk '
      /LOAD/ { for (i=1;i<=NF;i++) if ($i ~ /2\*\*/) { split($i,b,"\\*\\*"); print 2**b[2] } }')
  fi
  echo "$min"
}

# Google Play's 16 KB requirement applies ONLY to 64-bit ABIs (arm64-v8a,
# x86_64). 16 KB memory pages are a 64-bit-only feature, so the 32-bit ABIs
# (armeabi-v7a, x86) are EXEMPT and legitimately remain 4 KB-aligned — failing
# on them would be a false positive. We enforce alignment on 64-bit only.
is_64bit_abi() { case "$1" in arm64-v8a|x86_64) return 0 ;; *) return 1 ;; esac; }

fail=0; n64=0; n32=0
printf "%-46s %12s  %s\n" "LIBRARY (abi/name)" "MIN ALIGN" "RESULT"
printf '%s\n' "---------------------------------------------------------------------------"
for so in "${SOS[@]}"; do
  rel="$(echo "$so" | sed -E 's#^.*/lib/##')"   # e.g. arm64-v8a/libhermes.so
  abi="${rel%%/*}"
  m="$(min_load_align "$so")"
  if is_64bit_abi "$abi"; then
    n64=$((n64 + 1))
    if [ "$m" -eq 0 ]; then
      printf "%-46s %12s  %s\n" "$rel" "?" "UNKNOWN (could not read)"
      fail=1
    elif [ $(( m % PAGE )) -eq 0 ] && [ "$m" -ge "$PAGE" ]; then
      printf "%-46s %12s  %s\n" "$rel" "$m" "OK (>=16K)"
    else
      printf "%-46s %12s  %s\n" "$rel" "$m" "FAIL (<16K)"
      fail=1
    fi
  else
    n32=$((n32 + 1))
    printf "%-46s %12s  %s\n" "$rel" "${m:-?}" "SKIP (32-bit, exempt)"
  fi
done
printf '%s\n' "---------------------------------------------------------------------------"
echo "64-bit libs enforced: $n64   |   32-bit libs skipped (exempt): $n32"

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "RESULT: ✗ One or more 64-bit native libraries are NOT 16 KB aligned."
  echo "Google Play would reject this build with the 16 KB page-size error."
  exit 1
fi

echo ""
echo "RESULT: ✓ All $n64 64-bit native libraries (arm64-v8a, x86_64) are 16 KB aligned. Play-compliant."
exit 0
