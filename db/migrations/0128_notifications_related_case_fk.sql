-- Migration 0128: give notifications.related_case_id a real FK to cases(id)
-- with ON DELETE SET NULL (DB-integrity review 2026-07-04 — C6, defense-in-depth).
--
-- THE GAP
-- -------
-- notifications.related_case_id was a bare uuid with NO foreign key. Nothing
-- stopped a notification from referencing a case that does not exist, and a
-- hard-deleted case left dangling references behind (the dashboard "collapse
-- N case notifications into one" grouping then points at a ghost). The absence
-- is already visible in data: on the current local DB 265 of 377 non-null
-- related_case_id values are orphaned — cases that were deleted (e.g. cascaded
-- from a pet hard-delete via cases.primary_pet_id ON DELETE CASCADE) while the
-- notification survived.
--
-- FIX
-- ---
-- Add the FK with ON DELETE SET NULL: a deleted case now nulls the reference
-- instead of leaving a dangling uuid (graceful — the notification survives, it
-- just loses the case grouping). SET NULL (not CASCADE/RESTRICT) is correct
-- because a notification is not owned by its case and must outlive it.
--
-- HEAL-BEFORE-ADD
-- ---------------
-- ADD CONSTRAINT validates existing rows, so the pre-existing orphans would
-- reject it. We null them first — that is exactly the value ON DELETE SET NULL
-- would have written had the FK existed when those cases were deleted, so the
-- heal is semantically identical to the fix, not a data loss. notifications has
-- no append-only trigger, so the UPDATE is unguarded.
--
-- IDEMPOTENCY
-- -----------
-- The heal UPDATE is naturally re-runnable. The ADD is guarded by a pg_constraint
-- existence check. Safe to replay. The constraint name matches drizzle-kit's
-- default (`<table>_<col>_<reftable>_<refcol>_fk`) so schema.ts (which now
-- declares the same reference) and the DB agree — no drizzle-kit push drift.

-- 1. Heal dangling references (cases that no longer exist) before adding the FK.
update public.notifications n
   set related_case_id = null
 where n.related_case_id is not null
   and not exists (
     select 1 from public.cases c where c.id = n.related_case_id
   );

-- 2. Add the FK (idempotent — guarded by constraint existence).
do $$ begin
  if not exists (
    select 1
    from   pg_constraint c
    join   pg_class t on t.oid = c.conrelid
    where  t.relname = 'notifications'
      and  c.conname = 'notifications_related_case_id_cases_id_fk'
  ) then
    alter table public.notifications
      add constraint notifications_related_case_id_cases_id_fk
      foreign key (related_case_id) references public.cases(id)
      on delete set null;
  end if;
end $$;
