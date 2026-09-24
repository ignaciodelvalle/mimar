-- Migration 0064: add 'finder' value to the author_role enum.
--
-- 'finder' identifies events authored by an anonymous third party who physically
-- has the pet and submits a report via /p/[token]/encontre. Previously these
-- events fell back to 'scanner', which is semantically incorrect.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block in Postgres.
-- Do NOT wrap this statement in BEGIN/COMMIT. The backfill UPDATE that relies on
-- the new value lives in the next migration (0065) so the value is committed first.

alter type "public"."author_role" add value if not exists 'finder';
