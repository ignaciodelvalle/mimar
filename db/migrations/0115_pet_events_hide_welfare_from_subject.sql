-- pet_events RLS: hide welfare_denuncia bridge events from the subject owner
-- ==========================================================================
-- pet-document-redesign privacy fix (spec REQ-1.2/1.3, design ADR-1).
--
-- LEAK: migration 0086's "Pet events readable by active owner" SELECT policy
-- grants the owner-of-the-pet branch unconditional read on every pet_events
-- row for their pet, including welfare-bridge events (maltreatment_reported /
-- abandonment_reported) attached to an open welfare_denuncia case. The owner
-- is the SUBJECT of a welfare_denuncia investigation and must never see it
-- (canReadCase already denies this at the `cases` table for the exact same
-- reason — see lib/infra/case-access.ts isHiddenFromSubjectKind). This
-- migration closes the parallel hole at the `pet_events` table so a direct
-- PostgREST/supabase-js read (bypassing the app-layer filter added in the
-- same change) cannot leak the bridge events either.
--
-- FIX: rewrite the ownership branch of the SELECT policy so it does NOT
-- match when the event is attached to a case the viewer cannot read via
-- can_read_case() AND that case is a hidden-from-subject kind
-- (welfare_denuncia). Every other event (case_id IS NULL, or case_id points
-- to a non-welfare case) is unaffected — this is designed to be a no-op for
-- every legitimate owner read. The pre-existing second OR-branch
-- (`case_id is not null and can_read_case(...)`) is preserved verbatim so
-- non-owner case-party reads (vet/admin/govt via can_read_case) keep working.
--
-- GOTCHA CAUGHT BY THE RLS MATRIX HARNESS (do not regress this): a naive
-- `not exists (select 1 from cases c where c.id = pet_events.case_id and
-- c.case_kind = 'welfare_denuncia')` subquery is ITSELF subject to the
-- `cases` table's own RLS policy for the querying role. Since the subject
-- owner's `cases` SELECT policy already denies them read on their own
-- welfare_denuncia case (via can_read_case), that subquery's EXISTS check
-- silently returns FALSE for the very case it needs to detect — NOT because
-- the row doesn't match, but because RLS on `cases` filters it out first.
-- That flips `not exists (...)` to TRUE and defeats the whole guard (the
-- welfare-bridge event stays readable). The fix: a SECURITY DEFINER helper
-- (same pattern as `can_read_case`) that runs as the function owner
-- (BYPASSRLS), so the case-kind check itself is not subject to the caller's
-- RLS on `cases`.
--
-- SAFETY NET: __tests__/rls/matrix.test.ts gains a dedicated describe block
-- (fixtures in matrix.data.ts's sibling harness) asserting: owner SELECT on
-- a welfare-bridge pet_event = deny; owner SELECT on their own normal
-- pet_events = allow (regression); existing `cases` welfare row stays green.
-- This exact harness is what caught the RLS-on-RLS bug above — run it
-- against this migration before merge.
--
-- IDEMPOTENCY: CREATE OR REPLACE FUNCTION + DROP POLICY IF EXISTS. Safe to
-- re-run on any DB state.

BEGIN;

-- SECURITY DEFINER so the case-kind lookup bypasses the caller's own RLS on
-- `cases` (see GOTCHA above). Mirrors can_read_case's pattern exactly.
CREATE OR REPLACE FUNCTION public.is_hidden_from_subject_case(p_case_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.cases c
    WHERE c.id = p_case_id
      AND c.case_kind = 'welfare_denuncia'
  );
$$;

DROP POLICY IF EXISTS "Pet events readable by active owner" ON public.pet_events;
CREATE POLICY "Pet events readable by active owner"
  ON public.pet_events FOR SELECT TO authenticated
  USING (
    (
      EXISTS (
        SELECT 1 FROM public.ownerships o
        WHERE o.pet_id = pet_events.pet_id
          AND o.owner_user_id = auth.uid()
          AND o.ended_at IS NULL
      )
      AND (
        pet_events.case_id IS NULL
        OR NOT public.is_hidden_from_subject_case(pet_events.case_id)
        OR public.can_read_case(pet_events.case_id, auth.uid())
      )
    )
    OR (
      pet_events.case_id IS NOT NULL
      AND public.can_read_case(pet_events.case_id, auth.uid())
    )
  );

COMMIT;
