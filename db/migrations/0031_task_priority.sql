-- 0031 — Task priority. STRICTLY ADDITIVE.
--
-- Adds a single nullable `priority` column to the existing `tasks`
-- table. Existing rows stay NULL; the client falls back to a
-- temporal heuristic (overdue/today/this-week) when priority is
-- absent so no row visually regresses. New rows created from the
-- Tasks UI persist an explicit priority chosen by the user.
--
-- Allowed values: 'urgent' | 'high' | 'medium' | 'low'
-- Validation is enforced in Zod at the API layer (see
-- app/api/tasks/route.ts patchSchema/createSchema). No DB-level
-- CHECK constraint so we can extend the vocabulary later without a
-- second migration.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS priority varchar(16);

-- Optional index for filtering / sorting by priority within a tenant.
-- Partial on NOT NULL so existing NULL-priority rows don't bloat it.
CREATE INDEX IF NOT EXISTS tasks_tenant_priority_idx
  ON tasks(tenant_id, priority)
  WHERE priority IS NOT NULL;
