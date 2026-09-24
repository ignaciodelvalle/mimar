// Org-safe welfare report projection.
//
// This module is the SINGLE authoritative source for which welfare_reports
// columns an org-facing query is allowed to read. All org-facing welfare reads
// MUST go through `ORG_WELFARE_SELECT` — never via `db.select()` (star).
//
// WHY this exists (ARCH-J, 2026-06-10):
//   welfare_reports carries reporter PII (reporterContactEmail,
//   reporterContactPhone, reporterUserId). When a govt/admin actor derives a
//   report to an org (sets derivedToOrganizationId), org members can view that
//   report in their /maltrato/recibidos inbox. Because derivation is NOT a
//   separate table — it is just three columns on the same welfare_reports row —
//   the only thing protecting reporter identity from the org is query discipline.
//   This helper makes that discipline structural: the TypeScript type returned
//   by ORG_WELFARE_SELECT provably lacks PII fields, and the fitness test in
//   __tests__/welfare-org-pii-fitness.test.ts asserts it stays that way.
//
// DENYLIST (keep in sync with the fitness test):
//   reporterContactEmail  — email left by the reporter (may be anonymous)
//   reporterContactPhone  — phone left by the reporter (may be anonymous)
//   reporterUserId        — FK to profiles; leaks identity of registered reporter
//   description           — free-text narrative; reporters self-identify in it
//                           in practice ("soy la vecina de..., mi nombre es...").
//                           Orgs act on subjectDescription; the full narrative
//                           stays govt/admin-only.
//
// SAFE columns (all others on welfare_reports):
//   Metadata   : id, referenceCode, createdAt, occurredAt
//   Report body: kind, severity, status
//   Subject    : subjectKind, subjectDescription, subjectPetId
//   Location   : locationAddress, jurisdictionProvince, jurisdictionLocality,
//                locationLat, locationLng
//   Workflow   : triagedAt, closedAt, resolutionNotes, caseId
//   Derivation : derivedToOrganizationId, derivedAt
//   Intervention: orgInterventionStatus, orgInterventionAt (org workflow, non-PII)
//   Org-reporter: reporterOrganizationId (the ORG that filed — not a person)
//
// Note: triagedByUserId, moderationResolvedByUserId, derivedByUserId and
// assignedToUserId are intentionally excluded from org projections because
// they expose internal govt/admin user IDs.

import { cases, pets, welfareReports } from "@/db";

// ---------------------------------------------------------------------------
// PII denylist — the canonical list of columns that MUST NOT appear in any
// org-facing welfare query. The fitness test imports this and asserts it.
// ---------------------------------------------------------------------------

export const ORG_WELFARE_PII_DENYLIST = [
  "reporterContactEmail",
  "reporterContactPhone",
  "reporterUserId",
  // Narrative PII: the free-text report body where reporters self-identify in
  // practice. Structural columns above are PII by schema; this one is PII by
  // content. Org-facing surfaces use subjectDescription instead.
  "description",
] as const;

export type OrgWelfarePiiField = (typeof ORG_WELFARE_PII_DENYLIST)[number];

// ---------------------------------------------------------------------------
// Org-safe select shape — pass this to db.select({ ...ORG_WELFARE_SELECT })
// ---------------------------------------------------------------------------

export const ORG_WELFARE_SELECT = {
  // Identity
  reportId: welfareReports.id,
  referenceCode: welfareReports.referenceCode,
  // Report body — note: description (full narrative) is deliberately absent;
  // see ORG_WELFARE_PII_DENYLIST.
  kind: welfareReports.kind,
  severity: welfareReports.severity,
  status: welfareReports.status,
  // Subject
  subjectKind: welfareReports.subjectKind,
  subjectDescription: welfareReports.subjectDescription,
  subjectPetId: welfareReports.subjectPetId,
  // Location
  locationAddress: welfareReports.locationAddress,
  jurisdictionProvince: welfareReports.jurisdictionProvince,
  jurisdictionLocality: welfareReports.jurisdictionLocality,
  locationLat: welfareReports.locationLat,
  locationLng: welfareReports.locationLng,
  // Timestamps
  createdAt: welfareReports.createdAt,
  occurredAt: welfareReports.occurredAt,
  // Workflow — internal actor IDs (assignedToUserId etc.) deliberately absent.
  triagedAt: welfareReports.triagedAt,
  closedAt: welfareReports.closedAt,
  resolutionNotes: welfareReports.resolutionNotes,
  caseId: welfareReports.caseId,
  // Derivation — org needs to see when/by-whom it was derived (org ID is safe)
  derivedToOrganizationId: welfareReports.derivedToOrganizationId,
  derivedAt: welfareReports.derivedAt,
  // Org intervention state (UI-7) — workflow metadata, NON-PII. The org reads
  // these to render its own intervention badge ('tomado' / 'devuelto' / none).
  orgInterventionStatus: welfareReports.orgInterventionStatus,
  orgInterventionAt: welfareReports.orgInterventionAt,
  // Org-reporter — the org that filed the report (not a person — safe)
  reporterOrganizationId: welfareReports.reporterOrganizationId,
} as const;

// TypeScript type for a row returned by ORG_WELFARE_SELECT.
// Callers can import this instead of deriving it manually.
export type OrgWelfareRow = {
  [K in keyof typeof ORG_WELFARE_SELECT]: (typeof ORG_WELFARE_SELECT)[K] extends {
    _: { data: infer D };
  }
    ? D
    : never;
};

// ---------------------------------------------------------------------------
// Extended shapes — for pages that join cases or pets
// ---------------------------------------------------------------------------

/**
 * Extra columns added when joining cases for the public case code.
 * Usage: db.select({ ...ORG_WELFARE_SELECT, ...ORG_WELFARE_CASE_COLS })
 */
export const ORG_WELFARE_CASE_COLS = {
  casePublicCode: cases.publicCode,
} as const;

/**
 * Extra columns added when joining pets for the subject pet name.
 * Usage: db.select({ ...ORG_WELFARE_SELECT, ...ORG_WELFARE_PET_COLS })
 */
export const ORG_WELFARE_PET_COLS = {
  petName: pets.name,
} as const;
