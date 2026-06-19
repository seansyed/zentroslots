import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Serve runtime-uploaded staff avatars from disk.
 *
 * WHY THIS EXISTS: Next.js's static `public/` handler only serves files that
 * existed at BUILD time (the static manifest is fixed by `next build`). Avatars
 * are written to `public/uploads/avatars/` at RUNTIME by
 * POST /api/users/[id]/avatar, so any avatar uploaded after the last build
 * 404s on the static path — the upload "succeeds" (DB + disk written) but the
 * image never displays (the <Avatar> falls back to initials). Verified on prod:
 * a build-time avatar returned 200 while a freshly-uploaded one returned 404.
 *
 * This route reads the same on-disk file at request time, so avatars display
 * regardless of when they were uploaded. Build-time avatars are still served by
 * the static handler (filesystem routes take precedence); this catches the
 * runtime-added ones. No DB/URL change — `users.avatar_url` stays
 * `/uploads/avatars/<file>`.
 *
 * Safe to expose unauthenticated: avatars are public by design (shown on the
 * public booking page); filenames are random-suffixed so they aren't
 * enumerable, and the static handler already served them publicly. The
 * middleware matcher excludes image extensions, so this never auth-gates.
 */

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export async function GET(
  _req: Request,
  context: { params: Promise<{ file: string }> },
): Promise<NextResponse> {
  const { file } = await context.params;

  // Path-traversal guard: a single filename, known image extension, no slashes
  // or `..`. Anything else is a 404 (never touch the filesystem with it).
  if (file.includes("/") || file.includes("\\") || file.includes("..")) {
    return new NextResponse("Not found", { status: 404 });
  }
  const match = /^[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/.exec(file);
  if (!match) {
    return new NextResponse("Not found", { status: 404 });
  }
  const ext = match[1].toLowerCase();

  const fullPath = path.join(process.cwd(), "public", "uploads", "avatars", file);
  try {
    const bytes = await fs.readFile(fullPath);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        // Filenames carry a random suffix and change on every upload, so the
        // content at a given URL never changes — immutable caching is safe and
        // doubles as cache-busting (a new upload is a new URL).
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
