/**
 * Authenticated symmetric encryption for credentials at rest.
 *
 * AES-256-GCM with a 12-byte random IV per encryption. Output is a
 * compact "v1:<iv>:<ciphertext>:<tag>" string (all base64url) so it's
 * safe to store in a single text column and we can rotate the format
 * later by bumping the version prefix.
 *
 * Key source: env `COMMS_ENCRYPTION_KEY`, 64 hex chars (32 bytes). If
 * absent the module throws on first use — fail fast rather than store
 * unencrypted secrets.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const FORMAT_VERSION = "v1";
const ALG = "aes-256-gcm";

function loadKey(): Buffer {
  const raw = process.env.COMMS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "COMMS_ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32"
    );
  }
  const buf = Buffer.from(raw.trim(), "hex");
  if (buf.length !== 32) {
    throw new Error(
      `COMMS_ENCRYPTION_KEY must be 32 bytes (64 hex chars); got ${buf.length} bytes`
    );
  }
  return buf;
}

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) cachedKey = loadKey();
  return cachedKey;
}

function b64u(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64u(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/**
 * Encrypts a plaintext string. Returns the versioned envelope. Returns
 * null for null/undefined/empty input — convenient for optional fields.
 */
export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${FORMAT_VERSION}:${b64u(iv)}:${b64u(ct)}:${b64u(tag)}`;
}

/**
 * Decrypts a versioned envelope. Throws on tampering (auth tag fails).
 * Returns null for null/undefined input.
 */
export function decryptSecret(envelope: string | null | undefined): string | null {
  if (!envelope) return null;
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Encrypted envelope has unexpected format");
  }
  const [, ivB64, ctB64, tagB64] = parts;
  const iv = fromB64u(ivB64);
  const ct = fromB64u(ctB64);
  const tag = fromB64u(tagB64);
  const decipher = createDecipheriv(ALG, key(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Redacts a secret for display: returns "•••" + last 4 chars. Pass the
 * PLAINTEXT (briefly held in memory during a write) — never pass the
 * ciphertext envelope, that's not a useful preview.
 */
export function previewSecret(plaintext: string | null | undefined): string {
  if (!plaintext) return "";
  if (plaintext.length <= 4) return "•••";
  return "•••" + plaintext.slice(-4);
}
