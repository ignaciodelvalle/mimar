// Pure domain logic for the animal pipeline board (Wave 3 Item 18).
//
// Derives a pipeline column from PetCardData without any DB access.
// The column model is read from the custody states already modeled in the DB
// (ownershipRole + adoptionEligible + adoptionListedAt) — no new states invented.
//
// Pipeline stages (left → right):
//   ingreso       → shelter_custody, adoptionEligible = null  (not yet evaluated)
//   evaluacion    → shelter_custody, adoptionEligible = false (assessed not eligible)
//   disponible    → shelter_custody, adoptionEligible = true, not listed
//   en_adopcion   → shelter_custody, adoptionListedAt != null (listed or paused)
//   transito      → has an active foster row alongside shelter_custody
//   otros         → any other role (owner, co_owner, caretaker) — returned / misc

import type { PetCardData } from "@/app/org/[orgToken]/mascotas/OrgMascotasBulkList";

export type PipelineColumnKey =
  | "ingreso"
  | "evaluacion"
  | "disponible"
  | "en_adopcion"
  | "transito"
  | "otros";

export type PipelineColumn = {
  key: PipelineColumnKey;
  /** Human-readable Spanish label shown in the board header. */
  label: string;
  cards: PetCardData[];
};

/** Ordered list of pipeline columns (display order, left → right). */
export const PIPELINE_COLUMNS: ReadonlyArray<{
  key: PipelineColumnKey;
  label: string;
}> = [
  { key: "ingreso", label: "Ingreso" },
  { key: "evaluacion", label: "Evaluación" },
  { key: "disponible", label: "Disponible" },
  { key: "en_adopcion", label: "En adopción" },
  { key: "transito", label: "Tránsito" },
  { key: "otros", label: "Otros" },
] as const;

/**
 * Derive the pipeline column key for a single pet card.
 *
 * Priority rules:
 *  1. If the card has an active foster row alongside shelter_custody → transito.
 *  2. If ownershipRole is not shelter_custody → otros (owner, co_owner, caretaker).
 *  3. If adoptionListedAt is set → en_adopcion (covers published + paused states).
 *  4. If adoptionEligible is null → ingreso (not yet evaluated).
 *  5. If adoptionEligible is false → evaluacion (assessed, not eligible for adoption).
 *  6. If adoptionEligible is true → disponible (eligible, pending listing).
 */
export function derivePipelineColumn(
  card: PetCardData,
  fosteredPetIds: ReadonlySet<string>,
): PipelineColumnKey {
  // Cards with an active foster always go to "tránsito" regardless of
  // ownershipRole — a foster row sits alongside shelter_custody (AGENTS.md).
  if (fosteredPetIds.has(card.petId)) return "transito";

  if (card.ownershipRole !== "shelter_custody") return "otros";

  if (card.adoptionListedAt !== null) return "en_adopcion";
  if (card.adoptionEligible === null) return "ingreso";
  if (card.adoptionEligible === false) return "evaluacion";
  return "disponible";
}

/**
 * Group a flat list of PetCardData into ordered pipeline columns.
 *
 * Returns one entry per column key in display order, even when empty —
 * the board always renders all columns (empty state per column).
 */
export function groupIntoPipelineColumns(
  cards: PetCardData[],
  fosteredPetIds: ReadonlySet<string>,
): PipelineColumn[] {
  const grouped = new Map<PipelineColumnKey, PetCardData[]>(
    PIPELINE_COLUMNS.map(({ key }) => [key, []]),
  );

  for (const card of cards) {
    const key = derivePipelineColumn(card, fosteredPetIds);
    // Map always has all keys (initialized above); ?. is safe (push is never skipped).
    grouped.get(key)?.push(card);
  }

  return PIPELINE_COLUMNS.map(({ key, label }) => ({
    key,
    label,
    cards: grouped.get(key) ?? [],
  }));
}
