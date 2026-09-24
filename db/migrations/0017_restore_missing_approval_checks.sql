-- Restore the three approval_requests CHECK constraints that are present
-- in migration 0010 but absent in some dev DBs (likely due to historical
-- drizzle-kit push usage that bypassed the raw SQL CHECKs):
--
--   1. approval_initiated_valid   — initiated_by ∈ {'self','authority'}
--   2. approval_status_valid      — status ∈ {'pending','approved','rejected','withdrawn'}
--   3. approval_decision_consistent — decided_at/decided_by paired with terminal status
--
-- The 4th and 5th CHECKs (approval_type_valid, approval_target_consistent)
-- were already re-applied by migration 0015.
--
-- Idempotent: each ADD wrapped in DO $$ BEGIN … EXCEPTION WHEN
-- duplicate_object THEN NULL END $$;
--
-- Verified zero violating rows before apply:
--   SELECT count(*) FROM approval_requests WHERE
--     (status IN ('approved','rejected')
--       AND (decided_at IS NULL OR decided_by_user_id IS NULL))
--     OR (status IN ('pending','withdrawn')
--       AND (decided_at IS NOT NULL OR decided_by_user_id IS NOT NULL))
--     OR initiated_by NOT IN ('self','authority')
--     OR status NOT IN ('pending','approved','rejected','withdrawn');
-- → 0
--
-- Applied via:
--   cat db/migrations/0017_restore_missing_approval_checks.sql | \
--     docker exec -i supabase_db_DIM psql -U postgres -d postgres -v ON_ERROR_STOP=1

do $$ begin
  alter table public.approval_requests
    add constraint approval_initiated_valid
    check (initiated_by in ('self', 'authority'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.approval_requests
    add constraint approval_status_valid
    check (status in ('pending', 'approved', 'rejected', 'withdrawn'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.approval_requests
    add constraint approval_decision_consistent
    check (
      (status in ('approved', 'rejected') and decided_at is not null and decided_by_user_id is not null)
      or (status in ('pending', 'withdrawn') and decided_at is null and decided_by_user_id is null)
    );
exception when duplicate_object then null;
end $$;
