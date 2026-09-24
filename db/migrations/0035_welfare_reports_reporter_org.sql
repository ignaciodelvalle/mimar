-- Spec: 2026-05-19-org-abuse-investigation-design.
--
-- Adds `reporter_organization_id` to `welfare_reports` so org members of
-- verified orgs (clinics, shelters, sanitary authorities, rescue
-- networks) can attribute their welfare denuncias to the org. Drives:
--   - priority sort in /gob/maltrato queue
--   - audit + reporter identity in case detail
--   - multi-source escalation when ≥2 orgs report the same subject
--
-- Idempotent — safe to re-run.

alter table public.welfare_reports
  add column if not exists reporter_organization_id uuid
  references public.organizations(id) on delete set null;

create index if not exists welfare_reports_org_reporter_idx
  on public.welfare_reports (reporter_organization_id)
  where reporter_organization_id is not null;
