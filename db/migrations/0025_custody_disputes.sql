-- Admin page Fase 10 — Custody disputes resolution.
--
-- Two tables: `custody_disputes` (one open per pet, FK to the raising event)
-- and `custody_dispute_parties` (n parties — claimants, current holder,
-- witnesses). Disputes are scoped by jurisdiction so govt sees only their
-- coverage; admin sees all.
--
-- Idempotent — safe to re-run.

-- ============================================================================
-- 1. custody_disputes
-- ============================================================================
create table if not exists "public"."custody_disputes" (
  "id"                          uuid primary key default gen_random_uuid(),
  "public_token"                text not null unique,
  "pet_id"                      uuid not null references "public"."pets"("id") on delete cascade,

  "raised_by_user_id"           uuid references "public"."profiles"("id"),
  "raised_by_org_id"            uuid references "public"."organizations"("id"),
  "raised_by_role"              text not null,
  "raising_event_id"            uuid not null references "public"."pet_events"("id"),

  "jurisdiction_country"        text not null default 'AR',
  "jurisdiction_province"       text not null,
  "jurisdiction_locality"       text not null,

  "status"                      text not null default 'open',
  "resolution"                  text,
  "resolution_summary"          text,
  "resolution_event_id"         uuid references "public"."pet_events"("id"),
  "resolved_by_user_id"         uuid references "public"."profiles"("id"),
  "resolved_at"                 timestamptz,

  "created_at"                  timestamptz not null default now(),
  "updated_at"                  timestamptz not null default now(),

  constraint "custody_disputes_status_valid" check (status in ('open','resolved','withdrawn')),
  constraint "custody_disputes_resolution_consistent" check (
    (status = 'open' and resolution is null and resolved_by_user_id is null and resolved_at is null)
    or
    (status in ('resolved','withdrawn') and resolved_by_user_id is not null and resolved_at is not null)
  ),
  constraint "custody_disputes_resolution_required_when_resolved" check (
    status != 'resolved' or (resolution is not null and resolution_summary is not null)
  ),
  constraint "custody_disputes_raised_role_valid" check (raised_by_role in ('owner','org','govt','admin'))
);

create unique index if not exists "custody_disputes_one_open_per_pet"
  on "public"."custody_disputes" ("pet_id") where status = 'open';

create index if not exists "custody_disputes_juris_open_idx"
  on "public"."custody_disputes" ("jurisdiction_province", "jurisdiction_locality") where status = 'open';

create index if not exists "custody_disputes_pet_idx"
  on "public"."custody_disputes" ("pet_id", "created_at" desc);

-- ============================================================================
-- 2. custody_dispute_parties
-- ============================================================================
create table if not exists "public"."custody_dispute_parties" (
  "id"                       uuid primary key default gen_random_uuid(),
  "dispute_id"               uuid not null references "public"."custody_disputes"("id") on delete cascade,
  "party_user_id"            uuid references "public"."profiles"("id"),
  "party_organization_id"    uuid references "public"."organizations"("id"),
  "party_role"               text not null,
  "party_position_summary"   text,
  "added_by_user_id"         uuid references "public"."profiles"("id"),
  "added_at"                 timestamptz not null default now(),

  constraint "dispute_party_exactly_one_subject" check (
    (party_user_id is not null and party_organization_id is null)
    or
    (party_user_id is null and party_organization_id is not null)
  ),
  constraint "dispute_party_role_valid" check (party_role in (
    'current_owner','claimant_owner','current_org_custody','claimant_org','witness'
  ))
);

create index if not exists "custody_dispute_parties_dispute_idx" on "public"."custody_dispute_parties" ("dispute_id");
create index if not exists "custody_dispute_parties_user_idx"    on "public"."custody_dispute_parties" ("party_user_id") where party_user_id is not null;
create index if not exists "custody_dispute_parties_org_idx"     on "public"."custody_dispute_parties" ("party_organization_id") where party_organization_id is not null;

-- ============================================================================
-- 3. RLS — admin universal, govt scoped to their jurisdictions, parties see
--    their own row. Writes go through server actions (service role bypasses
--    RLS). No INSERT/UPDATE/DELETE policies = denied to PostgREST clients.
-- ============================================================================
alter table "public"."custody_disputes" enable row level security;
alter table "public"."custody_dispute_parties" enable row level security;

drop policy if exists "custody_disputes select by parties and authorities" on "public"."custody_disputes";
create policy "custody_disputes select by parties and authorities"
  on "public"."custody_disputes" for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (
          (p.role = 'admin' and p.account_type = 'institutional' and p.deactivated_at is null)
          or
          (p.role = 'govt' and p.account_type = 'institutional' and p.deactivated_at is null
            and exists (
              select 1 from public.govt_assignments g
              where g.user_id = p.id
                and g.revoked_at is null
                and g.jurisdiction_province = custody_disputes.jurisdiction_province
                and g.jurisdiction_locality = custody_disputes.jurisdiction_locality
            )
          )
        )
    )
    or
    exists (
      select 1 from public.custody_dispute_parties cdp
      where cdp.dispute_id = custody_disputes.id
        and (
          cdp.party_user_id = auth.uid()
          or cdp.party_organization_id in (
            select om.organization_id from public.organization_memberships om
            where om.user_id = auth.uid() and om.left_at is null
          )
        )
    )
  );

drop policy if exists "custody_dispute_parties select by parties and authorities" on "public"."custody_dispute_parties";
create policy "custody_dispute_parties select by parties and authorities"
  on "public"."custody_dispute_parties" for select
  using (
    party_user_id = auth.uid()
    or party_organization_id in (
      select om.organization_id from public.organization_memberships om
      where om.user_id = auth.uid() and om.left_at is null
    )
    or exists (
      select 1 from public.custody_disputes cd
      join public.profiles p on p.id = auth.uid()
      where cd.id = custody_dispute_parties.dispute_id
        and (
          (p.role = 'admin' and p.account_type = 'institutional' and p.deactivated_at is null)
          or
          (p.role = 'govt' and exists (
            select 1 from public.govt_assignments g
            where g.user_id = p.id
              and g.revoked_at is null
              and g.jurisdiction_province = cd.jurisdiction_province
              and g.jurisdiction_locality = cd.jurisdiction_locality
          ))
        )
    )
  );
