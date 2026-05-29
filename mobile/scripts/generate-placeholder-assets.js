#!/usr/bin/env node
/**
 * generate-placeholder-assets.js — Produce the 5 PNG assets that
 * `app.json` references so EAS Build doesn't fail on missing files.
 *
 * Brand-color (#359df3) backgrounds with a centered white "Z" mark.
 * Pure Node (zlib + crypto + Buffer) — no external dependencies and
 * no native binaries needed. Run once after `git clone`:
 *
 *   node scripts/generate-placeholder-assets.js
 *
 * Output (overwrites if present):
 *   assets/icon.png             1024×1024
 *   assets/adaptive-icon.png    1024×1024
 *   assets/notification-icon.png  96×96    (Android channel icon — white silhouette)
 *   assets/splash.png           1284×2778
 *   assets/favicon.png            48×48
 *
 * These are PLACEHOLDERS. Swap in real branded ZentroMeet assets at
 * the same paths whenever you have them — no code changes required.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ─── CRC32 (PNG chunk integrity) ────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

// ─── PNG encoder for RGBA images ────────────────────────────────────
function encodePngRgba(width, height, pixelsRGBA) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type 6 = RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  // Each scanline gets a leading filter byte (0 = None).
  const scanlineSize = 1 + width * 4;
  const raw = Buffer.alloc(scanlineSize * height);
  for (let y = 0; y < height; y++) {
    raw[y * scanlineSize] = 0;
    for (let x = 0; x < width; x++) {
      const srcOff = (y * width + x) * 4;
      const dstOff = y * scanlineSize + 1 + x * 4;
      raw[dstOff] = pixelsRGBA[srcOff];
      raw[dstOff + 1] = pixelsRGBA[srcOff + 1];
      raw[dstOff + 2] = pixelsRGBA[srcOff + 2];
      raw[dstOff + 3] = pixelsRGBA[srcOff + 3];
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─── Drawing helpers ────────────────────────────────────────────────
// We work directly with a Uint8Array of RGBA bytes. Tiny custom raster
// is easier than pulling a Canvas polyfill.

const BRAND = { r: 0x35, g: 0x9d, b: 0xf3 }; // #359df3
const BRAND_DEEP = { r: 0x1d, g: 0x7b, b: 0xd1 }; // #1d7bd1 — deeper brand
const VIOLET = { r: 0x8b, g: 0x5c, b: 0xf6 }; // #8b5cf6 accent
const WHITE = { r: 0xff, g: 0xff, b: 0xff };
const INK = { r: 0x0f, g: 0x17, b: 0x2a };
const BG_LIGHT = { r: 0xf5, g: 0xfa, b: 0xff }; // splash background (slight blue tint)

// Linear interpolation between two RGB colors.
function mix(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function makeCanvas(width, height, bg) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      buf[o] = bg.r;
      buf[o + 1] = bg.g;
      buf[o + 2] = bg.b;
      buf[o + 3] = 0xff;
    }
  }
  return buf;
}

/** Diagonal gradient — top-left → bottom-right. Brand → deeper-brand
 *  with a violet hint near the corner gives the icon a richer feel
 *  than a flat color. */
function makeGradientCanvas(width, height, colorA, colorB, accent) {
  const buf = Buffer.alloc(width * height * 4);
  const maxDist = Math.sqrt(width * width + height * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = Math.sqrt(x * x + y * y) / maxDist;
      const base = mix(colorA, colorB, t);
      // Apply a violet "halo" in the top-right quadrant
      let final = base;
      if (accent) {
        const dx = x - width * 0.78;
        const dy = y - height * 0.18;
        const distA = Math.sqrt(dx * dx + dy * dy);
        const radiusA = width * 0.45;
        if (distA < radiusA) {
          const k = (1 - distA / radiusA) * 0.35;
          final = mix(base, accent, k);
        }
      }
      const o = (y * width + x) * 4;
      buf[o] = final.r;
      buf[o + 1] = final.g;
      buf[o + 2] = final.b;
      buf[o + 3] = 0xff;
    }
  }
  return buf;
}

/** Filled circle — used to add ambient depth on splash. */
function fillCircle(buf, w, h, cx, cy, r, color, alpha) {
  const a = alpha ?? 1;
  const xs = Math.max(0, Math.floor(cx - r));
  const xe = Math.min(w, Math.ceil(cx + r));
  const ys = Math.max(0, Math.floor(cy - r));
  const ye = Math.min(h, Math.ceil(cy + r));
  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const o = (y * w + x) * 4;
      const oldR = buf[o];
      const oldG = buf[o + 1];
      const oldB = buf[o + 2];
      buf[o] = Math.round(oldR + (color.r - oldR) * a);
      buf[o + 1] = Math.round(oldG + (color.g - oldG) * a);
      buf[o + 2] = Math.round(oldB + (color.b - oldB) * a);
    }
  }
}

function fillRect(buf, w, h, x0, y0, x1, y1, color, alpha = 0xff) {
  const xs = Math.max(0, Math.min(w, Math.floor(x0)));
  const xe = Math.max(0, Math.min(w, Math.floor(x1)));
  const ys = Math.max(0, Math.min(h, Math.floor(y0)));
  const ye = Math.max(0, Math.min(h, Math.floor(y1)));
  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      const o = (y * w + x) * 4;
      buf[o] = color.r;
      buf[o + 1] = color.g;
      buf[o + 2] = color.b;
      buf[o + 3] = alpha;
    }
  }
}

/** Bresenham-style thick line — used for the Z diagonal. */
function fillDiagonal(buf, w, h, x0, y0, x1, y1, thickness, color) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.ceil(len * 1.5);
  const half = thickness / 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = x0 + dx * t;
    const cy = y0 + dy * t;
    fillRect(buf, w, h, cx - half, cy - half, cx + half, cy + half, color);
  }
}

/** Draw a stylized "Z" mark centered in a bounding box. */
function drawZ(buf, w, h, cx, cy, size, color) {
  const half = size / 2;
  const barThickness = size * 0.18;
  const x0 = cx - half;
  const x1 = cx + half;
  const yTop = cy - half;
  const yBottom = cy + half;
  // Top bar
  fillRect(buf, w, h, x0, yTop, x1, yTop + barThickness, color);
  // Bottom bar
  fillRect(buf, w, h, x0, yBottom - barThickness, x1, yBottom, color);
  // Diagonal — runs from top-right to bottom-left
  fillDiagonal(
    buf,
    w,
    h,
    x1 - barThickness * 0.4,
    yTop + barThickness * 1.05,
    x0 + barThickness * 0.4,
    yBottom - barThickness * 1.05,
    barThickness,
    color,
  );
}

// ─── Per-asset compositions ─────────────────────────────────────────

function buildIcon(size) {
  // Brand gradient + violet accent + centered white Z mark.
  const buf = makeGradientCanvas(size, size, BRAND, BRAND_DEEP, VIOLET);
  // Subtle outer "sheen" ring
  fillCircle(buf, size, size, size * 0.32, size * 0.28, size * 0.18, WHITE, 0.06);
  drawZ(buf, size, size, size / 2, size / 2, size * 0.62, WHITE);
  return encodePngRgba(size, size, buf);
}

function buildAdaptiveIcon(size) {
  // Android adaptive icon foreground — mask-safe area is the inner 66%
  // of the canvas. Use the same gradient so the launcher background
  // colour blends smoothly with the foreground edge.
  const buf = makeGradientCanvas(size, size, BRAND, BRAND_DEEP, VIOLET);
  drawZ(buf, size, size, size / 2, size / 2, size * 0.42, WHITE);
  return encodePngRgba(size, size, buf);
}

function buildNotificationIcon(size) {
  // Android channel icons MUST be a white silhouette on transparent.
  // Anything else renders as a solid white square on most OEM skins.
  const buf = Buffer.alloc(size * size * 4); // already 0,0,0,0 = transparent
  drawZ(buf, size, size, size / 2, size / 2, size * 0.7, WHITE);
  return encodePngRgba(size, size, buf);
}

function buildSplash(width, height) {
  // Premium splash: very light blue background + 3 ambient blobs (one
  // brand, one violet, one success) + the brand mark in deep brand
  // hue. Matches the GradientHeroCard treatment on Home for visual
  // continuity between cold-start and first interactive frame.
  const buf = makeCanvas(width, height, BG_LIGHT);
  const minDim = Math.min(width, height);
  // Ambient blobs — placed off-center for visual rhythm.
  fillCircle(buf, width, height, width * 0.82, height * 0.18, minDim * 0.45, BRAND, 0.10);
  fillCircle(buf, width, height, width * 0.12, height * 0.82, minDim * 0.50, VIOLET, 0.06);
  fillCircle(buf, width, height, width * 0.62, height * 0.55, minDim * 0.30, BRAND_DEEP, 0.04);
  // Brand mark — deep brand for contrast against light background.
  drawZ(buf, width, height, width / 2, height / 2, minDim * 0.32, BRAND_DEEP);
  return encodePngRgba(width, height, buf);
}

function buildFavicon(size) {
  // Use the same gradient as the main icon — the favicon shows up in
  // browser tabs alongside other tools, so the polished feel matters.
  const buf = makeGradientCanvas(size, size, BRAND, BRAND_DEEP, VIOLET);
  drawZ(buf, size, size, size / 2, size / 2, size * 0.7, WHITE);
  return encodePngRgba(size, size, buf);
}

// silence unused INK linter when imported only in future expansions
void INK;

// ─── Write outputs ──────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "assets");
fs.mkdirSync(OUT, { recursive: true });

const targets = [
  { name: "icon.png", buf: () => buildIcon(1024) },
  { name: "adaptive-icon.png", buf: () => buildAdaptiveIcon(1024) },
  { name: "notification-icon.png", buf: () => buildNotificationIcon(96) },
  { name: "splash.png", buf: () => buildSplash(1284, 2778) },
  { name: "favicon.png", buf: () => buildFavicon(48) },
];

const summary = [];
for (const t of targets) {
  const out = path.join(OUT, t.name);
  const data = t.buf();
  fs.writeFileSync(out, data);
  summary.push({ name: t.name, bytes: data.length });
}

console.log(
  JSON.stringify({ evt: "placeholder_assets_written", outDir: OUT, files: summary }, null, 2),
);
