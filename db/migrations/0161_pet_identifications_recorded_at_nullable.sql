-- pet_identifications.recorded_at becomes NULLABLE.
--
-- WHY
-- ---------------------------------------------------------------------------
-- `recorded_at` means "when the identification was MADE" — the day the tattoo
-- was applied, the day the microchip was implanted. It is not "when we wrote
-- this down".
--
-- The event spine already models the case where nobody knows: a tattoo_recorded
-- payload carries `tattoo_date_known: false` with `recorded_at: null`, which is
-- an event explicitly declining to state the date. That happens constantly in
-- the real world — an adopted adult dog arrives already tattooed and no one can
-- say when.
--
-- The column being NOT NULL made that unrepresentable, so every writer had to
-- invent something. scripts/seed-demo.ts fell back to the date the EVENT was
-- recorded, and the pet's credential then displayed that invented day as the
-- tattoo's date. lib/projections/pet-tattoo.ts derives the honest answer
-- (`tattoo_date_known ? recorded_at : null`), so cache and spine disagreed BY
-- CONSTRUCTION — caught by the fitness sweep in
-- __tests__/pet-cache-rederivation.test.ts on DIM-JUF5-ZW5J:
-- stored "2026-07-26", derived null.
--
-- Making the projection match the cache instead would mean asserting a date
-- nobody claimed, which is the same defect the libreta's `unconfirmed` state
-- was introduced to stop. The schema is what has to move.
--
-- SAFETY
-- ---------------------------------------------------------------------------
-- Dropping NOT NULL is additive: every existing row keeps its value, every
-- existing query keeps working, and no writer is forced to change. Readers that
-- assumed non-null get a null only for identifications whose date is genuinely
-- unknown — which is the information they were previously being lied to about.
--
-- Forward-only and idempotent (DROP NOT NULL on an already-nullable column is a
-- no-op in Postgres, but the guard keeps a re-run silent).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pet_identifications'
      AND column_name = 'recorded_at'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.pet_identifications
      ALTER COLUMN recorded_at DROP NOT NULL;
  END IF;
END
$$;

COMMENT ON COLUMN public.pet_identifications.recorded_at IS
  'When the identification was MADE (tattoo applied, chip implanted) — NOT when it was recorded in DIM. NULL means genuinely unknown, which the event spine models as tattoo_date_known=false; never substitute the event date.';
