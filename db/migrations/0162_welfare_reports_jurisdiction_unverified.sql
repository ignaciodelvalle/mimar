-- 0162 — welfare_reports.jurisdiction_unverified
--
-- P3.1 / PO decision D.11 (2026-07-31). A denuncia's (province, locality) is
-- derived client-side from the geocoder. When the provider is unreachable the
-- hidden jurisdiction inputs arrive EMPTY, the row lands with
-- jurisdiction_province NULL, and every branch of jurisdictionPairClause
-- (lib/metrics/scope.ts) tests province equality — so the report is invisible
-- to every government queue. D.11: fall back to the jurisdiction stated in the
-- form text and mark it NOT VERIFIED. This column is that mark.
--
-- TRUE means: nobody geocoded this location. The (province, locality) on this
-- row was READ OUT OF THE TEXT the citizen typed and may route the report to
-- the wrong municipality. The triage queue renders it as a visible pill
-- (app/gob/maltrato/_components/WelfareDenunciaRow.tsx) — a flag no screen
-- shows would deliver D.11's accepted risk without its mitigation, which the
-- PO made a non-negotiable condition of the decision.
--
-- DEFAULT false is the honest backfill: every pre-existing row got its
-- jurisdiction from a geocoder result the citizen picked (or from a map pin's
-- reverse geocode), which is exactly what "verified" means here. Rows with a
-- NULL jurisdiction predate the fallback and stay unflagged — the flag
-- describes HOW a jurisdiction was obtained, not whether one exists.
--
-- Deliberately NOT mirrored onto `cases`. The case row copies its jurisdiction
-- from the report at openCase time; a second column holding the same fact is a
-- drift surface (invariant #3: caches declare themselves, and no cache
-- outranks its source). The denuncias hub triage stage — the operator surface
-- D.11 names — reads welfare_reports directly.
--
-- Forward-only and idempotent.

ALTER TABLE public.welfare_reports
  ADD COLUMN IF NOT EXISTS jurisdiction_unverified boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.welfare_reports.jurisdiction_unverified IS
  'TRUE when jurisdiction_province/locality were recovered from the form text because geocoding failed (PO decision D.11). The routing target is a GUESS; the triage queue must show this. FALSE means a geocoder result or map-pin reverse geocode produced the pair.';

-- Partial index: the "Sin verificar" queue lens and any audit sweep scan only
-- the flagged rows, which are the rare case by construction.
CREATE INDEX IF NOT EXISTS welfare_reports_jurisdiction_unverified_idx
  ON public.welfare_reports (created_at DESC)
  WHERE jurisdiction_unverified;
