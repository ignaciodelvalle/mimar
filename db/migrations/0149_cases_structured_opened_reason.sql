-- ────────────────────────────────────────────────────────────────────────────
-- 0149_cases_structured_opened_reason.sql
-- Additive structured opened-reason columns on cases: opened_reason_code + params.
--
-- WHY
-- ---
-- `cases.opened_reason` is prose written by 18 independent production writers,
-- each with its own private grammar (`auto: ...` prefixes, `manual [code]: ...`,
-- bare `key=value` pairs). Two consequences:
--
--   1. An unmapped writer leaks English to funcionarios. transfer-custody.ts
--      shipped for months rendering "direct custody handoff to_role=owner" —
--      English plus a raw enum key, wrapped in a Spanish prefix so it read like
--      a translation and nobody noticed.
--   2. "How many cases were opened per cause" requires parsing prose. A view is
--      a projection of (events, filters) — the filter dimension has to exist as
--      DATA, not as a string to re-parse at every read.
--
-- These two columns make the cause structured and queryable: GROUP BY
-- opened_reason_code answers "casos abiertos por causa" with no regex, no LIKE.
--
-- ADDITIVE — opened_reason PROSE KEEPS BEING WRITTEN, BYTE-IDENTICAL
-- -----------------------------------------------------------------
-- The prose column is NOT deprecated and NOT backfilled:
--
--   - It is a LIVE SQL QUERY KEY. surveillance-repository.ts
--     (findOpenInvestigationsForDisease) runs
--     `opened_reason LIKE 'manual [{diseaseCode}]:%'` to dedupe open outbreak
--     investigations. Post-cutover rows keep the exact same prose bytes, so
--     that dedupe needs zero change and no mixed-cohort OR.
--   - Retro-translating historical prose into a guessed code would be a
--     retro-edit of append-only audit data. Pre-cutover rows stay (null, null)
--     permanently and keep rendering via the frozen regex layer.
--   - Rollback is free: revert the code and every row — including post-cutover
--     ones — still renders from prose.
--
-- NO PG ENUM, NO CHECK ON THE CODE VALUE
-- --------------------------------------
-- Follows the case_kind precedent (src/modules/cases/domain/case-kinds.ts):
-- text, so adding writer #19 is a TypeScript edit, not a migration plus a
-- gated remote apply. The Zod discriminated union is the enforcement; the DB
-- is storage. `alter type ... add value` is non-transactional and gated — the
-- wrong tax for a vocabulary that grows with the product.
--
-- Idempotent-safe (IF NOT EXISTS / drop-then-add per the 0033 house style) so a
-- re-run is a no-op. Forward-only, additive, nullable → no down migration.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS opened_reason_code text;

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS opened_reason_params jsonb;

-- Partial: every pre-cutover row is NULL and always will be (no backfill), so
-- indexing them is dead weight. Backs GROUP BY opened_reason_code.
CREATE INDEX IF NOT EXISTS cases_opened_reason_code_idx
  ON cases (opened_reason_code)
  WHERE opened_reason_code IS NOT NULL;

-- Pair constraint: makes "code without params" unrepresentable at rest.
-- Param-less codes store `{}`, not NULL. Legacy rows are (null, null) — legal.
ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_opened_reason_structured_pair;

ALTER TABLE cases
  ADD CONSTRAINT cases_opened_reason_structured_pair
  CHECK (opened_reason_code IS NULL OR opened_reason_params IS NOT NULL);
