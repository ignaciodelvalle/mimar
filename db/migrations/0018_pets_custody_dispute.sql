-- Adds pets.in_custody_dispute boolean flag.
--
-- True while the pet is in external legal custody proceedings (parental
-- divorce, succession, criminal seizure pending return). Default false so
-- existing pets are unaffected.
--
-- Set true by custody_dispute_raised events (admin- or govt-initiated),
-- unset by custody_dispute_resolved. The server actions that emit those
-- events and dual-write this column are NOT in this migration — only the
-- schema lands here. When the dispute workflow is implemented, server actions
-- atomically update the column alongside the event insert.
--
-- Features that should respect the flag (block transfers, block adoption
-- finalize, block scheduling, etc.) are designed per-feature when they emerge.
-- The flag exists today as a queryable signal; it does not yet block anything.
--
-- Partial index on `true` keeps "disputed pets" queries fast without bloating
-- the index for the (overwhelming) false majority.
--
-- Applied via:
--   cat db/migrations/0018_pets_custody_dispute.sql | \
--     docker exec -i supabase_db_DIM psql -U postgres -d postgres -v ON_ERROR_STOP=1

alter table public.pets
  add column if not exists in_custody_dispute boolean not null default false;

create index if not exists pets_in_custody_dispute_idx
  on public.pets (in_custody_dispute)
  where in_custody_dispute = true;

comment on column public.pets.in_custody_dispute is
  'True while pet is in external legal custody proceedings. Set by custody_dispute_raised event (admin or govt initiated), unset by custody_dispute_resolved.';
