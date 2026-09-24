-- Migration 0137 — Cache per-row auth.*() in RLS policies (auth_rls_initplan).
--
-- SOURCE
-- ------
-- Supabase performance advisor `auth_rls_initplan`: an RLS policy that calls
-- auth.uid() / auth.jwt() / auth.role() DIRECTLY re-evaluates that function
-- once PER ROW scanned. Wrapping the call in a scalar subselect —
-- `(select auth.uid())` — lets the planner hoist it into an InitPlan evaluated
-- ONCE per statement. The value is identical (auth.* are STABLE within a
-- statement), so this is a pure performance change with ZERO behavior impact.
--
-- WHAT
-- ----
-- Rewrites every flagged policy's USING / WITH CHECK expression, replacing each
-- bare auth.<fn>() with (select auth.<fn>()). The set was derived
-- programmatically from pg_policies on the local Docker DB (the RLS
-- source-of-truth per scripts/check-rls-coverage.ts), which is at migration
-- HEAD: 70 policies across 34 tables that had at least one unwrapped auth.*
-- call (including calls nested inside EXISTS subqueries — the advisor flags
-- those too, and wrapping them is likewise behavior-identical).
--
-- Already-wrapped occurrences are left untouched (no double-wrapping).
--
-- SAFETY
-- ------
-- Forward-only. ALTER POLICY only replaces the USING / WITH CHECK expression;
-- the command, roles (TO), and permissive/restrictive kind are unchanged. Every
-- listed policy exists on any DB replayed to this point (each was created by an
-- earlier migration). Re-issuing the same expression is naturally idempotent and
-- the runner tracks applied files by checksum, so this never re-runs. Behavior
-- is validated by __tests__/rls (matrix + write-path) staying green. No data
-- touched; transaction-safe (no -- dim:no-transaction needed).

BEGIN;

ALTER POLICY "alert_subscriptions delete by owner" ON public."alert_subscriptions"
  USING ((actor_user_id = (select auth.uid())));

ALTER POLICY "alert_subscriptions insert by owner" ON public."alert_subscriptions"
  WITH CHECK ((actor_user_id = (select auth.uid())));

ALTER POLICY "alert_subscriptions read by owner or admin" ON public."alert_subscriptions"
  USING (((actor_user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role) AND (p.deactivated_at IS NULL))))));

ALTER POLICY "alert_subscriptions update by owner" ON public."alert_subscriptions"
  USING ((actor_user_id = (select auth.uid())))
  WITH CHECK ((actor_user_id = (select auth.uid())));

ALTER POLICY "appointments read by org members" ON public."appointments"
  USING ((organization_id IN ( SELECT organization_memberships.organization_id
   FROM organization_memberships
  WHERE ((organization_memberships.user_id = (select auth.uid())) AND (organization_memberships.left_at IS NULL)))));

ALTER POLICY "appointments read by owner" ON public."appointments"
  USING ((owner_user_id = (select auth.uid())));

ALTER POLICY "appointments read by provider vet" ON public."appointments"
  USING ((service_offering_id IN ( SELECT service_offerings.id
   FROM service_offerings
  WHERE (service_offerings.provider_user_id = (select auth.uid())))));

ALTER POLICY "approval requests visible to applicant or authority" ON public."approval_requests"
  USING (((applicant_user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role)))) OR (EXISTS ( SELECT 1
   FROM govt_assignments g
  WHERE ((g.user_id = (select auth.uid())) AND (g.revoked_at IS NULL) AND (g.jurisdiction_province = approval_requests.jurisdiction_province) AND (g.jurisdiction_locality = approval_requests.jurisdiction_locality))))));

ALTER POLICY "ar_localities select authenticated" ON public."ar_localities"
  USING (((select auth.uid()) IS NOT NULL));

ALTER POLICY "ar_localities_import_runs select admin" ON public."ar_localities_import_runs"
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL)))));

ALTER POLICY "Attachments insertable by pet owner" ON public."attachments"
  WITH CHECK ((EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL) AND ((o.pet_id = attachments.pet_id) OR (o.pet_id = ( SELECT pe.pet_id
           FROM pet_events pe
          WHERE (pe.id = attachments.event_id))))))));

ALTER POLICY "Attachments readable by pet owner" ON public."attachments"
  USING (((EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL) AND ((o.pet_id = attachments.pet_id) OR (o.pet_id = ( SELECT pe.pet_id
           FROM pet_events pe
          WHERE (pe.id = attachments.event_id))))))) OR (EXISTS ( SELECT 1
   FROM pet_events pe
  WHERE ((pe.id = attachments.event_id) AND (pe.case_id IS NOT NULL) AND can_read_case(pe.case_id, (select auth.uid())))))));

ALTER POLICY "Attachments updatable by pet owner" ON public."attachments"
  USING ((EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL) AND ((o.pet_id = attachments.pet_id) OR (o.pet_id = ( SELECT pe.pet_id
           FROM pet_events pe
          WHERE (pe.id = attachments.event_id))))))));

ALTER POLICY "audit log visible to actor or admin" ON public."audit_log"
  USING (((actor_user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role))))));

ALTER POLICY "cases_select_visible" ON public."cases"
  USING (can_read_case(id, (select auth.uid())));

ALTER POLICY "cron_runs select by admin" ON public."cron_runs"
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL)))));

ALTER POLICY "custody_dispute_parties select by parties and authorities" ON public."custody_dispute_parties"
  USING (((party_user_id = (select auth.uid())) OR (party_organization_id IN ( SELECT om.organization_id
   FROM organization_memberships om
  WHERE ((om.user_id = (select auth.uid())) AND (om.left_at IS NULL)))) OR (EXISTS ( SELECT 1
   FROM (custody_disputes cd
     JOIN profiles p ON ((p.id = (select auth.uid()))))
  WHERE ((cd.id = custody_dispute_parties.dispute_id) AND (((p.role = 'admin'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL)) OR ((p.role = 'govt'::user_role) AND (EXISTS ( SELECT 1
           FROM govt_assignments g
          WHERE ((g.user_id = p.id) AND (g.revoked_at IS NULL) AND (g.jurisdiction_province = cd.jurisdiction_province) AND (g.jurisdiction_locality = cd.jurisdiction_locality)))))))))));

ALTER POLICY "custody_disputes select by parties and authorities" ON public."custody_disputes"
  USING (((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (((p.role = 'admin'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL)) OR ((p.role = 'govt'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL) AND (EXISTS ( SELECT 1
           FROM govt_assignments g
          WHERE ((g.user_id = p.id) AND (g.revoked_at IS NULL) AND (g.jurisdiction_province = custody_disputes.jurisdiction_province) AND (g.jurisdiction_locality = custody_disputes.jurisdiction_locality))))))))) OR (EXISTS ( SELECT 1
   FROM custody_dispute_parties cdp
  WHERE ((cdp.dispute_id = custody_disputes.id) AND ((cdp.party_user_id = (select auth.uid())) OR (cdp.party_organization_id IN ( SELECT om.organization_id
           FROM organization_memberships om
          WHERE ((om.user_id = (select auth.uid())) AND (om.left_at IS NULL))))))))));

ALTER POLICY "Org members can read own org proposals" ON public."foster_proposals"
  USING ((EXISTS ( SELECT 1
   FROM organization_memberships om
  WHERE ((om.user_id = (select auth.uid())) AND (om.organization_id = foster_proposals.organization_id) AND (om.left_at IS NULL)))));

ALTER POLICY "Platform admins read all proposals" ON public."foster_proposals"
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL)))));

ALTER POLICY "Volunteer can read proposals for them" ON public."foster_proposals"
  USING ((volunteer_user_id = (select auth.uid())));

ALTER POLICY "Org coordinators can read active pool" ON public."foster_volunteers"
  USING (((status = 'active'::text) AND (available_slots > 0) AND (EXISTS ( SELECT 1
   FROM organization_memberships om
  WHERE ((om.user_id = (select auth.uid())) AND (om.left_at IS NULL) AND ((om.role = 'admin'::organization_membership_role) OR (EXISTS ( SELECT 1
           FROM organization_capability_grants ocg
          WHERE ((ocg.membership_id = om.id) AND (ocg.capability = 'foster.assign'::text) AND (ocg.status = 'approved'::organization_capability_status))))))))));

ALTER POLICY "Platform admins read all volunteers" ON public."foster_volunteers"
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL)))));

ALTER POLICY "Volunteer can read own row" ON public."foster_volunteers"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "govt sees own assignments" ON public."govt_assignments"
  USING (((user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role))))));

ALTER POLICY "owner can insert libreta shares for their pets" ON public."libreta_share_tokens"
  WITH CHECK (((created_by_user_id = (select auth.uid())) AND (pet_id IN ( SELECT ownerships.pet_id
   FROM ownerships
  WHERE ((ownerships.owner_user_id = (select auth.uid())) AND (ownerships.ended_at IS NULL))))));

ALTER POLICY "owner can read own libreta shares" ON public."libreta_share_tokens"
  USING (((created_by_user_id = (select auth.uid())) OR (pet_id IN ( SELECT ownerships.pet_id
   FROM ownerships
  WHERE ((ownerships.owner_user_id = (select auth.uid())) AND (ownerships.ended_at IS NULL))))));

ALTER POLICY "owner can update (revoke) own libreta shares" ON public."libreta_share_tokens"
  USING ((created_by_user_id = (select auth.uid())))
  WITH CHECK ((created_by_user_id = (select auth.uid())));

ALTER POLICY "Notifications readable by self" ON public."notifications"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "Notifications updatable by self" ON public."notifications"
  USING ((user_id = (select auth.uid())))
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY "Org members can read own org messages" ON public."org_contact_messages"
  USING ((EXISTS ( SELECT 1
   FROM organization_memberships om
  WHERE ((om.user_id = (select auth.uid())) AND (om.organization_id = org_contact_messages.organization_id) AND (om.left_at IS NULL)))));

ALTER POLICY "Platform admins read all org messages" ON public."org_contact_messages"
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role) AND (p.account_type = 'institutional'::text) AND (p.deactivated_at IS NULL)))));

ALTER POLICY "Admins can read all grants in their org" ON public."organization_capability_grants"
  USING ((EXISTS ( SELECT 1
   FROM organization_memberships admin_m
  WHERE ((admin_m.organization_id = organization_capability_grants.organization_id) AND (admin_m.user_id = (select auth.uid())) AND (admin_m.role = 'admin'::organization_membership_role) AND (admin_m.left_at IS NULL)))));

ALTER POLICY "Members can read their own grants" ON public."organization_capability_grants"
  USING ((EXISTS ( SELECT 1
   FROM organization_memberships m
  WHERE ((m.id = organization_capability_grants.membership_id) AND (m.user_id = (select auth.uid()))))));

ALTER POLICY "Members can read their org coverage" ON public."organization_coverage"
  USING ((EXISTS ( SELECT 1
   FROM organization_memberships m
  WHERE ((m.organization_id = organization_coverage.organization_id) AND (m.user_id = (select auth.uid())) AND (m.left_at IS NULL)))));

ALTER POLICY "Members can read peers in same org" ON public."organization_memberships"
  USING ((EXISTS ( SELECT 1
   FROM organization_memberships peer
  WHERE ((peer.organization_id = organization_memberships.organization_id) AND (peer.user_id = (select auth.uid())) AND (peer.left_at IS NULL)))));

ALTER POLICY "Members can read their own memberships" ON public."organization_memberships"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "Members can read their own org" ON public."organizations"
  USING ((EXISTS ( SELECT 1
   FROM organization_memberships m
  WHERE ((m.organization_id = organizations.id) AND (m.user_id = (select auth.uid())) AND (m.left_at IS NULL)))));

ALTER POLICY "Ownerships insertable by self" ON public."ownerships"
  WITH CHECK ((owner_user_id = (select auth.uid())));

ALTER POLICY "Ownerships readable by self" ON public."ownerships"
  USING ((owner_user_id = (select auth.uid())));

ALTER POLICY "Ownerships updatable by self" ON public."ownerships"
  USING ((owner_user_id = (select auth.uid())))
  WITH CHECK ((owner_user_id = (select auth.uid())));

ALTER POLICY "achievement_views insert by owner" ON public."pet_achievement_views"
  WITH CHECK (((user_id = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.pet_id = pet_achievement_views.pet_id) AND (o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL))))));

ALTER POLICY "achievement_views select by owner" ON public."pet_achievement_views"
  USING (((user_id = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.pet_id = pet_achievement_views.pet_id) AND (o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL))))));

ALTER POLICY "achievement_views update by owner" ON public."pet_achievement_views"
  USING (((user_id = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.pet_id = pet_achievement_views.pet_id) AND (o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL))))))
  WITH CHECK (((user_id = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.pet_id = pet_achievement_views.pet_id) AND (o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL))))));

ALTER POLICY "Pet events insertable by active owner (owner-self only)" ON public."pet_events"
  WITH CHECK (((author_organization_id IS NULL) AND (EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.pet_id = pet_events.pet_id) AND (o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL))))));

ALTER POLICY "Pet events readable by active owner" ON public."pet_events"
  USING ((((EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.pet_id = pet_events.pet_id) AND (o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL)))) AND ((case_id IS NULL) OR (NOT is_hidden_from_subject_case(case_id)) OR can_read_case(case_id, (select auth.uid())))) OR ((case_id IS NOT NULL) AND can_read_case(case_id, (select auth.uid())))));

ALTER POLICY "pet_identifications read by active owner" ON public."pet_identifications"
  USING ((EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.pet_id = pet_identifications.pet_id) AND (o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL)))));

ALTER POLICY "pet_identifications read by admin" ON public."pet_identifications"
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role) AND (p.deactivated_at IS NULL)))));

ALTER POLICY "pet_identifications read by govt in jurisdiction" ON public."pet_identifications"
  USING ((EXISTS ( SELECT 1
   FROM (pets pt
     JOIN govt_assignments ga ON ((ga.user_id = (select auth.uid()))))
  WHERE ((pt.id = pet_identifications.pet_id) AND (ga.revoked_at IS NULL) AND (ga.jurisdiction_province = pt.jurisdiction_province)))));

ALTER POLICY "service_dog select by owner or authority" ON public."pet_service_dog"
  USING (((EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.pet_id = pet_service_dog.pet_id) AND (o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL)))) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.account_type = 'institutional'::text) AND (p.role = ANY (ARRAY['admin'::user_role, 'govt'::user_role])) AND (p.deactivated_at IS NULL))))));

ALTER POLICY "pet_transfers read by admin" ON public."pet_transfers"
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role) AND (p.deactivated_at IS NULL)))));

ALTER POLICY "pet_transfers read by receiver" ON public."pet_transfers"
  USING ((to_owner_id = (select auth.uid())));

ALTER POLICY "pet_transfers read by sender" ON public."pet_transfers"
  USING ((from_owner_id = (select auth.uid())));

ALTER POLICY "Pets readable by active owner" ON public."pets"
  USING ((EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.pet_id = pets.id) AND (o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL)))));

ALTER POLICY "Pets updatable by active owner" ON public."pets"
  USING ((EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.pet_id = pets.id) AND (o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.pet_id = pets.id) AND (o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL)))));

ALTER POLICY "Profiles readable by self" ON public."profiles"
  USING ((id = (select auth.uid())));

ALTER POLICY "Profiles updatable by self" ON public."profiles"
  USING ((id = (select auth.uid())))
  WITH CHECK ((id = (select auth.uid())));

ALTER POLICY "Reminders deletable by self" ON public."reminders"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "Reminders insertable by self" ON public."reminders"
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY "Reminders readable by self" ON public."reminders"
  USING ((user_id = (select auth.uid())));

ALTER POLICY "Reminders updatable by self" ON public."reminders"
  USING ((user_id = (select auth.uid())))
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY "service_offerings read by org members" ON public."service_offerings"
  USING ((organization_id IN ( SELECT organization_memberships.organization_id
   FROM organization_memberships
  WHERE ((organization_memberships.user_id = (select auth.uid())) AND (organization_memberships.left_at IS NULL)))));

ALTER POLICY "service_offerings read by provider vet" ON public."service_offerings"
  USING ((provider_user_id = (select auth.uid())));

ALTER POLICY "schedule_rules read by org members" ON public."service_schedule_rules"
  USING ((service_offering_id IN ( SELECT service_offerings.id
   FROM service_offerings
  WHERE (service_offerings.organization_id IN ( SELECT organization_memberships.organization_id
           FROM organization_memberships
          WHERE ((organization_memberships.user_id = (select auth.uid())) AND (organization_memberships.left_at IS NULL)))))));

ALTER POLICY "schedule_rules read by provider vet" ON public."service_schedule_rules"
  USING ((service_offering_id IN ( SELECT service_offerings.id
   FROM service_offerings
  WHERE (service_offerings.provider_user_id = (select auth.uid())))));

ALTER POLICY "Admin can insert welfare attachments" ON public."welfare_report_attachments"
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role)))));

ALTER POLICY "Admin can read any welfare attachments" ON public."welfare_report_attachments"
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.role = 'admin'::user_role)))));

ALTER POLICY "Reporter can insert own welfare attachments" ON public."welfare_report_attachments"
  WITH CHECK ((EXISTS ( SELECT 1
   FROM welfare_reports wr
  WHERE ((wr.id = welfare_report_attachments.welfare_report_id) AND (wr.reporter_user_id = (select auth.uid()))))));

ALTER POLICY "Reporter can read own welfare attachments" ON public."welfare_report_attachments"
  USING ((EXISTS ( SELECT 1
   FROM welfare_reports wr
  WHERE ((wr.id = welfare_report_attachments.welfare_report_id) AND (wr.reporter_user_id = (select auth.uid()))))));

ALTER POLICY "Reporter can read own welfare reports" ON public."welfare_reports"
  USING ((reporter_user_id = (select auth.uid())));

COMMIT;
