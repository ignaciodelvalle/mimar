// Regression fence for the finalize-time unique violation on a SPONSORED pet
// (rehome-by-titular, WU1/WU2 — spec REQ-9, design ADR-5).
//
// THE BUG THIS EXISTS FOR
// ---------------------------------------------------------------------------
// The rehome-by-titular arrangement is the first write path in DIM that leaves
// a pet with TWO live ownership rows at once: the titular's `owner` row (they
// keep the title, the animal keeps living with them) and the sponsoring org's
// `shelter_custody` row. `db/migrations/0000_orgs_foundation.sql:138-145`
// relaxed `ownerships_one_active_owner_per_pet` to `role='owner'` precisely so
// that pair is legal.
//
// `insertAdoptionFinalized` never met that pair. It closes the shelter_custody
// row and the foster row and then inserts the adopter's `owner` row, leaving
// the titular's `owner` row open. Postgres refuses the second live owner with
// SQLSTATE 23505 — AFTER the org approved an applicant and uploaded a signed
// contract, which is the worst possible moment to discover it.
//
// WHY THIS TEST HITS REAL POSTGRES (the `db` vitest project, serial)
// ---------------------------------------------------------------------------
// The bug IS a partial unique index. A mocked repository has no index, so a
// mocked test passes against the broken code: it would be a green light parked
// over the exact crash, which is worse than no test at all. Non-negotiable.
//
// TEST ORDER IS LOAD-BEARING. The armed-fence control and the listability
// assertion both need the owner+shelter_custody pair still live, and the
// finalize test consumes it (closing every row on the pet). Vitest runs `it`
// blocks in declaration order inside a file; do not reorder them, and do not
// move the finalize case above the other two.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  db,
  notifications,
  organizationCoverage,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { dniLast4, hashDni } from "@/lib/utils/dni-hash";
import { finalizeAdoption } from "@/src/modules/adoption/application/finalize-adoption";
import { queryAdoptionListing } from "@/src/modules/adoption/infrastructure/adoption-listing-read";
import { AdoptionRepository } from "@/src/modules/adoption/infrastructure/adoption-repository";
import { requestRehomeSponsorship } from "@/src/modules/rehome/application/request-rehome-sponsorship";
import { respondToRehomeRequest } from "@/src/modules/rehome/application/respond-to-rehome-request";
import { RehomeRepository } from "@/src/modules/rehome/infrastructure/rehome-repository";

import { withMutationOverride } from "./_helpers/db-overrides";
import { expectDbError } from "./_helpers/expect-db-error";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const TITULAR_EMAIL = "rehome-finalize-titular@dim-test.local";
const ADOPTER_EMAIL = "rehome-finalize-adopter@dim-test.local";
const COORD_EMAIL = "rehome-finalize-coord@dim-test.local";
const PASS = "RehomeFinalize_2026!";

const ORG_TOKEN = "DIM-REHOME-001";
const PET_TOKEN = "DIM-RHOM-PET1";
const ADOPTER_DNI = "30777001";

let titularUserId: string;
let adopterUserId: string;
let coordUserId: string;
let orgId: string;
let petId: string;
let titularOwnershipId: string;
let sponsorshipOwnershipId: string;

async function purgeUserByEmail(email: string): Promise<void> {
  const { data } = await supabaseAdmin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  // Deleting a profile cascades into pet_events.recorded_by_user_id (ON DELETE
  // SET NULL), which trips the append-only trigger. Wrap so the cascade is
  // allowed, same shape as adoption-cascade.test.ts.
  await withMutationOverride(async (tx) => {
    for (const uid of ids) {
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
      await tx.delete(ownerships).where(eq(ownerships.ownerUserId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabaseAdmin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  // Leftovers from a crashed previous run — the tokens are hardcoded.
  await withMutationOverride(async (tx) => {
    const stalePets = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN));
    for (const { id } of stalePets) {
      await tx.delete(notifications).where(eq(notifications.relatedPetId, id));
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
  });
  const staleOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, ORG_TOKEN));
  for (const { id } of staleOrgs) {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, id));
    await db.delete(organizations).where(eq(organizations.id, id));
  }
  for (const email of [TITULAR_EMAIL, ADOPTER_EMAIL, COORD_EMAIL]) {
    await purgeUserByEmail(email);
  }

  for (const { email, ref } of [
    { email: TITULAR_EMAIL, ref: "titular" },
    { email: ADOPTER_EMAIL, ref: "adopter" },
    { email: COORD_EMAIL, ref: "coord" },
  ] as const) {
    const r = await createFreshTestUser(supabaseAdmin, {
      email,
      password: PASS,
      email_confirm: true,
    });
    if (r.error || !r.data.user) throw new Error(`createUser ${ref}: ${r.error?.message}`);
    if (ref === "titular") titularUserId = r.data.user.id;
    if (ref === "adopter") adopterUserId = r.data.user.id;
    if (ref === "coord") coordUserId = r.data.user.id;
  }

  await db
    .update(profiles)
    .set({ displayName: "Rehome Titular", role: "owner", accountType: "personal" })
    .where(eq(profiles.id, titularUserId));
  // The adopter is resolved by the manual-DNI branch of finalize-adoption, which
  // requires a real registered account (no stub creation since org-pilot-pack).
  await db
    .update(profiles)
    .set({
      displayName: "Rehome Adopter",
      phone: "+541133330001",
      dniHash: hashDni(ADOPTER_DNI),
      dniLast4: dniLast4(ADOPTER_DNI),
      dniVerified: true,
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, adopterUserId));
  await db
    .update(profiles)
    .set({ displayName: "Rehome Coord", role: "owner", accountType: "personal" })
    .where(eq(profiles.id, coordUserId));

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Rehome Sponsor Refugio SRL",
      displayName: "Refugio Padrino",
      orgType: "shelter",
      email: "rehome-sponsor@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  // The zone the org works in — the request rule refuses an org that does not
  // reach the pet's locality (W-4), same predicate the picker filters on.
  await db.insert(organizationCoverage).values({
    organizationId: orgId,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
  });

  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: coordUserId,
    role: "admin",
    canWritePetEvents: true,
  });

  const now = new Date();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Malena",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      // A zone the sponsoring org covers: the request path is the real one
      // since WU3, and it now checks coverage (W-4).
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      inCustodyDispute: false,
      rabiesObservationStatus: null,
    })
    .returning();
  petId = pet.id;

  const [titularRow] = await db
    .insert(ownerships)
    .values({ petId, ownerUserId: titularUserId, role: "owner", startedAt: now })
    .returning({ id: ownerships.id });
  titularOwnershipId = titularRow.id;

  // The sponsored shape — the titular KEEPS their owner row and the org holds a
  // shelter_custody row alongside it — produced by the REAL path since WU3: the
  // titular asks, the org accepts. The accept transaction writes the custody
  // row, marks the pet eligible, publishes the listing and records the consent
  // fact (`rehome_sponsorship_started`, keyed by ownership_id) that finalize
  // later matches. WU1 manufactured the same pair with a direct write; every
  // assertion below is unchanged from then.
  const requested = await requestRehomeSponsorship(
    { petPublicToken: PET_TOKEN, titularUserId, targetOrgId: orgId },
    { repo: RehomeRepository, now: () => new Date() },
  );
  if (!requested.ok) throw new Error(`rehome request failed: ${requested.error}`);
  const accepted = await respondToRehomeRequest(
    { casePublicCode: requested.value.casePublicCode, decision: "accept" },
    {
      repo: RehomeRepository,
      actor: {
        user: { id: coordUserId },
        organization: { id: orgId, displayName: "Refugio Padrino", verified: true },
      },
      now: () => new Date(),
      transaction: db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>,
    },
  );
  if (!accepted.ok) throw new Error(`rehome accept failed: ${accepted.error}`);
  if (!accepted.value.ownershipId) throw new Error("rehome accept returned no custody row");
  sponsorshipOwnershipId = accepted.value.ownershipId;
});

afterAll(async () => {
  await db.delete(notifications).where(eq(notifications.relatedPetId, petId));
  await db.delete(ownerships).where(eq(ownerships.petId, petId));
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(eq(petEvents.petId, petId));
    await tx.delete(pets).where(eq(pets.id, petId));
  });
  await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const email of [TITULAR_EMAIL, ADOPTER_EMAIL, COORD_EMAIL]) {
    await purgeUserByEmail(email);
  }
});

describe("rehome sponsorship — the fence under the finalize test is armed", () => {
  // THE CONTROL. A green finalize test with a DROPPED index is indistinguishable
  // from a green finalize test with a correct fix. This assertion makes them
  // distinguishable: it proves `ownerships_one_active_owner_per_pet` is what the
  // finalize test is really up against, both before WU2 (it explains the red)
  // and forever after (it catches an accidental index drop).
  //
  // Same reasoning as 0190's post-condition block, which shipped broken because
  // it only ever ran on a path nobody exercised.
  it("a second live owner row on the same pet raises 23505", async () => {
    const info = await expectDbError(
      db.insert(ownerships).values({
        petId,
        ownerUserId: adopterUserId,
        role: "owner",
        startedAt: new Date(),
      }),
      { code: "23505", constraint: "ownerships_one_active_owner_per_pet" },
    );
    expect(info?.code).toBe("23505");
  });

  it("leaves the titular's owner row as the only live owner", async () => {
    // The rejected insert must not have landed: if it had, the finalize test
    // below would be running against a shape Postgres already refused.
    const liveOwners = await db
      .select({ id: ownerships.id, ownerUserId: ownerships.ownerUserId })
      .from(ownerships)
      .where(
        and(eq(ownerships.petId, petId), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
      );
    expect(liveOwners).toHaveLength(1);
    expect(liveOwners[0].ownerUserId).toBe(titularUserId);
  });
});

describe("rehome sponsorship — a sponsored pet is listable with no catalog change", () => {
  // Load-bearing proof for the PO's accepted tradeoff: `queryAdoptionListing`
  // keys on a live shelter_custody row and never asks whether a private titular
  // still holds the title, so the owner+shelter_custody pair lists as-is. If
  // this ever goes red, the four duplicated copies of the catalog predicate
  // moved and the whole design premise needs revisiting.
  it("queryAdoptionListing returns the pet while the titular still holds the owner row", async () => {
    const { items } = await queryAdoptionListing({ organizationToken: ORG_TOKEN }, null);
    expect(items.map((i) => i.petPublicToken)).toContain(PET_TOKEN);
  });
});

describe("rehome sponsorship — finalize closes EVERY live ownership row", () => {
  it("finalizes without violating ownerships_one_active_owner_per_pet", async () => {
    const result = await finalizeAdoption(
      {
        petPublicToken: PET_TOKEN,
        applicationEventId: null,
        adopterUserId: null,
        adopterDni: ADOPTER_DNI,
        adopterDisplayName: "Rehome Adopter",
        adopterPhone: "+541133330001",
        followupMonths: 0,
        notes: "Finalize sobre una mascota apadrinada",
        contractAttachmentId: null,
        contractStoragePath: null,
        contractMimeType: null,
        contractFileSize: null,
      },
      {
        repo: AdoptionRepository,
        actor: {
          user: { id: coordUserId },
          organization: {
            id: orgId,
            publicToken: ORG_TOKEN,
            verified: true,
            displayName: "Refugio Padrino",
          },
        },
        transaction: db.transaction.bind(db),
      },
    );

    // The RED assertion. Before WU2 this reports the raw Postgres message,
    // which names `ownerships_one_active_owner_per_pet` — that string IS the
    // evidence the right thing failed.
    expect(result.ok ? "" : result.error, "finalize must not hit a unique violation").toBe("");
    expect(result.ok).toBe(true);
  });

  it("leaves exactly one live ownership row: the adopter's owner row", async () => {
    const live = await db
      .select({
        id: ownerships.id,
        role: ownerships.role,
        ownerUserId: ownerships.ownerUserId,
        ownerOrganizationId: ownerships.ownerOrganizationId,
      })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));

    expect(live).toHaveLength(1);
    expect(live[0].role).toBe("owner");
    expect(live[0].ownerUserId).toBe(adopterUserId);
  });

  it("closes the titular's owner row AND the sponsoring org's custody row", async () => {
    const rows = await db
      .select({ id: ownerships.id, endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(eq(ownerships.petId, petId));
    const byId = new Map(rows.map((r) => [r.id, r.endedAt]));

    // REQ-9 scenario 3: every row closes AT the finalize's own instant — the
    // one `now` the use-case reads once and hands to endAllLiveOwnerships and
    // to the adoption_finalized event alike. Not merely "not null": a row
    // closed by some other path at some other time would pass that and still
    // be the wrong close (verify report S-1).
    const [finalized] = await db
      .select({ occurredAt: petEvents.occurredAt })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_finalized")));
    expect(finalized, "the adoption_finalized event carries the finalize's now()").toBeDefined();
    const finalizeNowMs = finalized.occurredAt.getTime();

    expect(
      byId.get(titularOwnershipId)?.getTime(),
      "titular owner row must be closed at the finalize instant",
    ).toBe(finalizeNowMs);
    expect(
      byId.get(sponsorshipOwnershipId)?.getTime(),
      "sponsoring custody row must be closed at the finalize instant",
    ).toBe(finalizeNowMs);
  });

  it("records both the adoption and the end of the sponsorship on the spine", async () => {
    const events = await db
      .select({ eventType: petEvents.eventType, payload: petEvents.payload })
      .from(petEvents)
      .where(eq(petEvents.petId, petId));
    const types = events.map((e) => e.eventType);

    expect(types).toContain("adoption_finalized");
    expect(types).toContain("rehome_sponsorship_ended");

    const ended = events.find((e) => e.eventType === "rehome_sponsorship_ended");
    const payload = ended?.payload as { outcome?: string; ownership_id?: string } | undefined;
    expect(payload?.outcome).toBe("adopted");
    // `ownership_id` is what lets rollback and audit say WHICH custody row a
    // sponsorship owned, instead of guessing from timestamps (design ADR-2).
    expect(payload?.ownership_id).toBe(sponsorshipOwnershipId);
  });

  it("takes the pet off the adoption shelf", async () => {
    const [row] = await db
      .select({
        adoptionListedAt: pets.adoptionListedAt,
        adoptionListingPausedAt: pets.adoptionListingPausedAt,
      })
      .from(pets)
      .where(eq(pets.id, petId));
    expect(row.adoptionListedAt).toBeNull();
    expect(row.adoptionListingPausedAt).toBeNull();
  });
});
