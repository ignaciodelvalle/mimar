// Who edits the animal's profile — "Editar datos" (owner-pet-actions, PO
// 2026-10-01: web = app).
//
// ONE rule for every door that enforces it: the web's `updatePetAction` and its
// two forms (the `?sheet=editar-mascota` sheet and `/editar`), and the app's
// `edit_profile` (`canEditProfile` in
// app/api/v1/pets/[publicToken]/profile/payload.ts). It is the owner panel's
// `edit` row as a predicate, and `__tests__/pet-actions-server-gates.test.ts`
// pins the two together for every role the database knows.
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
 * Whether the viewer edits the animal's profile.
 *
 * NARROWER than `isTitularHolder`, and an ALLOW like `canAccessTravel`: the
 * person path in PROFILE_EDITOR_ROLES only. It refuses a caretaker (deny-list
 * row `identity-field-edits`), a user-held shelter_custody row (PO: "a
 * shelter_custody holder does not edit the owner's data on the web either"),
 * any role added later, and the org path, which the panel never offers
 * "Editar datos" and which acts on custody from the org portal. What this
 * edits includes the owner's insurance contract and medical free text.
 *
 * On the web's write, `requireTitularAccess` still runs first: that guard is
 * what scripts/check-titular-gate.ts watches for, and this narrows behind it.
 */
export function canEditPetProfile(
  accessPath: "owner" | "org" | null,
  holderRole: OwnershipRole | string | null,
): boolean {
  return (
    accessPath === "owner" &&
    holderRole !== null &&
    (PROFILE_EDITOR_ROLES as readonly string[]).includes(holderRole)
  );
}
