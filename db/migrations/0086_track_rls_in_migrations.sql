-- Track Row Level Security in the versioned migration tree (V0-4, P0 — data security).
-- ===================================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Until now, RLS for the owner-facing / organization / welfare / foster /
-- scheduling tables lived ONLY in loose, untracked files under db/*.sql
-- (rls.sql, organizations_rls.sql, welfare_rls.sql, foster_rls.sql,
-- scheduling_rls.sql). Those files were applied by hand in Supabase Studio or
-- by scripts/db-bootstrap.ts — they were NEVER part of db/migrations/. The new
-- production contract is `db:migrate` (drizzle-kit applies db/migrations/*.sql),
-- which would NOT apply the loose files. Result: no guarantee RLS is enabled in
-- every environment. The audit flagged this as a P0 launch blocker, and flagged
-- that foster_rls.sql may never have reached the real DB and that several newer
-- PII tables (pet_transfers, pet_identifications, organization_invitations, …)
-- had no RLS at all.
--
-- This migration makes db/migrations/ the SOURCE OF TRUTH for RLS application.
-- The db/*.sql files are kept as readable reference but are REMOVED from the
-- bootstrap apply-order so RLS is applied exactly once (see scripts/db-bootstrap.ts).
--
-- CONNECTION-ROLE INVARIANT (the reason deny-all is safe)
-- -------------------------------------------------------
-- The app connects via DATABASE_URL as the `postgres` role, which has
-- BYPASSRLS (verified: pg_roles.rolbypassrls = true for both `postgres` and
-- `service_role`). Every Drizzle server-action query, the public
-- /p/[publicToken] credential page, and the Tier-2 libreta share route all go
-- through this connection and therefore BYPASS RLS entirely. RLS here only
-- governs PostgREST (the supabase-js anon / publishable key). Consequently,
-- enabling RLS with NO permissive policy = DENY-ALL to PostgREST, which is the
-- correct safe default for any table the app reaches only via service-role.
-- Enabling deny-all CANNOT lock the app out.
--
-- IDEMPOTENCY
-- -----------
-- Every policy is dropped (DROP POLICY IF EXISTS) before being (re)created, and
-- every ENABLE ROW LEVEL SECURITY is a no-op if already enabled. Safe to run on
-- a DB that already has the Studio-applied policies, and safe to run twice.
--
-- POLICY SEMANTICS
-- ----------------
-- The policy bodies below are ported FAITHFULLY from the existing db/*.sql
-- files — no semantic changes. `can_read_case(...)` is defined by the tracked
-- migration 0034_cases_rls_expanded.sql, which replays before this one.

BEGIN;

-- ###########################################################################
-- PART 1 — ported from db/rls.sql (owner-facing core + admin governance)
-- ###########################################################################

-- == profiles ===============================================================
alter table public.profiles enable row level security;

drop policy if exists "Profiles readable by self" on public.profiles;
create policy "Profiles readable by self"
  on public.profiles for select to authenticated
  using (id = auth.uid());

drop policy if exists "Profiles updatable by self" on public.profiles;
create policy "Profiles updatable by self"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
-- No INSERT (handle_new_user trigger, security definer). No DELETE.

-- == pets ===================================================================
alter table public.pets enable row level security;

drop policy if exists "Pets readable by active owner" on public.pets;
create policy "Pets readable by active owner"
  on public.pets for select to authenticated
  using (
    exists (
      select 1 from public.ownerships o
      where o.pet_id = pets.id
        and o.owner_user_id = auth.uid()
        and o.ended_at is null
    )
  );

drop policy if exists "Pets insertable by any authenticated user" on public.pets;
create policy "Pets insertable by any authenticated user"
  on public.pets for insert to authenticated
  with check (true);

drop policy if exists "Pets updatable by active owner" on public.pets;
create policy "Pets updatable by active owner"
  on public.pets for update to authenticated
  using (
    exists (
      select 1 from public.ownerships o
      where o.pet_id = pets.id
        and o.owner_user_id = auth.uid()
        and o.ended_at is null
    )
  )
  with check (
    exists (
      select 1 from public.ownerships o
      where o.pet_id = pets.id
        and o.owner_user_id = auth.uid()
        and o.ended_at is null
    )
  );
-- No DELETE.

-- == ownerships =============================================================
alter table public.ownerships enable row level security;

drop policy if exists "Ownerships readable by self" on public.ownerships;
create policy "Ownerships readable by self"
  on public.ownerships for select to authenticated
  using (owner_user_id = auth.uid());

drop policy if exists "Ownerships insertable by self" on public.ownerships;
create policy "Ownerships insertable by self"
  on public.ownerships for insert to authenticated
  with check (owner_user_id = auth.uid());

drop policy if exists "Ownerships updatable by self" on public.ownerships;
create policy "Ownerships updatable by self"
  on public.ownerships for update to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());
-- No DELETE.

-- == pet_events — APPEND-ONLY (AGENTS.md:39, 231, 465) ======================
-- SELECT policy includes the Fase F can_read_case OR-branch (from
-- 0034_cases_rls_expanded.sql). Ported as-is.
alter table public.pet_events enable row level security;

drop policy if exists "Pet events readable by active owner" on public.pet_events;
create policy "Pet events readable by active owner"
  on public.pet_events for select to authenticated
  using (
    exists (
      select 1 from public.ownerships o
      where o.pet_id = pet_events.pet_id
        and o.owner_user_id = auth.uid()
        and o.ended_at is null
    )
    or (
      pet_events.case_id is not null
      and public.can_read_case(pet_events.case_id, auth.uid())
    )
  );

drop policy if exists "Pet events insertable by active owner (owner-self only)" on public.pet_events;
create policy "Pet events insertable by active owner (owner-self only)"
  on public.pet_events for insert to authenticated
  with check (
    author_organization_id is null
    and exists (
      select 1 from public.ownerships o
      where o.pet_id = pet_events.pet_id
        and o.owner_user_id = auth.uid()
        and o.ended_at is null
    )
  );
-- No UPDATE / DELETE — append-only.

-- == reminders ==============================================================
alter table public.reminders enable row level security;

drop policy if exists "Reminders readable by self" on public.reminders;
create policy "Reminders readable by self"
  on public.reminders for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Reminders insertable by self" on public.reminders;
create policy "Reminders insertable by self"
  on public.reminders for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Reminders updatable by self" on public.reminders;
create policy "Reminders updatable by self"
  on public.reminders for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Reminders deletable by self" on public.reminders;
create policy "Reminders deletable by self"
  on public.reminders for delete to authenticated
  using (user_id = auth.uid());

-- == attachments ============================================================
-- SELECT includes the Fase F can_read_case OR-branch (0034). Ported as-is.
alter table public.attachments enable row level security;

drop policy if exists "Attachments readable by pet owner" on public.attachments;
create policy "Attachments readable by pet owner"
  on public.attachments for select to authenticated
  using (
    exists (
      select 1 from public.ownerships o
      where o.owner_user_id = auth.uid()
        and o.ended_at is null
        and (
          o.pet_id = attachments.pet_id
          or o.pet_id = (
            select pe.pet_id from public.pet_events pe where pe.id = attachments.event_id
          )
        )
    )
    or exists (
      select 1 from public.pet_events pe
      where pe.id = attachments.event_id
        and pe.case_id is not null
        and public.can_read_case(pe.case_id, auth.uid())
    )
  );

drop policy if exists "Attachments insertable by pet owner" on public.attachments;
create policy "Attachments insertable by pet owner"
  on public.attachments for insert to authenticated
  with check (
    exists (
      select 1 from public.ownerships o
      where o.owner_user_id = auth.uid()
        and o.ended_at is null
        and (
          o.pet_id = attachments.pet_id
          or o.pet_id = (
            select pe.pet_id from public.pet_events pe where pe.id = attachments.event_id
          )
        )
    )
  );

drop policy if exists "Attachments updatable by pet owner" on public.attachments;
create policy "Attachments updatable by pet owner"
  on public.attachments for update to authenticated
  using (
    exists (
      select 1 from public.ownerships o
      where o.owner_user_id = auth.uid()
        and o.ended_at is null
        and (
          o.pet_id = attachments.pet_id
          or o.pet_id = (
            select pe.pet_id from public.pet_events pe where pe.id = attachments.event_id
          )
        )
    )
  );
-- No DELETE.

-- == notifications ==========================================================
alter table public.notifications enable row level security;

drop policy if exists "Notifications readable by self" on public.notifications;
create policy "Notifications readable by self"
  on public.notifications for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Notifications updatable by self" on public.notifications;
create policy "Notifications updatable by self"
  on public.notifications for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
-- No INSERT / DELETE.

-- == libreta_share_tokens ===================================================
alter table public.libreta_share_tokens enable row level security;

drop policy if exists "owner can read own libreta shares" on public.libreta_share_tokens;
create policy "owner can read own libreta shares"
  on public.libreta_share_tokens for select to authenticated
  using (
    created_by_user_id = auth.uid()
    or pet_id in (
      select pet_id from public.ownerships
      where owner_user_id = auth.uid() and ended_at is null
    )
  );

drop policy if exists "owner can insert libreta shares for their pets" on public.libreta_share_tokens;
create policy "owner can insert libreta shares for their pets"
  on public.libreta_share_tokens for insert to authenticated
  with check (
    created_by_user_id = auth.uid()
    and pet_id in (
      select pet_id from public.ownerships
      where owner_user_id = auth.uid() and ended_at is null
    )
  );

drop policy if exists "owner can update (revoke) own libreta shares" on public.libreta_share_tokens;
create policy "owner can update (revoke) own libreta shares"
  on public.libreta_share_tokens for update to authenticated
  using (created_by_user_id = auth.uid())
  with check (created_by_user_id = auth.uid());
-- No DELETE — revocation is soft (revoked_at).

-- == govt_assignments =======================================================
alter table public.govt_assignments enable row level security;

drop policy if exists "govt sees own assignments" on public.govt_assignments;
create policy "govt sees own assignments"
  on public.govt_assignments for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );
-- No INSERT / UPDATE / DELETE — grants/revokes via server actions.

-- == approval_requests ======================================================
alter table public.approval_requests enable row level security;

drop policy if exists "approval requests visible to applicant or authority" on public.approval_requests;
create policy "approval requests visible to applicant or authority"
  on public.approval_requests for select to authenticated
  using (
    applicant_user_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
    or exists (
      select 1 from public.govt_assignments g
      where g.user_id = auth.uid()
        and g.revoked_at is null
        and g.jurisdiction_province = approval_requests.jurisdiction_province
        and g.jurisdiction_locality = approval_requests.jurisdiction_locality
    )
  );
-- No INSERT / UPDATE — server actions only.

-- == audit_log ==============================================================
alter table public.audit_log enable row level security;

drop policy if exists "audit log visible to actor or admin" on public.audit_log;
create policy "audit log visible to actor or admin"
  on public.audit_log for select to authenticated
  using (
    actor_user_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );
-- No INSERT (server-action side effect); UPDATE/DELETE blocked by append-only trigger.

-- ###########################################################################
-- PART 2 — ported from db/organizations_rls.sql
-- ###########################################################################

-- == organizations ==========================================================
alter table public.organizations enable row level security;

drop policy if exists "Verified orgs are publicly readable" on public.organizations;
create policy "Verified orgs are publicly readable"
  on public.organizations for select to anon, authenticated
  using (verified = true);

drop policy if exists "Members can read their own org" on public.organizations;
create policy "Members can read their own org"
  on public.organizations for select to authenticated
  using (
    exists (
      select 1 from public.organization_memberships m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
        and m.left_at is null
    )
  );

-- == organization_coverage ==================================================
alter table public.organization_coverage enable row level security;

drop policy if exists "Coverage readable when parent org is verified" on public.organization_coverage;
create policy "Coverage readable when parent org is verified"
  on public.organization_coverage for select to anon, authenticated
  using (
    exists (
      select 1 from public.organizations o
      where o.id = organization_coverage.organization_id
        and o.verified = true
    )
  );

drop policy if exists "Members can read their org coverage" on public.organization_coverage;
create policy "Members can read their org coverage"
  on public.organization_coverage for select to authenticated
  using (
    exists (
      select 1 from public.organization_memberships m
      where m.organization_id = organization_coverage.organization_id
        and m.user_id = auth.uid()
        and m.left_at is null
    )
  );

-- == organization_memberships ===============================================
alter table public.organization_memberships enable row level security;

drop policy if exists "Members can read their own memberships" on public.organization_memberships;
create policy "Members can read their own memberships"
  on public.organization_memberships for select to authenticated
  using (user_id = auth.uid());

-- The `peer` alias is REQUIRED to avoid RLS re-entrancy (see organizations_rls.sql).
drop policy if exists "Members can read peers in same org" on public.organization_memberships;
create policy "Members can read peers in same org"
  on public.organization_memberships for select to authenticated
  using (
    exists (
      select 1 from public.organization_memberships peer
      where peer.organization_id = organization_memberships.organization_id
        and peer.user_id = auth.uid()
        and peer.left_at is null
    )
  );

-- ###########################################################################
-- PART 3 — ported from db/welfare_rls.sql
-- ###########################################################################

-- == welfare_reports ========================================================
alter table public.welfare_reports enable row level security;

drop policy if exists "Anyone can insert welfare report" on public.welfare_reports;
create policy "Anyone can insert welfare report"
  on public.welfare_reports for insert to anon, authenticated
  with check (true);

drop policy if exists "Reporter can read own welfare reports" on public.welfare_reports;
create policy "Reporter can read own welfare reports"
  on public.welfare_reports for select to authenticated
  using (reporter_user_id = auth.uid());
-- No UPDATE / DELETE.

-- == welfare_report_attachments =============================================
alter table public.welfare_report_attachments enable row level security;

drop policy if exists "Anyone can insert welfare attachments" on public.welfare_report_attachments;
create policy "Anyone can insert welfare attachments"
  on public.welfare_report_attachments for insert to anon, authenticated
  with check (true);

drop policy if exists "Reporter can read own welfare attachments" on public.welfare_report_attachments;
drop policy if exists "Welfare attachments readable when parent report exists" on public.welfare_report_attachments;
create policy "Welfare attachments readable when parent report exists"
  on public.welfare_report_attachments for select to anon, authenticated
  using (
    exists (
      select 1 from public.welfare_reports wr
      where wr.id = welfare_report_attachments.welfare_report_id
    )
  );

-- ###########################################################################
-- PART 4 — ported from db/foster_rls.sql
-- ###########################################################################

-- == foster_volunteers ======================================================
alter table public.foster_volunteers enable row level security;

drop policy if exists "Volunteer can read own row" on public.foster_volunteers;
create policy "Volunteer can read own row"
  on public.foster_volunteers for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Org coordinators can read active pool" on public.foster_volunteers;
create policy "Org coordinators can read active pool"
  on public.foster_volunteers for select to authenticated
  using (
    status = 'active'
    and available_slots > 0
    and exists (
      select 1 from public.organization_memberships om
      where om.user_id = auth.uid()
        and om.left_at is null
        and (
          om.role = 'admin'
          or exists (
            select 1 from public.organization_capability_grants ocg
            where ocg.membership_id = om.id
              and ocg.capability = 'foster.assign'
              and ocg.status = 'approved'
          )
        )
    )
  );

drop policy if exists "Platform admins read all volunteers" on public.foster_volunteers;
create policy "Platform admins read all volunteers"
  on public.foster_volunteers for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.account_type = 'institutional'
        and p.deactivated_at is null
    )
  );
-- No INSERT / UPDATE / DELETE.

-- == foster_proposals =======================================================
alter table public.foster_proposals enable row level security;

drop policy if exists "Volunteer can read proposals for them" on public.foster_proposals;
create policy "Volunteer can read proposals for them"
  on public.foster_proposals for select to authenticated
  using (volunteer_user_id = auth.uid());

drop policy if exists "Org members can read own org proposals" on public.foster_proposals;
create policy "Org members can read own org proposals"
  on public.foster_proposals for select to authenticated
  using (
    exists (
      select 1 from public.organization_memberships om
      where om.user_id = auth.uid()
        and om.organization_id = foster_proposals.organization_id
        and om.left_at is null
    )
  );

drop policy if exists "Platform admins read all proposals" on public.foster_proposals;
create policy "Platform admins read all proposals"
  on public.foster_proposals for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.account_type = 'institutional'
        and p.deactivated_at is null
    )
  );
-- No INSERT / UPDATE / DELETE.

-- ###########################################################################
-- PART 5 — ported from db/scheduling_rls.sql
-- ###########################################################################

-- == service_offerings ======================================================
alter table public.service_offerings enable row level security;

drop policy if exists "service_offerings read approved publicly" on public.service_offerings;
create policy "service_offerings read approved publicly"
  on public.service_offerings for select to anon, authenticated
  using (status = 'approved');

drop policy if exists "service_offerings read by org members" on public.service_offerings;
create policy "service_offerings read by org members"
  on public.service_offerings for select to authenticated
  using (
    organization_id in (
      select organization_id from public.organization_memberships
      where user_id = auth.uid() and left_at is null
    )
  );

drop policy if exists "service_offerings read by provider vet" on public.service_offerings;
create policy "service_offerings read by provider vet"
  on public.service_offerings for select to authenticated
  using (provider_user_id = auth.uid());

-- == service_schedule_rules =================================================
alter table public.service_schedule_rules enable row level security;

drop policy if exists "schedule_rules read by org members" on public.service_schedule_rules;
create policy "schedule_rules read by org members"
  on public.service_schedule_rules for select to authenticated
  using (
    service_offering_id in (
      select id from public.service_offerings
      where organization_id in (
        select organization_id from public.organization_memberships
        where user_id = auth.uid() and left_at is null
      )
    )
  );

drop policy if exists "schedule_rules read by provider vet" on public.service_schedule_rules;
create policy "schedule_rules read by provider vet"
  on public.service_schedule_rules for select to authenticated
  using (
    service_offering_id in (
      select id from public.service_offerings
      where provider_user_id = auth.uid()
    )
  );

-- == time_slots — open availability data ====================================
alter table public.time_slots enable row level security;

drop policy if exists "time_slots read publicly" on public.time_slots;
create policy "time_slots read publicly"
  on public.time_slots for select to anon, authenticated
  using (true);

-- == appointments ===========================================================
alter table public.appointments enable row level security;

drop policy if exists "appointments read by owner" on public.appointments;
create policy "appointments read by owner"
  on public.appointments for select to authenticated
  using (owner_user_id = auth.uid());

drop policy if exists "appointments read by org members" on public.appointments;
create policy "appointments read by org members"
  on public.appointments for select to authenticated
  using (
    organization_id in (
      select organization_id from public.organization_memberships
      where user_id = auth.uid() and left_at is null
    )
  );

drop policy if exists "appointments read by provider vet" on public.appointments;
create policy "appointments read by provider vet"
  on public.appointments for select to authenticated
  using (
    service_offering_id in (
      select id from public.service_offerings
      where provider_user_id = auth.uid()
    )
  );

-- ###########################################################################
-- PART 6 — NEW: deny-all on PII / tenant tables that had NO RLS
-- ###########################################################################
--
-- These tables hold PII or tenant-scoped data and previously had RLS DISABLED
-- (relrowsecurity = false). The app reads/writes EVERY one of them exclusively
-- via Drizzle / server actions on the service-role (BYPASSRLS) connection —
-- never via the supabase-js anon/publishable key / PostgREST. Enabling RLS with
-- NO permissive policy makes them DENY-ALL to anon + authenticated through
-- PostgREST, which is the correct safe default: it closes the data-exfiltration
-- surface without affecting the app. Each WHY is documented inline.

-- pet_transfers — transfer offers carry recipient email + owner ids + free-text
-- notes (PII). Only the public-token accept/reject flow reads them, and that
-- runs server-side via Drizzle. Deny-all to PostgREST is safe.
alter table public.pet_transfers enable row level security;

-- pet_identifications — microchip / ISO subfields / tattoo data (PII, Ley
-- 25.326). Read only by server actions and the public credential page, both via
-- Drizzle. Deny-all to PostgREST is safe.
alter table public.pet_identifications enable row level security;

-- organization_invitations — invitee email + invitation token (PII +
-- capability secret). Accept/list flows run via server actions (Drizzle).
-- Deny-all to PostgREST is safe.
alter table public.organization_invitations enable row level security;

-- case_events — case timeline notes + recorded_by user (case-scoped PII).
-- Read/written only inside case server actions (Drizzle). Deny-all to PostgREST
-- is safe.
alter table public.case_events enable row level security;

-- physical_tag_interest — (pet, user) demand signal + free-text notes
-- (tenant-scoped PII). Toggled only via owner server actions (Drizzle).
-- Deny-all to PostgREST is safe.
alter table public.physical_tag_interest enable row level security;

-- eno_processing_queue — internal ENO (zoonosis notification) work queue keyed
-- by pet_event_id. System-only; drained by cron via service role. Deny-all to
-- PostgREST is safe.
alter table public.eno_processing_queue enable row level security;

-- event_notification_outbox — payload snapshots of pet_events (may contain PII)
-- + jurisdiction routing. System outbox drained by service role only. Deny-all
-- to PostgREST is safe (matches the existing RLS matrix expectation: deny for
-- every role).
alter table public.event_notification_outbox enable row level security;

-- share_telemetry — viewer IP hash + user agent of libreta-share viewers
-- (PII-adjacent). Written server-side on the public Tier-2 route via Drizzle.
-- Deny-all to PostgREST is safe.
alter table public.share_telemetry enable row level security;

-- ###########################################################################
-- PART 7 — intentionally NOT covered (documented exclusions)
-- ###########################################################################
--
-- The following public-schema tables are deliberately left WITHOUT RLS in this
-- migration because they contain NO PII and NO tenant-scoped data:
--
--   * govt_business_rules   — jurisdiction policy reference (PPP breed lists,
--                             weight thresholds). Authority-published reference
--                             data, no personal data. Writes are admin-only via
--                             server actions.
--   * jurisdictions_census  — public provincial census figures (population by
--                             province / year). Public reference data.
--   * rate_limit_buckets    — ephemeral counters keyed by an opaque/hashed
--                             bucket key; no user identity, TTL-expired rows.
--
-- ar_localities / ar_localities_import_runs / cron_runs already have RLS from
-- earlier migrations. If any future table here starts carrying PII, the RLS
-- fitness test (__tests__/rls/coverage.test.ts) will FAIL until it is added to
-- PART 6 (or justified as an exclusion).

COMMIT;
