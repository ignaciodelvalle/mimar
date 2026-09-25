-- ────────────────────────────────────────────────────────────────────────────
-- 0251_place_backfill_unambiguous.sql
-- Historical place rows get their catalogue id ONLY where the stored name
-- names exactly one row — and say so.
--
-- WHY (localidades-por-id B5)
-- ---------------------------
-- Stage D moves scope, routing and RLS from names to ids. A historical row
-- with no id would then be visible only at province level. Most of them can be
-- given their id honestly: the stored (province, locality) pair is canonical
-- (0055 CHECK, 0117, 0237, every writer since) and, for the great majority,
-- names ONE live catalogue row.
--
-- The rest cannot, and this migration does not try. R7 of the 2026-09-25
-- localities audit: `scripts/backfill-locality-id.ts` filled ids by NAME and
-- settled every homonym on the alphabetically first department — every
-- Bragado row named "Mechita" got Alberti's id. That script is deleted in the
-- same work unit. Here:
--
--   - a row with NO id whose pair names exactly one live row (same province
--     code, same catalogue spelling) gets that id and
--     `place_method = 'legacy_unique_name'` — the method says the id came
--     from a unique historical name, never from a person or a geocoder;
--   - a pair two rows share (Mechita, AR-B) is left with NO id. It is not
--     guessed; it is province-level until the spine or a person says which
--     (scripts/place-repair-homonym-ids.ts; the unresolved queue, stage D9);
--   - a row that ALREADY carries an id is not touched here. The ones whose
--     name is a homonym are exactly the rows the old script may have written
--     wrong: the repair script audits them against the spine (dry run by
--     default) and never trusts the old id as ground truth;
--   - whole-province rows (empty locality) and names the catalogue does not
--     know stay as they are.
--
-- The province → code step is `public.ar_province_code` (0249), not a sixth
-- copy of the map.
--
-- IDEMPOTENT: only rows with a NULL id are touched, so a re-run matches
-- nothing new. The NOTICE lines are the before/after inventory per table.
-- ROLLBACK (forward): UPDATE <table> SET locality_id = NULL, place_method =
-- NULL WHERE place_method = 'legacy_unique_name'.
--
-- THE REPAIR'S PRE-IMAGE (security review of stage B). The repair script may
-- rewrite or clear an id the old backfill wrote; `place_resolutions` (0250)
-- cannot hold the OLD id (its CHECK ties method to the new one), so every
-- change the repair makes is first recorded here — table, row, old id, new
-- id, verdict, reason, run — append-only like the resolutions themselves.
-- The ids carry no FK on purpose: a pre-image must outlive any catalogue row.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.place_repair_preimages (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid        NOT NULL,
  subject_table   text        NOT NULL CHECK (subject_table IN ('pets', 'cases', 'welfare_reports')),
  subject_id      uuid        NOT NULL,
  old_locality_id uuid,
  new_locality_id uuid,
  verdict         text        NOT NULL CHECK (verdict IN ('rewrite', 'clear')),
  reason          text        NOT NULL CHECK (length(reason) <= 1000),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS place_repair_preimages_subject_idx
  ON public.place_repair_preimages (subject_table, subject_id);

ALTER TABLE public.place_repair_preimages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "place_repair_preimages select by admin" ON public.place_repair_preimages;
CREATE POLICY "place_repair_preimages select by admin"
  ON public.place_repair_preimages
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE (p.id = (select auth.uid()))
        AND (p.role = 'admin'::user_role)
        AND (p.account_type = 'institutional'::text)
        AND (p.deactivated_at IS NULL)
        AND (p.deleted_at IS NULL)
    )
  );

DROP POLICY IF EXISTS "institutional sessions require aal2" ON public.place_repair_preimages;
CREATE POLICY "institutional sessions require aal2" ON public.place_repair_preimages
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE OR REPLACE FUNCTION public.enforce_place_repair_preimages_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'place_repair_preimages is append-only: % refused.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS place_repair_preimages_append_only ON public.place_repair_preimages;
CREATE TRIGGER place_repair_preimages_append_only
  BEFORE UPDATE OR DELETE ON public.place_repair_preimages
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_place_repair_preimages_append_only();

DROP TRIGGER IF EXISTS place_repair_preimages_no_truncate ON public.place_repair_preimages;
CREATE TRIGGER place_repair_preimages_no_truncate
  BEFORE TRUNCATE ON public.place_repair_preimages
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enforce_place_repair_preimages_append_only();

COMMENT ON TABLE public.place_repair_preimages IS
  'Append-only pre-image of every id scripts/place-repair-homonym-ids.ts rewrote or cleared (localidades-por-id B5, R7).';

DO $$
DECLARE
  t record;
  filled integer;
  left_homonym integer;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('pets', 'jurisdiction_province', 'jurisdiction_locality', 'locality_id', 'place_method'),
      ('cases', 'jurisdiction_province', 'jurisdiction_locality', 'locality_id', 'place_method'),
      ('welfare_reports', 'jurisdiction_province', 'jurisdiction_locality', 'locality_id', 'place_method'),
      ('organizations', 'jurisdiction_province', 'jurisdiction_locality', 'locality_id', 'place_method'),
      ('organization_coverage', 'jurisdiction_province', 'jurisdiction_locality', 'locality_id', 'place_method'),
      ('service_offerings', 'jurisdiction_province', 'jurisdiction_locality', 'locality_id', 'place_method'),
      ('govt_business_rules', 'jurisdiction_province', 'jurisdiction_locality', 'locality_id', 'place_method'),
      ('alert_subscriptions', 'jurisdiction_province', 'jurisdiction_locality', 'locality_id', 'place_method'),
      ('alert_firings', 'jurisdiction_province', 'jurisdiction_locality', 'locality_id', 'place_method'),
      ('foster_volunteers', 'jurisdiction_province', 'jurisdiction_locality', 'locality_id', 'place_method'),
      ('approval_requests', 'jurisdiction_province', 'jurisdiction_locality', 'locality_id', 'place_method'),
      ('custody_disputes', 'jurisdiction_province', 'jurisdiction_locality', 'locality_id', 'place_method'),
      ('event_notification_outbox', 'target_jurisdiction_province', 'target_jurisdiction_locality',
       'target_locality_id', 'target_place_method')
    ) AS v(tbl, prov_col, loc_col, id_col, method_col)
  LOOP
    EXECUTE format($q$
      WITH unique_rows AS (
        SELECT l.province_code, l.locality_name, min(l.id::text)::uuid AS locality_id
          FROM public.ar_localities l
         WHERE l.removed_at IS NULL
         GROUP BY l.province_code, l.locality_name
        HAVING count(*) = 1
      )
      UPDATE public.%1$I t
         SET %4$I = u.locality_id,
             %5$I = 'legacy_unique_name'
        FROM unique_rows u
       WHERE t.%4$I IS NULL
         AND t.%3$I IS NOT NULL
         AND t.%3$I <> ''
         AND u.province_code = public.ar_province_code(t.%2$I)
         AND u.locality_name = t.%3$I
    $q$, t.tbl, t.prov_col, t.loc_col, t.id_col, t.method_col);
    GET DIAGNOSTICS filled = ROW_COUNT;

    EXECUTE format($q$
      SELECT count(*)::int
        FROM public.%1$I t
       WHERE t.%4$I IS NULL
         AND t.%3$I IS NOT NULL
         AND t.%3$I <> ''
         AND (SELECT count(*) FROM public.ar_localities l
               WHERE l.removed_at IS NULL
                 AND l.province_code = public.ar_province_code(t.%2$I)
                 AND l.locality_name = t.%3$I) > 1
    $q$, t.tbl, t.prov_col, t.loc_col, t.id_col) INTO left_homonym;

    RAISE NOTICE '0251 %: % row(s) given a unique-name id; % homonym row(s) left without one',
      t.tbl, filled, left_homonym;
  END LOOP;
END
$$;
