-- ────────────────────────────────────────────────────────────────────────────
-- 0248_place_columns.sql
-- Every table that stores a place can say WHICH catalogue row it is and HOW
-- that was decided, and a catalogue row can no longer vanish from under it.
--
-- WHY (localidades-por-id, stage B1)
-- ----------------------------------
-- The PO's three properties: P1 never confuse places, P2 never lose an event's
-- origin place, P3 always reach exactly the right authority. Scope, routing and
-- the RLS policies still match places by NAME, and the INDEC catalogue ships
-- 68 (province, name) collisions (Mechita: partido Alberti and partido
-- Bragado). The id (`ar_localities.id`, the uuid PK — CABA barrios have no
-- INDEC id) is the only key that tells two Mechitas apart. Stage B stores it
-- everywhere a place is stored; stage D switches the readers to it, behind
-- flags, after a shadow comparison.
--
-- WHAT
-- ----
--   1. `place_method` on pets / cases / welfare_reports, which already carry
--      `locality_id` (0147): HOW the id was decided (lib/domain/place.ts).
--      NULL = not recorded (every row written before this migration); stage
--      B5's backfill and repair fill it where the answer is honest.
--   2. `locality_id` + `place_method` on the nine other place tables the
--      audit mapped (organizations, organization_coverage, service_offerings,
--      govt_business_rules, alert_subscriptions, alert_firings,
--      foster_volunteers, approval_requests, custody_disputes), and the
--      outbox's own snapshot pair: `target_locality_id` +
--      `target_place_method` on event_notification_outbox (the outbox
--      snapshots the place at event time and must never re-read the pet).
--   3. `place_entered` on welfare_reports: the place AS ENTERED
--      ({entered, resolved[, candidates]}, lib/events/place-payload.ts). A
--      denuncia about an animal that is not registered — and every API
--      denuncia about one — writes NO event, so until now a typed locality
--      that did not resolve (a homonym, a name the catalogue lacks) was lost:
--      the row keeps the province-level pair only. This is where it lives.
--   4. ON DELETE RESTRICT on EVERY foreign key into ar_localities, the four
--      that exist (0147, 0246) included. They were SET NULL: a catalogue row
--      physically deleted would have silently erased the origin of every row
--      pointing at it (P2). The importer only soft-deletes (`removed_at`), so
--      RESTRICT never fires on the normal path; it is what makes a hard
--      delete a loud error instead of a quiet loss.
--
-- The method CHECK is the list in lib/domain/place.ts, in the same order;
-- __tests__/place-columns.test.ts compares the two. There is no method that
-- picks among homonyms, by construction (P1).
--
-- ADDITIVE / UNREAD
-- -----------------
-- Every new column is nullable and nothing reads it yet. The display pair
-- (`jurisdiction_province`, `jurisdiction_locality`) stays the scope key until
-- stage D. The only new WRITERS in this stage are the three denuncia doors
-- (`place_entered` + `place_method`); lib/infra/schema-guard.ts lists those
-- columns so /api/health answers 503 on a database without this migration.
--
-- Idempotent-safe (IF NOT EXISTS; the FK swap drops by catalogue lookup and
-- re-adds under a fixed name). Forward-only. Rollback: the columns are unread —
-- revert the writers; a forward migration may drop them.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. place_method where locality_id already exists ---------------------------

ALTER TABLE pets ADD COLUMN IF NOT EXISTS place_method text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS place_method text;
ALTER TABLE welfare_reports ADD COLUMN IF NOT EXISTS place_method text;

-- 2. locality_id + place_method on the other place tables ---------------------

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS locality_id uuid,
  ADD COLUMN IF NOT EXISTS place_method text;
ALTER TABLE organization_coverage
  ADD COLUMN IF NOT EXISTS locality_id uuid,
  ADD COLUMN IF NOT EXISTS place_method text;
ALTER TABLE service_offerings
  ADD COLUMN IF NOT EXISTS locality_id uuid,
  ADD COLUMN IF NOT EXISTS place_method text;
ALTER TABLE govt_business_rules
  ADD COLUMN IF NOT EXISTS locality_id uuid,
  ADD COLUMN IF NOT EXISTS place_method text;
ALTER TABLE alert_subscriptions
  ADD COLUMN IF NOT EXISTS locality_id uuid,
  ADD COLUMN IF NOT EXISTS place_method text;
ALTER TABLE alert_firings
  ADD COLUMN IF NOT EXISTS locality_id uuid,
  ADD COLUMN IF NOT EXISTS place_method text;
ALTER TABLE foster_volunteers
  ADD COLUMN IF NOT EXISTS locality_id uuid,
  ADD COLUMN IF NOT EXISTS place_method text;
ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS locality_id uuid,
  ADD COLUMN IF NOT EXISTS place_method text;
ALTER TABLE custody_disputes
  ADD COLUMN IF NOT EXISTS locality_id uuid,
  ADD COLUMN IF NOT EXISTS place_method text;
ALTER TABLE event_notification_outbox
  ADD COLUMN IF NOT EXISTS target_locality_id uuid,
  ADD COLUMN IF NOT EXISTS target_place_method text;

-- 3. the place as entered, where no event holds it ----------------------------

ALTER TABLE welfare_reports ADD COLUMN IF NOT EXISTS place_entered jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'welfare_reports_place_entered_object'
       AND conrelid = 'public.welfare_reports'::regclass
  ) THEN
    ALTER TABLE welfare_reports
      ADD CONSTRAINT welfare_reports_place_entered_object
      CHECK (place_entered IS NULL OR jsonb_typeof(place_entered) = 'object');
  END IF;
END
$$;

-- 4. the method vocabulary, and RESTRICT on every FK into the catalogue -------

DO $$
DECLARE
  t record;
  fk record;
  methods constant text :=
    '(''indec_id'', ''catalogue_id'', ''exact_name_unique'', ''folded_name_unique'', '
    '''geocode_unique'', ''user_picked'', ''spine_rederived'', ''legacy_unique_name'', '
    '''admin_queue'', ''unresolved'')';
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('pets', 'locality_id', 'place_method'),
      ('cases', 'locality_id', 'place_method'),
      ('welfare_reports', 'locality_id', 'place_method'),
      ('govt_assignments', 'locality_id', NULL),
      ('organizations', 'locality_id', 'place_method'),
      ('organization_coverage', 'locality_id', 'place_method'),
      ('service_offerings', 'locality_id', 'place_method'),
      ('govt_business_rules', 'locality_id', 'place_method'),
      ('alert_subscriptions', 'locality_id', 'place_method'),
      ('alert_firings', 'locality_id', 'place_method'),
      ('foster_volunteers', 'locality_id', 'place_method'),
      ('approval_requests', 'locality_id', 'place_method'),
      ('custody_disputes', 'locality_id', 'place_method'),
      ('event_notification_outbox', 'target_locality_id', 'target_place_method')
    ) AS v(tbl, id_col, method_col)
  LOOP
    -- Drop whatever FK the column has today (0147/0246 created them unnamed,
    -- and a drizzle push names them differently), then add the RESTRICT one.
    FOR fk IN
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f'
         AND c.conrelid = format('public.%I', t.tbl)::regclass
         AND c.confrelid = 'public.ar_localities'::regclass
         AND a.attname = t.id_col
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t.tbl, fk.conname);
    END LOOP;
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) '
      'REFERENCES public.ar_localities (id) ON DELETE RESTRICT',
      t.tbl, t.tbl || '_' || t.id_col || '_restrict_fk', t.id_col
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (%I) WHERE %I IS NOT NULL',
      t.tbl || '_' || t.id_col || '_idx', t.tbl, t.id_col, t.id_col
    );

    IF t.method_col IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = t.tbl || '_' || t.method_col || '_known'
         AND conrelid = format('public.%I', t.tbl)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR %I IN %s)',
        t.tbl, t.tbl || '_' || t.method_col || '_known', t.method_col, t.method_col, methods
      );
    END IF;
  END LOOP;
END
$$;

COMMENT ON COLUMN welfare_reports.place_entered IS
  'The place as ENTERED and as RESOLVED ({entered, resolved[, candidates]}, lib/events/place-payload.ts). Never rewritten: a later resolution is a place_resolutions row (0250). localidades-por-id B1.';
COMMENT ON COLUMN pets.place_method IS
  'HOW locality_id was decided (lib/domain/place.ts). NULL = not recorded (rows before 0248). Cache: the spine decides.';
COMMENT ON COLUMN event_notification_outbox.target_locality_id IS
  'The catalogue row the notification targets, snapshotted at event time; never re-read from the pet. localidades-por-id B1.';
