-- ────────────────────────────────────────────────────────────────────────────
-- 0273_visits.sql
-- A clinical visit ("atención") groups the events one vet wrote for one pet at
-- one organization in one sitting (SDD change vet-visit-record, work unit 1).
--
-- WHAT THIS ADDS
-- ---------------------------------------------------------------------------
--   1. public.visits — operational metadata (invariant 3: a cache/metadata
--      row that declares itself, never a fact). The FACTS a visit groups stay
--      in the append-only spine; a visit row only says "these events were one
--      sitting": who, where, which modality, when it opened and closed.
--   2. pet_events.visit_id — stamped AT INSERT. pet_events is fully
--      append-only (db/triggers.sql, 0127), so the link can never be added
--      later by an UPDATE: an event is born inside a visit or outside one.
--      Pre-existing rows stay NULL and are never guess-backfilled.
--   3. service_offerings.modality / appointments.modality — clinic | home.
--      appointments.modality is denormalized from the offering at booking.
--
-- INTEGRITY, AND WHERE EACH RULE LIVES
-- ---------------------------------------------------------------------------
--   · Pet mismatch is structurally impossible: the FK is COMPOSITE,
--     (visit_id, pet_id) → visits(id, pet_id), so an event cannot name a visit
--     of another pet. NO ACTION (not RESTRICT): a pet hard delete cascades to
--     both pet_events and visits in one statement, and NO ACTION checks at the
--     end of that statement, after both cascades ran. RESTRICT would check
--     row by row mid-cascade and fail on whichever child Postgres reached
--     first.
--   · Org mismatch is refused by a BEFORE INSERT trigger on pet_events: an
--     event carrying a visit_id must be authored for that visit's
--     organization.
--   · A visit row may change only in the ways its lifecycle allows
--     (enforce_visits_mutation_rules): modality while no event references the
--     visit; the close fields once; the three nullable FKs only to NULL (their
--     ON DELETE SET NULL); everything else never.
--
-- RLS
-- ---------------------------------------------------------------------------
-- SELECT only, TO authenticated: an active member of the visit's organization,
-- or the pet's active titular. No write policy — every write is Drizzle over
-- the BYPASSRLS connection, exactly like pet_events since 0212.
--
-- The membership branch goes through a SECURITY DEFINER helper, not a
-- subquery. organization_memberships' own "Members can read peers in same org"
-- policy is self-referential, so ANY authenticated policy that subqueries that
-- table raises `infinite recursion detected in policy for relation
-- "organization_memberships"` (0216's header records it; measured again on
-- 2026-09-29 against "appointments read by org members", which fails the same
-- way). caller_is_active_org_member answers only about auth.uid() — the
-- caller's own membership — so it is not an oracle about anyone else.
--
-- Idempotent. Forward-only. Ends in a post-condition that raises.
-- Applying it to a remote DB is Ignacio-gated.
-- ────────────────────────────────────────────────────────────────────────────

-- ---------------------------------------------------------------------------
-- 1. visits
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.visits (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id             uuid        NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  organization_id    uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- Nullable for erasure only (a profile hard delete); the app always sets it.
  vet_user_id        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  modality           text        NOT NULL DEFAULT 'clinic',
  appointment_id     uuid        REFERENCES public.appointments(id) ON DELETE SET NULL,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  close_reason       text,
  closed_by_user_id  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visits_modality_valid CHECK (modality IN ('clinic', 'home')),
  CONSTRAINT visits_close_reason_valid CHECK (close_reason IN ('vet', 'expired', 'superseded')),
  CONSTRAINT visits_close_pair CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
  -- The target of pet_events' composite FK.
  CONSTRAINT visits_id_pet_unique UNIQUE (id, pet_id)
);

-- The open-visit lookup: (pet, org, vet) WHERE closed_at IS NULL. Deliberately
-- NOT unique: an offline client may sync a visit it opened while a web visit
-- is already open; the application supersedes the older one instead.
CREATE INDEX IF NOT EXISTS visits_open_idx
  ON public.visits (pet_id, organization_id, vet_user_id)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS visits_organization_id_idx
  ON public.visits (organization_id);

CREATE INDEX IF NOT EXISTS visits_appointment_id_idx
  ON public.visits (appointment_id)
  WHERE appointment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. pet_events.visit_id
-- ---------------------------------------------------------------------------

ALTER TABLE public.pet_events ADD COLUMN IF NOT EXISTS visit_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pet_events_visit_fk'
       AND conrelid = 'public.pet_events'::regclass
  ) THEN
    ALTER TABLE public.pet_events
      ADD CONSTRAINT pet_events_visit_fk
      FOREIGN KEY (visit_id, pet_id) REFERENCES public.visits (id, pet_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS pet_events_visit_id_idx
  ON public.pet_events (visit_id)
  WHERE visit_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_pet_event_visit_org()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF NEW.visit_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT v.organization_id INTO v_org FROM public.visits v WHERE v.id = NEW.visit_id;
  -- A missing visit is the FK's to report, with its own error.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW.author_organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'pet_events.visit_id % belongs to organization %; the event is authored for %',
      NEW.visit_id, v_org, NEW.author_organization_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_pet_event_visit_org() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pet_events_visit_org_match ON public.pet_events;
CREATE TRIGGER pet_events_visit_org_match
  BEFORE INSERT ON public.pet_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_pet_event_visit_org();

-- ---------------------------------------------------------------------------
-- 3. The visit lifecycle
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_visits_mutation_rules()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.pet_id IS DISTINCT FROM OLD.pet_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'visits %: id, pet, organization and opening time are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The three nullable FKs move only to NULL: that is their ON DELETE SET
  -- NULL (an erased profile, a deleted appointment), never a reassignment.
  IF (NEW.vet_user_id IS DISTINCT FROM OLD.vet_user_id AND NEW.vet_user_id IS NOT NULL)
     OR (NEW.appointment_id IS DISTINCT FROM OLD.appointment_id AND NEW.appointment_id IS NOT NULL)
     OR (NEW.closed_by_user_id IS DISTINCT FROM OLD.closed_by_user_id
         AND NEW.closed_by_user_id IS NOT NULL AND OLD.closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'visits %: vet, appointment and closer can only be cleared, never reassigned', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Closed once. Re-closing is the application's no-op (WHERE closed_at IS
  -- NULL); re-opening or re-dating a closed visit is refused here.
  IF OLD.closed_at IS NOT NULL
     AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at
          OR NEW.close_reason IS DISTINCT FROM OLD.close_reason) THEN
    RAISE EXCEPTION 'visits %: already closed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Modality is part of what the visit's events say happened (the intake
  -- event snapshots it). Once an event references the visit, it is frozen.
  IF NEW.modality IS DISTINCT FROM OLD.modality
     AND EXISTS (SELECT 1 FROM public.pet_events e WHERE e.visit_id = OLD.id) THEN
    RAISE EXCEPTION 'visits %: modality is frozen once an event references the visit', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_visits_mutation_rules() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS visits_mutation_rules ON public.visits;
CREATE TRIGGER visits_mutation_rules
  BEFORE UPDATE ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_visits_mutation_rules();

-- ---------------------------------------------------------------------------
-- 4. Modality on offerings and appointments
-- ---------------------------------------------------------------------------

ALTER TABLE public.service_offerings
  ADD COLUMN IF NOT EXISTS modality text NOT NULL DEFAULT 'clinic';
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS modality text NOT NULL DEFAULT 'clinic';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'service_offerings_modality_valid'
       AND conrelid = 'public.service_offerings'::regclass
  ) THEN
    ALTER TABLE public.service_offerings
      ADD CONSTRAINT service_offerings_modality_valid CHECK (modality IN ('clinic', 'home'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'appointments_modality_valid'
       AND conrelid = 'public.appointments'::regclass
  ) THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_modality_valid CHECK (modality IN ('clinic', 'home'));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.caller_is_active_org_member(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.organization_memberships m
     WHERE m.organization_id = p_organization_id
       AND m.user_id = auth.uid()
       AND m.left_at IS NULL
  );
$$;

COMMENT ON FUNCTION public.caller_is_active_org_member(uuid) IS
  'True when auth.uid() holds an active membership (left_at IS NULL) in the organization. Answers only about the caller. Exists because organization_memberships'' self-referential peers policy makes any policy subquery on that table recurse (migration 0273).';

REVOKE EXECUTE ON FUNCTION public.caller_is_active_org_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caller_is_active_org_member(uuid) TO authenticated, service_role;

ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.visits FROM anon;

DROP POLICY IF EXISTS "visits read by org member or pet titular" ON public.visits;
CREATE POLICY "visits read by org member or pet titular"
  ON public.visits
  FOR SELECT
  TO authenticated
  USING (
    public.caller_is_active_org_member(organization_id)
    OR EXISTS (
      SELECT 1
        FROM public.ownerships o
       WHERE o.pet_id = visits.pet_id
         AND o.owner_user_id = (SELECT auth.uid())
         AND o.ended_at IS NULL
    )
  );

-- ---------------------------------------------------------------------------
-- Post-condition — ask the catalog what it actually holds.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.visits'::regclass) THEN
    RAISE EXCEPTION 'Migration 0273 did not close: RLS is not enabled on public.visits';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'visits') <> 1
     OR EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'visits' AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'Migration 0273 did not close: public.visits must carry exactly one SELECT policy';
  END IF;
  IF has_function_privilege('anon', 'public.caller_is_active_org_member(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.caller_is_active_org_member(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Migration 0273 did not close: caller_is_active_org_member carries the wrong grants';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'pet_events_visit_fk'
                    AND conrelid = 'public.pet_events'::regclass
                    AND contype = 'f') THEN
    RAISE EXCEPTION 'Migration 0273 did not close: pet_events_visit_fk is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pet_events_visit_org_match'
                    AND tgrelid = 'public.pet_events'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'visits_mutation_rules'
                    AND tgrelid = 'public.visits'::regclass) THEN
    RAISE EXCEPTION 'Migration 0273 did not close: a visits trigger is missing';
  END IF;
END
$$;
