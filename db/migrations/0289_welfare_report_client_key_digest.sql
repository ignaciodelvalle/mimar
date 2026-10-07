-- ────────────────────────────────────────────────────────────────────────────
-- 0289_welfare_report_client_key_digest.sql
-- A retried denuncia lands on the original, for EVERY report that carries a
-- client key — anonymous ones and kinds that write no bridge event included
-- (plan A5f).
--
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- The replay added by integration/bite-replay (A5c) asks the pet-event bridge
-- for the key: it only answers an IDENTIFIED reporter about a REGISTERED pet
-- whose kind writes abandonment_reported / maltreatment_reported /
-- symptom_observed. Everything else — every anonymous denuncia, every report
-- about an unowned animal or a place, every `other` with no symptoms — stored
-- the key nowhere, so a retry over a flaky mobile network filed a second
-- report and opened a second welfare_denuncia case (a kind exempt from the
-- one-open-case index, so nothing refused it).
--
-- THE COLUMN: A DIGEST OF THE KEY, NEVER THE KEY
-- ---------------------------------------------------------------------------
-- client_key_digest = sha256('welfare-report-key:v1:' || scope || ':' || key),
-- hex, computed in src/modules/welfare/domain/report-key-digest.ts, where
--   scope = 'user:' || reporter_user_id   for an identified reporter;
--   scope = 'anon'                        for an anonymous one (including a
--                                         logged-in person who chose
--                                         "Enviar anónima").
-- Why a digest: a key read off this table must not be presentable as a retry.
-- Anyone who can read the row (an operator, a service-role script) would
-- otherwise hold a value that, sent back through the form, answers as the
-- original submitter.
-- Why the scope is inside the digest and not in the index: the identified
-- scope survives reporter_user_id going NULL (ON DELETE SET NULL, the
-- reporter-side purge) without colliding with anyone, so the index needs no
-- reporter column and a SET NULL can never fail on it.
--
-- WHAT SCOPES AN ANONYMOUS SUBMITTER: NOTHING BUT THE KEY
-- ---------------------------------------------------------------------------
-- The anonymous flow has no identifier that is both stable across a retry and
-- safe to store: the reporter session is minted AFTER the report exists, and
-- the rate-limit fingerprint is the caller IP — storing it (or a hash of it,
-- which is brute-forceable over IPv4) beside the report would re-attach a
-- network identity to an anonymous denuncia. So the anonymous scope is the
-- key alone: a client-generated crypto.randomUUID() (122 random bits), with a
-- server-side minimum length (REPORT_KEY_MIN_LENGTH = 32) below which no key
-- is stored or replayed at all. And because the key is the only proof, an
-- anonymous replay returns NOTHING about the original — no reference code, no
-- reporter session — only "ya la recibimos".
--
-- Classified reporter_identity (lib/domain/denuncia-data-partition.ts): it is
-- a handle on WHO submitted, never on what was alleged, so it belongs to the
-- reporter-side view and the reporter-side purge, not to the content.
--
-- Written in the same UPDATE that links the case, inside the write
-- transaction, under pg_advisory_xact_lock(hashtext('welfare-report-key:' ||
-- digest)) — so a committed row with a digest always has its case, and a row
-- whose transaction failed carries none and can never answer a retry.
--
-- No grant, no policy, no data change (existing rows keep NULL). Idempotent.
-- Forward-only. ROLLBACK (no deploy): drop the index and the column, and
-- restate 0186's welfare_report_reporter_identity — valid at any time; the
-- only loss is the replay itself.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.welfare_reports
  ADD COLUMN IF NOT EXISTS client_key_digest text;

ALTER TABLE public.welfare_reports
  DROP CONSTRAINT IF EXISTS welfare_reports_client_key_digest_format;
ALTER TABLE public.welfare_reports
  ADD CONSTRAINT welfare_reports_client_key_digest_format
  CHECK (client_key_digest IS NULL OR client_key_digest ~ '^[0-9a-f]{64}$');

-- One report per (scope, key). The scope is inside the digest, so the digest
-- alone is the unique slot.
CREATE UNIQUE INDEX IF NOT EXISTS welfare_reports_client_key_digest_unique
  ON public.welfare_reports (client_key_digest)
  WHERE client_key_digest IS NOT NULL;

COMMENT ON COLUMN public.welfare_reports.client_key_digest IS
  'sha256 hex of the submit''s client idempotency key, scoped (user:<id> | anon) '
  'inside the digest — never the key itself. Set with case_id in the write '
  'transaction; a retry with the same key lands on this report. '
  'src/modules/welfare/domain/report-key-digest.ts (migration 0289).';

-- ---------------------------------------------------------------------------
-- The reporter-identity view carries it (classification: reporter_identity).
-- DROP + CREATE as 0210 did for the content view: the column belongs inside
-- its class, not appended after the clock. The COMMENT and the REVOKE from
-- 0186 are restated because DROP takes them with it.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.welfare_report_reporter_identity;
CREATE VIEW public.welfare_report_reporter_identity
WITH (security_invoker = true) AS
SELECT
  -- join + clock key (0186)
  wr.id,
  wr.reference_code,
  wr.created_at,
  -- reporter_identity
  wr.reporter_user_id,
  wr.reporter_organization_id,
  wr.reporter_contact_email,
  wr.reporter_contact_phone,
  wr.client_key_digest
FROM public.welfare_reports wr;

COMMENT ON VIEW public.welfare_report_reporter_identity IS
  'Reporter-side record: who filed, the channel back to them, the digest of the '
  'submit''s client key, and created_at as the clock the short reporter-side '
  'retention runs on. Carries no relato, no descripción del denunciado, no '
  'location and no path to evidence, so it can be reserved and purged without '
  'touching the content — and so a purged content row is never rejoined to it. '
  'Revoked from anon/authenticated.';

REVOKE ALL ON public.welfare_report_reporter_identity FROM PUBLIC, anon, authenticated;

COMMIT;
