// ---------------------------------------------------------------------------
// Provenance tier — the SHARED "how do we know this?" lens (task #78, 2026-07).
//
// The pet credential answers three DIFFERENT questions about a vaccine, and
// conflating them is what makes a diligent owner read "0 de 4 · DECLARADA" as a
// flat contradiction. They are three legitimate lenses, not one broken number:
//
//   • COMPLIANCE (¿está al día en el registro oficial?) — pet-compliance.ts.
//     "Al día" only when a matriculated professional / accountable institution
//     signed the dose (H1 gate). This is the number the ministry counts.
//   • CURRENCY   (¿la dosis está vigente?) — libreta-health-status.ts.
//     VIGENTE / POR VENCER / VENCIDA, from the dose date + next_due_at. Says
//     nothing about WHO recorded it.
//   • PROVENANCE (¿quién la firmó?) — THIS module. Coarsens the six-tier
//     event-confidence model into the three tiers a citizen actually reads:
//     declarado / verificado / firmado_matricula.
//
// One source of truth so the vaccine surfaces, the panorama "solo verificados"
// toggle, and (later) data-quality all agree by construction on WHICH lens each
// is showing and how a given event maps into the provenance tier.
//
// Pure derivation over existing columns (authorRole / authorVerified /
// authorOrganizationId, or location_source for location events). No schema
// change, no new event type (token ratchet).
// ---------------------------------------------------------------------------

import { type ConfidenceInput, computeConfidence } from "@/lib/events/event-confidence";

/**
 * The three provenance tiers, in ascending order of institutional trust:
 *
 *   declarado          — the owner said so (self-reported / corroborated), or an
 *                        unverified / merely org-recorded event. Not backed by a
 *                        matriculated signature or institutional verification.
 *   verificado         — verified by an accountable institution (govt, a verified
 *                        shelter/org, or an independent lab). Not a personal
 *                        matrícula signature, but more than a declaration.
 *   firmado_matricula  — signed by a veterinarian with a validated matrícula. The
 *                        gold standard the official registry counts as "al día".
 *
 * INVARIANT (tested): an event clears the compliance "al día" gate
 * (pet-compliance.ts clearsObligation) iff its tier is NOT `declarado` — i.e.
 * `verificado` or `firmado_matricula`. This is what keeps the compliance card,
 * the provenance qualifier and the panorama "firmado por matrícula" filter from
 * ever contradicting each other.
 */
export type ProvenanceTier = "declarado" | "verificado" | "firmado_matricula";

/** Ascending trust order — index 0 = lowest. Used by isAtLeastProvenance. */
export const PROVENANCE_ORDER: ReadonlyArray<ProvenanceTier> = [
  "declarado",
  "verificado",
  "firmado_matricula",
];

/**
 * Location-event provenance source (`payload.location_source`). A device GPS fix
 * or an address geocode is instrument-derived → `verificado`; a hand-dropped pin
 * is a human assertion → `declarado`. Location events never carry a matrícula, so
 * they never reach `firmado_matricula`.
 */
export type LocationSource = "gps" | "pin_manual" | "geocodificada";

/** Minimal event shape provenanceTier reads — a superset of ConfidenceInput plus
 *  the optional location_source used for location-type events. Decoupled from the
 *  DB row so the module stays trivially table-testable. */
export type ProvenanceEvent = {
  authorRole?: string | null;
  authorVerified?: boolean | null;
  authorOrganizationId?: string | null;
  payload?: Record<string, unknown> | null;
};

/**
 * Coarsen the six-tier event-confidence model into the three provenance tiers.
 *
 *   professional_verified                         → firmado_matricula
 *   institutional_verified                        → verificado
 *   org_registered | corroborated |
 *   self_reported | unverified                    → declarado
 *
 * org_registered maps to `declarado` on purpose: a shelter member WITHOUT a
 * validated matrícula recorded it — a valid record, but the compliance gate does
 * not clear on it, so the provenance lens must not claim it is "verificado"
 * either (keeps the INVARIANT above true).
 */
function tierFromConfidence(input: ConfidenceInput): ProvenanceTier {
  const confidence = computeConfidence(input);
  if (confidence === "professional_verified") return "firmado_matricula";
  if (confidence === "institutional_verified") return "verificado";
  return "declarado";
}

/**
 * Map a location_source to a provenance tier. Instrument-derived positions
 * (GPS / geocoded address) are `verificado`; a manually dropped pin is
 * `declarado`. Unknown / missing source → `declarado` (conservative default).
 */
export function provenanceTierFromLocationSource(
  source: string | null | undefined,
): ProvenanceTier {
  if (source === "gps" || source === "geocodificada") return "verificado";
  return "declarado";
}

/**
 * The provenance tier of a pet event.
 *
 * For a location-type event pass `{ location: true }` to read `location_source`
 * from the payload instead of the author fields; for every other event the tier
 * is derived from the author's role / verification (via the shared
 * event-confidence model).
 */
export function provenanceTier(
  event: ProvenanceEvent,
  opts: { location?: boolean } = {},
): ProvenanceTier {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  if (opts.location) {
    const source = typeof payload.location_source === "string" ? payload.location_source : null;
    return provenanceTierFromLocationSource(source);
  }

  return tierFromConfidence({
    authorRole: event.authorRole ?? "",
    authorVerified: event.authorVerified ?? false,
    authorOrganizationId: event.authorOrganizationId ?? null,
    payload,
  });
}

/** True when `tier` is at least as trusted as `minimum` (order-index compare). */
export function isAtLeastProvenance(tier: ProvenanceTier, minimum: ProvenanceTier): boolean {
  return PROVENANCE_ORDER.indexOf(tier) >= PROVENANCE_ORDER.indexOf(minimum);
}

/**
 * es-AR label for a provenance tier — descriptive, never judgmental (mirrors the
 * event-confidence label policy). Describes the SOURCE, not a "confidence level".
 */
export function provenanceTierLabel(tier: ProvenanceTier): string {
  switch (tier) {
    case "firmado_matricula":
      return "Firmada por veterinario matriculado";
    case "verificado":
      return "Verificada institucionalmente";
    case "declarado":
      return "Declarada por el titular";
  }
}

/**
 * Short es-AR chip label (fits a badge). Same tiers, tighter copy.
 */
export function provenanceTierChip(tier: ProvenanceTier): string {
  switch (tier) {
    case "firmado_matricula":
      return "Firmada por matrícula";
    case "verificado":
      return "Verificada";
    case "declarado":
      return "Declarada";
  }
}

/**
 * The three vaccine lenses named in es-AR — a shared vocabulary so every surface
 * states WHICH question it is answering (consistent-by-construction, task #78).
 * `name` is the short badge word; `question` the plain-language framing; `note`
 * the one-line clarification that keeps a lens from being mistaken for another.
 */
export const VACCINE_LENS = {
  compliance: {
    name: "Al día",
    question: "¿Está al día en el registro oficial?",
    note: "Requiere la firma de un veterinario matriculado.",
  },
  currency: {
    name: "Vigente",
    question: "¿La dosis sigue vigente?",
    note: "Vigencia de la dosis. No equivale a estar “al día” en el registro oficial.",
  },
  provenance: {
    name: "Origen",
    question: "¿Quién la firmó?",
    note: "Quién registró la dosis: el titular, una institución o un veterinario matriculado.",
  },
} as const;
