-- Migration 0169 — pet_tags: physical tag (chapa) lifecycle table.
-- (physical-tag-lifecycle, design sdd/physical-tag/design D1-D6.)
--
-- WHAT THIS IS
-- ------------
-- One row per manufactured tag. Serial `TAG-XXXX-XXXX` (generatePrefixedToken,
-- 31^8 entropy) printed as QR on the tag; a SEPARATE wrapper-printed activation
-- code is stored ONLY as an HMAC-SHA256 hash (lib/utils/tag-code-hash.ts,
-- pepper DNI_HASH_PEPPER, domain-separated message `tag-activation-code:v1:`).
-- The plaintext code exists only in the admin issuance CSV response — it is
-- never persisted, never SELECTed back by app code, never placed in an event
-- payload.
--
-- STATE MACHINE (one-way, enforced by CHECK below):
--   unactivated -> active -> revoked        (revoked is terminal; no reuse)
-- A blank (unactivated) tag has NO pet_id, so it cannot be revoked — the
-- tag_revoked spine event needs a pet to hang on (design D4).
--
-- TRANSFER BEHAVIOR: custody transfer does NOT touch this table. An active
-- tag stays active on the same pet; the new owner may revoke it
-- (revoked_reason='transfer') and activate a fresh serial.
--
-- RLS POSTURE (0168 conventions: explicit TO roles):
--   SELECT own rows only (activator or current owner of the linked pet).
--   No INSERT/UPDATE/DELETE policies — all writes flow through server actions
--   over the Drizzle BYPASSRLS connection; RLS is the PostgREST backstop.
--   The SELECT projection through PostgREST still exposes columns to the row
--   owner; activation_code_hash is peppered HMAC (useless without the server
--   pepper) and app code never selects it.

BEGIN;

CREATE TABLE public.pet_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serial text NOT NULL,
  -- HMAC-SHA256 hex of the wrapper activation code. Never SELECTed by app
  -- code: the evidence gate compares inside a SQL predicate (chip-lookup.ts
  -- attemptedChipMatchesPet shape).
  activation_code_hash text NOT NULL,
  status text NOT NULL DEFAULT 'unactivated'
    CHECK (status IN ('unactivated', 'active', 'revoked')),
  -- Manufacturing batch identifier (admin issuance). Free text, no PII.
  lote_id text,
  pet_id uuid REFERENCES public.pets(id),
  activated_by_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  activated_at timestamptz,
  revoked_by_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoked_reason text
    CHECK (revoked_reason IN ('lost', 'damaged', 'transfer', 'fraud', 'owner_request', 'other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One-way state machine: each state pins exactly the columns it requires.
  -- revoked keeps pet_id + activated_at for audit (revocation preserves the
  -- linking history; it never detaches the pet).
  CONSTRAINT pet_tags_state_machine CHECK (
    (status = 'unactivated' AND pet_id IS NULL AND activated_at IS NULL AND revoked_at IS NULL)
    OR (status = 'active' AND pet_id IS NOT NULL AND activated_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND pet_id IS NOT NULL AND activated_at IS NOT NULL
        AND revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX pet_tags_serial_unique ON public.pet_tags (serial);
CREATE INDEX pet_tags_pet_idx ON public.pet_tags (pet_id) WHERE pet_id IS NOT NULL;
CREATE INDEX pet_tags_lote_idx ON public.pet_tags (lote_id) WHERE lote_id IS NOT NULL;

-- PII baseline (migration 0058): created_by/updated_by/purpose/deleted_at/
-- retention_until on user-referencing tables.
SELECT pii.apply_baseline('public.pet_tags');

ALTER TABLE public.pet_tags ENABLE ROW LEVEL SECURITY;

-- SELECT own: the user who activated the tag, or a current (active-ownership)
-- owner of the linked pet. Explicit TO authenticated (0168 posture) — anon
-- must never read tag rows; the public /t/[serial] resolver goes through the
-- server (BYPASSRLS) with a {status, publicToken} projection only.
CREATE POLICY "pet_tags select own" ON public.pet_tags
  FOR SELECT TO authenticated
  USING (
    activated_by_user_id = (SELECT auth.uid())
    OR pet_id IN (
      SELECT o.pet_id FROM public.ownerships o
      WHERE o.owner_user_id = (SELECT auth.uid())
        AND o.ended_at IS NULL
    )
  );

-- No INSERT/UPDATE/DELETE policies: writes only via server actions
-- (BYPASSRLS connection); RLS is the PostgREST backstop.

COMMIT;
