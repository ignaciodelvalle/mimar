// Libreta sanitaria — projection over pet_events filtered to medical entries.
//
// Confidence tier integration (2026-05-22):
// libretaConfidenceTier() derives the trustworthiness of an event from its
// provenance fields. Pure function — no DB calls, computed on read.
//
// Canonical source of truth: AGENTS.md → "Libreta sanitaria".
//
// Every new EventType added to db/schema.ts → EVENT_TYPES must explicitly
// declare whether it belongs to the libreta. The test in
// lib/libreta-sanitaria.test.ts will fail if a new EventType is not
// classified (either listed below as part of the libreta, or listed in
// NON_LIBRETA_EVENT_TYPES as deliberate exclusion).

import { sql } from "drizzle-orm";

import type { EventType } from "@/db/schema";
import { type ConfidenceTier, computeConfidence } from "@/lib/events/event-confidence";

// Event types that are part of the dueño's libreta sanitaria — the medical
// record the vet writes and the dueño carries. Surfaces: pet profile section,
// the dedicated /libreta route in Parte B, and the shareable Tier-2 route in
// Parte C.
export const LIBRETA_SANITARIA_EVENT_TYPES = [
  "vaccination_administered",
  "deworming_administered",
  "sterilization_performed",
  "medication_started",
  "medication_stopped",
  "medication_dose_taken",
  "vet_visit_logged",
  "weight_recorded",
  "clinical_info_logged",
  "microchip_implanted",
  // Microchip lifecycle beyond the initial implant — replacement
  // (and revocation, via new_chip_number=null) is identificatoria
  // info the vet/owner care about.
  "microchip_replaced",
  // Tattoo lifecycle — secondary identifier (D1-D4 closed 2026-05-22).
  // Same rationale as microchip: identificatoria info the vet/owner track.
  "tattoo_recorded",
  "tattoo_updated",
  "incident_reported",
  // Rabies observation lifecycle — clinical record (the vet of the future
  // wants to see "this dog bit someone in 2026 and completed observation
  // negative"). Both events emit atomically with their incident_reported.
  "rabies_observation_started",
  "rabies_observation_ended",
  "symptom_observed",
  "death_recorded",
] as const satisfies readonly EventType[];

// Event types deliberately OUTSIDE the libreta sanitaria — identity / admin /
// custody / welfare / system entries. Exhaustive together with
// LIBRETA_SANITARIA_EVENT_TYPES: every EVENT_TYPES value must appear in
// exactly one of the two.
export const NON_LIBRETA_EVENT_TYPES = [
  "pet_registered",
  "pet_profile_updated",
  "status_changed",
  "credential_scanned",
  "dangerous_breed_attested",
  "custody_transferred",
  "ownership_claimed",
  "shelter_intake_recorded",
  "foster_assigned",
  "foster_ended",
  "adoption_application_submitted",
  "adoption_application_resolved",
  "adoption_finalized",
  "post_adoption_checkin",
  "adoption_reversed",
  "abandonment_reported",
  "maltreatment_reported",
  "note_added",
  // Lost & Found — custody proposal/cancellation events (Fase 5 + ARCH-B). Not medical entries.
  "custody_transfer_proposed",
  "custody_transfer_cancelled",
  // Custody disputes — external legal proceedings flagged by admin/govt.
  // Not pet medical history.
  "custody_dispute_raised",
  "custody_dispute_resolved",
  // Foster volunteers pool — proposal lifecycle telemetry, NOT clinical.
  "foster_proposed",
  "foster_proposal_resolved",
  "foster_co_foster_allowed",
  // Adoption eligibility flag — operational state of the pet, not clinical.
  "adoption_eligibility_set",
  // Surveillance — system signal, not pet medical history. Owner must not see this
  // in their libreta (per spec D1: owner sees no disease names).
  "outbreak_signal",
  // Govt-side disease surveillance entry. Owner-visible only when payload says so
  // (D1 stigma model) and never as part of the libreta proper.
  "disease_reported",
  // Correction by amendment — principle #2 / Wave 2 Item 15 (2026-06-19).
  // The amendment event is a correction pointer, not a clinical entry. The
  // PROJECTION (libreta view) applies the latest amendment to the original
  // event's display value; this event_type itself is an admin/audit artifact.
  "event_amended",
  // Jurisdictional mobility (movilidad Fase 1) — administrative movement
  // context (jurisdiction change / foreign CVI fact / trip), not pet medical
  // history. Powers /viaje, not the libreta.
  "movement_recorded",
  // Physical tag (chapa) lifecycle — credential plumbing (link/unlink of a
  // QR chapa), not sanitary history. Powers /cuenta/chapas, not the libreta.
  "tag_activated",
  "tag_revoked",
  // Temporary caretaker (custodia-temporal, 0189) — WHO was looking after the
  // animal, not WHAT was done to it. The clinical events a caretaker records
  // are already in the libreta on their own merits, signed with the caretaker
  // as author; the arrangement itself is custody context, and putting it in a
  // sanitary record a vet or an inspector reads would say nothing medical.
  "caretaker_designated",
  "caretaker_ended",
  // Rehome sponsorship (rehome-by-titular) — WHO is accompanying the adoption
  // of the animal, not WHAT was done to it. Same reasoning as the caretaker
  // pair above: a vet or an inspector reading the libreta learns nothing
  // medical from an arrangement between a family and a shelter.
  "rehome_sponsorship_started",
  "rehome_sponsorship_ended",
  // Content moderation — a holder objecting to a stranger's message about their
  // animal. A vet or an inspector reading the libreta learns nothing medical
  // from it, and the libreta is the one surface where an unrelated entry costs
  // real credibility: it is read as a health record.
  "content_reported",
] as const satisfies readonly EventType[];

const LIBRETA_SET: ReadonlySet<string> = new Set(LIBRETA_SANITARIA_EVENT_TYPES);

export function isLibretaSanitariaEvent(eventType: string): boolean {
  return LIBRETA_SET.has(eventType);
}

// Drizzle SQL clause that restricts a pet_events query to libreta entries
// only. Use inside an `and(...)` WHERE clause. Postgres handles ANY() on an
// array literal efficiently; event_type is indexed.
//
// Example:
//   const events = await db
//     .select()
//     .from(petEvents)
//     .where(and(eq(petEvents.petId, pet.id), libretaSanitariaClause()))
//     .orderBy(desc(petEvents.occurredAt));
export function libretaSanitariaClause() {
  const typesArray = `{${LIBRETA_SANITARIA_EVENT_TYPES.join(",")}}`;
  return sql`event_type = ANY(${typesArray}::text[])`;
}

// Filter chips for the EventTimeline when mounted in a libreta context.
// Co-located here so the libreta-specific subset travels with the concept.
// Chips remain per-event-type (one chip = one row narrowing) — they are
// NOT the same axis as LIBRETA_GROUPS, which collapses several event types
// into a single section in the /libreta view.
export const LIBRETA_FILTER_CHIPS: ReadonlyArray<{ type: EventType; label: string }> = [
  { type: "vaccination_administered", label: "Vacunas" },
  { type: "deworming_administered", label: "Antiparasitarios" },
  { type: "sterilization_performed", label: "Esterilización" },
  { type: "vet_visit_logged", label: "Visitas" },
  { type: "weight_recorded", label: "Peso" },
  { type: "medication_started", label: "Medicación · inicio" },
  { type: "medication_stopped", label: "Medicación · fin" },
  { type: "medication_dose_taken", label: "Dosis dadas" },
  { type: "microchip_implanted", label: "Microchip" },
  { type: "tattoo_recorded", label: "Tatuaje" },
  { type: "clinical_info_logged", label: "Información clínica" },
  { type: "symptom_observed", label: "Síntomas" },
  { type: "incident_reported", label: "Mordeduras" },
  { type: "death_recorded", label: "Fallecimiento" },
];

export type LibretaChipCount = { type: string; label: string; count: number };

/**
 * Chip descriptors that have AT LEAST ONE matching row, in the order declared
 * by `chips` (LIBRETA_FILTER_CHIPS by default). A chip that would filter to
 * nothing is a dead control, so it is dropped here rather than rendered
 * disabled — and because the chips are derived from the very rows they will
 * filter, no selection can ever resolve to an empty feed.
 *
 * Pure: no query, no fetch. Every libreta/historial row already carries
 * `eventType` (HistorialEventRow), so the counts come free with the page load.
 */
export function libretaChipCounts(
  rows: ReadonlyArray<{ eventType: string }>,
  chips: ReadonlyArray<{ type: string; label: string }> = LIBRETA_FILTER_CHIPS,
): LibretaChipCount[] {
  const countsByType = new Map<string, number>();
  for (const row of rows) {
    countsByType.set(row.eventType, (countsByType.get(row.eventType) ?? 0) + 1);
  }
  return chips
    .map((chip) => ({
      type: chip.type,
      label: chip.label,
      count: countsByType.get(chip.type) ?? 0,
    }))
    .filter((chip) => chip.count > 0);
}

// Logical groups that the libreta is presented as in the /libreta view. The
// order here is the display order.
//
// Consolidated 2026-05-26 from 14 to 11 groups: esterilización folded into
// cirugías (it IS a surgery); microchip + tatuaje merged into identificación
// (the owner thinks "identify the pet", not chip vs tattoo); incidentes
// renamed to mordeduras_observacion to reflect its actual content (bite +
// 10-day rabies observation lifecycle, the legal flow); alergias removed as
// a group — those events route through estudios and the persistent
// condition list lives in the dashboard at the top of /libreta.
export const LIBRETA_GROUPS = [
  "vacunas",
  "antiparasitarios",
  "cirugias",
  "visitas",
  "estudios",
  "sintomas",
  "medicacion",
  "peso",
  "identificacion",
  "mordeduras_observacion",
  "fallecimiento",
] as const;

export type LibretaGroupKey = (typeof LIBRETA_GROUPS)[number];

export const LIBRETA_GROUP_LABELS: Record<LibretaGroupKey, string> = {
  vacunas: "Vacunación",
  antiparasitarios: "Antiparasitarios",
  cirugias: "Cirugías",
  visitas: "Visitas al veterinario",
  estudios: "Estudios e información clínica",
  sintomas: "Síntomas",
  medicacion: "Medicación",
  peso: "Peso",
  identificacion: "Identificación (chip y tatuaje)",
  mordeduras_observacion: "Mordeduras y observación antirrábica",
  fallecimiento: "Fallecimiento",
};

// Map an event row to its libreta group, or null if it doesn't belong.
// clinical_info_logged subdivides via payload.sub_kind so the unified event
// surfaces in the right conceptual group.
export function libretaGroupForEvent(event: {
  eventType: string;
  payload: unknown;
}): LibretaGroupKey | null {
  switch (event.eventType) {
    case "vaccination_administered":
      return "vacunas";
    case "deworming_administered":
      return "antiparasitarios";
    case "sterilization_performed":
      // Castración / ovariectomía is a surgery — surfaces under "Cirugías"
      // alongside other clinical_info_logged{sub_kind:'surgery'} events.
      return "cirugias";
    case "vet_visit_logged":
      return "visitas";
    case "medication_started":
    case "medication_stopped":
    case "medication_dose_taken":
      return "medicacion";
    case "weight_recorded":
      return "peso";
    case "microchip_implanted":
    case "microchip_replaced":
    case "tattoo_recorded":
    case "tattoo_updated":
      // Both identifiers live under a single "Identificación" section so the
      // owner sees one block for "how this pet is identified".
      return "identificacion";
    case "symptom_observed":
      return "sintomas";
    case "incident_reported":
    case "rabies_observation_started":
    case "rabies_observation_ended":
      // The 10-day rabies observation is the mandated legal follow-up to
      // an incident_reported (bite). Grouping together keeps the bite +
      // observation lifecycle visible as one block.
      return "mordeduras_observacion";
    case "death_recorded":
      return "fallecimiento";
  }

  if (event.eventType === "clinical_info_logged") {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const sub = typeof p.sub_kind === "string" ? p.sub_kind : null;
    switch (sub) {
      case "surgery":
        return "cirugias";
      case "lab_work":
      case "imaging":
      case "allergy_detection":
      case "other":
        // allergy_detection used to have its own "alergias" group; the
        // dashboard at the top of /libreta now surfaces persistent
        // conditions, so individual allergy_detection events route
        // through "Estudios e información clínica" alongside lab work
        // and imaging.
        return "estudios";
      // Safe default — keeps a future sub_kind visible until classified.
      default:
        return "estudios";
    }
  }

  return null;
}

// Group an array of pet events by libreta group, preserving insertion order
// within each group (caller is expected to pass events already sorted by
// occurredAt desc). Events without a group are silently dropped — the caller
// should already have filtered to libreta types, but defense in depth is
// cheap.
export function groupLibretaEvents<E extends { eventType: string; payload: unknown }>(
  events: readonly E[],
): Record<LibretaGroupKey, E[]> {
  const groups = Object.fromEntries(LIBRETA_GROUPS.map((g) => [g, [] as E[]])) as Record<
    LibretaGroupKey,
    E[]
  >;
  for (const event of events) {
    const g = libretaGroupForEvent(event);
    if (g !== null) groups[g].push(event);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Confidence tier helper for libreta entries
// ---------------------------------------------------------------------------

/**
 * Derives the confidence tier for a single libreta event row.
 * Thin wrapper over computeConfidence() that accepts the raw event
 * provenance fields — callers don't need to import event-confidence directly.
 */
export function libretaConfidenceTier(event: {
  authorRole: string;
  authorVerified: boolean;
  authorOrganizationId: string | null;
  payload: Record<string, unknown>;
}): ConfidenceTier {
  return computeConfidence(event);
}

// Re-export ConfidenceTier so consumers of libreta-sanitaria don't need to
// import from event-confidence separately.
export type { ConfidenceTier };
