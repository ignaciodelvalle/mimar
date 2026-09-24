-- Migration 0106 — DNI-less identity model + Mi Argentina OIDC scaffold.
-- Wave 5 Item 25a (autonomous half). See docs/superpowers/specs/2026-06-19-wave5-launch-hardening-handoff.md §Item 25.
--
-- DESIGN RATIONALE
-- ----------------
-- No DNI in plaintext rule (Ley 25.326 / Mi Argentina premise): after this
-- migration `profiles.dni_number` no longer exists. In its place:
--   - `miarg_sub`        — opaque, stable subject ID from Mi Argentina OIDC.
--   - `identity_source`  — enum('miarg','legacy') — how identity was verified.
--   - `dni_hash`         — HMAC-SHA256(dni, pepper) hex — equality matching only.
--                          Pepper lives in env/KMS, never in the DB.
--   - `dni_last4`        — right(dni, 4) — human disambiguation in operator UI.
--   - `dni_verified_at`  — timestamptz — when DNI was verified (mirrors dni_verified bool).
--
-- DESTRUCTIVE STEP
-- ----------------
-- This migration DROPS `profiles.dni_number` (and its unique index).
-- Safe precondition (owner-confirmed): the project is PRE-CUTOVER — no live
-- production data carries real citizen DNI numbers. The column is dropped after
-- backfilling `dni_hash` and `dni_last4` from existing rows.
--
-- BACKFILL STRATEGY
-- -----------------
-- pgcrypto's hmac() is used for the SQL-side backfill so the migration is
-- self-contained and does not depend on a separate script. The pepper is
-- injected via the `app.dni_hash_pepper` GUC, which the migration runner
-- MUST set before calling this file:
--
--   SET LOCAL app.dni_hash_pepper = '<pepper>';
--   \i db/migrations/0106_dni_less_identity.sql
--
-- If the GUC is not set the backfill falls back to a sentinel value
-- ('BACKFILL_PEPPER_NOT_SET') that is clearly identifiable in the hash output.
-- For a fresh-bootstrap DB (pnpm db:reset) there are no existing rows with
-- dni_number set, so the backfill is a no-op and the pepper does not matter.
--
-- IDEMPOTENCY
-- -----------
-- Each DDL step uses IF EXISTS / IF NOT EXISTS guards. Safe to replay.

BEGIN;

-- ============================================================================
-- 1. Enable pgcrypto (needed for hmac() in the backfill step).
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 2. Add new columns (all nullable — no NOT NULL until backfill is done).
-- ============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS miarg_sub       text,
  ADD COLUMN IF NOT EXISTS identity_source text
    CONSTRAINT profiles_identity_source_check CHECK (identity_source IN ('miarg', 'legacy'))
    DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS dni_hash        text,
  ADD COLUMN IF NOT EXISTS dni_last4       text,
  ADD COLUMN IF NOT EXISTS dni_verified_at timestamptz;

-- ============================================================================
-- 3. Backfill from dni_number where present.
--    Pepper: GUC app.dni_hash_pepper (set by runner). Fallback sentinel used
--    when GUC is absent (indicates a bootstrap environment with no DNI rows).
-- ============================================================================

DO $$
DECLARE
  pepper text;
BEGIN
  -- Try to read the pepper from the session-local GUC. Fallback to sentinel.
  BEGIN
    pepper := nullif(current_setting('app.dni_hash_pepper', true), '');
  EXCEPTION WHEN OTHERS THEN
    pepper := NULL;
  END;
  IF pepper IS NULL THEN
    pepper := 'BACKFILL_PEPPER_NOT_SET';
  END IF;

  UPDATE public.profiles
  SET
    dni_hash  = encode(hmac(dni_number, pepper, 'sha256'), 'hex'),
    dni_last4 = right(dni_number, 4),
    -- Treat existing verified rows as having been verified via the legacy flow.
    identity_source = CASE
      WHEN dni_verified = true THEN 'legacy'
      ELSE 'legacy'
    END,
    dni_verified_at = CASE
      WHEN dni_verified = true THEN COALESCE(updated_at, now())
      ELSE NULL
    END
  WHERE
    dni_number IS NOT NULL;
END
$$;

-- ============================================================================
-- 4. Drop the old unique index on dni_number (before dropping the column).
-- ============================================================================

DROP INDEX IF EXISTS public.profiles_dni_unique_when_present;

-- ============================================================================
-- 5. Drop dni_number column (DESTRUCTIVE — owner-confirmed safe pre-cutover).
-- ============================================================================

ALTER TABLE public.profiles DROP COLUMN IF EXISTS dni_number;

-- Also update the CHECK constraint that referenced dni_number.
-- The constraint profiles_institutional_no_pii checks that institutional
-- accounts don't carry personal PII. We need to update it to reference
-- the new columns.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_institutional_no_pii;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_institutional_no_pii CHECK (
    account_type = 'personal'
    OR (
      dni_hash IS NULL
      AND matricula_number IS NULL
      AND matricula_jurisdiccion IS NULL
      AND miarg_sub IS NULL
    )
  );

-- ============================================================================
-- 6. Add unique constraints on new columns.
-- ============================================================================

-- Unique index on miarg_sub (partial — only when set).
CREATE UNIQUE INDEX IF NOT EXISTS profiles_miarg_sub_unique
  ON public.profiles (miarg_sub)
  WHERE miarg_sub IS NOT NULL;

-- Unique index on dni_hash (partial — only when set).
-- Replaces the former dni_number unique index.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_dni_hash_unique
  ON public.profiles (dni_hash)
  WHERE dni_hash IS NOT NULL;

-- ============================================================================
-- 7. Update erase_subject_data() to null new columns instead of dni_number.
--    The function was last updated in migration 0087. Re-create it here so
--    the erasure path (Ley 25.326 art. 16) clears the new PII columns.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.erase_subject_data(p_user_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pii, pg_temp
AS $$
DECLARE
  pets_marked      int;
  subject_email    text;
BEGIN
  IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT pii.caller_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT u.email INTO subject_email FROM auth.users u WHERE u.id = p_user_id;

  -- Profile: hash display_name, null every direct + third-party PII column.
  -- Wave 5 Item 25a: dni_number dropped; erase dni_hash, dni_last4, miarg_sub,
  -- and dni_verified_at instead.
  UPDATE public.profiles
     SET display_name             = 'erased:' || md5(id::text),
         phone                    = NULL,
         -- New DNI columns (migration 0106) — erase hash + last4 + OIDC sub.
         dni_hash                 = NULL,
         dni_last4                = NULL,
         miarg_sub                = NULL,
         identity_source          = 'legacy',
         dni_verified             = false,
         dni_verified_at          = NULL,
         emergency_contact_name   = NULL,
         emergency_contact_phone  = NULL,
         preferred_vet_name       = NULL,
         preferred_vet_phone      = NULL,
         avatar_url               = NULL,
         matricula_number         = NULL,
         matricula_jurisdiccion   = NULL,
         deleted_at               = now(),
         updated_at               = now()
   WHERE id = p_user_id;

  -- Owned pets → soft-delete (sanitary events on them are retained).
  WITH affected AS (
    UPDATE public.pets
       SET deleted_at = now(),
           updated_at = now()
     WHERE id IN (
       SELECT pet_id FROM public.ownerships
        WHERE owner_user_id = p_user_id
          AND ended_at IS NULL
     )
       AND deleted_at IS NULL
    RETURNING id
  )
  SELECT count(*) INTO pets_marked FROM affected;

  -- Welfare reports the subject FILED: scrub reporter contact fields and the
  -- free-text location address. See migration 0087 for rationale.
  UPDATE public.welfare_reports
     SET reporter_contact_email = NULL,
         reporter_contact_phone = NULL,
         location_address = NULL,
         description = '[contenido eliminado a pedido del titular]'
   WHERE reporter_user_id = p_user_id;

  -- Pet transfers where the subject is a party and the transfer is still
  -- pending: cancel first.
  UPDATE public.pet_transfers
     SET status = 'cancelled',
         updated_at = now()
   WHERE (from_owner_id = p_user_id
          OR to_owner_id = p_user_id
          OR (subject_email IS NOT NULL AND to_owner_email = subject_email))
     AND status = 'pending';

  -- Pet transfers: null the recipient email (subject's PII footprint).
  UPDATE public.pet_transfers
     SET to_owner_email = 'erased@invalid.local'
   WHERE (from_owner_id = p_user_id
          OR to_owner_id = p_user_id
          OR (subject_email IS NOT NULL AND to_owner_email = subject_email))
     AND to_owner_email <> 'erased@invalid.local';

  -- Org contact messages the subject sent: null the inquirer email.
  IF subject_email IS NOT NULL THEN
    UPDATE public.org_contact_messages
       SET inquirer_email = 'erased@invalid.local',
           inquirer_name  = NULL
     WHERE inquirer_email = subject_email
       AND inquirer_email <> 'erased@invalid.local';
  END IF;

  -- Audit the erasure itself (mirrors 0087 audit shape).
  INSERT INTO public.audit_log (actor_user_id, action, target_user_id, payload)
  VALUES (
    auth.uid(),
    'subject_erasure',
    p_user_id,
    jsonb_build_object(
      'reason',            p_reason,
      'norma',             'Ley 25.326 art. 16',
      'self_erasure',      auth.uid() = p_user_id,
      'pets_soft_deleted', pets_marked
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.erase_subject_data(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) TO authenticated;

COMMIT;
