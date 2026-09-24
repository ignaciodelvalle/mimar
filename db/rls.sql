-- DIM owner-facing tables — Row Level Security
-- ---------------------------------------------
-- NOTE (V0-4): This file is now REFERENCE ONLY. The source of truth for
-- applying RLS is db/migrations/0086_track_rls_in_migrations.sql (applied by
-- db:migrate and replayed by db:bootstrap step 2). This file is no longer
-- applied by db-bootstrap.ts. Keep edits here in sync with migration 0086 and
-- the later migrations that reshaped these policies (0163 ownerships, 0211
-- profiles, 0212 pet_events).
-- Enforces per-user isolation on the seven core tables an authenticated owner
-- touches: profiles, pets, ownerships, pet_events, reminders, attachments,
-- notifications.
--
-- See AGENTS.md → Privacy tiers + AGENTS.md:421 ("The data layer enforces tier
-- visibility, not just the app code"). This file closes the v1 gap where these
-- tables had RLS disabled.
--
-- DO NOT APPLY THIS FILE (A02-2). Migrations are the only path that changes a
-- database: write a forward-only db/migrations/NNNN_*.sql, applied by
-- db:migrate. Pasting this file into the Supabase Studio SQL Editor would
-- re-create policies later migrations dropped (0175, 0211, 0212, …).
--
-- NOTE: This RLS only governs queries via PostgREST (the supabase-js client).
-- Drizzle uses a direct Postgres connection that bypasses RLS by design. All
-- server actions read/write via Drizzle and are unaffected. Public credential
-- page at /p/[publicToken] also goes through Drizzle, so Tier 0 / Tier 1 reveals
-- continue to work even though pets / profiles are locked to authenticated
-- owners at the PostgREST layer.
--
-- AGENTS.md:39, 231, 465 are absolute: pet_events are append-only — never edit
-- or delete. We enforce that here by providing no UPDATE/DELETE policy, which
-- results in PostgREST denying both for `authenticated` and `anon` roles. The
-- `service_role` bypasses RLS by Supabase design; we never use service_role for
-- event mutations.
-- Since migration 0212 there is no INSERT policy either: `pet_events` has NO
-- caller-facing write surface at all, only the SELECT policy. See the
-- pet_events section below.

-- ============================================================================
-- profiles
-- ============================================================================
alter table public.profiles enable row level security;

-- Each user can only read their own profile row.
-- (Tier-1 lost-pet reveals of owner display_name + phone happen via Drizzle in
-- the server-rendered /p/[publicToken] page and bypass this policy.)
drop policy if exists "Profiles readable by self" on public.profiles;
create policy "Profiles readable by self"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

-- NO INSERT / UPDATE / DELETE POLICY — deny-all for writes (migration 0211,
-- fresh-review lens A01).
--
-- This table used to carry "Profiles updatable by self"
-- (for update to authenticated, using / with check `id = auth.uid()`), added
-- "so future settings UI can update via supabase-js". That UI was never built,
-- and the policy pinned the ROW without pinning a COLUMN — while `profiles`
-- holds the three columns the authorization layer trusts (`role`,
-- `account_type`, `deactivated_at`; read by lib/infra/request-cache.ts and
-- turned into a verdict by lib/infra/auth-guards.ts). One
-- PATCH /rest/v1/profiles?id=eq.<self> {"role":"admin",
-- "account_type":"institutional"}, signed with the caller's own JWT, minted a
-- universal admin. The same surface cleared `deactivated_at` (undoing a
-- deactivation) and `deleted_at` (undoing an art. 16 erasure).
--
-- Every legitimate writer (update-profile, upload-avatar, complete-identity,
-- verify-dni, the admin decisions, the self-deactivations, vet-self-resign,
-- claim-stub-profile, seeds) writes through Drizzle's BYPASSRLS connection,
-- which never consults these policies; row creation is the handle_new_user
-- trigger (security definer), which is why there was never an INSERT policy.
-- Zero legitimate writers reach this table via PostgREST, so the policy that
-- admits exactly them is no write policy at all.
--
-- Profiles are never owner-deleted: deactivation sets deactivated_at and
-- erasure sets deleted_at — and both writes, too, are server-side only.

-- ============================================================================
-- pets
-- ============================================================================
alter table public.pets enable row level security;

-- Readable when the caller has an active ownership row on this pet.
drop policy if exists "Pets readable by active owner" on public.pets;
create policy "Pets readable by active owner"
  on public.pets
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.ownerships o
      where o.pet_id = pets.id
        and o.owner_user_id = auth.uid()
        and o.ended_at is null
    )
  );

-- NO INSERT AND NO UPDATE POLICY — and none may be added. Nothing writes pets
-- through PostgREST: every writer is Drizzle over the BYPASSRLS connection.
--   · INSERT "Pets insertable by any authenticated user" (with check (true))
--     was dropped by 0175.
--   · UPDATE "Pets updatable by active owner" was dropped by 0236: it scoped
--     ROWS (has_titular_write_access) and no COLUMNS, so an owner could
--     rewrite status, deceased_at, rabies_observation_status,
--     in_custody_dispute, public_token, deleted_at, jurisdiction_locality and
--     adoption_eligible on their own pet. 0236 also revokes UPDATE from
--     anon/authenticated. Pinned by __tests__/rls/matrix.test.ts.

-- No DELETE policy: pets are never deleted; "lost" / "deceased" status changes
-- cover the lifecycle. See AGENTS.md → Pet status.

-- ============================================================================
-- ownerships
-- ============================================================================
alter table public.ownerships enable row level security;

-- A user can see their own ownership rows (current and historical).
-- Org-held rows (owner_user_id NULL, owner_organization_id set) are invisible
-- to user-side queries — correct for v1 since no org portal exists yet.
drop policy if exists "Ownerships readable by self" on public.ownerships;
create policy "Ownerships readable by self"
  on public.ownerships
  for select
  to authenticated
  using (owner_user_id = auth.uid());

-- NO INSERT / UPDATE / DELETE POLICY — deny-all for writes (migration 0163,
-- RA-8 finding R1).
--
-- This table used to carry "Ownerships insertable by self"
-- (with check owner_user_id = auth.uid()) and "Ownerships updatable by self".
-- Neither clause pinned `pet_id` to anything the caller already held, so a
-- single POST /rest/v1/ownerships {"pet_id":"<victim>","owner_user_id":"<self>",
-- "role":"co_owner"} minted an ACTIVE ownership on ANY pet in the country:
-- ownerships_one_active_owner_per_pet is partial (role='owner' only), and every
-- downstream policy — pets SELECT/UPDATE, pet_events SELECT/INSERT,
-- attachments — tests for an ownership row with NO role filter. The UPDATE
-- policy was the same hole via `pet_id` repointing.
--
-- Every legitimate writer (createPet, accept-transfer, adoption, foster,
-- intake, free-claim, chip-match, dispute resolution, decomiso, owner-return,
-- seeds) inserts through Drizzle's BYPASSRLS connection, which never consults
-- these policies. Zero legitimate writers reach this table via PostgREST, so
-- the policy that admits exactly them is no write policy at all.
--
-- Ownership history is preserved by setting ended_at, never by deleting rows —
-- and that write, too, is server-side only.

-- ============================================================================
-- pet_events — APPEND-ONLY (AGENTS.md:39, 231, 465)
-- ============================================================================
alter table public.pet_events enable row level security;

-- Readable when the caller has an active ownership on the event's pet,
-- OR (Fase F of the cases system) when the event is attached to a case
-- the caller can read. The OR branch surfaces case-attached events to
-- non-owner participants (foster, dispute party, govt-in-scope, etc.)
-- via `can_read_case`.
drop policy if exists "Pet events readable by active owner" on public.pet_events;
create policy "Pet events readable by active owner"
  on public.pet_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.ownerships o
      where o.pet_id = pet_events.pet_id
        and o.owner_user_id = auth.uid()
        and o.ended_at is null
    )
    or (
      pet_events.case_id is not null
      and public.can_read_case(pet_events.case_id, auth.uid())
    )
  );

-- NO INSERT / UPDATE / DELETE POLICY — deny-all for writes (migration 0212,
-- fresh-review lens A02, finding A02-1).
--
-- This table used to carry "Pet events insertable by active owner (owner-self
-- only)" — for insert to authenticated, with check on three conjuncts:
-- `author_organization_id is null`, an active ownership row on
-- `pet_events.pet_id`, and (from migration 0190) titular write access whenever
-- `event_type` is one of `titular_only_event_types()`.
--
-- Those conjuncts pinned WHICH PET the row could name and WHICH FAMILY of
-- event_type a caretaker could not forge. They pinned none of the provenance
-- columns. `author_role`, `author_verified` and `recorded_by_user_id` were
-- entirely caller-supplied, and `event_type` was never compared to the
-- EVENT_TYPES catalog (the column is TEXT with no CHECK and no enum). So one
-- POST /rest/v1/pet_events on the caller's OWN pet, with
-- {"author_role":"govt","author_verified":true}, satisfied all three conjuncts
-- and minted a row claiming a sanitary authority wrote it —
-- lib/events/event-confidence.ts ranks that `institutional_verified`,
-- lib/domain/credential-badges.ts renders the tier on the public credential,
-- and lib/projections/pet-compliance.ts clears obligations on the strength of
-- it. With no UPDATE and no DELETE policy and invariant #2 forbidding deletion,
-- the forgery was permanent.
--
-- Every legitimate append is db.insert(petEvents) / tx.insert(petEvents)
-- through EventsRepository over the Drizzle BYPASSRLS connection, which never
-- consults these policies; /api/v1/pets/[publicToken]/events is a server route
-- over that same connection; apps/mobile reaches the server only through
-- /api/v1. Zero legitimate writers reach this table via PostgREST, so the policy
-- that admits exactly them is no write policy at all. Same shape as 0163
-- (ownerships) and 0211 (profiles).
--
-- The caretaker arrangement 0190 protected is unchanged: a caretaker still
-- records medical events through the app, which writes over Drizzle after
-- requirePetAccess authorized them. What narrows is the bearer token, not the
-- role. `has_titular_write_access()` stays — it still backs the pets UPDATE and
-- libreta_share_tokens INSERT policies.
--
-- credential_scanned events are inserted server-side in the public page handler
-- via Drizzle (bypasses RLS) — no anon INSERT policy needed, and never was.

-- ============================================================================
-- reminders
-- ============================================================================
alter table public.reminders enable row level security;

-- Reminders are per-user (the user_id column is the owner, not derived from pet).
drop policy if exists "Reminders readable by self" on public.reminders;
create policy "Reminders readable by self"
  on public.reminders
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "Reminders insertable by self" on public.reminders;
create policy "Reminders insertable by self"
  on public.reminders
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Reminders updatable by self" on public.reminders;
create policy "Reminders updatable by self"
  on public.reminders
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- DELETE is allowed: users can manually delete custom reminders they created.
drop policy if exists "Reminders deletable by self" on public.reminders;
create policy "Reminders deletable by self"
  on public.reminders
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ============================================================================
-- attachments
-- ============================================================================
alter table public.attachments enable row level security;

-- Readable when the attachment's pet has an active ownership for the caller.
-- attachments.pet_id can be NULL when the attachment is tied only to an event;
-- in that case resolve the pet via the event's pet_id.
--
-- Three-valued-logic note: when event_id is also NULL, the subquery returns
-- zero rows and `o.pet_id = (empty subquery)` evaluates to NULL (falsy). The
-- OR collapses cleanly to the first branch. Do NOT "simplify" this by removing
-- the COALESCE-free form unless you have re-verified the NULL semantics.
drop policy if exists "Attachments readable by pet owner" on public.attachments;
create policy "Attachments readable by pet owner"
  on public.attachments
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.ownerships o
      where o.owner_user_id = auth.uid()
        and o.ended_at is null
        and (
          o.pet_id = attachments.pet_id
          or o.pet_id = (
            select pe.pet_id from public.pet_events pe where pe.id = attachments.event_id
          )
        )
    )
    -- Fase F: case participants see attachments on case-attached events
    -- via the same can_read_case hook used by pet_events.
    or exists (
      select 1 from public.pet_events pe
      where pe.id = attachments.event_id
        and pe.case_id is not null
        and public.can_read_case(pe.case_id, auth.uid())
    )
  );

drop policy if exists "Attachments insertable by pet owner" on public.attachments;
create policy "Attachments insertable by pet owner"
  on public.attachments
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.ownerships o
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

-- UPDATE rarely needed (caption edits). Same predicate.
drop policy if exists "Attachments updatable by pet owner" on public.attachments;
create policy "Attachments updatable by pet owner"
  on public.attachments
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.ownerships o
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

-- No DELETE policy. Attachments tied to events live as long as the event does
-- (append-only). Photo replacement is via a new attachment + pets.primary_photo_id update.

-- ============================================================================
-- notifications
-- ============================================================================
alter table public.notifications enable row level security;

-- Per-user. read_at / archived_at toggles need UPDATE.
drop policy if exists "Notifications readable by self" on public.notifications;
create policy "Notifications readable by self"
  on public.notifications
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "Notifications updatable by self" on public.notifications;
create policy "Notifications updatable by self"
  on public.notifications
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No INSERT policy. Sources are: handle_new_user trigger (security definer),
-- server actions via Drizzle, future cron jobs via service_role.
-- No DELETE policy. Notifications are archived (archived_at set), never deleted.

-- ============================================================================
-- libreta_share_tokens — owner reads and writes their own shares
-- ============================================================================
-- D7 from the plan: the public Tier-2 route resolves share tokens via Drizzle
-- (bypasses RLS by design). These policies govern PostgREST access only
-- (defense-in-depth for owner self-service via supabase-js).
-- No DELETE policy: revocation is soft (revoked_at flag), never hard delete.
alter table public.libreta_share_tokens enable row level security;

drop policy if exists "owner can read own libreta shares" on public.libreta_share_tokens;
create policy "owner can read own libreta shares"
  on public.libreta_share_tokens
  for select
  to authenticated
  using (
    created_by_user_id = auth.uid()
    or pet_id in (
      select pet_id from public.ownerships
      where owner_user_id = auth.uid() and ended_at is null
    )
  );

-- Migration 0190 (custodia-temporal): minting a libreta share publishes a
-- bearer-readable link to the animal's medical record. That is a disclosure
-- decision, and a disclosure decision belongs to the titular.
drop policy if exists "owner can insert libreta shares for their pets" on public.libreta_share_tokens;
create policy "owner can insert libreta shares for their pets"
  on public.libreta_share_tokens
  for insert
  to authenticated
  with check (
    created_by_user_id = auth.uid()
    and pet_id in (
      select pet_id from public.ownerships
      where owner_user_id = auth.uid() and ended_at is null
    )
    and public.has_titular_write_access(pet_id, (select auth.uid()))
  );

drop policy if exists "owner can update (revoke) own libreta shares" on public.libreta_share_tokens;
create policy "owner can update (revoke) own libreta shares"
  on public.libreta_share_tokens
  for update
  to authenticated
  using (created_by_user_id = auth.uid())
  with check (created_by_user_id = auth.uid());

-- ============================================================================
-- govt_assignments — owner reads own assignments + admins read all
-- ============================================================================
-- Admin governance — Fase 0. See docs/superpowers/specs/2026-05-17-admin-page-design.md §9.
-- Server actions via Drizzle bypass RLS for the actual mutations
-- (granting, revoking). These policies are defense-in-depth for PostgREST.
alter table public.govt_assignments enable row level security;

drop policy if exists "govt sees own assignments" on public.govt_assignments;
create policy "govt sees own assignments"
  on public.govt_assignments
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.deactivated_at is null
        and p.deleted_at is null
    )
  );

-- No INSERT / UPDATE / DELETE policies via PostgREST. All grants and
-- revocations flow through server actions (Drizzle bypass). Revocation is
-- soft (revoked_at), never hard delete.

-- ============================================================================
-- approval_requests — applicant + scope-matching govt + admin
-- ============================================================================
alter table public.approval_requests enable row level security;

-- SELECT: applicant sees their own; a govt sees pending requests in any
-- locality where they have an active govt_assignment matching the request
-- jurisdiction; admin sees everything.
drop policy if exists "approval requests visible to applicant or authority" on public.approval_requests;
create policy "approval requests visible to applicant or authority"
  on public.approval_requests
  for select
  to authenticated
  using (
    applicant_user_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.deactivated_at is null
        and p.deleted_at is null
    )
    or (
      -- The assignment alone is not an operator: the profile behind it must be
      -- a live, non-erased govt (migration 0216 — erase_subject_data does not
      -- revoke govt_assignments; deactivation does).
      exists (
        select 1 from public.profiles p
        where p.id = auth.uid()
          and p.role = 'govt'
          and p.deactivated_at is null
          and p.deleted_at is null
      )
      and exists (
        select 1 from public.govt_assignments g
        where g.user_id = auth.uid()
          and g.revoked_at is null
          and g.jurisdiction_province = approval_requests.jurisdiction_province
          and g.jurisdiction_locality = approval_requests.jurisdiction_locality
      )
    )
  );

-- INSERT only via server actions. No PostgREST insert policy.
-- UPDATE only via server actions (decision flips). No PostgREST update policy.

-- ============================================================================
-- audit_log — actor sees own entries + admin sees all
-- ============================================================================
alter table public.audit_log enable row level security;

drop policy if exists "audit log visible to actor or admin" on public.audit_log;
create policy "audit log visible to actor or admin"
  on public.audit_log
  for select
  to authenticated
  using (
    actor_user_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.deactivated_at is null
        and p.deleted_at is null
    )
  );

-- No INSERT policy: every audit entry is written by a server action as a
-- side-effect of an authority decision. UPDATE and DELETE are blocked by
-- the append-only trigger (with app.allow_audit_mutation GUC bypass for
-- test cleanup — since 0182 the bypass also requires
-- app.allow_audit_mutation_actor and self-logs the override) — no RLS
-- rule needed.


-- ============================================================================
-- pet_tags — physical tag lifecycle (migration 0169)
-- ============================================================================
alter table public.pet_tags enable row level security;

-- SELECT own: the activating user, or a current owner of the linked pet.
-- Explicit TO authenticated (0168 posture). The public /t/[serial] resolver
-- reads through the server (BYPASSRLS) with a {status, publicToken}-only
-- projection; anon never reads this table.
drop policy if exists "pet_tags select own" on public.pet_tags;
create policy "pet_tags select own"
  on public.pet_tags
  for select
  to authenticated
  using (
    activated_by_user_id = (select auth.uid())
    or pet_id in (
      select o.pet_id from public.ownerships o
      where o.owner_user_id = (select auth.uid())
        and o.ended_at is null
    )
  );

-- No INSERT / UPDATE / DELETE policies: issuance, activation and revocation
-- flow through server actions (Drizzle BYPASSRLS). RLS is the PostgREST
-- backstop only.
