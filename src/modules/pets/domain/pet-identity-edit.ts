// Composing a `ParsedPet` for a NARROW identity edit — the three fields the
// native "Editar datos" screen offered before owner-pet-actions, laid over
// everything the animal already has. Installed builds still send it
// (`edit_identity`), so it stays.
//
// SINCE owner-pet-actions (2026-10-01) THIS IS THE IDENTITY SECTION OF
// `composePetProfileEdit` (`pet-profile-edit.ts`), with the sex and the birth
// date carried over as stored: one composer, so the two commands cannot drift
// into carrying the untouched fields differently. The reasoning below is still
// the reason both exist.
//
// WHY THIS EXISTS AT ALL, AND WHY IT IS NOT "JUST BUILD THE OBJECT INLINE"
// ---------------------------------------------------------------------------
// `PetsRepository.updatePetProfile` writes SEVENTEEN columns from `parsed` in
// one `SET`, unconditionally. It is a whole-row writer, because the only caller
// it ever had is a whole-form `<form>` whose every field is present on every
// submit. A JSON endpoint that edits three fields therefore cannot hand it three
// fields: a `ParsedPet` assembled from the request alone would null
// `estimatedWeightKg`, `favouriteFoods`, `knownAllergies`, `trainingLevel`,
// `insuranceCompany`, `insurancePolicyNumber`, `acquisitionMethod`,
// `permanentConditions` and `permanentConditionsOther`, and flip
// `emergencyInfoVisible` and `discloseConditionsPublicly` off — silently, with a
// 200, and with a `pet_profile_updated` event faithfully recording the wipe as
// if somebody had asked for it.
//
// So the composition is the whole job, it is pure, and it is HERE rather than
// inline in the route so it can be tested against that exact failure. The test
// beside this file asserts the identity of every field the caller did not name.
//
// WHAT IS DELIBERATELY NOT CARRIED OVER
// ---------------------------------------------------------------------------
//   · THE MICROCHIP fields, all five, are `null`. They are legacy `pets.*`
//     columns that `updatePetProfile` no longer writes (ARCH-S — canonical chip
//     data lives in `pet_identifications`), and they feed exactly one live
//     decision: `isChipNewlyAdded`, which with a null `microchipId` answers
//     false and appends no `microchip_implanted`. That is correct for this
//     endpoint: it does not edit chips, and a chip is added through its own path.
//   · `localityId` is omitted, not nulled. It is optional on `ParsedPet` and
//     `updatePetProfile` never writes it — jurisdiction is FULL-LOCK on the
//     profile-edit path (PO decision #40) — so passing anything would be
//     stating a value that has no writer to read it.
//   · SPECIES is carried but not editable. It is in `ParsedPet` because the type
//     has it; the repository's `SET` omits the column entirely, and every
//     downstream gate (the breed catalog, the PPP classification) is fed from
//     the PERSISTED species by the caller, never from here. That asymmetry is
//     the fix for the 2026-08-14 adversarial finding on `updatePetAction`, and
//     this endpoint inherits it by construction: there is no request field that
//     could disagree with the stored species in the first place.
//   · `custodyKind` IS A CONSTANT, and unlike `localityId` it cannot be omitted:
//     `ParsedPet` requires it. `"owner"` is inert rather than a claim — the only
//     reader of the field is `insertPetRegistered`, which turns it into the
//     ownerships ROLE and the `pet_registered` payload on the CREATE path.
//     `updatePetProfile` never touches it, `diffPet` has no such field, and no
//     value here could reach a column or an event. It is `"owner"` and not
//     `"foster_in_transit"` because a constant with no reader should be the one
//     that is true of most animals, not the one that is unusual. The snapshot
//     deliberately does not carry the pet's real custody: doing so would imply
//     this door decides something about it, and it decides nothing.

import { type EditablePetSnapshot, composePetProfileEdit } from "./pet-profile-edit";
import type { ParsedPet } from "./types";

/** Defined beside the general composer; re-exported for this file's importers. */
export type { EditablePetSnapshot };

/** The three fields the old native screen edits. Trimming happened in the schema. */
export type PetIdentityEdit = {
  name: string;
  breed: string | null;
  color: string | null;
};

/**
 * Overlay a three-field edit on the animal's current state: the identity
 * section of `composePetProfileEdit`, with the sex and the birth date exactly as
 * stored and every other section left alone.
 *
 * `permanentConditions` is carried, not re-validated — an unknown code (a row
 * written before a catalog entry was renamed, say) silently DROPPED by an
 * unrelated name edit is the same class of quiet data loss this whole file
 * exists to prevent. The general composer leaves an unedited section untouched,
 * so that holds by construction.
 */
export function composePetIdentityEdit(
  existing: EditablePetSnapshot,
  edit: PetIdentityEdit,
): ParsedPet {
  return composePetProfileEdit(existing, {
    identity: {
      name: edit.name,
      breed: edit.breed,
      color: edit.color,
      sex: existing.sex,
      dateOfBirth: existing.dateOfBirth,
      birthDateIsEstimated: existing.birthDateIsEstimated,
    },
    health: null,
    publicCredential: null,
    insurance: null,
    origin: null,
  });
}
