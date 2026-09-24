-- Migration 0081: Expression indexes on pet_events JSONB payload fields (ARCH-K P2)
--
-- Problem
-- -------
-- Several hot-path queries filter or join on JSONB payload fields via
-- `payload->>'field'` in WHERE clauses or NOT EXISTS anti-joins. Without indexes
-- these degrade linearly with pet_events table growth. Three patterns appear on
-- owner-facing and org-facing pages that run on every page load.
--
-- Index selection rationale
-- -------------------------
-- INDEXED (high cardinality, hot paths, NOT EXISTS anti-joins):
--
--   1. medication_started_event_id (TEXT extracted from UUID)
--      Pattern: NOT EXISTS (SELECT 1 FROM pet_events stop
--                WHERE stop.event_type = 'medication_stopped'
--                  AND stop.pet_id = e.pet_id
--                  AND stop.payload->>'medication_started_event_id' = e.id::text)
--      Hot paths: lib/owner-dashboard.ts:245 (active medications widget)
--      Cardinality: one row per medication_stopped event; UUID-like text,
--                   effectively unique. Index + partial predicate IS NOT NULL
--                   keeps the index small.
--
--   2. application_event_id (TEXT extracted from UUID)
--      Pattern: NOT EXISTS / JOIN ON payload->>'application_event_id' = <eventId>
--      Hot paths (7 call sites):
--        lib/owner-dashboard.ts:387, 754, 1291
--        app/mis-mascotas/postulaciones/page.tsx:106
--        app/org/[orgToken]/adopciones/[appEventId]/page.tsx:109
--        app/org/[orgToken]/adopciones/page.tsx:77
--        src/modules/adoption/infrastructure/adoption-repository.ts:391, 449, 490
--      Cardinality: one adoption_application_resolved per application; UUID-like.
--
--   3. applicant_user_id (UUID stored as TEXT in JSONB)
--      Pattern: WHERE payload->>'applicant_user_id' = $userId
--      Hot paths (5 call sites):
--        lib/owner-dashboard.ts:382, 1286
--        app/mis-mascotas/postulaciones/page.tsx:94
--        src/modules/adoption/infrastructure/adoption-repository.ts:386, 485
--      Cardinality: high (UUID per user), filtered down by event_type first but
--                   combined index on event_type + expression would require a
--                   functional index with multiple keys — drizzle doesn't support
--                   multi-column expression indexes cleanly. A single expression
--                   index on the payload key is enough; the planner can combine
--                   it with pet_events_event_type_idx via BitmapAnd.
--
-- NOT INDEXED (deliberate):
--
--   adopter_user_id — only 2 call sites; queries JOIN ON pet_id first (already
--     indexed via pet_events_pet_id_occurred_at_idx), so JSONB filter is applied
--     to a tiny set. Index overhead not justified.
--
--   is_self_scan — boolean (2 values); very low cardinality; a partial index
--     on a boolean does nothing useful for the planner.
--
--   kind / outcome / text / drug_name / frequency / etc. — read-only extraction
--     (SELECT payload->>'field'), not used in WHERE filters on hot paths.
--     Several appear in migration backfill WHERE clauses (already run once, not
--     repeated).
--
-- Transaction note
-- ----------------
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction. drizzle-kit does NOT
-- wrap individual migration files in explicit BEGIN/COMMIT blocks — the bootstrap
-- replays them via psql without wrapping transactions. However, plain
-- CREATE INDEX (without CONCURRENTLY) is transactional and safe in any context.
-- We use plain CREATE INDEX IF NOT EXISTS:
--   - Avoids the CONCURRENTLY restriction (no explicit transaction wrapping needed).
--   - On production this briefly holds ShareLock on pet_events during build.
--     Acceptable for a low-write audit table with no concurrent writers during
--     migrations. Lock is held only for the duration of the index build.
--   - IF NOT EXISTS makes the migration idempotent / re-runnable.
--
-- Drizzle schema.ts
-- -----------------
-- Expression indexes on JSONB (payload->>'field') are representable via
-- .on(sql`payload->>'field'`) using the same sql-template pattern already used
-- for the lower(email) index at org_invitations_active_unique (schema.ts:3479).
-- The schema.ts additions below keep the drift check (pnpm db:push / CI db-check)
-- in sync with the migration.

-- 1. medication_started_event_id
--    Serves: NOT EXISTS anti-join in active medications widget
CREATE INDEX IF NOT EXISTS pet_events_payload_med_started_idx
  ON public.pet_events ((payload->>'medication_started_event_id'))
  WHERE payload->>'medication_started_event_id' IS NOT NULL;

-- 2. application_event_id
--    Serves: NOT EXISTS anti-join + direct lookup in adoption review flows
CREATE INDEX IF NOT EXISTS pet_events_payload_app_event_id_idx
  ON public.pet_events ((payload->>'application_event_id'))
  WHERE payload->>'application_event_id' IS NOT NULL;

-- 3. applicant_user_id
--    Serves: owner-facing adoption application listing / counting
CREATE INDEX IF NOT EXISTS pet_events_payload_applicant_user_id_idx
  ON public.pet_events ((payload->>'applicant_user_id'))
  WHERE payload->>'applicant_user_id' IS NOT NULL;
