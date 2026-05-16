import { db } from "@/db/client";
import { notifications, type NewNotification } from "@/db/schema";

/**
 * Fire-and-forget notification writer. NEVER throws — booking and
 * billing critical paths must not fail because a notification write
 * fails.
 */
export async function notify(entry: {
  tenantId: string;
  userId: string;
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const row: NewNotification = {
      tenantId: entry.tenantId,
      userId: entry.userId,
      kind: entry.kind,
      title: entry.title,
      body: entry.body ?? null,
      link: entry.link ?? null,
      metadata: entry.metadata ?? {},
    };
    await db.insert(notifications).values(row);
  } catch (err) {
    console.error("[notify] write failed:", err);
  }
}

/**
 * Notify many users with the same content. Same fire-and-forget
 * semantics — failures swallowed.
 */
export async function notifyMany(args: {
  tenantId: string;
  userIds: string[];
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (args.userIds.length === 0) return;
  try {
    const rows: NewNotification[] = args.userIds.map((userId) => ({
      tenantId: args.tenantId,
      userId,
      kind: args.kind,
      title: args.title,
      body: args.body ?? null,
      link: args.link ?? null,
      metadata: args.metadata ?? {},
    }));
    await db.insert(notifications).values(rows);
  } catch (err) {
    console.error("[notify] bulk write failed:", err);
  }
}
