-- Drop the partial unique index on (province_code, locality_slug). INDEC
-- legitimately has multiple localities with the same name within a single
-- province (in different departments) — 68 such collisions across the real
-- dataset (as of 2026-05-18 import). Examples:
--   Catamarca: "Las Juntas" in Ambato y "Las Juntas" en El Alto
--   Santiago del Estero: 4 distinct "San Pedro" localities
--
-- Uniqueness is enforced by `indec_id` (column-level unique constraint),
-- which is the canonical identifier we should rely on anyway.
--
-- The slug remains useful as a denormalized URL/lookup convenience — it just
-- isn't unique within a province. Lookups by name return multiple results
-- in those rare cases; the typeahead UI surfaces all of them with their
-- department names disambiguated.
--
-- Idempotent: DROP INDEX IF EXISTS.

drop index if exists "public"."ar_localities_province_slug_uniq";

-- Replace with a non-unique partial index on the same columns so lookups by
-- (province, slug) stay cheap.
create index if not exists "ar_localities_province_slug_idx"
  on "public"."ar_localities" ("province_code", "locality_slug")
  where "removed_at" is null;
