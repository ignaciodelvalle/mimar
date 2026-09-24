// Quick-capture matcher restriction — atender console (#5).
//
// Reuses the SHARED lib/events/event-capture-matcher.ts verbatim (no fork).
// Atender only signs the 6 event kinds in ./atender-eventos, so a raw
// MatchResult from the owner-flow matcher must be narrowed before it can drive
// the atender surface: most of the matcher's ~14 event types (weight,
// sterilization, symptom, lost/found, management sheets, pregnancy sub-flows…)
// have no atender action and must read as "not recognized here", not silently
// route to the wrong form.
//
// routeOverride matches are ALWAYS rejected: every routeOverride in the shared
// matcher targets an owner-only /mis-mascotas sub-route (embarazo, marcar-
// perdida, compartir-libreta, …) that doesn't exist under atender.

import type { MatchResult } from "@/lib/events/event-capture-matcher";

import type { AtenderEvento } from "./atender-eventos";

/** The only matcher event types atender can sign, mapped to their evento key. */
const EVENT_TYPE_TO_ATENDER_EVENTO: Partial<Record<string, AtenderEvento>> = {
  vaccination_administered: "vacuna",
  deworming_administered: "desparasitacion",
  clinical_info_logged: "cirugia",
  medication_started: "medicacion",
  // Fresh chip placement from the grid/matcher (PO 2026-08-06, Cowork QA v3
  // M3) — "le coloqué un microchip" used to read "No reconocido" even though
  // the shared matcher identified it.
  microchip_implanted: "chip",
  note_added: "nota",
};

export type AtenderCaptureMatch = {
  evento: AtenderEvento;
  slots: Record<string, string>;
  confidence: MatchResult["confidence"];
};

/**
 * Narrows a raw matcher result to atender's clinical vocabulary. Returns null
 * when the match falls outside the 5 signable event types, or carries a
 * routeOverride (an owner-only sub-flow atender has no route for) — the
 * caller shows "no reconocido, elegí un tipo abajo" in both cases.
 */
export function toAtenderCaptureMatch(match: MatchResult | null): AtenderCaptureMatch | null {
  if (!match || match.routeOverride) return null;
  const evento = EVENT_TYPE_TO_ATENDER_EVENTO[match.eventType];
  if (!evento) return null;
  return { evento, slots: match.slots, confidence: match.confidence };
}
