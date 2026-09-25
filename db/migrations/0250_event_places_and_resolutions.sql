-- ────────────────────────────────────────────────────────────────────────────
-- 0250_event_places_and_resolutions.sql
-- Where every place-bearing event happened, queryable by catalogue id; and the
-- one append-only way a place is resolved LATER.
--
-- WHY (localidades-por-id B4)
-- ---------------------------
-- P2: never lose an event's origin place. Since stage A every place-bearing
-- event payload carries `place: {entered, resolved[, candidates]}`
-- (lib/events/place-payload.ts). That is the fact, and it is append-only with
-- the rest of the spine. Two things were missing:
--
--   1. A way to COUNT by it. The PO rule "every event counts where it
--      happened" (D3) cannot be served by a JSONB path in every aggregate.
--      `event_places` is a DECLARED PROJECTION of the spine: one row per event
--      that carries `place`, written by a trigger in the same transaction as
--      the event, rebuildable at any time from `pet_events` alone: delete the
--      rows and run `public.project_event_place` over the spine, exactly as
--      the backfill at the end of section 1 does. It is a cache; it never
--      outranks the payload.
--   2. A way to resolve a place LATER without editing anything. A platform
--      admin working the unresolved queue (stage D9), or a catalogue repair,
--      writes a `place_resolutions` row: which subject, which row, how, who,
--      why, and which earlier resolution it supersedes. The table refuses
--      UPDATE, DELETE and TRUNCATE — a resolution is corrected by a new one,
--      the way an event is corrected by a new event. The event payload is
--      never touched.
--
-- THE TRIGGER CANNOT FAIL AN EVENT. A projection must never be the reason a
-- vaccination or a bite is not recorded, so `project_event_place` validates
-- before it writes: a locality id that is not a uuid, or names no catalogue
-- row, is projected as unresolved (the payload keeps it verbatim); a method
-- outside the vocabulary is projected as `unresolved`; a second projection of
-- the same event is a no-op.
--
-- RLS: both tables are read by platform admins through PostgREST and written
-- only by the server (service role) and the trigger (SECURITY DEFINER, owner).
-- Provinces read their unresolved places through the queue in stage D.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).
-- Forward-only. Rollback: both tables are unread until stage D — a forward
-- migration may drop them.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. event_places ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.event_places (
  event_id      uuid        PRIMARY KEY REFERENCES public.pet_events (id) ON DELETE CASCADE,
  pet_id        uuid        NOT NULL REFERENCES public.pets (id) ON DELETE CASCADE,
  province_code text        CHECK (province_code IS NULL OR province_code ~ '^AR-[A-Z]$'),
  locality_id   uuid        REFERENCES public.ar_localities (id) ON DELETE RESTRICT,
  method        text        NOT NULL CHECK (method IN (
                              'indec_id', 'catalogue_id', 'exact_name_unique',
                              'folded_name_unique', 'geocode_unique', 'user_picked',
                              'spine_rederived', 'legacy_unique_name', 'admin_queue',
                              'unresolved')),
  entered       jsonb       NOT NULL CHECK (jsonb_typeof(entered) = 'object'),
  projected_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((method = 'unresolved') = (locality_id IS NULL))
);

CREATE INDEX IF NOT EXISTS event_places_locality_id_idx
  ON public.event_places (locality_id) WHERE locality_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_places_province_code_idx
  ON public.event_places (province_code);
CREATE INDEX IF NOT EXISTS event_places_pet_id_idx
  ON public.event_places (pet_id);

ALTER TABLE public.event_places ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "event_places select by admin" ON public.event_places;
CREATE POLICY "event_places select by admin"
  ON public.event_places
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

-- An institutional session below aal2 has no authority here either (0231).
DROP POLICY IF EXISTS "institutional sessions require aal2" ON public.event_places;
CREATE POLICY "institutional sessions require aal2" ON public.event_places
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

COMMENT ON TABLE public.event_places IS
  'Declared projection of pet_events.payload->place (localidades-por-id B4): one row per place-bearing event, written in the event''s transaction by trigger, rebuildable with public.project_event_place. A cache: the payload is the fact.';

-- The projection of ONE event. Used by the trigger and by the rebuild.
CREATE OR REPLACE FUNCTION public.project_event_place(
  p_event_id uuid,
  p_pet_id uuid,
  p_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_place    jsonb := p_payload -> 'place';
  v_resolved jsonb;
  v_entered  jsonb;
  v_raw_id   text;
  v_locality uuid;
  v_method   text;
  v_code     text;
  v_entered_province text;
BEGIN
  IF p_pet_id IS NULL OR v_place IS NULL OR jsonb_typeof(v_place) <> 'object' THEN
    RETURN;
  END IF;

  v_entered := CASE WHEN jsonb_typeof(v_place -> 'entered') = 'object'
                    THEN v_place -> 'entered' ELSE '{}'::jsonb END;
  v_resolved := CASE WHEN jsonb_typeof(v_place -> 'resolved') = 'object'
                     THEN v_place -> 'resolved' ELSE NULL END;

  v_raw_id := v_resolved ->> 'locality_id';
  IF v_raw_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT l.id INTO v_locality FROM public.ar_localities l WHERE l.id = v_raw_id::uuid;
  END IF;

  v_method := v_resolved ->> 'method';
  IF v_locality IS NULL
     OR v_method IS NULL
     OR v_method = 'unresolved'
     OR v_method NOT IN ('indec_id', 'catalogue_id', 'exact_name_unique',
                         'folded_name_unique', 'geocode_unique', 'user_picked',
                         'spine_rederived', 'legacy_unique_name', 'admin_queue') THEN
    v_locality := NULL;
    v_method := 'unresolved';
  END IF;

  -- The province: the resolved row's, else what was entered when it is a
  -- canonical name or a real code (an alias or a long form stays NULL).
  IF v_locality IS NOT NULL THEN
    SELECT l.province_code INTO v_code FROM public.ar_localities l WHERE l.id = v_locality;
  ELSE
    v_entered_province := v_entered ->> 'province';
    v_code := COALESCE(
      public.ar_province_code(v_entered_province),
      CASE WHEN public.ar_province_name(v_entered_province) IS NOT NULL
           THEN v_entered_province END
    );
  END IF;

  INSERT INTO public.event_places (event_id, pet_id, province_code, locality_id, method, entered)
  VALUES (p_event_id, p_pet_id, v_code, v_locality, v_method, v_entered)
  ON CONFLICT (event_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.project_event_place(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.project_event_place_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.project_event_place(NEW.id, NEW.pet_id, NEW.payload);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.project_event_place_on_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pet_events_project_place ON public.pet_events;
CREATE TRIGGER pet_events_project_place
  AFTER INSERT ON public.pet_events
  FOR EACH ROW
  WHEN (NEW.payload ? 'place')
  EXECUTE FUNCTION public.project_event_place_on_insert();

-- Every event already on the spine that carries a place (stage A writers).
SELECT public.project_event_place(e.id, e.pet_id, e.payload)
  FROM public.pet_events e
 WHERE e.payload ? 'place';

-- 2. place_resolutions ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.place_resolutions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_table   text        NOT NULL CHECK (subject_table IN (
                                'event_places', 'pets', 'cases', 'welfare_reports',
                                'organizations', 'organization_coverage',
                                'service_offerings', 'govt_business_rules',
                                'alert_subscriptions', 'alert_firings',
                                'foster_volunteers', 'approval_requests',
                                'custody_disputes', 'event_notification_outbox')),
  subject_id      uuid        NOT NULL,
  locality_id     uuid        REFERENCES public.ar_localities (id) ON DELETE RESTRICT,
  method          text        NOT NULL CHECK (method IN (
                                'indec_id', 'catalogue_id', 'exact_name_unique',
                                'folded_name_unique', 'geocode_unique', 'user_picked',
                                'spine_rederived', 'legacy_unique_name', 'admin_queue',
                                'unresolved')),
  -- Who resolved it: a platform admin's profile id, or NULL for a script.
  -- No FK on purpose: an append-only row cannot follow an ON DELETE rule.
  actor_user_id   uuid,
  reason          text        CHECK (reason IS NULL OR length(reason) <= 1000),
  supersedes_id   uuid        REFERENCES public.place_resolutions (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((method = 'unresolved') = (locality_id IS NULL))
);

CREATE INDEX IF NOT EXISTS place_resolutions_subject_idx
  ON public.place_resolutions (subject_table, subject_id, created_at DESC);

ALTER TABLE public.place_resolutions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "place_resolutions select by admin" ON public.place_resolutions;
CREATE POLICY "place_resolutions select by admin"
  ON public.place_resolutions
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

DROP POLICY IF EXISTS "institutional sessions require aal2" ON public.place_resolutions;
CREATE POLICY "institutional sessions require aal2" ON public.place_resolutions
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((select public.caller_meets_institutional_aal()));

CREATE OR REPLACE FUNCTION public.enforce_place_resolutions_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'place_resolutions is append-only: % refused. Correct a resolution with a new row that supersedes it.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS place_resolutions_append_only ON public.place_resolutions;
CREATE TRIGGER place_resolutions_append_only
  BEFORE UPDATE OR DELETE ON public.place_resolutions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_place_resolutions_append_only();

DROP TRIGGER IF EXISTS place_resolutions_no_truncate ON public.place_resolutions;
CREATE TRIGGER place_resolutions_no_truncate
  BEFORE TRUNCATE ON public.place_resolutions
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enforce_place_resolutions_append_only();

COMMENT ON TABLE public.place_resolutions IS
  'Append-only: the one way a place is resolved after the fact (admin queue, catalogue repair). Never an edit of the event (localidades-por-id B4).';
