-- Cases — receiver_organization_id canonical column.
--
-- Closes the §4.2 follow-up from docs/project-status-2026-05-21.md.
-- Pre-existing behavior: `acceptCrossOrgTransferAction` (cross-org
-- transfer handshake) trusted `proposalPayload.to_organization_id` to
-- decide which org was authorized to accept. With this migration the
-- value is also stored on `cases.receiver_organization_id` so the
-- accept path can authorize against the canonical column instead of
-- the payload — payload remains as a cross-check.
--
-- Scope:
--   1. Add nullable column `cases.receiver_organization_id` (FK on delete set null).
--   2. Backfill from the most recent `custody_transfer_proposed` event
--      payload `to_organization_id` for every case currently in the
--      `custody_transfer_handshake` kind, regardless of status (open or
--      already closed — closed cases get the column populated for
--      historical traceability).
--   3. Add a partial index for queue-style "incoming proposals for org X"
--      lookups.
--
-- Idempotent — safe to re-run.

alter table public.cases
  add column if not exists receiver_organization_id uuid references public.organizations(id) on delete set null;

create index if not exists cases_receiver_org_open_idx
  on public.cases (receiver_organization_id, case_kind)
  where status in ('open', 'escalated') and receiver_organization_id is not null;

-- Backfill from event payload. The unique-proposal-per-case invariant is
-- enforced at write time by `proposeCrossOrgTransferAction`, but we use
-- DISTINCT ON (case_id) ordered by recorded_at DESC so any historical
-- duplicate is resolved deterministically (latest wins, mirroring the
-- accept-path tie-break).
update public.cases c
set receiver_organization_id = picked.to_organization_id::uuid
from (
  select distinct on (pe.case_id)
    pe.case_id,
    pe.payload ->> 'to_organization_id' as to_organization_id
  from public.pet_events pe
  where pe.event_type = 'custody_transfer_proposed'
    and pe.case_id is not null
    and pe.payload ->> 'to_organization_id' is not null
  order by pe.case_id, pe.recorded_at desc
) picked
where c.id = picked.case_id
  and c.case_kind = 'custody_transfer_handshake'
  and c.receiver_organization_id is null;
