-- ────────────────────────────────────────────────────────────────────────────
-- 0255_authority_unit_refs.sql
-- The five tables that name a jurisdiction can reference an authority unit.
--
-- WHY (localidades-por-id C3)
-- ---------------------------
-- A grant, a business rule, an organisation's coverage, a service offering and
-- an alert subscription each say "this place" by NAME today (the
-- jurisdiction_province / jurisdiction_locality pair). Stage D moves every
-- reader to units, one row at a time, behind a shadow comparison. That needs
-- somewhere to say WHICH unit:
--
--   authority_unit_id NULL  → the legacy name path, exactly as today;
--   authority_unit_id set   → the unit path (its active members, or the whole
--                             province for a provincial unit).
--
-- Never both, never OR'd: a row flips individually, so moving one grant to
-- its unit cannot widen anybody else's (design, "Scope, RLS, routing, rules").
-- Setting it on a per-locality grant WOULD widen that grant to the whole unit,
-- which is why no writer fills it here: the partial-grant report
-- (scripts/seed-authority-units.ts, D2) lists those for a person to confirm.
--
-- Every reference is ON DELETE RESTRICT (a unit is never deleted — 0253 — and
-- a row must never lose its scope in silence). The constraint is added NOT
-- VALID and validated in a separate step, as 0248 does for its FKs, so the
-- stronger lock is never held while the table is scanned. Every row is NULL,
-- so the validation has nothing to reject.
--
-- Idempotent. Forward-only. Rollback: the columns are unread; NULL is the
-- name path, so leaving them NULL is the rollback.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.govt_assignments      ADD COLUMN IF NOT EXISTS authority_unit_id uuid;
ALTER TABLE public.govt_business_rules   ADD COLUMN IF NOT EXISTS authority_unit_id uuid;
ALTER TABLE public.organization_coverage ADD COLUMN IF NOT EXISTS authority_unit_id uuid;
ALTER TABLE public.service_offerings     ADD COLUMN IF NOT EXISTS authority_unit_id uuid;
ALTER TABLE public.alert_subscriptions   ADD COLUMN IF NOT EXISTS authority_unit_id uuid;

DO $$
DECLARE
  t text;
  fk record;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'govt_assignments', 'govt_business_rules', 'organization_coverage',
    'service_offerings', 'alert_subscriptions'
  ]
  LOOP
    -- One reference per column: a bootstrap's drizzle push creates its own
    -- FK before this replay runs, under another name. Keep only ours.
    FOR fk IN
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f'
         AND c.conrelid = format('public.%I', t)::regclass
         AND c.confrelid = 'public.authority_units'::regclass
         AND a.attname = 'authority_unit_id'
         AND c.conname <> t || '_authority_unit_id_fk'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, fk.conname);
    END LOOP;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = t || '_authority_unit_id_fk'
         AND conrelid = format('public.%I', t)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (authority_unit_id) '
        'REFERENCES public.authority_units (id) ON DELETE RESTRICT NOT VALID',
        t, t || '_authority_unit_id_fk'
      );
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'govt_assignments', 'govt_business_rules', 'organization_coverage',
    'service_offerings', 'alert_subscriptions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', t, t || '_authority_unit_id_fk');
  END LOOP;
END
$$;

-- The grant lookup stage D runs per request: a user's active unit grants.
CREATE INDEX IF NOT EXISTS govt_assignments_user_unit_active_idx
  ON public.govt_assignments (user_id, authority_unit_id)
  WHERE revoked_at IS NULL AND authority_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS govt_business_rules_authority_unit_id_idx
  ON public.govt_business_rules (authority_unit_id) WHERE authority_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS organization_coverage_authority_unit_id_idx
  ON public.organization_coverage (authority_unit_id) WHERE authority_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_offerings_authority_unit_id_idx
  ON public.service_offerings (authority_unit_id) WHERE authority_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS alert_subscriptions_authority_unit_id_idx
  ON public.alert_subscriptions (authority_unit_id) WHERE authority_unit_id IS NOT NULL;
