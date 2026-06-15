/**
 * Departments API client.
 *
 *   GET   /api/departments    — list departments for the calling tenant,
 *                               each enriched with operational counts
 *   POST  /api/departments    — create (admin|manager only, 201)
 *
 * The list endpoint returns per-department aggregates derived honestly
 * from existing tables (staffCount, serviceCount, assignedServiceNames,
 * bookingsLast30d) so a single fetch paints the whole management screen.
 *
 * ── BACKEND GAP (out of scope, flagged) ──────────────────────────────
 * There is NO `app/api/departments/[id]/route.ts` on the backend, so
 * UPDATE and DELETE are not possible from mobile yet. Editing/deleting a
 * department still has to happen on the web dashboard. When the backend
 * adds `PATCH /api/departments/:id` and `DELETE /api/departments/:id`,
 * wire `update()` / `remove()` here (apiPatch/apiDelete are already
 * imported in the client) and add the matching mutation hooks +
 * affordances on the screen. Do NOT fabricate calls against the
 * non-existent route — they would 404/405.
 */

import { apiGet, apiPost } from "./client";

/** Create payload — mirrors the backend POST /api/departments zod schema.
 *  `name` required; `color` (hex #RRGGBB) and `description` optional. */
export type DepartmentCreateInput = {
  name: string;
  color?: string | null;
  description?: string | null;
};

export type Department = {
  id: string;
  tenantId: string;
  name: string;
  /** Brand hex like "#359df3", or null when none was chosen. */
  color: string | null;
  description: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  // Operational aggregates the list endpoint folds in per row.
  staffCount: number;
  serviceCount: number;
  /** Up to 3 service names owned by this department (alphabetical). */
  assignedServiceNames: string[];
  bookingsLast30d: number;
};

export type DepartmentListResponse = Department[];

export const departmentsApi = {
  /** List every department for the tenant (alphabetical), with counts. */
  async list(): Promise<DepartmentListResponse> {
    return apiGet<DepartmentListResponse>("/api/departments");
  },

  /** Create a department. Backend returns the created row (201). Writes
   *  require admin|manager — a non-managerial caller gets 403. */
  async create(input: DepartmentCreateInput): Promise<Department> {
    return apiPost<Department, DepartmentCreateInput>("/api/departments", input);
  },

  // NOTE: update(id, input) and remove(id) intentionally omitted — the
  // backend exposes no /api/departments/[id] route yet. See file header.
};
