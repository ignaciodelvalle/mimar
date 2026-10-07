-- ────────────────────────────────────────────────────────────────────────────
-- 0286_time_slots_read_narrowed.sql
-- time_slots stops being readable by anyone holding the publishable key.
--
-- THE HOLE (security review 2026-10-06, plan A6-c)
-- ---------------------------------------------------------------------------
-- 0086 ported "time_slots read publicly" from db/scheduling_rls.sql: FOR SELECT
-- TO anon, authenticated USING (true). Over GET /rest/v1/time_slots that is
-- every slot of every offering — including pending and rejected ones, and the
-- offerings of independent vets — with its capacity and live bookings_count:
-- the occupancy of every clinic's agenda, readable without an account. No
-- column identifies a person, which is why it was allowlisted in 0086 and in
-- read-path-matrix.test.ts; the occupancy itself is still operational data of
-- each organization that nobody needed to publish.
--
-- WHO READS time_slots, AND HOW (inventory, 2026-10-07)
-- ---------------------------------------------------------------------------
-- Nobody through PostgREST. No `.from("time_slots")`, no embedded select, no
-- RPC, no view, no realtime channel in app/, lib/, src/, components/ or
-- packages/; apps/mobile/ talks to the Next API. Every reader is Drizzle over
-- the BYPASSRLS connection:
--   - owner search and booking: app/(app)/turnos/buscar/** (the slot list,
--     the reservar page), src/modules/events/application/booking/* (book,
--     cancel, the capacity UPDATE), /api/v1 appointment search;
--   - the org agenda and service pages: app/org/[orgToken]/agenda/**,
--     app/org/[orgToken]/servicios/**, lib/analytics/org-dashboard.ts;
--   - the owner's turnos: app/(app)/mis-turnos/**;
--   - materialization: lib/infra/slot-materialization.ts and the cron.
-- No policy on another table sub-selects time_slots. So no caller role reads
-- it through RLS today, and narrowing the policy cannot break booking: the
-- booking path never consults it.
--
-- WHAT IT NARROWS TO
-- ---------------------------------------------------------------------------
-- The same audience as service_schedule_rules, the rules the slots are
-- materialized from: the active members of the offering's organization and
-- the independent vet who provides it. Both TO authenticated.
--   - org members ask public.caller_is_active_org_member (0273), the 0285
--     shape; a direct subquery on organization_memberships would recurse.
--   - the provider vet sub-selects service_offerings.id WHERE
--     provider_user_id = auth.uid(), like its appointments / rules twins.
-- Both sub-selects read only id, organization_id and provider_user_id of
-- service_offerings — inside authenticated's 0279 column grant.
-- An owner reads no slot through PostgREST, a booked one included: their
-- turnos pages render server-side. anon reads nothing.
--
-- WHY RLS AND NOT A GRANT: deploy-provision re-grants SELECT on every public
-- table to anon (0280). With no policy that admits anon, anon reads zero rows
-- whatever the grants are. The REVOKE below is a second layer, not the fence.
--
-- PROVISIONING: db/scheduling_rls.sql, which scripts/deploy-provision.ts
-- applies AFTER the migration replay, carries the block below
-- byte-identical, so a provision does not put the public policy back.
-- check 6 of scripts/check-rls-coverage.ts: time_slots leaves
-- ANON_READ_SURFACE; read-path-matrix.test.ts: its unconditional-read
-- exception goes.
--
-- Forward-only and idempotent. The post-condition asks the catalog by SHAPE.
-- Behavioural fence: __tests__/rls/time-slots-read.test.ts.
-- ────────────────────────────────────────────────────────────────────────────

-- >>> scheduling_rls.sql mirror: time_slots (0286)
alter table public.time_slots enable row level security;
revoke all on public.time_slots from anon;

drop policy if exists "time_slots read publicly" on public.time_slots;

drop policy if exists "time_slots read by org members" on public.time_slots;
create policy "time_slots read by org members"
  on public.time_slots for select
  to authenticated
  using (
    service_offering_id in (
      select id from public.service_offerings
      where public.caller_is_active_org_member(organization_id)
    )
  );

drop policy if exists "time_slots read by provider vet" on public.time_slots;
create policy "time_slots read by provider vet"
  on public.time_slots for select
  to authenticated
  using (
    service_offering_id in (
      select id from public.service_offerings
      where provider_user_id = (select auth.uid())
    )
  );
-- <<< scheduling_rls.sql mirror

-- ---------------------------------------------------------------------------
-- Post-condition — ask the catalog what it actually holds.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.time_slots'::regclass) THEN
    RAISE EXCEPTION 'Migration 0286 did not close: RLS is not enabled on public.time_slots';
  END IF;

  -- Name-independent: every policy is a SELECT TO authenticated, none admits
  -- anon or PUBLIC, none is unconditional, none sub-selects
  -- organization_memberships directly (the recursion).
  SELECT string_agg(format('%s (%s, %s)', policyname, cmd, array_to_string(roles, '/')), '; ')
    INTO offenders
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'time_slots'
     AND (cmd <> 'SELECT'
          OR roles <> ARRAY['authenticated']::name[]
          OR coalesce(btrim(qual), 'true') = 'true'
          OR qual LIKE '%organization_memberships%');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0286 did not close: unexpected policy on public.time_slots (%). Inventory pg_policies and drop it by its real name before retrying.', offenders;
  END IF;

  -- The inverse mistake: members and providers keep their read paths.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'time_slots') <> 2 THEN
    RAISE EXCEPTION 'Migration 0286: public.time_slots must carry exactly its org-member and provider-vet SELECT policies';
  END IF;
END
$$;
