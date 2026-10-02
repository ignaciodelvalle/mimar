// Wire key → column → privacy class, for the block "Editar datos" pre-fills
// (owner-pet-actions, plan step 4).
//
// THE CLAIM UNDER TEST is the one `PetProfileDraftV1` makes about itself in
// packages/contract/src/api/pet-profile-edit.ts: every key is its column's
// name, camelCased, and nothing else, so a wire key INHERITS the privacy class
// of the column it carries. A key named after anything but its column would make
// that inheritance a matter of opinion, and the block carries the owner's
// insurance contract and a free-text medical description.
//
// DERIVED FROM THE THINGS THEMSELVES, not from a list of keys: the keys are read
// off a payload the real builder produced, the columns off the drizzle model,
// and the classes off the erasure map (`lib/events/payload-privacy.ts`) that
// `lint:subject-rights` holds equal to the database. A key added to the block
// tomorrow is judged tomorrow, without anyone remembering to add it here.
//
// Offline: the builder is pure and getTableColumns reads the model.

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  type ProfilePetRow,
  type ResolvedProfileAccess,
  buildPetProfileEditV1,
} from "@/app/api/v1/pets/[publicToken]/profile/payload";
import { pets } from "@/db/schema";
import {
  PAYLOAD_PRIVACY,
  PROFILE_CHANGE_FIELD_PRIVACY,
  type PrivacyEntry,
} from "@/lib/events/payload-privacy";

/**
 * Columns the block carries that NO event payload ever records, so the erasure
 * map has nothing to say about them. Pinned with the reason, and refused once
 * stale: a column that gains an event class must leave this list.
 */
const NOT_IN_ANY_EVENT: Readonly<Record<string, string>> = {
  emergency_info_visible:
    "A display preference, not a fact about the animal: diffPet leaves it out and updatePet writes it without an entry, so no payload holds it.",
};

/** The keys whose column is the person's, not the animal's. Pinned on purpose. */
const PERSONAL_KEYS = ["insuranceCompany", "insurancePolicyNumber", "permanentConditionsOther"];

/** Every column a write can fill, with real values — so a key can be measured. */
const ROW: ProfilePetRow = {
  publicToken: "DIM-PAMP-0001",
  species: "dog",
  name: "Pampa",
  breed: "Caniche",
  color: "Atigrada",
  preferredVetName: "Vet Norte",
  preferredVetPhone: "1122334455",
  emergencyContactName: "Martín",
  emergencyContactPhone: "1199887766",
  sex: "female",
  dateOfBirth: "2021-03-04",
  birthDateIsEstimated: false,
  favouriteFoods: ["Dieta casera"],
  knownAllergies: ["Pollo"],
  trainingLevel: "basic",
  permanentConditions: ["ciego", "otra"],
  permanentConditionsOther: "displasia de cadera",
  emergencyInfoVisible: true,
  discloseConditionsPublicly: true,
  insuranceCompany: "Sancor Seguros",
  insurancePolicyNumber: "POL-1",
  acquisitionMethod: "adopted",
};

/** The access record, with only what the capabilities read. */
function access(kind: "owner" | "org", holderRole: string | null): ResolvedProfileAccess {
  return { kind, holderRole, pet: { status: "active" } } as unknown as ResolvedProfileAccess;
}

function payloadFor(viewer: ResolvedProfileAccess, petHasTitular = true) {
  return buildPetProfileEditV1({
    pet: ROW,
    access: viewer,
    accountContacts: null,
    physicalTagInterest: null,
    serviceDog: null,
    petHasTitular,
    now: new Date("2026-10-01T12:00:00Z"),
  });
}

/** `insuranceCompany` → `insurance_company`. */
function snake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** The column each drizzle property writes, read off the model. */
const COLUMN_OF: Record<string, string> = Object.fromEntries(
  Object.entries(getTableColumns(pets)).map(([property, column]) => [property, column.name]),
);

type ColumnClass = PrivacyEntry["class"] | "not_in_any_event";

/**
 * A column's class: the class its changelog values take, else the class the
 * registration payload gives it, else the pinned no-event list. `null` when
 * nothing classifies it — the failure this file exists for.
 */
function classOf(column: string): ColumnClass | null {
  const entry = PROFILE_CHANGE_FIELD_PRIVACY[column] ?? PAYLOAD_PRIVACY.pet_registered[column];
  if (entry) return entry.class;
  return column in NOT_IN_ANY_EVENT ? "not_in_any_event" : null;
}

const ownerBlock = payloadFor(access("owner", "owner")).profile;
const wireKeys = Object.keys(ownerBlock ?? {});

describe("the profile block — wire key, column, privacy class", () => {
  it("is served to the owner, with more keys than a broken read would have", () => {
    expect(ownerBlock).not.toBeNull();
    expect(wireKeys.length).toBeGreaterThanOrEqual(10);
  });

  it("names every key after a real pets column, camelCased — no key without a column", () => {
    const misnamed = wireKeys.filter((key) => COLUMN_OF[key] !== snake(key));
    expect(misnamed, "wire keys whose column is not `pets.<snake_case of the key>`").toEqual([]);
  });

  it("gives every key a privacy class through its column", () => {
    const unclassified = wireKeys.filter((key) => classOf(snake(key)) === null);
    expect(
      unclassified,
      "a key whose column the erasure map does not classify: classify the column in lib/events/payload-privacy.ts, or pin it in NOT_IN_ANY_EVENT with the reason",
    ).toEqual([]);
  });

  it("carries personal data in exactly three keys: the insurance contract and the condition text", () => {
    const personal = wireKeys.filter((key) => classOf(snake(key)) === "personal_data");
    expect(personal.sort()).toEqual([...PERSONAL_KEYS].sort());
  });

  it("keeps the no-event list live — every entry still names a block column no event classifies", () => {
    for (const column of Object.keys(NOT_IN_ANY_EVENT)) {
      expect(wireKeys.map(snake)).toContain(column);
      expect(PROFILE_CHANGE_FIELD_PRIVACY[column] ?? PAYLOAD_PRIVACY.pet_registered[column]).toBe(
        undefined,
      );
    }
  });
});

describe("the profile block — personal data only under the capability", () => {
  it("reaches the owner, a co-owner and a foster: the viewers the panel lets edit", () => {
    for (const viewer of [
      access("owner", "owner"),
      access("owner", "co_owner"),
      access("owner", "foster"),
    ]) {
      const json = JSON.stringify(payloadFor(viewer));
      for (const key of PERSONAL_KEYS) expect(json).toContain(`"${key}"`);
    }
  });

  it("reaches the vecino en tránsito only while the animal has no titular", () => {
    const vecino = access("owner", "shelter_custody");
    const json = JSON.stringify(payloadFor(vecino, false));
    for (const key of PERSONAL_KEYS) expect(json).toContain(`"${key}"`);
    // The fact opens nobody else's door.
    for (const viewer of [access("owner", "caretaker"), access("org", null)]) {
      const other = JSON.stringify(payloadFor(viewer, false));
      for (const key of PERSONAL_KEYS) expect(other).not.toContain(`"${key}"`);
    }
  });

  it("appears NOWHERE in the payload a caretaker, a user-held custody row on an animal with a titular or the org path reads", () => {
    for (const viewer of [
      access("owner", "caretaker"),
      access("owner", "shelter_custody"),
      access("org", null),
    ]) {
      const json = JSON.stringify(payloadFor(viewer));
      for (const key of PERSONAL_KEYS) expect(json).not.toContain(`"${key}"`);
      // The VALUES too, not only the key names: a value under another key is
      // the same leak.
      expect(json).not.toContain(ROW.insuranceCompany as string);
      expect(json).not.toContain(ROW.permanentConditionsOther as string);
    }
  });
});
