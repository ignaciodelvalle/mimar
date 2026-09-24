-- 0210 — welfare_report_content view: carry observed_symptoms (0209).
--
-- WHY A MIGRATION AND NOT A HOTFIX. 0209 added `observed_symptoms` to
-- `welfare_reports` and classified it as DENUNCIA CONTENT (testimony prose of
-- the same class as `description` — free text that can restate the allegation
-- or name people; see lib/domain/denuncia-data-partition.ts). The partition's
-- own fitness tests then demand the column appear on every content surface:
-- the drizzle select shape (code, fixed in the same change) and THIS view,
-- which is a database object only a migration may move. 0186 defined the
-- view; forward-only discipline means it is re-stated here, not edited there.
--
-- DROP + CREATE, not CREATE OR REPLACE: Postgres refuses to insert a column
-- mid-list ("cannot change name of view column"), and appending testimony
-- prose at the tail — away from its purge unit — would trade the file's
-- readability for a syntax convenience. Nothing depends on the view (it is a
-- read shape, not a base for other views), so the drop is safe; the COMMENT
-- and the asymmetric grants from 0186 are restated below because DROP takes
-- them with it.
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
