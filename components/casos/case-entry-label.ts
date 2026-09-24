// caseEntryLabel — the title a case-timeline entry renders under.
//
// The case detail merges two sources into one timeline: `pet_events` (typed
// by the pet EventType catalog, labelled by `eventTypeLabel`) and
// `case_events` (typed by CASE_EVENT_ENTRY_TYPES in db/schema.ts, which that
// map does not know). Titling every row with `eventTypeLabel` gave every
// case_events row an `undefined` title, so an org decline, a titular cancel
// and an operator close all rendered as an untitled card with a note under
// it — the exact surface spec REQ-5 (rehome-by-titular) needs to tell those
// three apart.
//
// `payload.rehome_decision` is written by src/modules/rehome (the case_closed
// entry of a request answer, a titular cancel, a withdraw and its application
// cascade); this is its reader. Pure: no DB, no framework, tested without
// either.

import type { CaseEventEntryType } from "@/db/schema";
import { eventTypeLabel } from "@/lib/utils/format";
import type { EventType } from "@dim/contract/events";

// Exhaustive BY TYPE against CASE_EVENT_ENTRY_TYPES (WU5 review): a fourteenth
// entry type without a title here is a `tsc` error at this line, not a row
// that silently renders the fallback.
const CASE_ENTRY_LABELS = {
  case_opened: "Expediente abierto",
  case_escalated: "Expediente escalado",
  case_closed: "Expediente cerrado",
  reporter_comment: "Comentario de quien denunció",
  finder_tip: "Información de un tercero",
  operator_note: "Nota de la autoridad",
  classification: "Clasificación",
  lab_result: "Resultado de laboratorio",
  control_action: "Acción de control",
  contact_tracing: "Rastreo de contactos",
  final_report: "Informe final",
  signal_link: "Señal vinculada",
  system: "Registro del sistema",
} satisfies Record<CaseEventEntryType, string>;

// The three outcomes a rehome close carries (design ADR-1's table), said as
// WHO decided. `withdrawn` covers the titular's cancel of a pending request,
// the withdraw of a running sponsorship and the application cascade it
// triggers — the note under the title carries the specifics.
const REHOME_DECISION_LABELS: Record<string, string> = {
  accepted: "Solicitud aceptada por la organización",
  declined: "Solicitud rechazada por la organización",
  withdrawn: "Cancelado por el titular",
};

const FALLBACK_LABEL = "Registro en el expediente";

export function caseEntryLabel(eventType: string, payload: unknown): string {
  if (eventType === "case_closed") {
    const decision = (payload as { rehome_decision?: unknown } | null)?.rehome_decision;
    if (typeof decision === "string" && decision in REHOME_DECISION_LABELS) {
      return REHOME_DECISION_LABELS[decision];
    }
  }
  const caseLabel = (CASE_ENTRY_LABELS as Record<string, string | undefined>)[eventType];
  if (caseLabel) return caseLabel;
  // A pet event: the libreta's own label. The map is keyed by EventType, so
  // anything outside both catalogs lands on the fallback rather than on
  // `undefined` or on a raw identifier.
  const petLabel = (eventTypeLabel as (t: string) => string | undefined)(eventType as EventType);
  return petLabel ?? FALLBACK_LABEL;
}
