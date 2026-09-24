-- Pets adoption eligibility — spec foster-volunteers-pool v1.4 §17.
--
-- Adds 6 columns to pets that capture whether the animal is currently
-- adoption-eligible, why (structured reason), free-text notes for the 'other'
-- branch, optional "ineligible until" target date, and authorship of the
-- last state change. Default is NULL (no determinado todavía).
--
-- 4 CHECK constraints enforce the data shape:
--   - reason enum
--   - (eligible IS NOT NULL ⇔ set_at IS NOT NULL): a state was set
--   - eligible=false REQUIRES reason
--   - reason='other' REQUIRES free-text notes
--
-- 2 partial indexes:
--   - WHERE adoption_eligible IS NOT NULL — surfaces "evaluated pets"
--   - WHERE adoption_eligible=false + ineligible_until IS NOT NULL —
--     supports a future "revisit pending pets" cron / surface
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + DO blocks for CHECK constraints.
--
-- Applied via:
--   cat db/migrations/0023_pets_adoption_eligibility.sql | \
--     docker exec -i supabase_db_DIM psql -U postgres -d postgres -v ON_ERROR_STOP=1

alter table public.pets
  add column if not exists adoption_eligible                  boolean,
  add column if not exists adoption_ineligible_reason         text,
  add column if not exists adoption_ineligible_reason_notes   text,
  add column if not exists adoption_ineligible_until          timestamptz,
  add column if not exists adoption_eligibility_set_at        timestamptz,
  add column if not exists adoption_eligibility_set_by_user_id uuid
    references public.profiles(id);

do $$ begin
  alter table public.pets
    add constraint pets_adoption_ineligible_reason_valid check (
      adoption_ineligible_reason is null
      or adoption_ineligible_reason in (
        'medical_treatment','behavioral_evaluation','recovery','quarantine',
        'legal_hold','age','pending_intake_eval','other'
      )
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.pets
    add constraint pets_adoption_eligibility_consistent check (
      (adoption_eligible is not null and adoption_eligibility_set_at is not null)
      or (adoption_eligible is null and adoption_eligibility_set_at is null)
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.pets
    add constraint pets_adoption_ineligible_reason_required check (
      adoption_eligible is null
      or adoption_eligible = true
      or (adoption_eligible = false and adoption_ineligible_reason is not null)
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.pets
    add constraint pets_adoption_ineligible_other_needs_notes check (
      adoption_ineligible_reason is null
      or adoption_ineligible_reason != 'other'
      or (adoption_ineligible_reason_notes is not null
          and length(trim(adoption_ineligible_reason_notes)) > 0)
    );
exception when duplicate_object then null; end $$;

create index if not exists pets_adoption_eligibility_idx
  on public.pets (adoption_eligible)
  where adoption_eligible is not null;

create index if not exists pets_adoption_ineligible_until_idx
  on public.pets (adoption_ineligible_until)
  where adoption_eligible = false and adoption_ineligible_until is not null;

comment on column public.pets.adoption_eligible is
  'Adoption eligibility flag (spec v1.4 §17). NULL = not determined yet (default at intake). TRUE = listed in /adoptar future surface. FALSE = listed under the org "no aptas" view with a structured reason.';
comment on column public.pets.adoption_ineligible_reason is
  '8-value enum: medical_treatment | behavioral_evaluation | recovery | quarantine | legal_hold | age | pending_intake_eval | other. Required when adoption_eligible=false.';
