-- Migration 0079: case_id FKs on pet_events and foster_proposals (ARCH-E P1)
--
-- Background
-- ----------
-- pet_events.case_id and foster_proposals.case_id were added as plain UUID
-- columns (migrations 0033 and 0068 respectively) with no foreign key to the
-- cases table. Dangling case references were therefore structurally possible.
--
-- This migration adds the missing FK constraints so the DB enforces referential
-- integrity on both columns, and backfills the custody_dispute_raised raising
-- events whose case_id was NULL due to the sequencing bug fixed in ARCH-E
-- (the event was inserted before the case row existed).
--
-- ON DELETE choices
-- -----------------
-- pet_events.case_id  → RESTRICT: events are immutable; a case hard-delete
--   while events reference it is a logic error, not a recoverable cascade.
--   Mirrors the intent expressed in migration 0033's ADD COLUMN comment.
-- foster_proposals.case_id → SET NULL: proposals can outlive a case correction;
--   losing the link is acceptable (proposal lifecycle is self-contained).
--   Matches the welfare_reports.case_id pattern established in migration 0033.
--
-- Backfill
-- --------
-- For each custody_dispute_raised event where case_id IS NULL but a
-- custody_dispute row exists that names that event as raising_event_id, the
-- linked case can be derived exactly: custody_disputes.raising_event_id is a
-- unique FK (one dispute per raising event), and each dispute has exactly one
-- cases row via cases.custody_dispute_id. The UPDATE uses the GUC escape hatch
-- (app.allow_event_mutation + app.allow_event_mutation_actor) required by the
-- enforce_pet_events_append_only trigger.
--
-- A sentinel profile row (uuid ...000079) is inserted to serve as the
-- audit actor for the override records.
--
-- Idempotent — safe to re-run.

-- ===========================================================================
-- 0. Sentinel actor for audit rows
-- ===========================================================================

INSERT INTO public.profiles (id, role, display_name, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000079',
  'admin',
  'system:backfill-0079',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 1. pet_events.case_id FK
-- ===========================================================================

ALTER TABLE public.pet_events
  ADD CONSTRAINT pet_events_case_id_cases_id_fk
  FOREIGN KEY (case_id)
  REFERENCES public.cases(id)
  ON DELETE RESTRICT
  NOT VALID;

-- NOTE: drizzle runs this file in a single transaction, so NOT VALID +
-- VALIDATE in the same file does NOT reduce locking versus a plain
-- ADD CONSTRAINT. Acceptable at current table sizes; if pet_events grows
-- large before this runs in prod, move the VALIDATE to a separate migration.
ALTER TABLE public.pet_events
  VALIDATE CONSTRAINT pet_events_case_id_cases_id_fk;

-- ===========================================================================
-- 2. foster_proposals.case_id FK
-- ===========================================================================

ALTER TABLE public.foster_proposals
  ADD CONSTRAINT foster_proposals_case_id_cases_id_fk
  FOREIGN KEY (case_id)
  REFERENCES public.cases(id)
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE public.foster_proposals
  VALIDATE CONSTRAINT foster_proposals_case_id_cases_id_fk;

-- ===========================================================================
-- 3. Backfill custody_dispute_raised events with NULL case_id
-- ===========================================================================
-- Derivable when: custody_disputes.raising_event_id = pet_events.id AND
-- cases.custody_dispute_id = custody_disputes.id. The join is exact
-- (one raising event per dispute, one dispute case per dispute).
--
-- Uses the GUC escape hatch to bypass the append-only trigger.

DO $$
DECLARE
  remaining int;
BEGIN
  -- Escape-hatch GUCs (transaction-local; reset at COMMIT). Required by
  -- enforce_pet_events_append_only to permit the bulk mutation + audit it.
  PERFORM set_config('app.allow_event_mutation', 'true', true);
  PERFORM set_config(
    'app.allow_event_mutation_actor',
    '00000000-0000-0000-0000-000000000079',
    true
  );

  UPDATE public.pet_events pe
  SET    case_id = c.id
  FROM   public.custody_disputes cd
  JOIN   public.cases c ON c.custody_dispute_id = cd.id
  WHERE  pe.id = cd.raising_event_id
    AND  pe.event_type = 'custody_dispute_raised'
    AND  pe.case_id IS NULL;

  -- Verification: no derivable raising event should remain un-linked.
  SELECT count(*) INTO remaining
  FROM   public.pet_events pe
  JOIN   public.custody_disputes cd ON cd.raising_event_id = pe.id
  JOIN   public.cases c ON c.custody_dispute_id = cd.id
  WHERE  pe.event_type = 'custody_dispute_raised'
    AND  pe.case_id IS NULL;

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'Migration 0079 backfill verification failed: % custody_dispute_raised rows still have NULL case_id after backfill',
      remaining;
  END IF;
END $$;
