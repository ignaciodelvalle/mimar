-- Migration 0069: case_events — generic pet-independent timeline table for any
-- case kind that needs a chronological activity log not tied to a pet.
--
-- Motivation: pet_events.pet_id is NOT NULL at the DB level, so general-subject
-- cases (primarySubjectKind = 'general' | 'location' | 'unowned_animal') cannot
-- use pet_events for case-scoped entries. This table fills that gap in a
-- domain-agnostic way — outbreak_investigation uses it today; decomiso,
-- welfare, and foster pet-less cases can reuse it without a new migration.
--
-- Design decisions:
--  - Plain text `entry_type` (not a PG enum) — same pattern as pet_events.event_type
--    and audit_log.action. Adding a new entry type is a one-line Zod/TS change.
--  - `payload` JSONB with ::jsonb cast default mirrors pet_events.payload convention.
--  - `case_id` FK with ON DELETE CASCADE: events belong to the case lifecycle.
--  - `recorded_by_user_id` FK to profiles with ON DELETE SET NULL mirrors petEvents.
--  - No `pet_id` column — intentionally pet-free.
--  - Append-only by convention (no UPDATE trigger yet; add when needed).
--  - Primary index uses DESC on occurred_at for efficient "latest first" queries.

CREATE TABLE IF NOT EXISTS case_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  entry_type          text NOT NULL,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes               text,
  recorded_by_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS case_events_case_id_occurred_idx
  ON case_events (case_id, occurred_at DESC);

COMMENT ON TABLE case_events IS
  'Generic pet-independent timeline entries for any case kind whose primary subject
   is not a pet (outbreak_investigation, future decomiso/welfare/foster general-subject
   cases). Mirrors pet_events semantics but without a pet_id FK requirement.';
