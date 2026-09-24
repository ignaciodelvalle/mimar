-- Migration 0038 — FK ON DELETE clauses + FK column indexes
--
-- §3.1 (review 2026-05-19): 22 FKs were missing ON DELETE clauses, defaulting
-- to Postgres RESTRICT. This caused integration-test failures (see 0014 for
-- precedent). Each ALTER below drops the auto-named constraint and re-adds it
-- with the correct ON DELETE action.
--
-- §3.2 (review 2026-05-19): Postgres does NOT auto-index FK columns. Parent-row
-- deletes scan child tables without these. Added below via CREATE INDEX IF NOT EXISTS.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT, CREATE INDEX IF NOT EXISTS.
-- Re-runnable on any environment.

-- ============================================================================
-- §3.1 — Add ON DELETE clauses to FKs
-- ============================================================================

-- 1. govt_assignments.granted_by_user_id → profiles.id  (SET NULL — audit)
do $$ begin
  alter table public.govt_assignments
    drop constraint if exists govt_assignments_granted_by_user_id_fkey;
end $$;
alter table public.govt_assignments
  add constraint govt_assignments_granted_by_user_id_fkey
    foreign key (granted_by_user_id) references public.profiles(id) on delete set null;

-- 2. govt_assignments.revoked_by_user_id → profiles.id  (SET NULL — audit)
do $$ begin
  alter table public.govt_assignments
    drop constraint if exists govt_assignments_revoked_by_user_id_fkey;
end $$;
alter table public.govt_assignments
  add constraint govt_assignments_revoked_by_user_id_fkey
    foreign key (revoked_by_user_id) references public.profiles(id) on delete set null;

-- 3. approval_requests.initiated_by_user_id → profiles.id  (SET NULL — audit)
do $$ begin
  alter table public.approval_requests
    drop constraint if exists approval_requests_initiated_by_user_id_fkey;
end $$;
alter table public.approval_requests
  add constraint approval_requests_initiated_by_user_id_fkey
    foreign key (initiated_by_user_id) references public.profiles(id) on delete set null;

-- 4. approval_requests.decided_by_user_id → profiles.id  (SET NULL — audit)
do $$ begin
  alter table public.approval_requests
    drop constraint if exists approval_requests_decided_by_user_id_fkey;
end $$;
alter table public.approval_requests
  add constraint approval_requests_decided_by_user_id_fkey
    foreign key (decided_by_user_id) references public.profiles(id) on delete set null;

-- 5. audit_log.approval_request_id → approval_requests.id  (SET NULL — audit link)
do $$ begin
  alter table public.audit_log
    drop constraint if exists audit_log_approval_request_id_fkey;
end $$;
alter table public.audit_log
  add constraint audit_log_approval_request_id_fkey
    foreign key (approval_request_id) references public.approval_requests(id) on delete set null;

-- 6. audit_log.target_user_id → profiles.id  (SET NULL — audit)
do $$ begin
  alter table public.audit_log
    drop constraint if exists audit_log_target_user_id_fkey;
end $$;
alter table public.audit_log
  add constraint audit_log_target_user_id_fkey
    foreign key (target_user_id) references public.profiles(id) on delete set null;

-- 7. audit_log.target_organization_id → organizations.id  (SET NULL — audit)
do $$ begin
  alter table public.audit_log
    drop constraint if exists audit_log_target_organization_id_fkey;
end $$;
alter table public.audit_log
  add constraint audit_log_target_organization_id_fkey
    foreign key (target_organization_id) references public.organizations(id) on delete set null;

-- 8. audit_log.target_govt_assignment_id → govt_assignments.id  (SET NULL — audit)
do $$ begin
  alter table public.audit_log
    drop constraint if exists audit_log_target_govt_assignment_id_fkey;
end $$;
alter table public.audit_log
  add constraint audit_log_target_govt_assignment_id_fkey
    foreign key (target_govt_assignment_id) references public.govt_assignments(id) on delete set null;

-- 9. foster_proposals.proposed_by_user_id → profiles.id  (SET NULL — audit)
--    NOTE: The review listed this as "adoptionApplications.proposedByUserId" but
--    the actual table at db/schema.ts:1825 is foster_proposals. No adoptionApplications
--    table exists. Column name confirmed: proposed_by_user_id.
do $$ begin
  alter table public.foster_proposals
    drop constraint if exists foster_proposals_proposed_by_user_id_fkey;
end $$;
alter table public.foster_proposals
  add constraint foster_proposals_proposed_by_user_id_fkey
    foreign key (proposed_by_user_id) references public.profiles(id) on delete set null;

-- 10. foster_proposals.cancelled_by_user_id → profiles.id  (SET NULL — audit)
do $$ begin
  alter table public.foster_proposals
    drop constraint if exists foster_proposals_cancelled_by_user_id_fkey;
end $$;
alter table public.foster_proposals
  add constraint foster_proposals_cancelled_by_user_id_fkey
    foreign key (cancelled_by_user_id) references public.profiles(id) on delete set null;

-- 11. foster_proposals.resolved_ownership_id → ownerships.id  (SET NULL — informational)
do $$ begin
  alter table public.foster_proposals
    drop constraint if exists foster_proposals_resolved_ownership_id_fkey;
end $$;
alter table public.foster_proposals
  add constraint foster_proposals_resolved_ownership_id_fkey
    foreign key (resolved_ownership_id) references public.ownerships(id) on delete set null;

-- 12. custody_disputes.raised_by_user_id → profiles.id  (SET NULL — audit)
do $$ begin
  alter table public.custody_disputes
    drop constraint if exists custody_disputes_raised_by_user_id_fkey;
end $$;
alter table public.custody_disputes
  add constraint custody_disputes_raised_by_user_id_fkey
    foreign key (raised_by_user_id) references public.profiles(id) on delete set null;

-- 13. custody_disputes.raised_by_org_id → organizations.id  (SET NULL — audit)
do $$ begin
  alter table public.custody_disputes
    drop constraint if exists custody_disputes_raised_by_org_id_fkey;
end $$;
alter table public.custody_disputes
  add constraint custody_disputes_raised_by_org_id_fkey
    foreign key (raised_by_org_id) references public.organizations(id) on delete set null;

-- 14. custody_disputes.raising_event_id → pet_events.id
--    NOTE: The review listed this as "openedEventId" but the actual column is
--    raising_event_id (schema:1947). It is NOT NULL, so SET NULL is not valid
--    (Postgres rejects ON DELETE SET NULL on a NOT-NULL column). Using CASCADE
--    instead: if the founding pet_event is force-deleted (bypass trigger), the
--    dispute row disappears with it — correct behavior.
do $$ begin
  alter table public.custody_disputes
    drop constraint if exists custody_disputes_raising_event_id_fkey;
end $$;
alter table public.custody_disputes
  add constraint custody_disputes_raising_event_id_fkey
    foreign key (raising_event_id) references public.pet_events(id) on delete cascade;

-- 15. custody_disputes.resolution_event_id → pet_events.id  (SET NULL — audit linkage)
do $$ begin
  alter table public.custody_disputes
    drop constraint if exists custody_disputes_resolution_event_id_fkey;
end $$;
alter table public.custody_disputes
  add constraint custody_disputes_resolution_event_id_fkey
    foreign key (resolution_event_id) references public.pet_events(id) on delete set null;

-- 16. custody_disputes.resolved_by_user_id → profiles.id  (SET NULL — audit)
do $$ begin
  alter table public.custody_disputes
    drop constraint if exists custody_disputes_resolved_by_user_id_fkey;
end $$;
alter table public.custody_disputes
  add constraint custody_disputes_resolved_by_user_id_fkey
    foreign key (resolved_by_user_id) references public.profiles(id) on delete set null;

-- 17. custody_dispute_parties.party_user_id → profiles.id  (SET NULL — informational)
do $$ begin
  alter table public.custody_dispute_parties
    drop constraint if exists custody_dispute_parties_party_user_id_fkey;
end $$;
alter table public.custody_dispute_parties
  add constraint custody_dispute_parties_party_user_id_fkey
    foreign key (party_user_id) references public.profiles(id) on delete set null;

-- 18. custody_dispute_parties.party_organization_id → organizations.id  (SET NULL — informational)
do $$ begin
  alter table public.custody_dispute_parties
    drop constraint if exists custody_dispute_parties_party_organization_id_fkey;
end $$;
alter table public.custody_dispute_parties
  add constraint custody_dispute_parties_party_organization_id_fkey
    foreign key (party_organization_id) references public.organizations(id) on delete set null;

-- 19. custody_dispute_parties.added_by_user_id → profiles.id  (SET NULL — audit)
do $$ begin
  alter table public.custody_dispute_parties
    drop constraint if exists custody_dispute_parties_added_by_user_id_fkey;
end $$;
alter table public.custody_dispute_parties
  add constraint custody_dispute_parties_added_by_user_id_fkey
    foreign key (added_by_user_id) references public.profiles(id) on delete set null;

-- 20. pet_service_dog.verified_by_user_id → profiles.id  (SET NULL — audit)
do $$ begin
  alter table public.pet_service_dog
    drop constraint if exists pet_service_dog_verified_by_user_id_fkey;
end $$;
alter table public.pet_service_dog
  add constraint pet_service_dog_verified_by_user_id_fkey
    foreign key (verified_by_user_id) references public.profiles(id) on delete set null;

-- 21. pet_service_dog.revoked_by_user_id → profiles.id  (SET NULL — audit)
do $$ begin
  alter table public.pet_service_dog
    drop constraint if exists pet_service_dog_revoked_by_user_id_fkey;
end $$;
alter table public.pet_service_dog
  add constraint pet_service_dog_revoked_by_user_id_fkey
    foreign key (revoked_by_user_id) references public.profiles(id) on delete set null;

-- 22. cases.primary_pet_id → pets.id  (CASCADE — a case is meaningless without its pet)
do $$ begin
  alter table public.cases
    drop constraint if exists cases_primary_pet_id_fkey;
end $$;
alter table public.cases
  add constraint cases_primary_pet_id_fkey
    foreign key (primary_pet_id) references public.pets(id) on delete cascade;

-- ============================================================================
-- §3.2 — FK column indexes
-- Skipped (already exist in schema):
--   audit_log_request_idx       (audit_log.approval_request_id)
--   audit_log_target_user_idx   (audit_log.target_user_id)
-- ============================================================================

-- audit_log.target_organization_id
create index if not exists audit_log_target_organization_idx
  on public.audit_log (target_organization_id);

-- foster_proposals.proposed_by_user_id
create index if not exists foster_proposals_proposed_by_idx
  on public.foster_proposals (proposed_by_user_id);

-- foster_proposals.cancelled_by_user_id
create index if not exists foster_proposals_cancelled_by_idx
  on public.foster_proposals (cancelled_by_user_id);

-- foster_proposals.resolved_ownership_id
create index if not exists foster_proposals_resolved_ownership_idx
  on public.foster_proposals (resolved_ownership_id);

-- approval_requests.initiated_by_user_id
create index if not exists approval_requests_initiated_by_idx
  on public.approval_requests (initiated_by_user_id);

-- approval_requests.decided_by_user_id
create index if not exists approval_requests_decided_by_idx
  on public.approval_requests (decided_by_user_id);

-- pets.adoption_eligibility_set_by_user_id
create index if not exists pets_adoption_eligibility_set_by_idx
  on public.pets (adoption_eligibility_set_by_user_id);
