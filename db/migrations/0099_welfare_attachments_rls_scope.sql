-- welfare_report_attachments RLS hardening (HIGH/privacy)
--
-- PROBLEM: The existing SELECT policy uses a bare sub-select on welfare_reports
-- with no auth check, meaning ANY anon/auth caller who knows the parent report
-- UUID can read all attachment rows for that report via PostgREST. The INSERT
-- policy is with check (true) — equally permissive.
--
-- FIX: Scope both policies to the reporter identity of the parent report,
-- matching the access model of welfare_reports itself:
--   SELECT: authenticated reporter who owns the parent report OR admin/govt user.
--   INSERT: authenticated reporter who owns the parent report OR admin/govt user.
--
-- ANON UPLOAD IS UNAFFECTED: The app inserts attachment rows via Drizzle (direct
-- DB connection with BYPASSRLS), never through PostgREST. The anon welfare upload
-- flow (lib/welfare-uploads.ts → createClient → Supabase Storage) writes to the
-- *storage bucket*, not to this table directly. Row insertion happens in
-- createWelfareReport (src/modules/welfare/application/create-welfare-report.ts)
-- via repo.insertAttachments() → drizzle db.insert(), which bypasses RLS.
-- Tightening this INSERT policy therefore does NOT break anonymous denuncia
-- submission.
--
-- Admin/govt access mirrors the pattern in welfare_reports: profiles.role = 'admin'
-- (includes both platform admins and govt operators who receive an admin role upon
-- assignment — see govt_assignments). A dedicated govt-SELECT policy is added for
-- govt_assignments holders following the same pattern as approval_requests.
--
-- Idempotent — safe to re-run.

BEGIN;

-- == SELECT policy ===========================================================

DROP POLICY IF EXISTS "Welfare attachments readable when parent report exists"
  ON public.welfare_report_attachments;
DROP POLICY IF EXISTS "Reporter can read own welfare attachments"
  ON public.welfare_report_attachments;

-- Reporter sees only attachments belonging to their own reports.
CREATE POLICY "Reporter can read own welfare attachments"
  ON public.welfare_report_attachments
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.welfare_reports wr
      WHERE wr.id = welfare_report_attachments.welfare_report_id
        AND wr.reporter_user_id = auth.uid()
    )
  );

-- Admin (platform + govt) can read all attachments for case-handling purposes.
CREATE POLICY "Admin can read any welfare attachments"
  ON public.welfare_report_attachments
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'admin'
    )
  );

-- == INSERT policy ===========================================================

DROP POLICY IF EXISTS "Anyone can insert welfare attachments"
  ON public.welfare_report_attachments;

-- Attachment rows are always inserted via Drizzle (BYPASSRLS), so the INSERT
-- policy is defense-in-depth only. Scope it to reporters attaching to their own
-- report, plus admins (for back-office tooling). Anon PostgREST INSERT is
-- intentionally removed — the app never uses it.
CREATE POLICY "Reporter can insert own welfare attachments"
  ON public.welfare_report_attachments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.welfare_reports wr
      WHERE wr.id = welfare_report_attachments.welfare_report_id
        AND wr.reporter_user_id = auth.uid()
    )
  );

CREATE POLICY "Admin can insert welfare attachments"
  ON public.welfare_report_attachments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'admin'
    )
  );

COMMIT;
