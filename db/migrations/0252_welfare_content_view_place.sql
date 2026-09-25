-- 0252 — welfare_report_content view: carry place_entered and place_method (0248).
--
-- 0248 added both columns to `welfare_reports`; lib/domain/denuncia-data-partition.ts
-- classifies them as CASE RECORD — locality-level, never a point or an
-- address, the same class as the jurisdiction pair and `locality_id`, and kept
-- exactly as the `place` key of an event payload is. The partition's fitness
-- tests then demand the columns on every content surface: the drizzle select
-- shape (code, same change) and THIS view, which only a migration may move.
--
-- Same shape as 0210: DROP + CREATE so the columns sit with the case record
-- instead of at the tail, then the COMMENT and the asymmetric grants from 0186
-- restated because DROP takes them with it. Nothing depends on the view.
DROP VIEW IF EXISTS public.welfare_report_content;
CREATE VIEW public.welfare_report_content
WITH (security_invoker = true) AS
SELECT
  -- case_record: survives the R1/R2 purge (the acuse + workflow attribution)
  wr.id,
  wr.reference_code,
  wr.kind,
  wr.severity,
  wr.subject_kind,
  wr.jurisdiction_province,
  wr.jurisdiction_locality,
  wr.locality_id,
  wr.place_entered,
  wr.place_method,
  wr.jurisdiction_unverified,
  wr.occurred_at,
  wr.created_at,
  wr.status,
  wr.triaged_at,
  wr.triaged_by_user_id,
  wr.closed_at,
  wr.flagged_at,
  wr.flag_reasons,
  wr.moderation_resolved_at,
  wr.moderation_resolved_by_user_id,
  wr.moderation_escalated_at,
  wr.moderation_escalated_by_user_id,
  wr.case_id,
  wr.assigned_to_user_id,
  wr.derived_to_organization_id,
  wr.derived_at,
  wr.derived_by_user_id,
  wr.org_intervention_status,
  wr.org_intervention_at,
  wr.seed_tag,
  -- denuncia_content: the R1/R2 purge unit. `description`,
  -- `observed_symptoms` and `subject_description` are free text and are NOT
  -- anonymisable — the descripción IS the identifier, and reporters
  -- self-identify inside the relato. Their disposition is destruction, never
  -- redaction.
  wr.description,
  wr.observed_symptoms,
  wr.subject_pet_id,
  wr.subject_description,
  wr.location_address,
  wr.location_lat,
  wr.location_lng,
  wr.resolution_notes
FROM public.welfare_reports wr;

COMMENT ON VIEW public.welfare_report_content IS
  'Denuncia content + case record, structurally free of reporter identity. '
  'The read an art. 17 inc. 1 answer to the denunciado draws from. The '
  'denuncia_content columns (description, observed_symptoms, subject_pet_id, '
  'subject_description, location_address, location_lat, location_lng, '
  'resolution_notes) are the R1/R2 retention purge unit. Classification of '
  'record: lib/domain/denuncia-data-partition.ts.';

-- Grants restated from 0186 — DROP VIEW discarded them.
REVOKE ALL ON public.welfare_report_content FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.welfare_report_content TO authenticated;
