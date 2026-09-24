// Integration tests for fetchPetWeightHistory (lib/owner-dashboard.ts — Chunk J).
//
// Verifies:
//   T1 — returns weight events within the last 12 months, ascending by date.
//   T2 — excludes weight events older than 12 months.
//   T3 — returns empty array when pet has no weight events.
//   T4 — normalises payload.kg from both string and number forms.
//   T5 — both readers refuse, IN THE QUERY, a viewer who does not hold the pet.
//   T6 — the in-query holder clause agrees with resolvePetHolderAccess on every
//        term of the rule (differential, against the real database).

import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, organizationMemberships, organizations, ownerships, petEvents, pets } from "@/db";
import { fetchPetEventsForProfileV2, fetchPetWeightHistory } from "@/lib/analytics/owner-dashboard";
import { resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { getLibretaFaceData } from "@/src/modules/pets/application/tab-data/get-libreta-face-data";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function ensureUserDeleted(email: string) {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, found.id));
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  await admin.auth.admin.deleteUser(found.id);
}

async function createUser(email: string): Promise<string> {
  const { data, error } = await createFreshTestUser(admin, {
    email,
    password: "PetWeight_2026!",
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return data.user.id;
}

async function createPet(userId: string, tokenSuffix: string) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `AR-WGT-${tokenSuffix}`,
      name: `Pet_WGT_${tokenSuffix}`,
      species: "dog",
      sex: "unknown",
      status: "active",
    })
    .returning();
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: userId, role: "owner" });
  return pet;
}

async function insertWeightEvent(
  petId: string,
  userId: string,
  occurredAt: Date,
  kg: number | string,
) {
  const [ev] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "weight_recorded",
      occurredAt,
      recordedAt: occurredAt,
      recordedByUserId: userId,
      authorRole: "owner",
      payload: { payload_version: 1, kg },
    })
    .returning();
  return ev;
}

async function cleanupUser(userId: string) {
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, userId));
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  await admin.auth.admin.deleteUser(userId);
}

// ---------------------------------------------------------------------------
// T1 — returns weight events within the last 12 months, ascending
// ---------------------------------------------------------------------------

describe("fetchPetWeightHistory — returns recent events ascending", () => {
  const EMAIL = "wgh-t1@dim-test.local";
  let userId: string;
  let petId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL);
    const pet = await createPet(userId, `T1-${userId.slice(0, 4)}`);
    petId = pet.id;

    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const threeMonthsAgo = new Date(now);
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    // Insert in reverse order to confirm the helper sorts ascending.
    await insertWeightEvent(petId, userId, now, "4.5");
    await insertWeightEvent(petId, userId, threeMonthsAgo, "4.3");
    await insertWeightEvent(petId, userId, sixMonthsAgo, "4.1");
  });

  afterAll(() => cleanupUser(userId));

  it("returns all three events", async () => {
    const result = await fetchPetWeightHistory(userId, petId);
    expect(result).toHaveLength(3);
  });

  it("events are ordered ascending by date", async () => {
    const result = await fetchPetWeightHistory(userId, petId);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].date.getTime()).toBeGreaterThanOrEqual(result[i - 1].date.getTime());
    }
  });

  it("kg values are numbers", async () => {
    const result = await fetchPetWeightHistory(userId, petId);
    for (const s of result) {
      expect(typeof s.kg).toBe("number");
      expect(Number.isFinite(s.kg)).toBe(true);
    }
  });

  it("most recent sample has kg=4.5", async () => {
    const result = await fetchPetWeightHistory(userId, petId);
    const last = result[result.length - 1];
    expect(last.kg).toBeCloseTo(4.5);
  });

  // A01-5 (2026-09-18): the viewer is an in-query predicate, so a caller that
  // skipped requirePetAccess gets nothing back for a pet the viewer does not
  // hold. The positive controls are the tests above and below (same pet, holder).
  it("returns nothing to a viewer who does not hold the pet", async () => {
    const stranger = randomUUID();
    expect(await fetchPetWeightHistory(stranger, petId)).toEqual([]);
    const v2 = await fetchPetEventsForProfileV2(stranger, petId);
    expect(v2.typedEvents).toEqual([]);
    expect(v2.recentFive).toEqual([]);
  });

  it("the profile-v2 reader answers the holder (positive control)", async () => {
    const v2 = await fetchPetEventsForProfileV2(userId, petId);
    expect(v2.recentFive.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T2 — excludes weight events older than 12 months
// ---------------------------------------------------------------------------

describe("fetchPetWeightHistory — excludes events older than 12 months", () => {
  const EMAIL = "wgh-t2@dim-test.local";
  let userId: string;
  let petId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL);
    const pet = await createPet(userId, `T2-${userId.slice(0, 4)}`);
    petId = pet.id;

    const now = new Date();
    const thirteenMonthsAgo = new Date(now);
    thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);
    const twoMonthsAgo = new Date(now);
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    await insertWeightEvent(petId, userId, thirteenMonthsAgo, "3.8"); // should be excluded
    await insertWeightEvent(petId, userId, twoMonthsAgo, "4.2"); // should be included
  });

  afterAll(() => cleanupUser(userId));

  it("returns only the event within 12 months", async () => {
    const result = await fetchPetWeightHistory(userId, petId);
    expect(result).toHaveLength(1);
    expect(result[0].kg).toBeCloseTo(4.2);
  });
});

// ---------------------------------------------------------------------------
// T3 — returns empty array when pet has no weight events
// ---------------------------------------------------------------------------

describe("fetchPetWeightHistory — empty when no weight events", () => {
  const EMAIL = "wgh-t3@dim-test.local";
  let userId: string;
  let petId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL);
    const pet = await createPet(userId, `T3-${userId.slice(0, 4)}`);
    petId = pet.id;
    // No weight events inserted.
  });

  afterAll(() => cleanupUser(userId));

  it("returns an empty array", async () => {
    const result = await fetchPetWeightHistory(userId, petId);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T4 — normalises kg from both string and number payload forms
// ---------------------------------------------------------------------------

describe("fetchPetWeightHistory — normalises kg from string and number payloads", () => {
  const EMAIL = "wgh-t4@dim-test.local";
  let userId: string;
  let petId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL);
    const pet = await createPet(userId, `T4-${userId.slice(0, 4)}`);
    petId = pet.id;

    const now = new Date();
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    // String form (old recording path).
    await insertWeightEvent(petId, userId, oneMonthAgo, "12.50");
    // Number form (newer recording paths).
    await insertWeightEvent(petId, userId, now, 13);
  });

  afterAll(() => cleanupUser(userId));

  it("both events are returned as finite numbers", async () => {
    const result = await fetchPetWeightHistory(userId, petId);
    expect(result).toHaveLength(2);
    for (const s of result) {
      expect(typeof s.kg).toBe("number");
      expect(Number.isFinite(s.kg)).toBe(true);
    }
  });

  it("string form normalises to 12.5", async () => {
    const result = await fetchPetWeightHistory(userId, petId);
    expect(result[0].kg).toBeCloseTo(12.5);
  });

  it("number form normalises to 13", async () => {
    const result = await fetchPetWeightHistory(userId, petId);
    expect(result[1].kg).toBeCloseTo(13);
  });
});

// ---------------------------------------------------------------------------
// T6 — the in-query clause answers exactly what resolvePetHolderAccess answers
// ---------------------------------------------------------------------------
//
// viewerHoldsPetClause is a SECOND statement of resolvePetHolderAccess's rule
// (A01-5, 2026-09-18). A second statement drifts, so this is a DIFFERENTIAL
// test: for each (viewer, pet) pair the resolver's verdict and both readers'
// verdicts must agree, and must match the expected answer. Each row of the
// matrix exists because deleting one term of the clause flips it (mutation-
// proven): a live owner row, a live caretaker row, an ended row, a soft-deleted
// pet with a live row (both paths), a live org member, a member who left, an
// org whose custody row ended, a member of an org that does NOT hold the pet
// (the org link, hm.organization_id = ho.owner_organization_id), and a stranger.
// The libreta readers (timeline + vaccination source) are checked too.

describe("viewerHoldsPetClause — agrees with resolvePetHolderAccess (A01-5)", () => {
  const suffix = randomUUID().slice(0, 8);
  const EMAILS = {
    owner: `wgh-t6-owner-${suffix}@dim-test.local`,
    caretaker: `wgh-t6-care-${suffix}@dim-test.local`,
    member: `wgh-t6-member-${suffix}@dim-test.local`,
    leftMember: `wgh-t6-left-${suffix}@dim-test.local`,
  };
  const ids: Record<keyof typeof EMAILS, string> = {
    owner: "",
    caretaker: "",
    member: "",
    leftMember: "",
  };
  const stranger = randomUUID();
  let orgId = "";
  let org: typeof organizations.$inferSelect;
  const petsByName: Record<string, typeof pets.$inferSelect> = {};

  async function insertPet(name: string, deletedAt: Date | null = null) {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: `AR-WGT-T6${name}-${suffix}`,
        name: `Pet_WGT_T6_${name}`,
        species: "dog",
        sex: "unknown",
        status: "active",
        deletedAt,
      })
      .returning();
    petsByName[name] = pet;
    await insertWeightEvent(pet.id, ids.owner, new Date(), "5");
    return pet.id;
  }

  beforeAll(async () => {
    for (const key of Object.keys(EMAILS) as Array<keyof typeof EMAILS>) {
      ids[key] = await createUser(EMAILS[key]);
    }
    [org] = await db
      .insert(organizations)
      .values({
        publicToken: `DIM-WGT-T6-${suffix}`,
        legalName: "Weight T6 Refugio SRL",
        displayName: "Weight T6 Refugio",
        orgType: "shelter",
        email: `wgh-t6-org-${suffix}@dim-test.local`,
        verified: true,
      })
      .returning();
    orgId = org.id;
    await db.insert(organizationMemberships).values([
      { organizationId: orgId, userId: ids.member, role: "admin", canWritePetEvents: true },
      {
        organizationId: orgId,
        userId: ids.leftMember,
        role: "admin",
        canWritePetEvents: true,
        leftAt: new Date(Date.now() - 60_000),
      },
    ]);

    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // HELD: live owner row, live caretaker row, live org custody row.
    const held = await insertPet("HELD");
    await db.insert(ownerships).values([
      { petId: held, ownerUserId: ids.owner, role: "owner" },
      { petId: held, ownerUserId: ids.caretaker, role: "caretaker" },
      { petId: held, ownerOrganizationId: orgId, role: "shelter_custody" },
    ]);
    // A free-text vaccine (off-catalog) so the libreta's vaccination source
    // shows up as summary.otherCount — only on HELD.
    await db.insert(petEvents).values({
      petId: held,
      eventType: "vaccination_administered",
      occurredAt: new Date(),
      recordedAt: new Date(),
      recordedByUserId: ids.owner,
      authorRole: "owner",
      payload: { payload_version: 1, vaccine_name: "Vacuna T6 fuera de catalogo" },
    });
    // OTHER: held live ONLY by the caretaker user. The org member holds a live
    // membership in an org that has no row on this pet — only the org link in
    // the clause keeps them out.
    const other = await insertPet("OTHER");
    await db.insert(ownerships).values({ petId: other, ownerUserId: ids.caretaker, role: "owner" });
    // ENDED: the owner's row ended.
    const ended = await insertPet("ENDED");
    await db
      .insert(ownerships)
      .values({ petId: ended, ownerUserId: ids.owner, role: "owner", endedAt: new Date() });
    // ERASED: live owner and org rows, but the pet is soft-deleted.
    const erased = await insertPet("ERASED", past);
    await db.insert(ownerships).values([
      { petId: erased, ownerUserId: ids.owner, role: "owner" },
      { petId: erased, ownerOrganizationId: orgId, role: "shelter_custody" },
    ]);
    // ORGENDED: the org's custody row ended; its member no longer holds it.
    const orgEnded = await insertPet("ORGENDED");
    await db.insert(ownerships).values({
      petId: orgEnded,
      ownerOrganizationId: orgId,
      role: "shelter_custody",
      endedAt: new Date(),
    });
  });

  afterAll(async () => {
    const petIds = Object.values(petsByName).map((p) => p.id);
    for (const petId of petIds) await db.delete(ownerships).where(eq(ownerships.petId, petId));
    await withMutationOverride(async (tx) => {
      for (const petId of petIds) {
        await tx.delete(petEvents).where(eq(petEvents.petId, petId));
        await tx.delete(pets).where(eq(pets.id, petId));
      }
    });
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    for (const id of Object.values(ids)) if (id) await admin.auth.admin.deleteUser(id);
  });

  const cases: Array<[string, () => string, string, boolean]> = [
    ["live owner row", () => ids.owner, "HELD", true],
    ["live caretaker row", () => ids.caretaker, "HELD", true],
    ["live member of the custodian org", () => ids.member, "HELD", true],
    ["member who left the org", () => ids.leftMember, "HELD", false],
    ["stranger", () => stranger, "HELD", false],
    ["ended owner row", () => ids.owner, "ENDED", false],
    ["soft-deleted pet, owner path", () => ids.owner, "ERASED", false],
    ["soft-deleted pet, org path", () => ids.member, "ERASED", false],
    ["org custody row ended", () => ids.member, "ORGENDED", false],
    ["member of an org that does not hold the pet", () => ids.member, "OTHER", false],
    ["live owner of the other pet (positive control)", () => ids.caretaker, "OTHER", true],
  ];

  for (const [label, viewerOf, petName, expected] of cases) {
    it(`${label} → ${expected ? "holds" : "does not hold"}, in the resolver AND in fetchPetWeightHistory / fetchPetEventsForProfileV2 / getLibretaFaceData`, async () => {
      const viewer = viewerOf();
      const pet = petsByName[petName];
      const resolved = (await resolvePetHolderAccess(pet.publicToken, viewer)).kind !== "none";
      const weights = await fetchPetWeightHistory(viewer, pet.id);
      const v2 = await fetchPetEventsForProfileV2(viewer, pet.id);
      expect(resolved).toBe(expected);
      expect(weights.length > 0).toBe(expected);
      expect(v2.typedEvents.length > 0 || v2.recentFive.length > 0).toBe(expected);

      const orgViewer = viewer === ids.member || viewer === ids.leftMember;
      const libreta = await getLibretaFaceData(
        {
          user: { id: viewer },
          pet,
          accessPath: orgViewer ? "org" : "owner",
          organization: orgViewer ? org : null,
        },
        { signAttachments: false },
      );
      expect(libreta.ok).toBe(true);
      if (!libreta.ok) return;
      expect(libreta.data.past.length > 0).toBe(expected);
      expect(libreta.data.summary.otherCount > 0).toBe(expected && petName === "HELD");
    });
  }
});
