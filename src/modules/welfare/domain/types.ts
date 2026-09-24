// Domain types for the welfare report module.
// Legal frame: Ley Nacional 14.346 (1954) — Malos tratos y actos de crueldad contra animales.
//
// Zero external imports — no Drizzle, no Next.js, no @/db runtime.
// @/db/schema type-only imports are allowed for Drizzle row shapes used by the
// repository layer; none are needed here.

// ---------------------------------------------------------------------------
// Kind
// ---------------------------------------------------------------------------

export const WELFARE_REPORT_KINDS = [
  "abandonment",
  "neglect",
  "physical_abuse",
  "chained",
  "no_shelter",
  "hoarding",
  "dog_fighting",
  "trafficking",
  "other",
] as const;

export type WelfareReportKind = (typeof WELFARE_REPORT_KINDS)[number];

export function welfareReportKindLabel(kind: WelfareReportKind | string): string {
  switch (kind) {
    case "abandonment":
      return "Abandono";
    case "neglect":
      return "Negligencia (sin agua/comida/refugio)";
    case "physical_abuse":
      return "Maltrato físico / golpes / lesiones";
    case "chained":
      return "Animal encadenado o sin movilidad";
    case "no_shelter":
      return "Sin refugio del clima";
    case "hoarding":
      return "Acumulación de animales";
    case "dog_fighting":
      return "Peleas de perros";
    case "trafficking":
      return "Tráfico / venta clandestina";
    case "other":
      return "Otra";
    default:
      return kind;
  }
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export const WELFARE_REPORT_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export type WelfareReportSeverity = (typeof WELFARE_REPORT_SEVERITIES)[number];

export function welfareReportSeverityLabel(severity: WelfareReportSeverity | string): string {
  switch (severity) {
    case "low":
      return "Baja — preocupante, no urgente";
    case "medium":
      return "Media — requiere intervención pronto";
    case "high":
      return "Alta — urgente";
    case "critical":
      return "Crítica — peligro inmediato";
    default:
      return severity;
  }
}

/**
 * The severity label a CITIZEN sees — the same words the reporting wizard
 * offered them, not the operator triage vocabulary.
 *
 * Blind QA 2026-08-19 (O2): the reporter picked the card labelled
 * "Grave / urgente" and the follow-up screen told them
 * "Gravedad que indicaste: Crítica — peligro inmediato". Same severity, a word
 * they never saw, under copy that claims to quote them back.
 *
 * The four DB severities do not map one-to-one onto the wizard's three cards
 * (`Step2Severity.tsx`: grave_urgente → critical, moderado → medium,
 * sospecha → low). `high` is unreachable from the citizen wizard — it exists
 * for server-authoritative paths — so it gets the plain word a reporter would
 * recognise rather than an invented fourth card.
 *
 * Operator surfaces keep `welfareReportSeverityLabel`: "Crítica — peligro
 * inmediato" carries the SLA tier that a triage queue needs and a reporter
 * does not.
 */
export const WELFARE_SEVERITY_CITIZEN_LABEL: Record<WelfareReportSeverity, string> = {
  low: "Sospecha",
  medium: "Moderado",
  high: "Grave",
  critical: "Grave / urgente",
};

export function welfareReportSeverityCitizenLabel(
  severity: WelfareReportSeverity | string,
): string {
  return WELFARE_SEVERITY_CITIZEN_LABEL[severity as WelfareReportSeverity] ?? severity;
}

/**
 * Bare severity-tier label (no urgency framing) for the four tiers this
 * vocabulary shares across welfare denuncias AND bite-incident severity
 * (situational-map-config/DetailDrawer read the same low/medium/high/critical
 * strings off a pet_events payload). Lives here — next to
 * welfareReportSeverityLabel, welfare's canonical severity owner — instead of
 * two byte-identical UI-local copies (was duplicated verbatim in
 * DetailDrawer's SEVERITY_LABEL and WelfareDenunciaRow's SEVERITY_BASE_LABEL).
 * `Record<string, string>` (not keyed to WelfareReportSeverity) so untyped
 * callers can index it directly with `?? key` fallback, same as before.
 */
export const SEVERITY_BASE_LABEL: Record<string, string> = {
  low: "Baja",
  medium: "Media",
  high: "Alta",
  critical: "Crítica",
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const WELFARE_REPORT_STATUSES = [
  "open",
  "triaged",
  "in_progress",
  "closed",
  "duplicate",
  "invalid",
] as const;

export type WelfareReportStatus = (typeof WELFARE_REPORT_STATUSES)[number];

export function welfareReportStatusLabel(status: WelfareReportStatus | string): string {
  switch (status) {
    case "open":
      return "Abierta";
    case "triaged":
      return "Revisada";
    case "in_progress":
      return "En curso";
    case "closed":
      return "Cerrada";
    case "duplicate":
      return "Duplicada";
    case "invalid":
      return "Sin sustento";
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Assignment display
// ---------------------------------------------------------------------------

/**
 * es-AR label for a denuncia's "Asignado a" chip.
 *
 * G0b (govt/public honesty): a denuncia DERIVED to an org but not assigned to a
 * named operator must NOT read as "Sin asignar" — that made a derived case look
 * unowned (the DEN-9KSC-MRMZ ambiguity). When there is no personal assignee but
 * the case has been derived, the holding ORG is the owner of record → show
 * "Derivada a {org}". Precedence: a named operator assignment always wins (an
 * operator can pick up a derived case); only when there is no assignee does the
 * derivation surface. No derivation and no assignee → the honest "Sin asignar".
 */
export function welfareAssignmentLabel(
  assignedToName: string | null | undefined,
  derivedOrgName: string | null | undefined,
): string {
  if (assignedToName) return assignedToName;
  if (derivedOrgName) return `Derivada a ${derivedOrgName}`;
  return "Sin asignar";
}

/**
 * The same fact as a LABEL + VALUE pair, for the stat cards on the denuncia
 * detail and the inspector.
 *
 * `welfareAssignmentLabel` bakes the relation into the value ("Derivada a
 * Refugio Test") because a queue cell has no label beside it to carry it. Under
 * a fixed "Asignado a" heading that same string says the relation twice and
 * answers a question nobody asked: the label promises a PERSON and the value
 * names a derivation (QA 2026-08-07). Here the heading moves with the fact, so
 * the value stays a bare name.
 *
 * Same precedence as the function above — a named operator always wins, the
 * derivation only surfaces when there is no assignee — because it must: two
 * places deciding "who owns this case" differently is the ambiguity G0b closed.
 */
export function welfareAssignmentField(
  assignedToName: string | null | undefined,
  derivedOrgName: string | null | undefined,
): { label: string; value: string } {
  if (assignedToName) return { label: "Asignado a", value: assignedToName };
  if (derivedOrgName) return { label: "Derivada a", value: derivedOrgName };
  return { label: "Asignado a", value: "Sin asignar" };
}

// ---------------------------------------------------------------------------
// Subject kind
// ---------------------------------------------------------------------------

export const WELFARE_REPORT_SUBJECT_KINDS = [
  "registered_pet",
  "unowned_animal",
  "location",
  "general",
] as const;

export type WelfareReportSubjectKind = (typeof WELFARE_REPORT_SUBJECT_KINDS)[number];

export function welfareReportSubjectKindLabel(kind: WelfareReportSubjectKind | string): string {
  switch (kind) {
    case "registered_pet":
      return "Mascota miMAR registrada";
    case "unowned_animal":
      return "Animal sin dueño identificado";
    case "location":
      return "Lugar / situación";
    case "general":
      return "Otro";
    default:
      return kind;
  }
}

// ---------------------------------------------------------------------------
// Flag reasons (auto-moderation heuristics)
// ---------------------------------------------------------------------------
// Reason codes are stable strings used to aggregate admin metrics and matched
// against in tests. Adding a new rule = appending a new code; never repurpose.

export const FLAG_REASONS = [
  "trivial_description",
  "critical_without_evidence",
  "duplicate_within_24h",
  "bot_suspected_dwell_time",
  "bot_suspected_honeypot",
] as const;

export type FlagReason = (typeof FLAG_REASONS)[number];
