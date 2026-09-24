// The death of a SPONSORED pet ends the sponsorship (rehome-by-titular,
// design ADR-2 "add rehome_request to death_recorded.compatibleWith so the
// death cascade closes the arrangement"; tasks 7.4).
//
// WHY THIS HITS REAL POSTGRES (the `db` vitest project, serial)
// ---------------------------------------------------------------------------
// Attaching `death_recorded` to the open cases was the attachment rule's job
// and it never ended anything: the org's `shelter_custody` row stayed live
// (the org's census counted a dead animal as held), the listing columns
// stayed set (only the catalog's `status <> 'deceased'` guard hid it), the
// spine kept saying the sponsorship was running, and nobody — not the org,
// not the applicants — was told. The death use-case now runs CASCADE D in the
// same transaction as the death event. This proves what one transaction
// leaves behind across ownerships, pets, pet_events, cases and the
// notifications the use-case hands back.
//
// NOT the withdraw cascade, on purpose: `withdrawRehomeSponsorship` is the
// TITULAR's act — it locks the titular's own owner row by user id and signs
// `withdrawn_by_titular`. A death is recorded by whoever is present (the
// titular, the org, a vet) and the closing fact must carry THAT authorship
// with outcome `pet_deceased`, the enum member reserved for exactly this.
//
// THREE SPONSORED PETS, one per claim (WU6/7 review):
//   Lila — the cascade itself (what one transaction leaves behind).
//   Nube — the titular's withdraw RACES the death (M-1): the death transaction
//          takes the pet advisory lock FIRST and re-reads under it, so a
//          withdraw that committed meanwhile is seen, nothing ends twice and
//          the org is told nothing by the death.
//   Sol  — another org's member records the death (M-2): the closing fact and
//          the auto-rejections name the SPONSORING org, not the recorder's.
//
// The fixture walks the real path (request → accept → apply), so the shape
// under test is the shape production produces.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, eq, isNull, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  caseEvents,
  cases,
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
import { endSponsorshipForDeceasedPet } from "@/lib/infra/rehome-death-cascade";
import { DEFAULT_LOCAL_URL } from "@/scripts/_db-target";
import { queryOrphanedSponsorships } from "@/scripts/check-spine-integrity";
import { AdoptionRepository } from "@/src/modules/adoption/infrastructure/adoption-repository";
import { findOpenSponsorship } from "@/src/modules/adoption/infrastructure/rehome-sponsorship-writer";
import {
  type CreateDeathRecordInput,
  createDeathRecord,
} from "@/src/modules/events/application/lifecycle/death-record-use-case";
import type { NewNotification } from "@/src/modules/events/application/types";
import { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";
import { requestRehomeSponsorship } from "@/src/modules/rehome/application/request-rehome-sponsorship";
import { respondToRehomeRequest } from "@/src/modules/rehome/application/respond-to-rehome-request";
import { withdrawRehomeSponsorship } from "@/src/modules/rehome/application/withdraw-rehome-sponsorship";
import { RehomeRepository } from "@/src/modules/rehome/infrastructure/rehome-repository";

import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const USERS = {
  titular: "rehome-death-titular@dim-test.local",
  coordA: "rehome-death-coord-a@dim-test.local",
  coordB: "rehome-death-coord-b@dim-test.local",
  applicant: "rehome-death-applicant@dim-test.local",
} as const;
const PASS = "RehomeDeath_2026!";

const ORG_A_TOKEN = "DIM-RHDT-0001";
const ORG_B_TOKEN = "DIM-RHDT-0002";
const ALL_ORG_TOKENS = [ORG_A_TOKEN, ORG_B_TOKEN];
const PET_TOKEN = "DIM-RHDT-PET1";
const PET_RACE_TOKEN = "DIM-RHDT-PET2";
const PET_OTHER_ORG_TOKEN = "DIM-RHDT-PET3";
const ALL_PET_TOKENS = [PET_TOKEN, PET_RACE_TOKEN, PET_OTHER_ORG_TOKEN];

type Planted = {
  petId: string;
  titularOwnershipId: string;
  custodyId: string;
  listingCaseId: string;
  applicationId: string | null;
};

const ids = {} as Record<keyof typeof USERS, string>;
let orgAId: string;
let orgBId: string;
/** Lila. */
let petId: string;
let titularOwnershipId: string;
let custodyId: string;
let listingCaseId: string;
let applicationId: string;
let nube: Planted;
let sol: Planted;

const pgSql = postgres(process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL, {
  max: 1,
  connect_timeout: 5,
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const transaction = db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;

async function purgeUserByEmail(email: string): Promise<void> {
  const { data } = await supabaseAdmin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const userIds = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  await withMutationOverride(async (tx) => {
    for (const uid of userIds) {
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
      await tx.delete(ownerships).where(eq(ownerships.ownerUserId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabaseAdmin.auth.admin.deleteUser(found.id);
}

async function purgePetsAndOrgs(): Promise<void> {
  await withMutationOverride(async (tx) => {
    for (const token of ALL_PET_TOKENS) {
      const stale = await tx.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
      for (const { id } of stale) {
        await tx.delete(notifications).where(eq(notifications.relatedPetId, id));
        const staleCases = await tx
          .select({ id: cases.id })
          .from(cases)
          .where(eq(cases.primaryPetId, id));
        for (const c of staleCases) {
          await tx.delete(caseEvents).where(eq(caseEvents.caseId, c.id));
        }
        await tx.delete(petEvents).where(eq(petEvents.petId, id));
        await tx.delete(cases).where(eq(cases.primaryPetId, id));
        await tx.delete(ownerships).where(eq(ownerships.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    }
  });
  for (const token of ALL_ORG_TOKENS) {
    const staleOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.publicToken, token));
    for (const { id } of staleOrgs) {
      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.organizationId, id));
      await db.delete(organizations).where(eq(organizations.id, id));
    }
  }
}

/** The real path: the titular asks org A, org A accepts, optionally someone applies. */
async function plantSponsoredPet(
  token: string,
  name: string,
  opts: { apply: boolean },
): Promise<Planted> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name,
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      inCustodyDispute: false,
      rabiesObservationStatus: null,
    })
    .returning({ id: pets.id });
  const [ownerRow] = await db
    .insert(ownerships)
    .values({ petId: pet.id, ownerUserId: ids.titular, role: "owner", startedAt: new Date() })
    .returning({ id: ownerships.id });

  const requested = await requestRehomeSponsorship(
    { petPublicToken: token, titularUserId: ids.titular, targetOrgId: orgAId },
    { repo: RehomeRepository, now: () => new Date() },
  );
  if (!requested.ok) throw new Error(`request ${name} failed: ${requested.error}`);
  const accepted = await respondToRehomeRequest(
    { casePublicCode: requested.value.casePublicCode, decision: "accept" },
    {
      repo: RehomeRepository,
      actor: {
        user: { id: ids.coordA },
        organization: { id: orgAId, displayName: "Refugio Duelo", verified: true },
      },
      now: () => new Date(),
      transaction,
    },
  );
  if (!accepted.ok) throw new Error(`accept ${name} failed: ${accepted.error}`);
  if (!accepted.value.ownershipId || !accepted.value.listingCaseId) {
    throw new Error(`accept ${name} returned no custody row / listing case`);
  }

  let applicationId: string | null = null;
  if (opts.apply) {
    applicationId = await db.transaction(async (tx) => {
      const { eventId } = await AdoptionRepository.insertApplication(
        {
          petId: pet.id,
          userId: ids.applicant,
          orgId: orgAId,
          housingType: "departamento",
          otherPets: null,
          dailyRoutine: null,
          notes: null,
          motivation: `Quiero darle un hogar a ${name}.`,
          priorPets: "no",
          now: new Date(),
        },
        tx as Tx,
      );
      return eventId;
    });
  }

  return {
    petId: pet.id,
    titularOwnershipId: ownerRow.id,
    custodyId: accepted.value.ownershipId,
    listingCaseId: accepted.value.listingCaseId,
    applicationId,
  };
}

beforeAll(async () => {
  await purgePetsAndOrgs();
  for (const email of Object.values(USERS)) await purgeUserByEmail(email);

  for (const [key, email] of Object.entries(USERS) as Array<[keyof typeof USERS, string]>) {
    const r = await createFreshTestUser(supabaseAdmin, {
      email,
      password: PASS,
      email_confirm: true,
    });
    if (r.error || !r.data.user) throw new Error(`createUser ${key}: ${r.error?.message}`);
    ids[key] = r.data.user.id;
    await db
      .update(profiles)
      .set({ displayName: email.split("@")[0], role: "owner", accountType: "personal" })
      .where(eq(profiles.id, ids[key]));
  }

  const [orgA] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_A_TOKEN,
      legalName: "Refugio Duelo SRL",
      displayName: "Refugio Duelo",
      orgType: "shelter",
      email: `${ORG_A_TOKEN.toLowerCase()}@dim-test.local`,
      verified: true,
    })
    .returning({ id: organizations.id });
  orgAId = orgA.id;
  // The zone the org works in — the request rule refuses an org that does not
  // reach the pet's locality (W-4), same predicate the picker filters on.
  await db.insert(organizationCoverage).values({
    organizationId: orgAId,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
  });
  await db.insert(organizationMemberships).values({
    organizationId: orgAId,
    userId: ids.coordA,
    role: "admin",
    canWritePetEvents: true,
  });
  // Org B never sponsors anything: it is "another org" whose member happens
  // to record a death (a clinic, a foster org) — the M-2 scenario.
  const [orgB] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_B_TOKEN,
      legalName: "Refugio Ajeno SRL",
      displayName: "Refugio Ajeno",
      orgType: "shelter",
      email: `${ORG_B_TOKEN.toLowerCase()}@dim-test.local`,
      verified: true,
    })
    .returning({ id: organizations.id });
  orgBId = orgB.id;
  await db.insert(organizationMemberships).values({
    organizationId: orgBId,
    userId: ids.coordB,
    role: "admin",
    canWritePetEvents: true,
  });

  const lila = await plantSponsoredPet(PET_TOKEN, "Lila", { apply: true });
  petId = lila.petId;
  titularOwnershipId = lila.titularOwnershipId;
  custodyId = lila.custodyId;
  listingCaseId = lila.listingCaseId;
  applicationId = lila.applicationId as string;
  nube = await plantSponsoredPet(PET_RACE_TOKEN, "Nube", { apply: false });
  sol = await plantSponsoredPet(PET_OTHER_ORG_TOKEN, "Sol", { apply: true });
});

afterAll(async () => {
  await purgePetsAndOrgs();
  for (const email of Object.values(USERS)) await purgeUserByEmail(email);
  await pgSql.end({ timeout: 1 }).catch(() => {});
});

async function liveOwnerships(forPetId: string = petId) {
  return db
    .select({ id: ownerships.id, role: ownerships.role })
    .from(ownerships)
    .where(and(eq(ownerships.petId, forPetId), isNull(ownerships.endedAt)));
}

async function eventsOfType(type: string, forPetId: string = petId) {
  return db
    .select({
      payload: petEvents.payload,
      authorRole: petEvents.authorRole,
      authorOrganizationId: petEvents.authorOrganizationId,
      recordedByUserId: petEvents.recordedByUserId,
      caseId: petEvents.caseId,
    })
    .from(petEvents)
    .where(and(eq(petEvents.petId, forPetId), eq(petEvents.eventType, type)));
}

async function caseById(id: string) {
  const [row] = await db
    .select({
      status: cases.status,
      closedReason: cases.closedReason,
      closedBy: cases.closedByUserId,
      publicCode: cases.publicCode,
    })
    .from(cases)
    .where(eq(cases.id, id));
  return row;
}

async function petStatus(forPetId: string) {
  const [row] = await db
    .select({ status: pets.status, l: pets.adoptionListedAt, p: pets.adoptionListingPausedAt })
    .from(pets)
    .where(eq(pets.id, forPetId));
  return row;
}

const OWNER = { authorRole: "owner", authorOrganizationId: null, authorVerified: false };

function deathInput(
  pet: { id: string; name: string; status?: string },
  recordedByUserId: string,
  eventAuthorship: CreateDeathRecordInput["eventAuthorship"],
): CreateDeathRecordInput {
  return {
    pet: {
      id: pet.id,
      name: pet.name,
      status: pet.status ?? "active",
      rabiesObservationStatus: null,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    },
    recordedByUserId,
    eventAuthorship,
    cause: "natural",
    causeDetail: null,
    confirmedByVet: false,
    vetName: null,
    dispositionMethod: null,
    facility: null,
    occurredAt: new Date(),
    notes: null,
    deathAtClinic: false,
    clinicName: null,
    vetContactedOwner: null,
    vetDecidedAlone: false,
    ownerToPrivateCrematorium: false,
    diseaseCode: null,
    confirmedByLab: false,
    uploadedPath: null,
    uploadedMimeType: null,
    uploadedSize: null,
    clientIdempotencyKey: null,
    custodyEpisodeCaseId: null,
  };
}

function deathDeps(flushed: NewNotification[]) {
  return {
    repo: new EventsRepository(),
    transaction,
    flushNotifications: async (pending: NewNotification[]) => {
      flushed.push(...pending);
    },
  };
}

describe("control — the pet is sponsored, listed and applied-for going in", () => {
  it("live owner + custody rows, listed, one pending application, open listing case", async () => {
    const live = await liveOwnerships();
    expect(live.map((o) => o.role).sort()).toEqual(["owner", "shelter_custody"]);
    expect((await petStatus(petId)).l).not.toBeNull();
    expect(await findOpenSponsorship(petId, db)).toMatchObject({ ownershipId: custodyId });
    expect((await caseById(listingCaseId)).status).toBe("open");
    expect(await eventsOfType("adoption_application_resolved")).toHaveLength(0);
  });
});

describe("death_recorded on a sponsored pet — CASCADE D", () => {
  const flushed: NewNotification[] = [];

  it("ends the sponsorship in the same transaction: custody row closed, listing cleared, pet_deceased on the spine, cases closed, people told", async () => {
    const result = await createDeathRecord(
      deathInput({ id: petId, name: "Lila" }, ids.titular, OWNER),
      deathDeps(flushed),
    );
    expect(result.ok).toBe(true);

    // The org's row is closed; the titular's owner row is NOT (a death does
    // not change who the animal belonged to).
    const live = await liveOwnerships();
    expect(live.map((o) => o.role)).toEqual(["owner"]);
    expect(live[0].id).toBe(titularOwnershipId);

    // The listing cache is cleared in the same transaction, not left to the
    // catalog's status guard.
    const cols = await petStatus(petId);
    expect(cols.status).toBe("deceased");
    expect(cols.l).toBeNull();
    expect(cols.p).toBeNull();

    // The closing fact: outcome pet_deceased, naming the custody row, signed
    // by whoever recorded the death, attached to the listing case.
    const ended = await eventsOfType("rehome_sponsorship_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0].payload).toMatchObject({ ownership_id: custodyId, outcome: "pet_deceased" });
    expect(ended[0].authorRole).toBe("owner");
    expect(ended[0].recordedByUserId).toBe(ids.titular);
    expect(ended[0].caseId).toBe(listingCaseId);
    expect(await findOpenSponsorship(petId, db)).toBeNull();

    // Not an orphan: the row ended WITH its event.
    const orphans = await queryOrphanedSponsorships(pgSql);
    expect(orphans.map((o) => o.public_token)).not.toContain(PET_TOKEN);

    // The listing case and the application case both close, with a note.
    const listing = await caseById(listingCaseId);
    expect(listing.status).toBe("closed");
    expect(listing.closedReason).toBe("resolved");
    const [listingNote] = await db
      .select({ notes: caseEvents.notes })
      .from(caseEvents)
      .where(and(eq(caseEvents.caseId, listingCaseId), eq(caseEvents.entryType, "case_closed")));
    expect(listingNote?.notes).toMatch(/falleció/);

    const [appCase] = await db
      .select({ status: cases.status, closedReason: cases.closedReason })
      .from(cases)
      .where(
        and(
          eq(cases.primaryPetId, petId),
          eq(cases.caseKind, "adoption_application"),
          eq(cases.applicantUserId, ids.applicant),
        ),
      );
    expect(appCase?.status).toBe("closed");

    // The pending application is resolved on the spine — auto-generated, the
    // reason named, signed with the death's own authorship.
    const resolved = await eventsOfType("adoption_application_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].payload).toMatchObject({
      application_event_id: applicationId,
      outcome: "rejected",
      reason: "pet_deceased",
      auto_generated: true,
    });
    expect(resolved[0].authorRole).toBe("owner");

    // The people: the org's admins and the applicant, after commit.
    const orgNotice = flushed.find((n) => n.userId === ids.coordA);
    expect(orgNotice?.notificationType).toBe("rehome_sponsorship_ended_by_death");
    expect(orgNotice?.title).toContain("Lila");
    expect(orgNotice?.body).toMatch(/acompañamiento/);
    // UI-2: actionable — the closed sponsorship case, which the org's members
    // can still read once the custody row is gone.
    expect(orgNotice?.relatedCaseId).toBe(listingCaseId);
    expect(orgNotice?.ctaUrl).toBe(`/casos/${listing.publicCode}`);
    const applicantNotice = flushed.find((n) => n.userId === ids.applicant);
    expect(applicantNotice?.notificationType).toBe("adoption_application_closed");
    expect(applicantNotice?.body).toMatch(/falleció/);
    expect(applicantNotice?.body).toMatch(/No hace falta que hagas nada/);
    expect(applicantNotice?.ctaUrl).toBe("/adoptar");
  });

  it("a second death record is an idempotent noop: nothing ends twice, nobody is told twice", async () => {
    const again: NewNotification[] = [];
    const result = await createDeathRecord(
      deathInput({ id: petId, name: "Lila", status: "deceased" }, ids.titular, OWNER),
      deathDeps(again),
    );
    expect(result.ok).toBe(true);
    expect(await eventsOfType("rehome_sponsorship_ended")).toHaveLength(1);
    expect(
      again.filter((n) => n.notificationType === "rehome_sponsorship_ended_by_death"),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M-1 — the death transaction takes the pet advisory lock FIRST
// ---------------------------------------------------------------------------

describe("the titular's withdraw races the death (Nube) — the lock makes the withdraw visible", () => {
  async function otherConnectionCanTakeIt(forPetId: string): Promise<boolean> {
    return db.transaction(async (other) => {
      const rows = await other.execute<{ got: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${forPetId})) AS got`,
      );
      return rows[0].got;
    });
  }

  it("a withdraw that commits as the death reaches for its first lock is SEEN: nothing ends twice, the org is told nothing by the death", async () => {
    expect(await findOpenSponsorship(nube.petId, db)).toMatchObject({
      ownershipId: nube.custodyId,
    });

    // The race, made deterministic (the same device as
    // __tests__/rehome-withdraw-flow.test.ts): the moment the death
    // transaction reaches for its FIRST lock — the pet advisory lock — the
    // titular's withdraw has ALREADY committed on its own connection. The
    // cascade's read under the lock then finds no open sponsorship. Before
    // the fix, the death never reached for the lock at all: this spy is
    // never called, `raced` stays false, and the cascade's unlocked read
    // would have ended an arrangement the withdraw was ending too.
    let raced = false;
    const original = AdoptionRepository.acquirePetAdvisoryLock;
    const spy = vi
      .spyOn(AdoptionRepository, "acquirePetAdvisoryLock")
      .mockImplementation(async (lockedPetId, tx) => {
        if (!raced && lockedPetId === nube.petId) {
          raced = true;
          const w = await withdrawRehomeSponsorship(
            { petPublicToken: PET_RACE_TOKEN, titularUserId: ids.titular },
            { repo: RehomeRepository, now: () => new Date(), transaction },
          );
          if (!w.ok) throw new Error(`the racing withdraw failed: ${w.error}`);
        }
        return original.call(AdoptionRepository, lockedPetId, tx);
      });

    // Is the lock the DEATH transaction's own? Probe from another connection
    // after the body ran and before commit: a transaction-scoped advisory
    // lock held by the death refuses pg_try_advisory_xact_lock elsewhere.
    let heldByDeathTx: boolean | null = null;
    const probingTransaction = async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
      transaction(async (tx) => {
        const out = await cb(tx);
        heldByDeathTx = !(await otherConnectionCanTakeIt(nube.petId));
        return out;
      });

    const flushed: NewNotification[] = [];
    try {
      const result = await createDeathRecord(
        deathInput({ id: nube.petId, name: "Nube" }, ids.titular, OWNER),
        { ...deathDeps(flushed), transaction: probingTransaction },
      );
      expect(raced, "the withdraw ran inside the window").toBe(true);
      expect(result.ok ? "" : result.error).toBe("");
      expect(heldByDeathTx, "the death transaction holds the pet lock until commit").toBe(true);
    } finally {
      spy.mockRestore();
    }

    // The death is recorded; the arrangement ended ONCE, by the titular.
    expect((await petStatus(nube.petId)).status).toBe("deceased");
    const ended = await eventsOfType("rehome_sponsorship_ended", nube.petId);
    expect(ended.map((e) => (e.payload as { outcome: string }).outcome)).toEqual([
      "withdrawn_by_titular",
    ]);
    expect(await findOpenSponsorship(nube.petId, db)).toBeNull();
    expect(await otherConnectionCanTakeIt(nube.petId)).toBe(true);

    // Nobody is told by the DEATH that "el acompañamiento terminó" — it did
    // not end it. (The withdraw told the org, on its own path.)
    expect(
      flushed.filter((n) => n.notificationType === "rehome_sponsorship_ended_by_death"),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M-2 — another org's member records the death (Sol)
// ---------------------------------------------------------------------------

describe("recorded by another org's member (Sol) — the closing fact names the SPONSORING org", () => {
  it("refuses an author_role outside the enum before touching anything", async () => {
    await expect(
      transaction(async (tx) =>
        endSponsorshipForDeceasedPet(
          {
            petId: sol.petId,
            petName: "Sol",
            recordedByUserId: ids.coordB,
            authorRole: "wizard",
            authorVerified: false,
            now: new Date(),
          },
          tx as Tx,
        ),
      ),
      // OUR refusal, not Postgres's enum error after the rows were touched.
    ).rejects.toThrow(/is not a pet_events\.author_role/);
    expect(await findOpenSponsorship(sol.petId, db)).toMatchObject({ ownershipId: sol.custodyId });
    expect(await eventsOfType("rehome_sponsorship_ended", sol.petId)).toHaveLength(0);
  });

  it("rehome_sponsorship_ended and the auto-rejection carry org A's id, with org B's member as the recorder", async () => {
    const flushed: NewNotification[] = [];
    const result = await createDeathRecord(
      deathInput({ id: sol.petId, name: "Sol" }, ids.coordB, {
        authorRole: "shelter",
        authorOrganizationId: orgBId,
        authorVerified: true,
      }),
      deathDeps(flushed),
    );
    expect(result.ok ? "" : result.error).toBe("");

    // The death event itself keeps the recorder's full authorship — that IS
    // who recorded it.
    const [death] = await eventsOfType("death_recorded", sol.petId);
    expect(death.authorRole).toBe("shelter");
    expect(death.authorOrganizationId).toBe(orgBId);

    // The closing fact of org A's arrangement names org A — not the org of
    // whoever happened to record the death — while the role, the verification
    // and the person stay the recorder's.
    const [ended] = await eventsOfType("rehome_sponsorship_ended", sol.petId);
    expect(ended.payload).toMatchObject({ ownership_id: sol.custodyId, outcome: "pet_deceased" });
    expect(ended.authorRole).toBe("shelter");
    expect(ended.recordedByUserId).toBe(ids.coordB);
    expect(ended.authorOrganizationId).toBe(orgAId);

    // Same for the auto-rejection of the pending application: it is a
    // resolution on org A's listing.
    const [resolved] = await eventsOfType("adoption_application_resolved", sol.petId);
    expect(resolved.payload).toMatchObject({
      application_event_id: sol.applicationId,
      outcome: "rejected",
      reason: "pet_deceased",
      auto_generated: true,
      reviewer_user_id: ids.coordB,
    });
    expect(resolved.authorRole).toBe("shelter");
    expect(resolved.authorOrganizationId).toBe(orgAId);

    // And org A — the sponsor — is the org that is told.
    const told = flushed.filter((n) => n.notificationType === "rehome_sponsorship_ended_by_death");
    expect(told.map((n) => n.userId)).toEqual([ids.coordA]);
  });
});
