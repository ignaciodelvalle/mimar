// Drizzle select shapes for the denuncia data partition.
//
// The classification itself lives in `lib/domain/denuncia-data-partition.ts`
// (pure). This module is the query-layer instrument built from it: two select
// shapes that can be handed to `db.select()` and that are PROVABLY unable to
// carry the other side's columns, because the colocated fitness test asserts
// each shape's key set against the domain partition.
//
// WHAT THESE ARE FOR — AND WHAT THEY ARE NOT
// ------------------------------------------
// These are the GOVERNANCE reads: the two operations that must be able to run
// without touching each other.
//
//   DENUNCIA_CONTENT_SELECT          — what an art. 17 access answer to the
//                                      DENUNCIADO may draw from. Reporter
//                                      identity is structurally absent, so the
//                                      inc. 1 reserve is exercised by choosing
//                                      this shape rather than by remembering to
//                                      omit four columns.
//
//   DENUNCIA_REPORTER_IDENTITY_SELECT — the reporter-side record, readable and
//                                      expirable on its own clock, carrying
//                                      none of the accused's description and no
//                                      path to the evidence.
//
// They are NOT replacements for the three operational projections that already
// exist, and this change deliberately rewires none of them:
//
//   • `ORG_WELFARE_SELECT` (lib/infra/welfare-org-projection.ts) — what a
//     RECEIVING ORG may see. Narrower than content on `description`.
//   • `GOB_WELFARE_DETAIL_SELECT` (app/gob/maltrato/[id]) — the operator
//     expediente. Spans both sides, because the operator handling the case is
//     the one actor entitled to both.
//   • the seguimiento projection + `buildReporterView` — what the DENUNCIANTE
//     may see. Also spans both sides, and legitimately so: their own relato and
//     their own contact data are both theirs. It is the one surface where
//     crossing the boundary is the correct answer, which is exactly why it is
//     a hand-audited whitelist and not a spread.
//
// Reading a partition shape at one of those surfaces would CHANGE what it
// renders. Nothing here does that.

import { welfareReports } from "@/db";
import {
  CASE_RECORD_COLUMNS,
  DENUNCIA_CONTENT_COLUMNS,
  REPORTER_IDENTITY_COLUMNS,
} from "@/lib/domain/denuncia-data-partition";

// ---------------------------------------------------------------------------
// Content side — case_record ∪ denuncia_content, and nothing else
// ---------------------------------------------------------------------------

/**
 * Every column an answer about the DENUNCIA may draw from. Includes the case
 * record because an answer that omitted "when, where, to which organism" would
 * be reserving the existence of the case, which the PO decision explicitly
 * does not do: the content can be denied, the existence cannot.
 *
 * The keys are written out one by one rather than generated from
 * `CASE_RECORD_COLUMNS` so the shape keeps its precise drizzle types; the
 * fitness test asserts the two lists agree, so the duplication cannot drift.
 */
export const DENUNCIA_CONTENT_SELECT = {
  // --- case_record ---
  id: welfareReports.id,
  referenceCode: welfareReports.referenceCode,
  kind: welfareReports.kind,
  severity: welfareReports.severity,
  subjectKind: welfareReports.subjectKind,
  jurisdictionProvince: welfareReports.jurisdictionProvince,
  jurisdictionLocality: welfareReports.jurisdictionLocality,
  localityId: welfareReports.localityId,
  jurisdictionUnverified: welfareReports.jurisdictionUnverified,
  occurredAt: welfareReports.occurredAt,
  createdAt: welfareReports.createdAt,
  status: welfareReports.status,
  triagedAt: welfareReports.triagedAt,
  triagedByUserId: welfareReports.triagedByUserId,
  closedAt: welfareReports.closedAt,
  flaggedAt: welfareReports.flaggedAt,
  flagReasons: welfareReports.flagReasons,
  moderationResolvedAt: welfareReports.moderationResolvedAt,
  moderationResolvedByUserId: welfareReports.moderationResolvedByUserId,
  moderationEscalatedAt: welfareReports.moderationEscalatedAt,
  moderationEscalatedByUserId: welfareReports.moderationEscalatedByUserId,
  caseId: welfareReports.caseId,
  assignedToUserId: welfareReports.assignedToUserId,
  derivedToOrganizationId: welfareReports.derivedToOrganizationId,
  derivedAt: welfareReports.derivedAt,
  derivedByUserId: welfareReports.derivedByUserId,
  orgInterventionStatus: welfareReports.orgInterventionStatus,
  orgInterventionAt: welfareReports.orgInterventionAt,
  seedTag: welfareReports.seedTag,
  // --- denuncia_content (the R1/R2 purge unit) ---
  description: welfareReports.description,
  observedSymptoms: welfareReports.observedSymptoms,
  subjectPetId: welfareReports.subjectPetId,
  subjectDescription: welfareReports.subjectDescription,
  locationAddress: welfareReports.locationAddress,
  locationLat: welfareReports.locationLat,
  locationLng: welfareReports.locationLng,
  resolutionNotes: welfareReports.resolutionNotes,
} as const;

// ---------------------------------------------------------------------------
// Reporter-identity side — identity ∪ join/clock key, and nothing else
// ---------------------------------------------------------------------------

/**
 * The reporter-side record. `createdAt` is here because a set of rows with no
 * date cannot be aged out on its own clock, and ageing this side out
 * independently is the point.
 *
 * `description` is absent even though the reporter wrote it. It is content by
 * classification (and unsanitisable free text besides); the surface that owes
 * the reporter their own words back reads it through the seguimiento
 * projection, which is audited for that purpose.
 */
export const DENUNCIA_REPORTER_IDENTITY_SELECT = {
  // --- join + clock key ---
  id: welfareReports.id,
  referenceCode: welfareReports.referenceCode,
  createdAt: welfareReports.createdAt,
  // --- reporter_identity ---
  reporterUserId: welfareReports.reporterUserId,
  reporterOrganizationId: welfareReports.reporterOrganizationId,
  reporterContactEmail: welfareReports.reporterContactEmail,
  reporterContactPhone: welfareReports.reporterContactPhone,
} as const;

/** Row type returned by `DENUNCIA_CONTENT_SELECT`. */
export type DenunciaContentRow = {
  [K in keyof typeof DENUNCIA_CONTENT_SELECT]: (typeof DENUNCIA_CONTENT_SELECT)[K] extends {
    _: { data: infer D };
  }
    ? D
    : never;
};

/** Row type returned by `DENUNCIA_REPORTER_IDENTITY_SELECT`. */
export type DenunciaReporterIdentityRow = {
  [K in keyof typeof DENUNCIA_REPORTER_IDENTITY_SELECT]: (typeof DENUNCIA_REPORTER_IDENTITY_SELECT)[K] extends {
    _: { data: infer D };
  }
    ? D
    : never;
};

/**
 * Names of the database views that mirror these shapes (migration 0186).
 * Exported so the boundary test can assert the SQL objects and the TypeScript
 * partition still agree — a check that fails if either side drifts.
 */
export const DENUNCIA_CONTENT_VIEW = "welfare_report_content" as const;
export const DENUNCIA_REPORTER_IDENTITY_VIEW = "welfare_report_reporter_identity" as const;

/** Column-name lists, in SQL form, for cross-checking against the views. */
export const CONTENT_VIEW_EXPECTED_COLUMNS: readonly string[] = [
  ...CASE_RECORD_COLUMNS.map((c) => c.column),
  ...DENUNCIA_CONTENT_COLUMNS.map((c) => c.column),
];

export const REPORTER_IDENTITY_VIEW_EXPECTED_COLUMNS: readonly string[] = [
  "id",
  "reference_code",
  "created_at",
  ...REPORTER_IDENTITY_COLUMNS.map((c) => c.column),
];
