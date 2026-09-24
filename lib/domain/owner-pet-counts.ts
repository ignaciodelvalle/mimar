// Splitting "mis mascotas" into the ones that ARE mine and the ones I am
// looking after.
//
// WHY THIS EXISTS. Both the /mis-mascotas list query and `fetchPetsForOwner`
// scope to "any active ownership row, no role filter". That is the right rule
// for the LIST — the whole point of a caretaker arrangement is that the animal
// shows up for the person caring for it — and the wrong one for the COUNT. A
// titular of three pets who accepts one arrangement would read "4 activas"
// under a heading that says "Mis mascotas", and the fourth is somebody else's.
//
// The rule is pure and lives here, not in the page, for two reasons: it can be
// tested without a database, and the wording has one home, so a second surface
// that eventually needs the same split cannot invent a second phrasing.

import { pluralizeEs } from "@/lib/utils/format";

export type OwnerPetCounts = { ownCount: number; caretakerCount: number };

/**
 * Split active ownership rows by whether the viewer is CARETAKING the animal.
 *
 * `foster` and `shelter_custody` count as the viewer's own. That is deliberate:
 * a tránsito is in this person's care in the sense the header means, and those
 * rows already carry their own "En tránsito" badge in the list. Splitting them
 * out too would be a different product decision, and this is not the change
 * that gets to make it.
 */
export function splitOwnerPetCounts(rows: { ownershipRole: string }[]): OwnerPetCounts {
  let caretakerCount = 0;
  for (const row of rows) {
    if (row.ownershipRole === "caretaker") caretakerCount += 1;
  }
  return { ownCount: rows.length - caretakerCount, caretakerCount };
}

/**
 * The header line under "Mis mascotas".
 *
 * Shape depends on whether a second class of pet exists at all:
 *   - no caretaker rows → "3 activas" — today's wording, byte for byte. "N
 *     activas" is only ambiguous once there is something it could be confused
 *     with, and rewording the header for every owner who will never use this
 *     feature is not this change's business.
 *   - with caretaker rows → "3 tuyas · 1 al cuidado" (PO decision 3,
 *     2026-08-19). The sum is never rendered.
 */
export function ownerPetCountLabel(input: {
  ownCount: number;
  caretakerCount: number;
  deceasedCount: number;
}): string {
  const { ownCount, caretakerCount, deceasedCount } = input;
  const parts: string[] = [];

  if (caretakerCount === 0) {
    parts.push(`${ownCount} ${pluralizeEs(ownCount, "activa")}`);
  } else {
    // "0 tuyas" is arithmetically correct and reads as a bug to the person
    // whose only listed animal is one they are caring for. Drop the half that
    // says nothing.
    if (ownCount > 0) parts.push(`${ownCount} ${pluralizeEs(ownCount, "tuya")}`);
    parts.push(`${caretakerCount} al cuidado`);
  }

  if (deceasedCount > 0) parts.push(`${deceasedCount} en memoria`);

  return parts.join(" · ");
}
