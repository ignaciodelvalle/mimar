// What the pet page hands the "Editar datos" sheet — or `null`.
//
// CLIENT PROPS REACH EVERY VIEWER OF THIS ROUTE. The sheet's data is the whole
// `pets` row: the owner's insurance contract and the medical free text among
// it. So it ships to exactly the viewers the edit form admits
// (`canEditPetProfile`, the rule the app's `edit_profile` reads too) and to
// nobody else — `null` is a boundary, not an empty form — and it never carries
// the pet-level emergency contacts, which PetForm does not read (M2
// fresh-review required fix 1: the contacts are the titular's own).
//
// Pure, apart from the page, so the boundary is tested as a boundary.

import type { Pet } from "@/db";
import { canEditPetProfile } from "@/lib/domain/profile-editors";

export type EditPetData = {
  existingPet: Pet;
  existingPhotoUrl: string | null;
  /**
   * Jurisdiction-resolved PPP breed list, so the form's inline "raza peligrosa"
   * warning flags a breed a locality added via the admin console. Display-only.
   */
  pppBreedList: readonly string[];
};

export function editPetDataFor(input: {
  accessPath: "owner" | "org";
  holderRole: string | null;
  pet: Pet;
  existingPhotoUrl: string | null;
  pppBreedList: readonly string[];
}): EditPetData | null {
  if (!canEditPetProfile(input.accessPath, input.holderRole)) return null;
  return {
    existingPet: {
      ...input.pet,
      preferredVetName: null,
      preferredVetPhone: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
    },
    existingPhotoUrl: input.existingPhotoUrl,
    pppBreedList: input.pppBreedList,
  };
}
