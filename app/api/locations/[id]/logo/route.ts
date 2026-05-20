import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { db } from "@/db/client";
import { locations } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";

// Location logo upload — mirrors the staff avatar upload contract.
// Multipart POST writes to /public/uploads/locations/<id>-<random>.<ext>;
// nginx serves the file directly via the existing /uploads/ alias
// (no nginx change needed). Old logo is unlinked on replace.
//
// Identity gate: admin / manager only (locations are workspace
// infrastructure). Cross-tenant ids return 404 — we never disclose
// existence cross-tenant.
//
// File-safety: image/jpeg|png|webp only, 2 MB cap, extension derived
// from MIME (not the filename — same defense-in-depth as avatars).

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
};

function uploadsDir() {
  return path.join(process.cwd(), "public", "uploads", "locations");
}

async function unlinkPrevious(prevUrl: string | null | undefined) {
  if (!prevUrl) return;
  if (!prevUrl.startsWith("/uploads/locations/")) return;
  const filename = path.basename(prevUrl);
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) return;
  try {
    await fs.unlink(path.join(uploadsDir(), filename));
  } catch {
    // ignore — best-effort cleanup
  }
}

async function findInTenant(id: string, tenantId: string) {
  return db.query.locations.findFirst({
    where: and(eq(locations.id, id), eq(locations.tenantId, tenantId)),
  });
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const { id } = await context.params;
    const existing = await findInTenant(id, admin.tenantId);
    if (!existing) throw new HttpError(404, "Location not found");

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new HttpError(400, "Missing file");
    }

    const ext = ALLOWED[file.type];
    if (!ext) {
      throw new HttpError(415, "Unsupported file type — use JPG, PNG, or WebP");
    }
    if (file.size <= 0) throw new HttpError(400, "Empty file");
    if (file.size > MAX_BYTES) throw new HttpError(413, "Image too large — max 2 MB");

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) {
      throw new HttpError(413, "Image too large — max 2 MB");
    }

    const dir = uploadsDir();
    await fs.mkdir(dir, { recursive: true });

    const random = crypto.randomBytes(6).toString("hex");
    const filename = `${id}-${random}.${ext}`;
    const fullPath = path.join(dir, filename);
    await fs.writeFile(fullPath, bytes);

    const publicUrl = `/uploads/locations/${filename}`;

    await db
      .update(locations)
      .set({ logoUrl: publicUrl, updatedAt: new Date() })
      .where(and(eq(locations.id, id), eq(locations.tenantId, admin.tenantId)));

    await unlinkPrevious(existing.logoUrl);

    return NextResponse.json({ logoUrl: publicUrl });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const { id } = await context.params;
    const existing = await findInTenant(id, admin.tenantId);
    if (!existing) throw new HttpError(404, "Location not found");

    await db
      .update(locations)
      .set({ logoUrl: null, updatedAt: new Date() })
      .where(and(eq(locations.id, id), eq(locations.tenantId, admin.tenantId)));

    await unlinkPrevious(existing.logoUrl);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
