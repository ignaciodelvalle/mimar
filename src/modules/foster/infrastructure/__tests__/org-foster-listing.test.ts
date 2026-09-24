// listOrgFosters — the org tránsitos listing is bound to the viewing org.
//
// Finding A10-1 (2026-09 review): the historial tab of /org/[orgToken]/transitos
// listed every ended foster of every pet the org had EVER held, so after org A
// handed a pet to org B, A read the name of the volunteer B placed it with.
//
// Fixture timeline (explicit instants — nothing here is compared to a clock):
//
//   pet P1  org A shelter_custody [T0, T10)  →  org B shelter_custody [T10, ∞)
//           A's foster FA1 [T1, T2)     assigned by hand: NO proposal row
//           A's foster FA2 [T3, T10)    ended by the transfer, same instant B starts
//           B's foster FB1 [T11, T12)   the leak: must never reach A
//           B's foster FB2 [T13, ∞)     live under B
//   pet P2  org B shelter_custody [T0, ∞)
//           B's foster FB3 [T1, T2)
//
// FA1 has no `foster_proposals` row on purpose: binding historial through a
// join on proposals (the review's first suggestion) would drop it, i.e. erase
// the org's own history of every foster it assigned directly.

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, organizations, ownerships, pets, profiles } from "@/db";
import { hashDni } from "@/lib/utils/dni-hash";
import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";

import { listOrgFosters } from "../org-foster-listing";

const ORG_A_TOKEN = "DIM-ORGFOSTLIST-A";
const ORG_B_TOKEN = "DIM-ORGFOSTLIST-B";
const PET_1_TOKEN = "DIM-ORGFOSTLIST-P1";
const PET_2_TOKEN = "DIM-ORGFOSTLIST-P2";

const day = (n: number) => new Date(Date.UTC(2025, 0, 1 + n, 12, 0, 0));
const T0 = day(0);
const T1 = day(1);
const T2 = day(2);
const T3 = day(3);
const T10 = day(10);
const T11 = day(11);
const T12 = day(12);
const T13 = day(13);

const NAMES = {
  fa1: "OrgFosterList VolunteerA1",
  fa2: "OrgFosterList VolunteerA2",
  fb1: "OrgFosterList VolunteerB1",
  fb2: "OrgFosterList VolunteerB2",
  fb3: "OrgFosterList VolunteerB3",
} as const;

let orgA: string;
let orgB: string;
const petIds: string[] = [];
const userIds: Record<keyof typeof NAMES, string> = {
  fa1: crypto.randomUUID(),
  fa2: crypto.randomUUID(),
  fb1: crypto.randomUUID(),
  fb2: crypto.randomUUID(),
  fb3: crypto.randomUUID(),
};
const fosterIds = {} as Record<keyof typeof NAMES, string>;

async function cleanup() {
  await withMutationOverride(async (tx) => {
    const stalePets = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(inArray(pets.publicToken, [PET_1_TOKEN, PET_2_TOKEN]));
    for (const { id } of stalePets) await tx.delete(pets).where(eq(pets.id, id));
    const staleOrgs = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(inArray(organizations.publicToken, [ORG_A_TOKEN, ORG_B_TOKEN]));
    for (const { id } of staleOrgs) await tx.delete(organizations).where(eq(organizations.id, id));
    await tx.delete(profiles).where(inArray(profiles.id, Object.values(userIds)));
  });
}

async function insertOrg(token: string, name: string) {
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: token,
      legalName: `${name} SRL`,
      displayName: name,
      orgType: "shelter",
      email: `${token.toLowerCase()}@dim-test.local`,
      verified: true,
    })
    .returning({ id: organizations.id });
  return org.id;
}

async function insertPet(token: string, name: string) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name,
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      status: "active",
    })
    .returning({ id: pets.id });
  petIds.push(pet.id);
  return pet.id;
}

async function insertFoster(
  key: keyof typeof NAMES,
  petId: string,
  startedAt: Date,
  endedAt: Date | null,
) {
  const [row] = await db
    .insert(ownerships)
    .values({ petId, ownerUserId: userIds[key], role: "foster", startedAt, endedAt })
    .returning({ id: ownerships.id });
  fosterIds[key] = row.id;
}

beforeAll(async () => {
  await cleanup();

  orgA = await insertOrg(ORG_A_TOKEN, "OrgFosterList A");
  orgB = await insertOrg(ORG_B_TOKEN, "OrgFosterList B");

  for (const key of Object.keys(NAMES) as (keyof typeof NAMES)[]) {
    await db.insert(profiles).values({
      id: userIds[key],
      displayName: NAMES[key],
      dniHash: hashDni(`${Math.floor(Math.random() * 90000000 + 10000000)}`),
      dniVerified: true,
      role: "owner",
    });
  }

  const p1 = await insertPet(PET_1_TOKEN, "OrgFosterList Uno");
  const p2 = await insertPet(PET_2_TOKEN, "OrgFosterList Dos");

  await db.insert(ownerships).values([
    { petId: p1, ownerOrganizationId: orgA, role: "shelter_custody", startedAt: T0, endedAt: T10 },
    { petId: p1, ownerOrganizationId: orgB, role: "shelter_custody", startedAt: T10 },
    { petId: p2, ownerOrganizationId: orgB, role: "shelter_custody", startedAt: T0 },
  ]);

  await insertFoster("fa1", p1, T1, T2);
  await insertFoster("fa2", p1, T3, T10);
  await insertFoster("fb1", p1, T11, T12);
  await insertFoster("fb2", p1, T13, null);
  await insertFoster("fb3", p2, T1, T2);
});

afterAll(cleanup);

const ids = (rows: { ownershipId: string }[]) => rows.map((r) => r.ownershipId).sort();
const expected = (...keys: (keyof typeof NAMES)[]) => keys.map((k) => fosterIds[k]).sort();

describe("listOrgFosters — historial is bound to the viewing org (A10-1)", () => {
  it("org A sees the fosters it placed, and never the one org B placed after the hand-off", async () => {
    const rows = await listOrgFosters(orgA, "historial");

    expect(ids(rows)).toEqual(expected("fa1", "fa2"));
    const shownNames = rows.map((r) => r.fosterDisplayName);
    expect(shownNames).not.toContain(NAMES.fb1);
    expect(shownNames).not.toContain(NAMES.fb3);
  });

  it("org B sees its own ended fosters, including on the pet it received, and none of A's", async () => {
    const rows = await listOrgFosters(orgB, "historial");

    // FA2 ended at T10, the instant B's window opened: it started under A, so it is A's.
    expect(ids(rows)).toEqual(expected("fb1", "fb3"));
  });

  it("orders historial by ending, newest first, and carries the pet it belongs to", async () => {
    const rows = await listOrgFosters(orgB, "historial");

    expect(rows.map((r) => r.ownershipId)).toEqual([fosterIds.fb1, fosterIds.fb3]);
    expect(rows[0]).toMatchObject({
      endedAt: T12,
      fosterDisplayName: NAMES.fb1,
      pet: { publicToken: PET_1_TOKEN, name: "OrgFosterList Uno" },
      kind: null,
    });
  });
});

describe("listOrgFosters — activos stays bound to current custody", () => {
  it("an org that handed the pet off sees none of the live fosters on it", async () => {
    expect(await listOrgFosters(orgA, "activos")).toEqual([]);
  });

  it("the current holder sees the live foster, classified as vecino without proposal or membership", async () => {
    const rows = await listOrgFosters(orgB, "activos");

    expect(ids(rows)).toEqual(expected("fb2"));
    expect(rows[0]).toMatchObject({ fosterDisplayName: NAMES.fb2, endedAt: null, kind: "vecino" });
  });
});
