import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";

// POST /api/users/[id]/avatar — multipart upload of a profile image.
// DELETE /api/users/[id]/avatar — clears the image.
//
// Storage strategy (additive, no S3 dependency):
//   • Files land in /public/uploads/avatars/<userId>-<random>.<ext>
//   • Served as static assets via Next's public dir.
//   • `users.avatar_url` stores the public URL (`/uploads/avatars/…`).
//   • Old file (if any) is unlinked on replace so the directory
//     never grows unbounded for users who churn through images.
//   • `public/uploads/` is gitignored; lives on EC2 disk, survives
//     `next build` (the `.next` folder is rebuilt; `public` is not).
//
// Identity rules:
//   • Caller may upload for themselves (self-edit).
//   • Admin or manager may upload for any user in the SAME tenant.
//   • Cross-tenant uploads always rejected with 403.
//
// File-safety rules:
//   • Accept only image/jpeg, image/png, image/webp.
//   • Hard cap at 2 MB before disk write (rejects oversize early).
//   • Extension derived from MIME, not the filename — so a renamed
//     payload (e.g. malicious.exe disguised) won't land on disk
//     with an unexpected extension.

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
};

// Resolve the on-disk avatars directory. Outside this route the path
// is referenced via the public URL only; the filesystem path is
// strictly internal.
function avatarsDir() {
  return path.join(process.cwd(), "public", "uploads", "avatars");
}

async function assertCanEditUser(targetUserId: string) {
  const caller = await requireUser();
  if (caller.id === targetUserId) return caller; // self
  // For non-self edits the caller must be admin/manager in the same
  // tenant as the target. Look up the target user explicitly.
  if (caller.role !== "admin" && caller.role !== "manager") {
    throw new HttpError(403, "Forbidden");
  }
  const target = await db.query.users.findFirst({ where: eq(users.id, targetUserId) });
  if (!target) throw new HttpError(404, "User not found");
  if (target.tenantId !== caller.tenantId) {
    throw new HttpError(403, "User not in your workspace");
  }
  return caller;
}

// Best-effort unlink of the previous avatar so the public dir stays
// tidy. Silently swallows file-not-found and unreadable errors —
// we never want a stale-file glitch to block a successful upload.
async function unlinkPrevious(prevUrl: string | null | undefined) {
  if (!prevUrl) return;
  if (!prevUrl.startsWith("/uploads/avatars/")) return;
  const filename = path.basename(prevUrl);
  // Refuse to traverse out of the avatars dir.
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) return;
  try {
    await fs.unlink(path.join(avatarsDir(), filename));
  } catch {
    // ignore
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await assertCanEditUser(id);

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new HttpError(400, "Missing file");
    }

    const mime = file.type;
    const ext = ALLOWED[mime];
    if (!ext) {
      throw new HttpError(415, "Unsupported file type — use JPG, PNG, or WebP");
    }
    if (file.size <= 0) {
      throw new HttpError(400, "Empty file");
    }
    if (file.size > MAX_BYTES) {
      throw new HttpError(413, "Image too large — max 2 MB");
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    // Defense-in-depth: re-check size from the actual buffer.
    if (bytes.byteLength > MAX_BYTES) {
      throw new HttpError(413, "Image too large — max 2 MB");
    }

    const dir = avatarsDir();
    await fs.mkdir(dir, { recursive: true });

    // <userId>-<random>.<ext> — userId scopes the file, random
    // suffix lets old/new versions coexist briefly under a CDN
    // cache before unlink finalizes.
    const random = crypto.randomBytes(6).toString("hex");
    const filename = `${id}-${random}.${ext}`;
    const fullPath = path.join(dir, filename);
    await fs.writeFile(fullPath, bytes);

    const publicUrl = `/uploads/avatars/${filename}`;

    // Persist + unlink previous in parallel (unlink is best-effort).
    const prev = await db
      .select({ avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, id))
      .then((r) => r[0]?.avatarUrl ?? null);

    await db
      .update(users)
      .set({ avatarUrl: publicUrl, updatedAt: new Date() })
      .where(eq(users.id, id));

    await unlinkPrevious(prev);

    return NextResponse.json({ avatarUrl: publicUrl });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await assertCanEditUser(id);

    const prev = await db
      .select({ avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, id))
      .then((r) => r[0]?.avatarUrl ?? null);

    await db
      .update(users)
      .set({ avatarUrl: null, updatedAt: new Date() })
      .where(eq(users.id, id));

    await unlinkPrevious(prev);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
