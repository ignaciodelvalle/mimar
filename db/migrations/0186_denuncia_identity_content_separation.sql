-- Migration 0186 — separate the denunciante's identity from the denuncia's
-- content at the database, as two independently grantable objects.
--
-- WHY (legal review 2026-08-17; engram `legal/retencion-denuncias-decision`)
-- ------------------------------------------------------------------------
-- Ley 25.326 art. 17 inc. 1 lets the organism refuse access "en función de la
-- protección de los derechos e intereses de terceros" — and, unlike inc. 2, it
-- does NOT require ongoing proceedings. That is the correct instrument for
-- protecting a denunciante from retaliation when the denunciado asks what is on
-- file. It is exercisable only over something SEPARABLE, and today the two are
-- one row: `welfare_reports` carries reporter_user_id / reporter_organization_id
-- / reporter_contact_email / reporter_contact_phone in the same tuple as the
-- relato, the descripción del denunciado and the location.
--
-- The retention clocks (R1 = 30 días desde la recepción si nunca se derivó,
-- R2 = 90 días desde la derivación) depend on the same separation: purging the
-- content without destroying the reporter-side record, and ageing the reporter
-- out without destroying the acuse, both require the two sides to be
-- addressable independently. Building the clocks first would have meant
-- rebuilding them. This migration is that prerequisite and NOTHING else — no
-- clock, no access channel, no change to what any surface renders.
--
-- WHAT THIS DOES
-- --------------
-- Two SECURITY INVOKER views over `welfare_reports`, whose column sets are
-- disjoint except for the join/clock key (id, reference_code, created_at):
--
--   public.welfare_report_content            — case record + the R1/R2 purge
--                                              unit. Structurally cannot carry
--                                              reporter identity.
--   public.welfare_report_reporter_identity  — who reported, how to reach them,
--                                              and the date the reporter-side
--                                              clock will run on. Structurally
--                                              cannot carry the relato, the
--                                              descripción del denunciado, the
--                                              location or any path to evidence.
--
-- WHY VIEWS AND NOT A SATELLITE TABLE
-- -----------------------------------
-- A satellite table would be the stronger form, and it is deliberately NOT what
-- this migration does. Moving reporter_user_id off `welfare_reports` breaks the
-- "Reporter can read own welfare reports" RLS policy (0086) and, worse, breaks
-- the CURRENT body of erase_subject_data(), a ~440-line SECURITY DEFINER
-- function that every erasure runs through and that four surfaces' privacy
-- guarantees rest on. Re-emitting it by hand to satisfy a boundary change is a
-- transcription risk taken in the wrong place. The views give the property the
-- legal instrument actually needs — two objects that can be granted, revoked,
-- read and purged independently — at zero risk to the erasure path, and they
-- leave the satellite available later as a mechanical follow-up if a
-- non-service-role reader ever appears.
--
-- SECURITY INVOKER is load-bearing: without it the views would run as their
-- owner and would BYPASS the row-level policy on `welfare_reports`, turning a
-- boundary object into a privilege-escalation hole. With it, each view inherits
-- exactly the policies of the underlying table.
--
-- Grants are asymmetric on purpose. The content view is readable by the same
-- roles that can already read the table (they gain nothing they did not have).
-- The identity view is revoked from anon and authenticated outright: no
-- API-key-facing role has any business selecting the reporter side as a set,
-- and the reporter's own access to their own row keeps working through the
-- table's existing policy, not through this view.
--
-- Idempotent — CREATE OR REPLACE + unconditional REVOKE/GRANT. Forward-only.
-- Application reads are unchanged; nothing in this file alters a rendered
-- string.

BEGIN;

-- ---------------------------------------------------------------------------
-- Content side — case record + the purge unit. No reporter identity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.welfare_report_content
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
  -- denuncia_content: the R1/R2 purge unit. `description` and
  -- `subject_description` are free text and are NOT anonymisable — the
  -- descripción IS the identifier, and reporters self-identify inside the
  -- relato. Their disposition is destruction, never redaction.
  wr.description,
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
  'denuncia_content columns (description, subject_pet_id, subject_description, '
  'location_address, location_lat, location_lng, resolution_notes) are the '
  'R1/R2 retention purge unit. Classification of record: '
  'lib/domain/denuncia-data-partition.ts.';

-- ---------------------------------------------------------------------------
-- Reporter-identity side — who reported, and the clock to age them out on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.welfare_report_reporter_identity
WITH (security_invoker = true) AS
SELECT
  -- join + clock key. created_at is not decoration: a set of rows with no date
  -- cannot be aged out on its own basis, and ageing this side out
  -- independently of the content is the entire point.
  wr.id,
  wr.reference_code,
  wr.created_at,
  -- reporter_identity. reporter_organization_id is here even though
  -- ORG_WELFARE_PII_DENYLIST treats it as safe: that denylist asks whether the
  -- RECEIVING org may see its own id (a no-op), this view asks whether
  -- disclosing it to the DENUNCIADO would expose who reported them ("el refugio
  -- X te denunció" is exactly the retaliation art. 17 inc. 1 guards against).
  wr.reporter_user_id,
  wr.reporter_organization_id,
  wr.reporter_contact_email,
  wr.reporter_contact_phone
FROM public.welfare_reports wr;

COMMENT ON VIEW public.welfare_report_reporter_identity IS
  'Reporter-side record: who filed, the channel back to them, and created_at as '
  'the clock the short reporter-side retention runs on. Carries no relato, no '
  'descripción del denunciado, no location and no path to evidence, so it can '
  'be reserved and purged without touching the content — and so a purged '
  'content row is never rejoined to it. Revoked from anon/authenticated.';

-- ---------------------------------------------------------------------------
-- Grants. Asymmetric by design — see the header.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.welfare_report_content FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.welfare_report_content TO authenticated;

-- No role reachable from an API key selects the reporter side as a set. The
-- reporter's access to their OWN row continues through the welfare_reports
-- policy "Reporter can read own welfare reports" (0086), untouched.
REVOKE ALL ON public.welfare_report_reporter_identity FROM PUBLIC, anon, authenticated;

COMMIT;
