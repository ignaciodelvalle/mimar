// The reporter's entitlement, expressed as a projection.
//
// This module is the single place where "what a denunciante may see about their
// own denuncia" is decided. It is deliberately PURE — no db, no storage, no
// session — so the boundary is a function you can read top to bottom and a test
// can drive with a hostile row: hand it a report carrying resolution notes, the
// description of the accused, coordinates and internal moderation flags, and
// assert that none of it comes out the other side.
//
// THE LEGAL SHAPE. The denunciante is not a party to the proceeding. They are
// the person who told the state something; the state then investigates someone
// else. That asymmetry is the whole design:
//
//   ENTITLED — that their submission exists, when they made it, THEIR OWN TEXT
//   AS THEY WROTE IT, what contact data of theirs is retained, a coarse status
//   timeline with dates, the responsible organism and its channel, and a
//   constancia number they can cite.
//
//   NOT ENTITLED — the identity of the accused, internal notes, the substantive
//   content of the investigation, or the grounds of any resolution.
//
// WHY THIS IS A WHITELIST AND NEVER A SPREAD. Every field below is named
// individually. `...report` would be one keystroke and would silently publish
// every column added to `welfare_reports` from then on — including the next
// `resolution_notes`. The columns in FORBIDDEN_IN_REPORTER_VIEW are the ones
// whose appearance here would be a legal breach rather than a bug, and the
// colocated test asserts, against a fully-populated hostile row, that no
// serialization of the output contains their values.

/** Coarse, reporter-facing stages. Never a substantive investigation step. */
export type ReporterTimelineStage = "recibida" | "derivada" | "en_tramite" | "cerrada";

export type ReporterTimelineEntry = {
  stage: ReporterTimelineStage;
  at: Date;
};

/** The responsible organism + the channel the reporter may use to reach it. */
export type ReporterOrganism = {
  name: string;
  email: string | null;
  phone: string | null;
};

export type ReporterView = {
  /** Constancia number. The reporter already holds it; echoing it is the receipt. */
  constanciaNumber: string;
  submittedAt: Date;
  /** Reporter-supplied: when they say it happened. Their own input. */
  occurredAt: Date | null;
  /** Reporter-supplied classification. Their own input. */
  kind: string;
  /** Reporter-supplied classification. Their own input. */
  severity: string;
  /** Their own free text, verbatim — never summarised, never trimmed. */
  ownText: string;
  /** What of THEIRS we retained, shown in full: this is a Ley 25.326 access answer. */
  retainedContact: { email: string | null; phone: string | null };
  /** Count only. The reporter has their own files; we never re-serve ours. */
  attachmentCount: number;
  timeline: ReporterTimelineEntry[];
  organism: ReporterOrganism | null;
};

/**
 * Column names that must never reach a reporter surface, with the reason each
 * one is disqualifying. Exported so the test can assert on the list itself:
 * shortening the list is then a visible diff, not an invisible regression.
 */
export const FORBIDDEN_IN_REPORTER_VIEW: readonly string[] = [
  // Identity of the accused. The reporter wrote it and therefore already knows
  // it, so rendering it buys them nothing and puts the single most
  // re-identifying string in the record onto a link-reachable page.
  "subjectDescription",
  "subjectPetId",
  // Grounds of the resolution — explicitly outside the entitlement.
  "resolutionNotes",
  // Substantive investigation content / internal process.
  "assignedToUserId",
  "triagedByUserId",
  "derivedByUserId",
  "flagReasons",
  "flaggedAt",
  "moderationResolvedAt",
  "moderationResolvedByUserId",
  "moderationEscalatedAt",
  "moderationEscalatedByUserId",
  "jurisdictionUnverified",
  // Location. The reporter supplied it, but a rendered coordinate or street
  // address points at the accused's home or workplace. The organism name below
  // already carries the only jurisdiction disclosure the view needs.
  "locationAddress",
  "locationLat",
  "locationLng",
  "localityId",
  // Internal plumbing that identifies the expediente rather than the report.
  "caseId",
  "id",
  "seedTag",
  // Raw status enum. `invalid` reads "Sin sustento" and `duplicate` reads
  // "Duplicada" — both are resolution GROUNDS wearing an enum's clothes. The
  // timeline coarsens all three terminal states to "cerrada" + date.
  "status",
];

/** The minimal row shape this projection needs. Structurally typed on purpose */
/** so both a Drizzle row and a test fixture satisfy it without a cast. */
export type ReporterViewSource = {
  referenceCode: string;
  createdAt: Date | string;
  occurredAt: Date | string | null;
  kind: string;
  severity: string;
  description: string;
  reporterContactEmail: string | null;
  reporterContactPhone: string | null;
  status: string;
  triagedAt: Date | string | null;
  derivedAt: Date | string | null;
  closedAt: Date | string | null;
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return toDate(value);
}

/**
 * Build the coarse timeline.
 *
 * COARSENING IS THE POINT. `invalid` and `duplicate` both collapse into
 * "cerrada". Surfacing "Sin sustento" to the person who reported in good faith
 * would hand them the grounds of the resolution — outside the entitlement — and
 * would do it in the most discouraging phrasing available, to someone the
 * product needs to keep trusting it. They learn that it closed, and when. Why
 * is the organism's answer to give, through the channel named in the view.
 *
 * Stages are emitted only when their timestamp exists, so the timeline never
 * asserts a step the data cannot date. A `triagedAt` is reported as
 * "en trámite" because that is what triage means to the person outside the
 * building; the internal distinction between triaged and in_progress is process
 * detail they are not owed.
 */
export function buildReporterTimeline(source: ReporterViewSource): ReporterTimelineEntry[] {
  const entries: ReporterTimelineEntry[] = [{ stage: "recibida", at: toDate(source.createdAt) }];

  const derivedAt = toDateOrNull(source.derivedAt);
  if (derivedAt) entries.push({ stage: "derivada", at: derivedAt });

  const triagedAt = toDateOrNull(source.triagedAt);
  if (triagedAt) entries.push({ stage: "en_tramite", at: triagedAt });

  const closedAt = toDateOrNull(source.closedAt);
  if (closedAt) entries.push({ stage: "cerrada", at: closedAt });

  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Project a denuncia row down to what its reporter may see.
 *
 * `organism` is passed in rather than derived here so this module stays pure:
 * resolving "who is responsible" needs the organizations table when the report
 * was derived, and the jurisdiction otherwise.
 */
export function buildReporterView(
  source: ReporterViewSource,
  options: { attachmentCount: number; organism: ReporterOrganism | null },
): ReporterView {
  return {
    constanciaNumber: source.referenceCode,
    submittedAt: toDate(source.createdAt),
    occurredAt: toDateOrNull(source.occurredAt),
    kind: source.kind,
    severity: source.severity,
    ownText: source.description,
    retainedContact: {
      email: source.reporterContactEmail,
      phone: source.reporterContactPhone,
    },
    attachmentCount: options.attachmentCount,
    timeline: buildReporterTimeline(source),
    organism: options.organism,
  };
}

export const REPORTER_TIMELINE_LABELS: Record<ReporterTimelineStage, string> = {
  recibida: "Recibida",
  derivada: "Derivada al organismo",
  en_tramite: "En trámite",
  cerrada: "Cerrada",
};
