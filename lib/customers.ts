/**
 * Customer-record upsert. Extracted to a shared module so both the
 * inline free-booking path (POST /api/bookings) and the
 * webhook-confirmed paid path can reuse the same logic.
 *
 * NEVER throws — returns null on failure. Booking flows must not
 * fail because of a customer-record issue.
 */

import { eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { customers } from "@/db/schema";

export async function upsertCustomer(args: {
  tenantId: string;
  name: string;
  email: string;
}): Promise<string | null> {
  try {
    const existing = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(
        sql`${customers.tenantId} = ${args.tenantId} AND lower(${customers.email}) = lower(${args.email})`
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].name !== args.name) {
        await db
          .update(customers)
          .set({ name: args.name, updatedAt: new Date() })
          .where(eq(customers.id, existing[0].id));
      }
      return existing[0].id;
    }
    const [row] = await db
      .insert(customers)
      .values({
        tenantId: args.tenantId,
        name: args.name,
        email: args.email,
      })
      .returning();
    return row.id;
  } catch (err) {
    console.error("[customers] upsert failed:", err);
    return null;
  }
}
