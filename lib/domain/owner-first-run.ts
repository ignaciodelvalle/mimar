// Owner first-run detection for /inicio (task #19, owner-process-clarity plan
// Lens 1). Pure and DB-free so it is trivially unit-testable.
//
// The owner home used to show "Todo en orden" (a "you're caught up" message) to
// an owner who had set up NOTHING yet — reassurance where the first-run owner
// needs direction. This deriver tells the page when the owner has no pet to
// manage, and distinguishes the two zero-pet shapes the design proposal
// (2026-07-12-owner-screens-and-pet-profile §1.6) asked us to separate:
//
//   - "fresh"     — the owner has no pets at all (never registered one, or is
//                   brand new). Copy leads with "Cargá tu primera mascota".
//   - "returning" — the owner has pets on record but none is currently active
//                   (e.g. every pet is in memoriam). Copy is softer:
//                   "Tus mascotas activas aparecerán acá".
//
// A "manageable" pet is any non-deceased pet: it appears in the credential
// carousel and the health strip. Deceased pets live only in the In memoriam
// section and never make an owner "not first-run".

/** Null = the owner has at least one manageable (non-deceased) pet, so /inicio
 *  renders its normal structure. Otherwise the zero-pet variant to show. */
export type OwnerFirstRunState = "fresh" | "returning" | null;

/**
 * Derive the first-run state from the owner's pet list (the same
 * `fetchPetsForOwner` rows /inicio already loads — deceased pets included).
 *
 * Note: an owner who transferred every pet away has no current-ownership rows
 * left, so they read as "fresh" here — we deliberately do not run an extra
 * ended-ownership query for that edge case. Flagged for the PO in the task #19
 * report.
 */
export function deriveOwnerFirstRunState(
  pets: ReadonlyArray<{ status: string }>,
): OwnerFirstRunState {
  const hasManageablePet = pets.some((p) => p.status !== "deceased");
  if (hasManageablePet) return null;
  return pets.length === 0 ? "fresh" : "returning";
}
