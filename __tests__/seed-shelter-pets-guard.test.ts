// DB-backed test for scripts/seed-shelter-pets-guard.ts.
//
// Why this file exists: scripts/seed-test-users.ts advertised "Idempotent —
// safe to re-run", and for the shelter-custody pets step that was FALSE. The
// guard asked "does this org hold a live shelter_custody?" while the step's
// real collision surface is the FIXED microchip codes it writes into
// pet_identifications, protected by
//
//   CREATE UNIQUE INDEX pet_identifications_chip_unique
//     ON public.pet_identifications(code)
//     WHERE kind = 'microchip_iso' AND status = 'active';
//
// Those two facts come apart the moment a custody ENDS, which is what an
// adoption or a transfer does. The guard then sees zero live custodies, the
// step runs again, re-creates the pets, and dies with 23505 partway through —
// no protection and no atomicity. Measured on staging 2026-08-21: duplicated
// shelter pets, some of them left without the chip row their spine event says
// they have.
//
// These tests pin the guard against the constraint it will actually hit:
// the chip half fires even with the custody long ended, the custody half is
// still honoured for seed pets that carry no chip, a clean database still
// gets seeded, and — the mirror-image trap — a chip row that is no longer
// `active` does NOT block, because it no longer occupies the unique index
// either. A guard stricter than its constraint is just a different bug.

import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, organizations, ownerships, petIdentifications, pets } from "@/db";
import { shelterPetsAlreadySeeded } from "../scripts/seed-shelter-pets-guard";

const TOKEN_PREFIX = "DIM-SHGD-";
const ORG_TOKEN = "ORG-SHGD-0001";
// Not the seed's real 858000000000101 — this test must never collide with the
// rows scripts/seed-test-users.ts owns on the same local database.
const CHIP = "858999000000901";

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM pet_identifications WHERE code = ${CHIP}`);
  await db.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
    SELECT id FROM pets WHERE public_token LIKE ${`${TOKEN_PREFIX}%`}
  )`);
  await db.execute(sql`DELETE FROM pets WHERE public_token LIKE ${`${TOKEN_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM organizations WHERE public_token = ${ORG_TOKEN}`);
}

async function makeOrg(): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Refugio Guard (test)",
      displayName: "Refugio Guard (test)",
      orgType: "shelter",
      email: "shelter-guard@dim.test",
    })
    .returning({ id: organizations.id });
  return org.id;
}

async function makePet(suffix: string): Promise<string> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `${TOKEN_PREFIX}${suffix}`,
      species: "dog",
      name: `Guard ${suffix}`,
      sex: "male",
      status: "active",
    })
    .returning({ id: pets.id });
  return pet.id;
}

beforeEach(cleanup);
afterAll(cleanup);

describe("shelterPetsAlreadySeeded", () => {
  it("reports NOT seeded on a database that has neither custody nor chips", async () => {
    const orgId = await makeOrg();

    await expect(shelterPetsAlreadySeeded({ orgId, chipCodes: [CHIP] })).resolves.toEqual({
      alreadySeeded: false,
    });
  });

  it("reports seeded when the org still holds a live shelter custody", async () => {
    const orgId = await makeOrg();
    const petId = await makePet("CUST");
    await db.insert(ownerships).values({
      petId,
      ownerOrganizationId: orgId,
      role: "shelter_custody",
    });

    const state = await shelterPetsAlreadySeeded({ orgId, chipCodes: [CHIP] });
    expect(state.alreadySeeded).toBe(true);
    expect(state.alreadySeeded && state.reason).toBe("live-custody");
  });

  // THE BUG. The custody is over (adopted out, transferred), so the old guard
  // said "run" — and the run then hit pet_identifications_chip_unique partway
  // through, after it had already inserted pets and spine events.
  it("reports seeded when a fixed chip already exists and the custody has ENDED", async () => {
    const orgId = await makeOrg();
    const petId = await makePet("CHIP");

    await db.insert(ownerships).values({
      petId,
      ownerOrganizationId: orgId,
      role: "shelter_custody",
      endedAt: new Date(),
    });
    await db.insert(petIdentifications).values({
      petId,
      kind: "microchip_iso",
      status: "active",
      code: CHIP,
      recordedAt: new Date().toISOString().slice(0, 10),
      isoCountryCode: CHIP.slice(0, 3),
      isoManufacturerCode: CHIP.slice(3, 7),
      isoNationalId: CHIP.slice(7, 15),
      isoCompliant: true,
    });

    const state = await shelterPetsAlreadySeeded({ orgId, chipCodes: [CHIP] });
    expect(state.alreadySeeded).toBe(true);
    expect(state.alreadySeeded && state.reason).toBe("chip-already-present");
    expect(state.alreadySeeded && state.detail).toContain(CHIP);
  });

  // The mirror image: a REPLACED chip row is outside the partial unique index,
  // so re-inserting that code would succeed. The guard must not block on it.
  it("does NOT report seeded for a chip row that is no longer active", async () => {
    const orgId = await makeOrg();
    const petId = await makePet("REPL");

    await db.insert(petIdentifications).values({
      petId,
      kind: "microchip_iso",
      status: "replaced",
      code: CHIP,
      recordedAt: new Date().toISOString().slice(0, 10),
      isoCountryCode: CHIP.slice(0, 3),
      isoManufacturerCode: CHIP.slice(3, 7),
      isoNationalId: CHIP.slice(7, 15),
      isoCompliant: true,
    });

    await expect(shelterPetsAlreadySeeded({ orgId, chipCodes: [CHIP] })).resolves.toEqual({
      alreadySeeded: false,
    });
  });

  it("ignores chip codes belonging to a step that declares none", async () => {
    const orgId = await makeOrg();
    const petId = await makePet("NONE");
    await db.insert(petIdentifications).values({
      petId,
      kind: "microchip_iso",
      status: "active",
      code: CHIP,
      recordedAt: new Date().toISOString().slice(0, 10),
      isoCountryCode: CHIP.slice(0, 3),
      isoManufacturerCode: CHIP.slice(3, 7),
      isoNationalId: CHIP.slice(7, 15),
      isoCompliant: true,
    });

    await expect(shelterPetsAlreadySeeded({ orgId, chipCodes: [] })).resolves.toEqual({
      alreadySeeded: false,
    });
  });
});
