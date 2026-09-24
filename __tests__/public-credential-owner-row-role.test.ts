// The public lost credential must resolve the TITULAR, never whoever the heap
// hands back first.
//
// THE DEFECT THIS PINS. `ownerships` holds MORE THAN ONE active row per pet.
// The partial unique index caps active `owner` rows at one and active
// `caretaker` rows at one — separately — so an owned pet with an accepted
// temporary-caretaker grant legitimately has two rows with `ended_at IS NULL`.
// loadCredentialViewData's owner query filtered only on (pet_id, ended_at IS
// NULL) and took `limit(1)` with no ordering, so which of the two rows won was
// whatever the plan happened to emit first.
//
// WHY THAT IS A PRIVACY BUG AND NOT A COSMETIC ONE. That row's `display_name`
// and `phone` are what the lost credential publishes to anyone who scans the
// QR, gated by the TITULAR's `disclose_phone_when_lost` /
// `disclose_first_name_when_lost`. Resolving the caretaker row means the
// titular's consent publishes a THIRD PARTY's phone number and first name. The
// two-key model in lib/infra/caretaker-public-contact.ts exists precisely
// because the titular cannot consent on the caretaker's behalf — and this query
// walked around it. Measured on staging: the single pet holding both an active
// owner and an active caretaker row resolved to the caretaker. It failed safe
// there only by accident, because that caretaker's phone happened to be NULL.
//
// HOW THIS TEST FORCES THE FAILURE DETERMINISTICALLY. The caretaker ownership
// row is inserted BEFORE the owner row, so the pre-fix query — index scan on
// (pet_id), ties broken by physical order — returns the caretaker first. The
// caretaker is given a phone and a name that differ from the titular's in every
// character, so a wrong row cannot coincidentally assert green. Verified RED
// against the unfixed loader before the fix landed.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Pet, db, ownerships, pets, profiles } from "@/db";
import { loadCredentialViewData } from "@/src/modules/pets/application/read/load-public-credential";

const PET_TOKEN = "DIM-OWNR-0001";
const TITULAR_ID = "0cae7a14-5555-4000-8000-000000000001";
const CARETAKER_ID = "0cae7a14-5555-4000-8000-000000000002";

const TITULAR_PHONE = "+541155551111";
const CARETAKER_PHONE = "+541155552222";

let pet: Pet;

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM ownerships WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await db.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  await db.execute(
    sql`DELETE FROM profiles WHERE id IN (${TITULAR_ID}::uuid, ${CARETAKER_ID}::uuid)`,
  );
}

beforeAll(async () => {
  await cleanup();
  await db.insert(profiles).values([
    { id: TITULAR_ID, displayName: "Ignacio Del Valle", role: "owner", phone: TITULAR_PHONE },
    { id: CARETAKER_ID, displayName: "Ana Pérez López", role: "owner", phone: CARETAKER_PHONE },
  ]);
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Pampa Titular",
      species: "dog",
      status: "lost",
      // The titular's own disclosure keys. These are the ONLY consents in play;
      // the caretaker has given none.
      discloseFirstNameWhenLost: true,
      disclosePhoneWhenLost: true,
    })
    .returning();
  pet = row;

  // Order matters — see the header. Caretaker first, so the unfixed query's
  // limit(1) lands on the wrong row.
  await db
    .insert(ownerships)
    .values({ petId: pet.id, ownerUserId: CARETAKER_ID, role: "caretaker" });
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: TITULAR_ID, role: "owner" });
});

afterAll(async () => {
  await cleanup();
});

describe("loadCredentialViewData — the owner row is the OWNER's row", () => {
  it("publishes the titular's first name and phone, not the active caretaker's", async () => {
    const data = await loadCredentialViewData(pet);

    expect(data.lostContext).not.toBeNull();
    // First name only — a public credential never carries a full legal name.
    expect(data.lostContext?.ownerFirstName).toBe("Ignacio");
    expect(data.lostContext?.phone).toBe(TITULAR_PHONE);
  });

  it("never lets the caretaker's contact reach the public payload through the owner slot", async () => {
    // Stated separately from the assertion above on purpose. The first test says
    // "the right person"; this one says "not the wrong one" — the caretaker's
    // details must be absent from the disclosed contact whether or not the
    // titular's own values happen to match. The caretaker's contact has exactly
    // one legitimate route to this page (resolveCaretakerPublicContact, two
    // keys), and `caretakerContact` here is null because key 1 is off by
    // default. Any appearance of these values is a leak.
    const data = await loadCredentialViewData(pet);

    expect(data.lostContext?.phone).not.toBe(CARETAKER_PHONE);
    expect(data.lostContext?.ownerFirstName).not.toBe("Ana");
    expect(data.lostContext?.caretakerContact).toBeNull();
  });
});
