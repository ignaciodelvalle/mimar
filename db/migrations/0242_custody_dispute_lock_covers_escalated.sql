-- T4-D1 — an escalated custody dispute KEEPS the custody lock (PO decision 2A,
-- 2026-09-22).
--
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- Migration 0235 taught `custody_disputes.status` to hold 'escalated' so the
-- dispute row could follow its case, and deliberately stopped there: every
-- reader still understood "in dispute" as the literal `status = 'open'`.
-- Writing 'escalated' in that state would have SILENTLY RELEASED the lock on
-- the animal — the one-open-dispute-per-pet uniqueness would have freed up, the
-- `pets.in_custody_dispute` cache would have re-derived to false on the next
-- reconcile sweep, the transfer and adoption-finalize guards would have opened,
-- and the dispute would have vanished from the arbiter's and the authority's
-- queue. A dispute that moved to judicial channels would have looked, to every
-- reader in the system, exactly like a dispute that had been settled.
--
-- The TypeScript half of the fix moves every reader onto IN_DISPUTE_STATUSES /
-- `disputeHoldsCustodyLock()` (db/schema.ts). This migration moves the two
-- database-side readers: the partial indexes whose WHERE clause IS the
-- predicate.
--
--   custody_disputes_one_open_per_pet  — the uniqueness guard. Partial on
--       `status = 'open'`, so an escalated dispute stopped occupying the slot
--       and a SECOND dispute could be opened over a pet already in one.
--   custody_disputes_juris_open_idx    — the jurisdiction worklist index. Not a
--       correctness boundary, but it must cover the same set the queue now
--       reads or the queue falls off its index.
--
-- Neither index is RENAMED. The name still says "open"; renaming a shipped
-- index buys nothing and costs a drift diff in every environment. The predicate
-- is what carries the meaning, and db/schema.ts derives it from the constant.
--
-- WHY THIS CANNOT FAIL ON EXISTING DATA
-- ---------------------------------------------------------------------------
-- The new unique index is STRICTER than the old one: a pet holding one 'open'
-- and one 'escalated' dispute satisfies the old predicate and violates the new
-- one. Nothing in the application has ever written 'escalated' to this table
-- (that writer lands in the same change, after this migration), so the set is
-- provably empty — but "provably empty" is an argument about the code, and this
-- runs against a database that has been hand-patched before (see 0239). So we
-- MEASURE instead of asserting: the guard below names every offending pet and
-- refuses with an actionable message, rather than letting CREATE UNIQUE INDEX
-- fail with a duplicate-key error that names one row and explains nothing.
--
-- Forward-only and idempotent — safe to re-run.

-- ============================================================================
-- 1. Pre-flight — refuse loudly, and by name, if the data cannot take the index
-- ============================================================================
do $$
declare
  offenders text;
begin
  select string_agg(pet_id::text, ', ' order by pet_id)
    into offenders
  from (
    select pet_id
    from public.custody_disputes
    where status in ('open', 'escalated')
    group by pet_id
    having count(*) > 1
  ) dupes;

  if offenders is not null then
    raise exception using
      message = 'custody_disputes: more than one in-dispute row per pet',
      detail  = format(
        'pet_id(s): %s. The one-in-dispute-per-pet unique index cannot be '
        || 'created while these exist.', offenders),
      hint    = 'Resolve or withdraw the redundant dispute rows, then re-run '
        || 'this migration. Do NOT widen the index to accommodate them: two '
        || 'live disputes over one animal is the state the index exists to '
        || 'prevent.';
  end if;
end
$$;

-- ============================================================================
-- 2. The uniqueness guard — one IN-DISPUTE dispute per pet, open or escalated
-- ============================================================================
drop index if exists "public"."custody_disputes_one_open_per_pet";

create unique index if not exists "custody_disputes_one_open_per_pet"
  on "public"."custody_disputes" ("pet_id")
  where status in ('open', 'escalated');

-- ============================================================================
-- 3. The jurisdiction worklist index — same set the /gob queue now reads
-- ============================================================================
drop index if exists "public"."custody_disputes_juris_open_idx";

create index if not exists "custody_disputes_juris_open_idx"
  on "public"."custody_disputes" ("jurisdiction_province", "jurisdiction_locality")
  where status in ('open', 'escalated');

comment on index "public"."custody_disputes_one_open_per_pet" is
  'At most one IN-DISPUTE (open or escalated) custody dispute per pet. '
  'Escalation moves the matter to judicial channels; it does not free the slot '
  '(PO decision 2A, 2026-09-22 — migration 0242).';
