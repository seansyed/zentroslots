-- 0013 — Add 'manager' value to user_role enum.
-- Strictly additive. Existing admin/staff/client values untouched, no
-- existing data is rewritten. Postgres requires ADD VALUE outside an
-- explicit transaction when the new value is referenced in the same
-- transaction; we only add it here, so a plain ALTER is safe.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'manager';
