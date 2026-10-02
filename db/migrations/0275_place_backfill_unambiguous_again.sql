-- ────────────────────────────────────────────────────────────────────────────
-- 0275_place_backfill_unambiguous_again.sql
-- Cases and welfare reports written with a locality NAME and no catalogue id
-- since 0251 get their id where it can be given honestly — and say how.
--
-- WHY (localidades CABA + Córdoba, 2026-10, change C2)
-- ---------------------------------------------------------------------------
-- With `scope` and `routing` on the id path, a row that carries a locality
-- name but no `locality_id` is unresolved: only whole-province holders see it.
-- Several case writers kept the name and dropped the id — the lost writer's
-- home fallback above all (15 CABA lost cases on staging, created 28/9–2/10,
-- invisible to the Palermo holder once scope reads ids). The writers are fixed
-- in the same work unit and fenced by
-- __tests__/case-writers-offer-locality-id.test.ts; this migration recovers
-- the rows they already wrote.
--
-- THE RULES (0251's, plus one; never a guess)
-- ---------------------------------------------------------------------------
-- Only rows with NO id and a non-empty locality name are touched, and never a
-- row a writer explicitly declared `place_method = 'unresolved'`.
--
--   A. A pet-subject CASE whose writer files it at the pet's HOME by
--      construction (the opened_reason codes listed below), whose pair names
--      the pet's own catalogue row, takes the pet's `locality_id` — method
--      `spine_rederived` (the pet's id comes from the spine: registration or
--      a jurisdiction move). This is the only rule that can resolve a homonym
--      (San Pedro, Córdoba), because the pet already says which one. It does
--      NOT apply when:
--        - the case kind can be filed where something HAPPENED (a lost or
--          bite report's incident place, a denuncia, a seizure filed at the
--          seizing authority's place): the same name there may be the other
--          twin, so the pet's id would be a guess;
--        - the pet recorded a movement after the case was opened (its id may
--          name a later home of the same name);
--        - the pet's catalogue row is removed, or is not the row the case's
--          pair names (same province code, same catalogue spelling).
--   B. Everything else (cases and welfare reports): the pair names exactly ONE
--      live catalogue row in its province → that id, method
--      `legacy_unique_name`. 0251 verbatim.
--   Homonyms no rule resolves stay NULL: province-level, for the admin queue
--   (/admin/localidades/pendientes).
--
-- IDEMPOTENT: every UPDATE requires `locality_id IS NULL`, so a re-run matches
-- nothing new. The NOTICE lines are the before/after inventory per table, and
-- name the rows each rule filled.
--
-- SIDE EFFECT, accepted as in 0251: the cases BEFORE UPDATE trigger stamps
-- `updated_at` on every case filled here.
--
-- ROLLBACK (forward): UPDATE <table> SET locality_id = NULL, place_method =
-- NULL WHERE id = ANY(<the ids this migration's NOTICE lines list>).
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  before_cases integer;
  before_welfare integer;
  after_cases integer;
  after_welfare integer;
  homonym_cases integer;
  homonym_welfare integer;
  filled_ids text;
  filled integer;
BEGIN
  SELECT count(*)::int INTO before_cases
    FROM public.cases
   WHERE locality_id IS NULL AND jurisdiction_locality IS NOT NULL AND jurisdiction_locality <> '';
  SELECT count(*)::int INTO before_welfare
    FROM public.welfare_reports
   WHERE locality_id IS NULL AND jurisdiction_locality IS NOT NULL AND jurisdiction_locality <> '';
  RAISE NOTICE '0275 before: cases % row(s) with a name and no id; welfare_reports % row(s)',
    before_cases, before_welfare;

  -- Rule A ------------------------------------------------------------------
  WITH home AS (
    SELECT c.id AS case_id, p.locality_id
      FROM public.cases c
      JOIN public.pets p ON p.id = c.primary_pet_id
      JOIN public.ar_localities l ON l.id = p.locality_id
     WHERE c.locality_id IS NULL
       AND c.place_method IS DISTINCT FROM 'unresolved'
       AND c.jurisdiction_locality IS NOT NULL
       AND c.jurisdiction_locality <> ''
       -- Writers that file the case at the pet's home pair, whole, by
       -- construction (every openCase site is enumerated by the fence named
       -- in the header). Not here: pet_marked_lost, bite_reported_*,
       -- welfare_report_*, decomiso_* (the seizing authority's place),
       -- outbreak_investigation_manual (no pet), adoption_* (no place).
       AND c.opened_reason_code IN (
         'cross_org_transfer_proposed',
         'custody_dispute_raised',
         'custody_handoff_direct',
         'foster_placement_assigned',
         'foster_proposal_sent',
         'lost_search_reactivated',
         'microchip_replaced',
         'org_intake',
         'rehome_requested'
       )
       -- The case's pair names the pet's OWN catalogue row (same province
       -- code, same catalogue spelling): compared through the row, never
       -- name against name (lint:locality-name-join).
       AND l.removed_at IS NULL
       AND l.province_code = public.ar_province_code(c.jurisdiction_province)
       AND l.locality_name = c.jurisdiction_locality
       AND NOT EXISTS (
         SELECT 1 FROM public.pet_events e
          WHERE e.pet_id = p.id
            AND e.event_type = 'movement_recorded'
            AND e.recorded_at > c.opened_at
       )
  ), done AS (
    UPDATE public.cases c
       SET locality_id = h.locality_id,
           place_method = 'spine_rederived'
      FROM home h
     WHERE c.id = h.case_id
    RETURNING c.id
  )
  SELECT count(*)::int, coalesce(string_agg(id::text, ',' ORDER BY id), '')
    INTO filled, filled_ids
    FROM done;
  RAISE NOTICE '0275 rule A (pet home, spine_rederived): cases % row(s) [%]', filled, filled_ids;

  -- Rule B (0251 verbatim, on the two tables whose writers dropped the id) ---
  WITH unique_rows AS (
    SELECT l.province_code, l.locality_name, min(l.id::text)::uuid AS locality_id
      FROM public.ar_localities l
     WHERE l.removed_at IS NULL
     GROUP BY l.province_code, l.locality_name
    HAVING count(*) = 1
  ), done AS (
    UPDATE public.cases t
       SET locality_id = u.locality_id,
           place_method = 'legacy_unique_name'
      FROM unique_rows u
     WHERE t.locality_id IS NULL
       AND t.place_method IS DISTINCT FROM 'unresolved'
       AND t.jurisdiction_locality IS NOT NULL
       AND t.jurisdiction_locality <> ''
       AND u.province_code = public.ar_province_code(t.jurisdiction_province)
       AND u.locality_name = t.jurisdiction_locality
    RETURNING t.id
  )
  SELECT count(*)::int, coalesce(string_agg(id::text, ',' ORDER BY id), '')
    INTO filled, filled_ids
    FROM done;
  RAISE NOTICE '0275 rule B (unique name, legacy_unique_name): cases % row(s) [%]', filled, filled_ids;

  WITH unique_rows AS (
    SELECT l.province_code, l.locality_name, min(l.id::text)::uuid AS locality_id
      FROM public.ar_localities l
     WHERE l.removed_at IS NULL
     GROUP BY l.province_code, l.locality_name
    HAVING count(*) = 1
  ), done AS (
    UPDATE public.welfare_reports t
       SET locality_id = u.locality_id,
           place_method = 'legacy_unique_name'
      FROM unique_rows u
     WHERE t.locality_id IS NULL
       AND t.place_method IS DISTINCT FROM 'unresolved'
       AND t.jurisdiction_locality IS NOT NULL
       AND t.jurisdiction_locality <> ''
       AND u.province_code = public.ar_province_code(t.jurisdiction_province)
       AND u.locality_name = t.jurisdiction_locality
    RETURNING t.id
  )
  SELECT count(*)::int, coalesce(string_agg(id::text, ',' ORDER BY id), '')
    INTO filled, filled_ids
    FROM done;
  RAISE NOTICE '0275 rule B (unique name, legacy_unique_name): welfare_reports % row(s) [%]',
    filled, filled_ids;

  -- After ---------------------------------------------------------------------
  SELECT count(*)::int INTO after_cases
    FROM public.cases
   WHERE locality_id IS NULL AND jurisdiction_locality IS NOT NULL AND jurisdiction_locality <> '';
  SELECT count(*)::int INTO after_welfare
    FROM public.welfare_reports
   WHERE locality_id IS NULL AND jurisdiction_locality IS NOT NULL AND jurisdiction_locality <> '';
  SELECT count(*)::int INTO homonym_cases
    FROM public.cases t
   WHERE t.locality_id IS NULL AND t.jurisdiction_locality IS NOT NULL AND t.jurisdiction_locality <> ''
     AND (SELECT count(*) FROM public.ar_localities l
           WHERE l.removed_at IS NULL
             AND l.province_code = public.ar_province_code(t.jurisdiction_province)
             AND l.locality_name = t.jurisdiction_locality) > 1;
  SELECT count(*)::int INTO homonym_welfare
    FROM public.welfare_reports t
   WHERE t.locality_id IS NULL AND t.jurisdiction_locality IS NOT NULL AND t.jurisdiction_locality <> ''
     AND (SELECT count(*) FROM public.ar_localities l
           WHERE l.removed_at IS NULL
             AND l.province_code = public.ar_province_code(t.jurisdiction_province)
             AND l.locality_name = t.jurisdiction_locality) > 1;
  RAISE NOTICE '0275 after: cases % row(s) with a name and no id (% homonym); welfare_reports % (% homonym)',
    after_cases, homonym_cases, after_welfare, homonym_welfare;
END
$$;
