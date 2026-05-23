/**
 * Server-side avatar fetcher (Phase 17I-8).
 *
 * Downloads a profile picture from an OAuth provider (Google's
 * `picture` claim URL or Microsoft Graph's `/me/photo/$value` binary)
 * and stores it under public/uploads/avatars/ using the EXACT same
 * convention POST /api/users/[id]/avatar uses for manual uploads.
 *
 * Why we cache locally instead of hotlinking:
 *   • Google avatar URLs (lh3.googleusercontent.com/...) carry
 *     short-ish lifetimes; we'd see broken images.
 *   • Microsoft Graph photo URLs require a bearer token; we'd have
 *     to refresh tokens forever to keep avatars alive.
 *   • Repeated lookups against provider endpoints waste rate-limit
 *     budget that the calendar sync flow needs.
 *
 * Storage convention (matches app/api/users/[id]/avatar/route.ts):
 *   • Path: public/uploads/avatars/<userId>-<random>.<ext>
 *   • DB column: users.avatar_url stores the public URL
 *     "/uploads/avatars/..." (NOT the disk path).
 *   • public/uploads/ is gitignored; lives on EC2 disk; survives
 *     `next build` (which only rebuilds .next/).
 *
 * Security posture:
 *   • Server-side fetch ONLY — provider URLs never go to the
 *     browser. The browser only ever sees the rewritten
 *     /uploads/avatars/... public URL.
 *   • Content-type validated by allowlist (jpg/png/webp).
 *   • Hard size cap (2 MB, matches the manual-upload route).
 *   • 5-second timeout on the fetch so a hung provider can't pin
 *     the OAuth callback request.
 *   • Magic-byte sniff after the buffer arrives, so a misreported
 *     content-type can't smuggle a non-image past the MIME check.
 *
 * NEVER throws — every failure logs to pm2 stderr and returns null
 * so the OAuth callback can safely fire-and-forget this without
 * risking the user's signin.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — same as manual upload
const FETCH_TIMEOUT_MS = 5_000;

const ALLOWED_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Magic-byte signatures so a misreported content-type can't smuggle a
// non-image past the MIME check. We tolerate the content-type lying
// (some Microsoft Graph responses return generic image/jpeg even when
// it's actually a PNG); the byte sniff is the authority.
function sniffExtension(bytes: Buffer): "jpg" | "png" | "webp" | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  // WebP: RIFF....WEBP (offset 8..12)
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

function avatarsDir() {
  return path.join(process.cwd(), "public", "uploads", "avatars");
}

export type FetchedAvatar = {
  /** Public URL stored on users.avatar_url. */
  publicUrl: string;
  /** Detected extension after sniff. */
  extension: "jpg" | "png" | "webp";
  /** Raw byte length on disk. */
  byteLength: number;
};

/**
 * Download an image from `url` over HTTPS, validate it, and write it
 * to public/uploads/avatars/<userId>-<random>.<ext>.
 *
 * `bearerToken` is used by the Microsoft Graph branch where the
 * provider photo endpoint requires Authorization. Google's `picture`
 * URL is publicly fetchable and bearerToken should be omitted.
 *
 * Returns null on any failure (network, timeout, bad MIME, too large,
 * write error) — the caller MUST treat avatar fetch as best-effort.
 */
export async function fetchAndStoreAvatar(args: {
  url: string;
  userId: string;
  bearerToken?: string;
}): Promise<FetchedAvatar | null> {
  // 5-second timeout via AbortController so a slow provider can't
  // pin the OAuth callback.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(args.url, {
      headers: args.bearerToken
        ? { Authorization: `Bearer ${args.bearerToken}` }
        : {},
      signal: controller.signal,
      // No redirect overrides — follow them normally so Google's
      // CDN re-routing still resolves.
      cache: "no-store",
    });
  } catch (e) {
    clearTimeout(timer);
    console.warn(
      `[avatar-fetch] fetch failed (user=${args.userId}):`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
  clearTimeout(timer);

  if (!res.ok) {
    // 404 is the common Microsoft Graph response when no photo is set
    // on the account — log at info level, not warn.
    if (res.status === 404) {
      console.info(`[avatar-fetch] no avatar set on provider (user=${args.userId})`);
    } else {
      console.warn(
        `[avatar-fetch] non-OK response (user=${args.userId}): ${res.status}`,
      );
    }
    return null;
  }

  // Content-type sanity check. Some providers send vendor-specific
  // mime variants (e.g. "image/jpeg; charset=UTF-8") so we normalize.
  const rawType = (res.headers.get("content-type") ?? "").toLowerCase();
  const baseType = rawType.split(";")[0].trim();
  // Allow either an explicit allowlist hit OR a generic "image/*" —
  // the byte sniff below is the authoritative gate.
  if (!ALLOWED_BY_CONTENT_TYPE[baseType] && !baseType.startsWith("image/")) {
    console.warn(
      `[avatar-fetch] bad content-type (user=${args.userId}): ${rawType}`,
    );
    return null;
  }

  // Size check BEFORE buffering — honor Content-Length when present.
  const contentLengthHeader = res.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      console.warn(
        `[avatar-fetch] declared size too large (user=${args.userId}): ${declared}`,
      );
      return null;
    }
  }

  let buffer: Buffer;
  try {
    const ab = await res.arrayBuffer();
    buffer = Buffer.from(ab);
  } catch (e) {
    console.warn(
      `[avatar-fetch] body read failed (user=${args.userId}):`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }

  // Post-buffer size check (defense in depth — some providers omit
  // Content-Length or chunk).
  if (buffer.byteLength > MAX_BYTES) {
    console.warn(
      `[avatar-fetch] body too large (user=${args.userId}): ${buffer.byteLength}`,
    );
    return null;
  }
  if (buffer.byteLength < 100) {
    // Smaller than any real photo — likely an error blob.
    console.warn(
      `[avatar-fetch] body too small (user=${args.userId}): ${buffer.byteLength}`,
    );
    return null;
  }

  // Magic-byte sniff — this is the security boundary.
  const ext = sniffExtension(buffer);
  if (!ext) {
    console.warn(
      `[avatar-fetch] body sniff rejected (user=${args.userId}, ct=${rawType})`,
    );
    return null;
  }

  // Write to disk using the same naming convention as the manual
  // upload route.
  const dir = avatarsDir();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    console.warn(
      `[avatar-fetch] mkdir failed (user=${args.userId}):`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
  const random = crypto.randomBytes(6).toString("hex");
  const filename = `${args.userId}-${random}.${ext}`;
  const fullPath = path.join(dir, filename);
  try {
    await fs.writeFile(fullPath, buffer);
  } catch (e) {
    console.warn(
      `[avatar-fetch] writeFile failed (user=${args.userId}):`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }

  return {
    publicUrl: `/uploads/avatars/${filename}`,
    extension: ext,
    byteLength: buffer.byteLength,
  };
}

/** Unlink a previously cached avatar file. Best-effort — silently
 *  swallows file-not-found so a stale reference doesn't break the
 *  caller. Mirrors the unlinkPrevious helper in the manual-upload
 *  route so behavior stays identical across both write paths. */
export async function unlinkAvatarFile(prevUrl: string | null | undefined): Promise<void> {
  if (!prevUrl) return;
  if (!prevUrl.startsWith("/uploads/avatars/")) return;
  const filename = path.basename(prevUrl);
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) return;
  try {
    await fs.unlink(path.join(avatarsDir(), filename));
  } catch {
    // ignore
  }
}
