// Visits — domain vocabulary (vet-visit-record, migration 0273).
//
// A visit is OPERATIONAL METADATA (invariant 3), not a fact: it says which
// events one vet wrote for one pet at one organization in one sitting. The
// facts themselves stay in the append-only spine, each stamped with the
// visit's id at insert.

/** Where the care happened. Mirrors the CHECK on visits / service_offerings / appointments. */
export const VISIT_MODALITIES = ["clinic", "home"] as const;
export type VisitModality = (typeof VISIT_MODALITIES)[number];

/**
 * Why a visit stopped being open. Mirrors visits_close_reason_valid.
 *   vet        — the vet closed it ("Terminar atención").
 *   expired    — nobody closed it and it outlived the stale window.
 *   superseded — a newer open visit for the same (pet, org, vet) replaced it.
 */
export const VISIT_CLOSE_REASONS = ["vet", "expired", "superseded"] as const;
export type VisitCloseReason = (typeof VISIT_CLOSE_REASONS)[number];

/**
 * An open visit older than this is closed lazily, as `expired`, the next time
 * anyone asks for an open visit for the same (pet, org, vet). PO default,
 * reversible (design open question); measured against the DATABASE clock.
 */
export const VISIT_STALE_HOURS = 12;

/** The identity an open visit is looked up by. */
export type VisitKey = {
  petId: string;
  organizationId: string;
  vetUserId: string;
};

export type Visit = {
  id: string;
  petId: string;
  organizationId: string;
  /** Null only after the vet's profile was erased (ON DELETE SET NULL). */
  vetUserId: string | null;
  modality: VisitModality;
  appointmentId: string | null;
  openedAt: Date;
  closedAt: Date | null;
  closeReason: VisitCloseReason | null;
};

export function isVisitModality(value: unknown): value is VisitModality {
  return typeof value === "string" && (VISIT_MODALITIES as readonly string[]).includes(value);
}

/** True when `visit` was opened for exactly this (pet, org, vet). */
export function visitMatchesKey(visit: Visit, key: VisitKey): boolean {
  return (
    visit.petId === key.petId &&
    visit.organizationId === key.organizationId &&
    visit.vetUserId === key.vetUserId
  );
}
