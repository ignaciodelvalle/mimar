// Who edits the animal's profile — "Editar datos" (owner-pet-actions, PO
// 2026-10-01: web = app).
//
// ONE rule for every door that enforces it: the web's `updatePetAction` and its
// two forms (the `?sheet=editar-mascota` sheet and `/editar`), the app's
// `edit_profile` (`canEditProfile` in
// app/api/v1/pets/[publicToken]/profile/payload.ts), and — since the security
// review of 3babbe25a — `correctPetSpeciesAction` / `CorrectSpeciesPage` and the
// app's `correct_species` (`canCorrectSpecies`, same file). It is the owner
// panel's `edit` row as a predicate, and
// `__tests__/pet-actions-server-gates.test.ts` pins the two together for every
// role the database knows.
//
// PURE, AND HERE RATHER THAN BESIDE THE GUARDS in lib/infra/pet-access.ts: the
// rule has no I/O, and a predicate a test can import without the guards' DB
// client is one a test can check for real instead of mocking a copy of it.

import type { OwnershipRole } from "@/db/schema";

/**
 * The roles that edit the animal's profile. Today the same three as
 * TRAVEL_TITULAR_ROLES, and kept apart on purpose: who reads a household's trips
 * and who corrects an animal's data are different questions that happen to
 * have one answer this year.
 */
export const PROFILE_EDITOR_ROLES = [
  "owner",
  "co_owner",
  "foster",
] as const satisfies readonly OwnershipRole[];

/**
 * Whether the answer of `canEditPetProfile` depends on `petHasTitular` for this
 * holder — true only for a USER-held `shelter_custody` row (the "vecino en
 * tránsito"). Every other holder's answer is fixed by the role alone, so a door
 * reads the titular fact from the database only when this says so.
 */
export function profileEditReadsTitular(
  accessPath: "owner" | "org" | null,
  holderRole: OwnershipRole | string | null,
): boolean {
  return accessPath === "owner" && holderRole === "shelter_custody";
}

/**
 * Whether the viewer edits the animal's profile.
 *
 * NARROWER than `isTitularHolder`, and an ALLOW like `canAccessTravel`: the
 * person path in PROFILE_EDITOR_ROLES, plus ONE conditional holder. It refuses
 * a caretaker (deny-list row `identity-field-edits`), any role added later, and
 * the org path, which the panel never offers "Editar datos" and which acts on
 * custody from the org portal. What this edits includes the owner's insurance
 * contract and medical free text.
 *
 * THE VECINO EN TRÁNSITO (PO decision 2026-10-01). A user-held
 * `shelter_custody` row — a neighbour holding a stray with no known owner —
 * edits the animal's data ONLY WHILE THE ANIMAL HAS NO TITULAR: no live
 * `owner`, `co_owner` or `foster` row, held by anybody. Nobody else can fill
 * the record in. The moment a titular exists (a chip match finds the owner,
 * a transfer lands) the data is the titular's again and the vecino reads it.
 * Before this decision the row was refused outright ("a shelter_custody holder
 * does not edit the owner's data") — which is still the answer whenever there
 * IS an owner whose data it would be.
 *
 * `petHasTitular` is a SERVER fact (`resolvePetHasTitularFact` in
 * lib/infra/pet-access.ts reads the live ownership rows); no door may take it
 * from a client. It is ignored for every holder but the one above.
 *
 * On the web's write, `requireTitularAccess` still runs first: that guard is
 * what scripts/check-titular-gate.ts watches for, and this narrows behind it.
 */
export function canEditPetProfile(
  accessPath: "owner" | "org" | null,
  holderRole: OwnershipRole | string | null,
  petHasTitular: boolean,
): boolean {
  if (accessPath !== "owner" || holderRole === null) return false;
  if ((PROFILE_EDITOR_ROLES as readonly string[]).includes(holderRole)) return true;
  return profileEditReadsTitular(accessPath, holderRole) && !petHasTitular;
}
