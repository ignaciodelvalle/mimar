// What the pet page hands the "Editar datos" sheet — or `null`, a boundary.
//
// Client props reach EVERY viewer of /mis-mascotas/[token]. The edit sheet's
// data is the whole pets row: the owner's insurance contract, the condition
// text, the pet-level emergency contacts. Before owner-pet-actions the page
// shipped it to everybody, a caretaker and an org member included, and relied
// on the form being unreachable. Now it ships to exactly the viewers the form
// admits (`canEditPetProfile`), and never with the contacts PetForm does not
// read (M2 fresh-review required fix 1).

import { describe, expect, it } from "vitest";

import type { Pet } from "@/db";

import { editPetDataFor } from "./edit-pet-data";

const PET = {
  id: "pet-1",
  publicToken: "DIM-PAMP-0001",
  name: "Pampa",
  insuranceCompany: "Sancor Seguros",
  insurancePolicyNumber: "POL-1",
  permanentConditionsOther: "displasia de cadera",
  preferredVetName: "Vet Norte",
  preferredVetPhone: "1122334455",
  emergencyContactName: "Martín",
  emergencyContactPhone: "1199887766",
} as unknown as Pet;

function dataFor(accessPath: "owner" | "org", holderRole: string | null) {
  return editPetDataFor({
    accessPath,
    holderRole,
    pet: PET,
    existingPhotoUrl: "https://x.test/pampa.jpg",
    pppBreedList: ["Pit Bull Terrier"],
  });
}

describe("editPetDataFor — the edit sheet's data only reaches who may save it", () => {
  it.each([
    ["a caretaker", "owner", "caretaker"],
    ["a user-held custody row", "owner", "shelter_custody"],
    ["an organization member", "org", null],
  ] as const)("ships nothing to %s", (_who, accessPath, holderRole) => {
    expect(dataFor(accessPath, holderRole)).toBeNull();
  });

  it.each(["owner", "co_owner", "foster"])("ships the form's data to a %s", (role) => {
    const data = dataFor("owner", role);
    expect(data?.existingPet.insuranceCompany).toBe("Sancor Seguros");
    expect(data?.existingPhotoUrl).toBe("https://x.test/pampa.jpg");
    expect(data?.pppBreedList).toEqual(["Pit Bull Terrier"]);
  });

  it("never carries the pet-level emergency contacts, even to the titular", () => {
    const pet = dataFor("owner", "owner")?.existingPet;
    expect(pet?.preferredVetName).toBeNull();
    expect(pet?.preferredVetPhone).toBeNull();
    expect(pet?.emergencyContactName).toBeNull();
    expect(pet?.emergencyContactPhone).toBeNull();
    // Everything else is the row itself.
    expect(pet?.name).toBe("Pampa");
  });
});
