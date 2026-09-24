-- ────────────────────────────────────────────────────────────────────────────
-- 0070_unaccent_extension.sql
-- Enable the unaccent extension for accent-insensitive text matching.
--
-- Powers the rabies vaccine-name predicate in govt dashboards so that accented
-- forms like "antirrábica" / "Vacuna Antirrábica" are counted alongside the
-- ASCII variants "rabia" and "rabies".
--
-- Idempotent (IF NOT EXISTS). The extension was first referenced inside a
-- PL/pgSQL function in migration 0055; this migration makes the dependency
-- explicit as a standalone DDL step.
-- ────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS unaccent;
