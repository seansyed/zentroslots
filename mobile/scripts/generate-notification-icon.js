#!/usr/bin/env node
/**
 * generate-notification-icon.js — regenerate ONLY assets/notification-icon.png.
 *
 * The Android status-bar notification icon (app.json → expo-notifications
 * plugin) MUST be a WHITE silhouette on a TRANSPARENT background — Android
 * tints the opaque pixels with the channel color (#2563EB). The previous file
 * was an effectively-blank 96×96 RGBA PNG (~266 bytes), which renders as an
 * empty square in the status bar.
 *
 * This writes a crisp, anti-aliased white "Z" (the ZentroMeet mark) on
 * transparent, with safe padding. Pure Node (zlib only) — no deps, no native
 * binaries. It deliberately touches NOTHING else, so the real branded
 * icon.png / adaptive-icon.png / splash.png stay intact.
 *
 *   node scripts/generate-notification-icon.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePngRgba(width, height, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9); // RGBA
  const scan = 1 + width * 4;
  const raw = Buffer.alloc(scan * height);
  for (let y = 0; y < height; y++) {
    raw[y * scan] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = y * scan + 1 + x * 4;
      raw[d] = pixels[s]; raw[d + 1] = pixels[s + 1]; raw[d + 2] = pixels[s + 2]; raw[d + 3] = pixels[s + 3];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ─── Z geometry (in supersampled space) ─────────────────────────────
const W = 96, SS = 4, S = W * SS;
const margin = Math.round(S * 0.17); // safe padding around the glyph
const thick = Math.round(S * 0.155); // bar / diagonal thickness

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
function insideZ(x, y) {
  const lo = margin, hi = S - margin;
  if (x < lo || x > hi) return false;
  // top bar
  if (y >= lo && y <= lo + thick) return true;
  // bottom bar
  if (y >= hi - thick && y <= hi) return true;
  // diagonal (top-right → bottom-left)
  if (y >= lo && y <= hi) {
    const d = distToSeg(x, y, hi, lo + thick / 2, lo, hi - thick / 2);
    if (d <= thick / 2) return true;
  }
  return false;
}

const px = Buffer.alloc(W * W * 4); // all zero → transparent
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        if (insideZ(x * SS + sx + 0.5, y * SS + sy + 0.5)) hits++;
      }
    }
    const coverage = hits / (SS * SS);
    const o = (y * W + x) * 4;
    px[o] = 0xff; px[o + 1] = 0xff; px[o + 2] = 0xff; // white
    px[o + 3] = Math.round(coverage * 255); // alpha = coverage
  }
}

const out = path.join(__dirname, "..", "assets", "notification-icon.png");
fs.writeFileSync(out, encodePngRgba(W, W, px));
let opaque = 0;
for (let i = 3; i < px.length; i += 4) if (px[i] > 200) opaque++;
console.log(`wrote ${out} (${fs.statSync(out).size} bytes, ${W}x${W}, ${opaque} near-opaque white px)`);
