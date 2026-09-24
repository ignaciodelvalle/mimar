// The denuncia data partition — who reported vs. what was reported.
//
// WHY THIS MODULE EXISTS (legal review 2026-08-17, PO decision
// `legal/retencion-denuncias-decision`). Ley 25.326 art. 17 inc. 1 lets the
// organism refuse an access request "en función de la protección de los
// derechos e intereses de terceros", and — unlike inc. 2 — it does NOT require
// ongoing proceedings. That is the instrument that protects a denunciante from
// retaliation when the denunciado asks what is on file about them. But a
// reserve can only be exercised over something SEPARABLE. Until this module
// existed, "the reporter's identity" was not a thing the codebase could name:
// each surface re-derived its own idea of it by hand (three hand-rolled
// projections, one denylist, zero shared definition), so nothing could be
// reserved, aged out, or purged as a unit.
//
// The same separation is what makes the retention clocks possible at all. The
// lawyer's point is that keeping the record whole maximises BOTH harms: the
// accused cannot answer an allegation they do not know about, and the reporter
// stays exposed for exactly as long as the record survives. Purging the
// content without destroying the reporter-side record (and the reverse) needs
// the two sides to be addressable independently. This is that address book.
//
// THIS MODULE IS PURE. No drizzle, no db, no session — it is a set of column
// classifications and two purge plans, so a test can read it top to bottom and
// a fitness test can prove it exhaustive against the live table. The drizzle
// select shapes built from it live in `lib/infra/welfare-report-partition.ts`;
// the database views that mirror it live in migration 0186.
//
// WHAT THIS MODULE DOES NOT DO
//   - It does not run the retention clocks (R1 = 30 días desde la recepción si
//     nunca se derivó, R2 = 90 días desde la derivación). It only declares the
//     units those clocks will act on. See PURGE SEAMS below.
//   - It does not answer access requests. It declares what such an answer may
//     and may not draw from.
//   - It does not redact free text. It cannot — see FREE TEXT below.
//
// FREE TEXT IS NOT SOLVED AND CANNOT BE SOLVED HERE
// -------------------------------------------------
// A denunciante routinely self-identifies inside the relato ("soy el vecino de
// al lado", "trabajo en la veterinaria de la esquina"). `description` is
// therefore reporter-identifying AND content at the same time, and no
// heuristic redaction makes it otherwise: the sentence that identifies the
// reporter is usually the same sentence that makes the report actionable.
// `lib/infra/welfare-org-projection.ts` already reached this conclusion for
// orgs and solved it the only honest way — by withholding the whole field.
//
// This module makes the same call and states its consequence plainly:
// `description` is classified as CONTENT, which means it is purgeable AS ONE
// UNIT and is never drawn into a reporter-identity read. It does NOT mean the
// reporter's identity has been removed from it. Anyone building the access
// channel must treat the relato as unreservable-but-purgeable: it can be
// withheld and it can be destroyed, it cannot be sanitised.

/**
 * The three disjoint classes every `welfare_reports` column belongs to.
 *
 * `reporter_identity` — who filed and how to reach them. Reservable under
 *   art. 17 inc. 1; retained on its own short clock with its own basis, and
 *   once the content is purged it must never be rejoined to it.
 *
 * `denuncia_content` — the allegation and what points at the accused. This is
 *   the R1/R2 purge unit: free text and the descripción del denunciado are not
 *   anonymisable (the descripción IS the identifier), so the disposition is
 *   destruction, not de-identification.
 *
 * `case_record` — the state's own record of its handling. Survives the content
 *   purge: it is the acuse (that a report existed, when, in which
 *   jurisdiction, to which organism it went, how it ended) plus internal
 *   workflow attribution. Neither reserved from the denunciado nor purged.
 */
export type DenunciaDataClass = "reporter_identity" | "denuncia_content" | "case_record";

/** One classified column: the drizzle property and the SQL column it maps to. */
export type DenunciaColumn = {
  /** Drizzle property name on `welfareReports` (camelCase). */
  property: string;
  /** Physical Postgres column name (snake_case). */
  column: string;
};

// ---------------------------------------------------------------------------
// 1. REPORTER IDENTITY — the reservable, separately-retained side
// ---------------------------------------------------------------------------

/**
 * Who reported, and the channel back to them.
 *
 * `reporterOrganizationId` is here deliberately, and this is a REclassification
 * relative to `ORG_WELFARE_PII_DENYLIST`, which treats it as safe. Both are
 * right, because they answer different questions. That denylist asks "may the
 * receiving org see this column on the row it was handed" — and an org seeing
 * its own id is a no-op. This partition asks "would disclosing this to the
 * DENUNCIADO expose whoever reported them" — and "el refugio X te denunció" is
 * precisely the retaliation the art. 17 inc. 1 reserve exists to prevent. The
 * org projection is unchanged by this module.
 *
 * Note what is NOT here because it does not exist: `welfare_reports` has no
 * reporter NAME and no reporter ADDRESS column. Reporter identity is a user FK,
 * an org FK and two contact strings — nothing else structured. Everything else
 * identifying about the reporter lives in free text (see FREE TEXT above).
 */
export const REPORTER_IDENTITY_COLUMNS: readonly DenunciaColumn[] = [
  { property: "reporterUserId", column: "reporter_user_id" },
  { property: "reporterOrganizationId", column: "reporter_organization_id" },
  { property: "reporterContactEmail", column: "reporter_contact_email" },
  { property: "reporterContactPhone", column: "reporter_contact_phone" },
] as const;

// ---------------------------------------------------------------------------
// 2. DENUNCIA CONTENT — the R1/R2 purge unit
// ---------------------------------------------------------------------------

/**
 * The allegation itself and everything in the row that points at the accused.
 *
 * `resolutionNotes` is here rather than in `case_record` on purpose: the
 * DESENLACE survives a purge as a category (`status` + `closedAt`), but the
 * operator's prose about it routinely restates the allegation and names people.
 * Prose describing an unverified imputation is content whoever wrote it.
 *
 * `locationLat` / `locationLng` travel together — `welfare_reports_location_pair_check`
 * requires both null or both set, so they must be in the same purge unit or the
 * purge would violate the constraint.
 */
export const DENUNCIA_CONTENT_COLUMNS: readonly DenunciaColumn[] = [
  { property: "description", column: "description" },
  // What the reporter observed on the animal (migration 0209) — testimony
  // prose of the same class as `description`: free text that can restate the
  // allegation or name people, and must vanish with the content unit.
  { property: "observedSymptoms", column: "observed_symptoms" },
  { property: "subjectPetId", column: "subject_pet_id" },
  { property: "subjectDescription", column: "subject_description" },
  { property: "locationAddress", column: "location_address" },
  { property: "locationLat", column: "location_lat" },
  { property: "locationLng", column: "location_lng" },
  { property: "resolutionNotes", column: "resolution_notes" },
] as const;

// ---------------------------------------------------------------------------
// 3. CASE RECORD — survives the purge
// ---------------------------------------------------------------------------

/**
 * The organism's record of having received and handled something. Retaining
 * this after the content is gone is the whole point of the design the lawyer
 * described: derive the full package, keep the ACUSE, purge the content.
 */
export const CASE_RECORD_COLUMNS: readonly DenunciaColumn[] = [
  { property: "id", column: "id" },
  { property: "referenceCode", column: "reference_code" },
  { property: "kind", column: "kind" },
  { property: "severity", column: "severity" },
  { property: "subjectKind", column: "subject_kind" },
  { property: "jurisdictionProvince", column: "jurisdiction_province" },
  { property: "jurisdictionLocality", column: "jurisdiction_locality" },
  { property: "localityId", column: "locality_id" },
  { property: "jurisdictionUnverified", column: "jurisdiction_unverified" },
  { property: "occurredAt", column: "occurred_at" },
  { property: "createdAt", column: "created_at" },
  { property: "status", column: "status" },
  { property: "triagedAt", column: "triaged_at" },
  { property: "triagedByUserId", column: "triaged_by_user_id" },
  { property: "closedAt", column: "closed_at" },
  { property: "flaggedAt", column: "flagged_at" },
  { property: "flagReasons", column: "flag_reasons" },
  { property: "moderationResolvedAt", column: "moderation_resolved_at" },
  { property: "moderationResolvedByUserId", column: "moderation_resolved_by_user_id" },
  { property: "moderationEscalatedAt", column: "moderation_escalated_at" },
  { property: "moderationEscalatedByUserId", column: "moderation_escalated_by_user_id" },
  { property: "caseId", column: "case_id" },
  { property: "assignedToUserId", column: "assigned_to_user_id" },
  { property: "derivedToOrganizationId", column: "derived_to_organization_id" },
  { property: "derivedAt", column: "derived_at" },
  { property: "derivedByUserId", column: "derived_by_user_id" },
  { property: "orgInterventionStatus", column: "org_intervention_status" },
  { property: "orgInterventionAt", column: "org_intervention_at" },
  { property: "seedTag", column: "seed_tag" },
] as const;

/**
 * The subset of `case_record` that is the STATISTICAL AGGREGATE DIMENSION —
 * "el hecho del caso (tipo, jurisdicción, fecha, desenlace)". Named here as a
 * seam: the aggregate publication the retention decision calls for must apply
 * k-anon over the COMBINED filter space of these fields, not per isolated
 * query.
 *
 * Everything else in `case_record` is internal workflow attribution (which
 * operator triaged, assigned, derived, moderated). It survives the purge as
 * accountability, and it is NOT an aggregate dimension — publishing an operator
 * id is a different disclosure with a different basis.
 */
export const CASE_RECORD_AGGREGATE_DIMENSIONS: readonly string[] = [
  "kind",
  "severity",
  "subjectKind",
  "jurisdictionProvince",
  "jurisdictionLocality",
  "occurredAt",
  "createdAt",
  "status",
  "derivedAt",
  "closedAt",
] as const;

/**
 * Columns both governed sides may carry: the key that lets them be rejoined
 * BY AN AUTHORISED OPERATION and the clock the identity side is aged out on.
 *
 * `createdAt` is not decoration here. The reporter-identity side has to be
 * expirable on its own basis, and a set of rows with no date cannot be aged
 * out — so the clock has to be readable from the identity side without reading
 * the content side.
 */
export const DENUNCIA_JOIN_KEY_COLUMNS: readonly DenunciaColumn[] = [
  { property: "id", column: "id" },
  { property: "referenceCode", column: "reference_code" },
  { property: "createdAt", column: "created_at" },
] as const;

// ---------------------------------------------------------------------------
// Derived lookups
// ---------------------------------------------------------------------------

const CLASS_BY_PROPERTY: ReadonlyMap<string, DenunciaDataClass> = new Map<
  string,
  DenunciaDataClass
>([
  ...REPORTER_IDENTITY_COLUMNS.map((c) => [c.property, "reporter_identity"] as const),
  ...DENUNCIA_CONTENT_COLUMNS.map((c) => [c.property, "denuncia_content"] as const),
  ...CASE_RECORD_COLUMNS.map((c) => [c.property, "case_record"] as const),
]);

/** All classified columns, in one list. Order is identity → content → record. */
export const ALL_PARTITIONED_COLUMNS: readonly DenunciaColumn[] = [
  ...REPORTER_IDENTITY_COLUMNS,
  ...DENUNCIA_CONTENT_COLUMNS,
  ...CASE_RECORD_COLUMNS,
];

/**
 * Classify a `welfareReports` drizzle property. Returns null for an unknown
 * name — which, per the fitness test, can only mean a column was added to the
 * table without being classified. That is a decision, not an oversight, and
 * the test makes it a visible one.
 */
export function classifyWelfareReportColumn(property: string): DenunciaDataClass | null {
  return CLASS_BY_PROPERTY.get(property) ?? null;
}

// ---------------------------------------------------------------------------
// PURGE SEAMS — declared here, executed by the retention change
// ---------------------------------------------------------------------------

/**
 * How a purged column is emptied. NOT NULL columns cannot be nulled, so they
 * take a sentinel; the rest are nulled outright. This distinction is the
 * reason the plan is data rather than a hand-written UPDATE: getting it wrong
 * is a constraint violation at the worst possible moment (a scheduled job
 * running unattended against production).
 */
export type PurgeAction =
  | { property: string; column: string; action: "null" }
  | { property: string; column: string; action: "sentinel"; sentinel: string };

/**
 * Sentinel for retention-expiry purges. Deliberately distinct from the erasure
 * sentinels already in use ('[contenido eliminado a pedido del titular]',
 * migrations 0130+): the access is a pedido, the supresión is de oficio, and a
 * record must be able to say which of the two emptied it.
 */
export const RETENTION_PURGE_SENTINEL = "[contenido purgado — plazo de conservación vencido]";

/**
 * SEAM FOR R1/R2. The content side, emptied as one unit.
 *
 * The clocks that will drive this are NOT built here: R1 = 30 días corridos
 * desde la RECEPCIÓN cuando nunca se derivó; R2 = 90 días corridos desde la
 * DERIVACIÓN. Both count from the HECHO, never from last activity. Suspension
 * (requerimiento fiscal/judicial, pedido de acceso pendiente, expediente
 * formalmente abierto) is likewise not modelled here.
 *
 * Two stores hold content that this plan does NOT reach, because they are
 * separate tables and need their own statements — see DENUNCIA_SATELLITE_STORES.
 */
export const CONTENT_PURGE_PLAN: readonly PurgeAction[] = [
  // NOT NULL in the schema — sentinel, never null.
  {
    property: "description",
    column: "description",
    action: "sentinel",
    sentinel: RETENTION_PURGE_SENTINEL,
  },
  // Nullable in the schema (0209) — null, not sentinel: an absent observation
  // needs no tombstone, unlike the NOT NULL description above.
  { property: "observedSymptoms", column: "observed_symptoms", action: "null" },
  { property: "subjectPetId", column: "subject_pet_id", action: "null" },
  { property: "subjectDescription", column: "subject_description", action: "null" },
  { property: "locationAddress", column: "location_address", action: "null" },
  { property: "locationLat", column: "location_lat", action: "null" },
  { property: "locationLng", column: "location_lng", action: "null" },
  { property: "resolutionNotes", column: "resolution_notes", action: "null" },
] as const;

/**
 * SEAM FOR THE REPORTER-SIDE CLOCK. Every identity column is nullable, so the
 * whole side nulls cleanly — which is exactly the property that lets the
 * reporter be forgotten while the acuse survives, and the reverse.
 */
export const REPORTER_IDENTITY_PURGE_PLAN: readonly PurgeAction[] = [
  { property: "reporterUserId", column: "reporter_user_id", action: "null" },
  { property: "reporterOrganizationId", column: "reporter_organization_id", action: "null" },
  { property: "reporterContactEmail", column: "reporter_contact_email", action: "null" },
  { property: "reporterContactPhone", column: "reporter_contact_phone", action: "null" },
] as const;

/**
 * Content and identity that live OUTSIDE `welfare_reports` and therefore
 * outside the two purge plans above. Enumerated so the retention change starts
 * from a map instead of from a grep — the map is the deliverable, the grep is
 * how three separate audits already concluded a capability was missing.
 *
 * Each entry says which side it belongs to and what the purge has to do to it.
 */
export const DENUNCIA_SATELLITE_STORES: readonly {
  table: string;
  side: DenunciaDataClass;
  note: string;
}[] = [
  {
    table: "welfare_report_attachments",
    side: "denuncia_content",
    note:
      "Evidence. Purge is a two-step the row alone cannot express: delete the storage " +
      "object in the welfare-evidence bucket, THEN the row. Photos can carry the " +
      "denunciado, the domicilio, a patente and EXIF geolocation, and the signed URLs " +
      "are bearer capabilities (TTL 3600s) that do not pass the rate limiter.",
  },
  {
    table: "case_events (entry_type = 'reporter_comment')",
    side: "denuncia_content",
    note:
      "The reporter's own follow-up prose on their case. Free text, same " +
      "unsanitisable shape as `description`. Append-only: a purge must run inside " +
      "the app.allow_event_mutation override window and will emit its own " +
      "case_events_mutation_override audit row, as erase_subject_data already does.",
  },
  {
    table: "notifications",
    side: "reporter_identity",
    note:
      "Delivery record to the reporter. title/body may restate the denuncia and the " +
      "row is keyed by user_id, so it is reporter-side by addressee even when its " +
      "text is content. erase_subject_data already redacts it on request; the " +
      "retention clock must reach it de oficio.",
  },
  {
    table: "audit_log",
    side: "case_record",
    note:
      "NOT purged. The accountability trail for triage, derivation and any purge " +
      "itself has its own basis and outlives both clocks. Naming it here so the " +
      "retention change does not quietly extend a purge into it.",
  },
] as const;
