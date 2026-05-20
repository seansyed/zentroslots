import { z } from "zod";

export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(120),
  role: z.enum(["admin", "staff", "client"]).default("client"),
  timezone: z.string().default("UTC"),
  // Admin signup: workspaceName is required (a new tenant is created).
  // Staff/client signup: tenantSlug is required (joins an existing tenant).
  workspaceName: z.string().min(1).max(120).optional(),
  tenantSlug: z.string().min(1).max(80).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const videoProviderSchema = z.enum(["google_meet", "zoom", "teams", "none"]);

export const serviceSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, hyphens").min(1).max(80).optional(),
  description: z.string().optional(),
  durationMinutes: z.number().int().min(5).max(8 * 60),
  price: z.number().int().min(0).default(0),
  bufferBefore: z.number().int().min(0).max(240).default(0),
  bufferAfter: z.number().int().min(0).max(240).default(0),
  videoProvider: videoProviderSchema.default("google_meet"),
  staffUserIds: z.array(z.string().uuid()).default([]),
  // Direct department ownership (migration 0032). Optional — services
  // can be created unassigned; nullable so the operator can later
  // clear the assignment. The route validates the department belongs
  // to the caller's tenant before accepting.
  departmentId: z.string().uuid().nullable().optional(),
});

export const availabilityRuleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
});

export const availabilityPutSchema = z.object({
  rules: z.array(availabilityRuleSchema),
});

export const createBookingSchema = z.object({
  serviceId: z.string().uuid(),
  staffUserId: z.union([z.string().uuid(), z.literal("auto")]),
  startAt: z.string().datetime(),       // ISO UTC string
  clientName: z.string().min(1).max(120),
  clientEmail: z.string().email(),
  notes: z.string().max(2000).optional(),
  intakeResponses: z.record(z.unknown()).optional(),
});

export const slotsQuerySchema = z.object({
  serviceId: z.string().uuid(),
  staffUserId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1),
});

// ─── Availability overrides ────────────────────────────────────────────

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const hm = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "expected HH:MM");

export const overrideCreateSchema = z.object({
  userId: z.string().uuid().optional(), // defaults to caller; admin can target others
  date: ymd,
  unavailable: z.boolean().default(false),
  startTime: hm.optional(),
  endTime: hm.optional(),
  reason: z.string().max(200).optional(),
}).superRefine((v, ctx) => {
  if (v.unavailable && (v.startTime || v.endTime)) {
    ctx.addIssue({ code: "custom", message: "times must be empty when unavailable=true", path: ["unavailable"] });
  }
  if (!v.unavailable && (!v.startTime || !v.endTime)) {
    ctx.addIssue({ code: "custom", message: "startTime + endTime required when unavailable=false", path: ["startTime"] });
  }
});

export const overrideBulkSchema = z.object({
  userId: z.string().uuid().optional(),
  dates: z.array(ymd).min(1).max(366),
  unavailable: z.boolean().default(true),
  startTime: hm.optional(),
  endTime: hm.optional(),
  reason: z.string().max(200).optional(),
});

// ─── Booking status updates ────────────────────────────────────────────

export const bookingStatusSchema = z.object({
  status: z.enum(["pending", "confirmed", "cancelled", "completed", "no_show"]),
});

export const bookingRescheduleSchema = z.object({
  startAt: z.string().datetime(),
});

// ─── Public token-based actions ────────────────────────────────────────

export const publicRescheduleSchema = z.object({
  startAt: z.string().datetime(),
});
