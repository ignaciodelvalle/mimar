-- Migration 0102 — Shelter census & occupancy (Wave 3 Item 16)
--
-- ADDITIVE ONLY: nullable integer columns on organizations.
-- No backfill, no NOT NULL, no DROP, no data change.
-- Safe to apply to production with zero downtime.
--
-- Capacity is optional (NULL = not declared). Occupancy is always derived from
-- active shelter_custody ownerships via lib/org-census.ts (pure projection).
--
-- See: docs/superpowers/specs/2026-06-18-wave3-org-ops-handoff.md §Item 16 D1

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS capacity_dogs  integer,
  ADD COLUMN IF NOT EXISTS capacity_cats  integer,
  ADD COLUMN IF NOT EXISTS capacity_other integer,
  ADD COLUMN IF NOT EXISTS capacity_total integer;

COMMENT ON COLUMN organizations.capacity_dogs  IS 'Declared dog capacity (Item 16 D1). NULL = not configured.';
COMMENT ON COLUMN organizations.capacity_cats  IS 'Declared cat capacity (Item 16 D1). NULL = not configured.';
COMMENT ON COLUMN organizations.capacity_other IS 'Declared capacity for other species (Item 16 D1). NULL = not configured.';
COMMENT ON COLUMN organizations.capacity_total IS 'Declared total capacity across all species (Item 16 D1). NULL = not configured.';
