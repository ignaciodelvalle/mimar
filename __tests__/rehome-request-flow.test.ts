// The rehome_request lifecycle end to end — request, decline, accept
// (rehome-by-titular, WU3: spec REQ-1, REQ-2, REQ-4, REQ-5, REQ-16; design ADR-1).
//
// WHY THIS HITS REAL POSTGRES (the `db` vitest project, serial)
// ---------------------------------------------------------------------------
// The accept transaction is the first write path in DIM that deliberately
// produces a live owner + live shelter_custody pair, and its ordering is
// load-bearing against three partial unique indexes and one attachment rule
// (`rehome_sponsorship_started` requires the consent case to still be open
// when it is written). A mocked repository has none of those; it would pass
// against a transaction that writes the same rows in the wrong order.
//
// TEST ORDER IS LOAD-BEARING: later cases build on the rows earlier ones leave.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
import { queryAdoptionListing } from "@/src/modules/adoption/infrastructure/adoption-listing-read";
import { requestRehomeSponsorship } from "@/src/modules/rehome/application/request-rehome-sponsorship";
import { respondToRehomeRequest } from "@/src/modules/rehome/application/respond-to-rehome-request";
import { RehomeRepository } from "@/src/modules/rehome/infrastructure/rehome-repository";

import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const USERS = {
  titular: "rehome-flow-titular@dim-test.local",
  fosterer: "rehome-flow-fosterer@dim-test.local",
  caretaker: "rehome-flow-caretaker@dim-test.local",
  coowner: "rehome-flow-coowner@dim-test.local",
  coordA: "rehome-flow-coord-a@dim-test.local",
  coordB: "rehome-flow-coord-b@dim-test.local",
} as const;
const PASS = "RehomeFlow_2026!";

const ORG_A_TOKEN = "DIM-RHRQ-0001";
const ORG_B_TOKEN = "DIM-RHRQ-0002";
const ORG_VET_TOKEN = "DIM-RHRQ-0003";
const ORG_FAR_TOKEN = "DIM-RHRQ-0004";
const PET_TOKEN = "DIM-RHRQ-PET1";

const ids = {} as Record<keyof typeof USERS, string>;
let orgAId: string;
let orgBId: string;
let orgVetId: string;
let orgFarId: string;
let petId: string;
let titularOwnershipId: string;

const deps = () => ({ repo: RehomeRepository, now: () => new Date() });

const answerDeps = (userId: string, org: { id: string; displayName: string }) => ({
  repo: RehomeRepository,
  actor: { user: { id: userId }, organization: { ...org, verified: true } },
  now: () => new Date(),
  transaction: db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>,
});

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

async function purgePetAndOrgs(): Promise<void> {
  await withMutationOverride(async (tx) => {
    const stale = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN));
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
  });
  for (const token of [ORG_A_TOKEN, ORG_B_TOKEN, ORG_VET_TOKEN, ORG_FAR_TOKEN]) {
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

beforeAll(async () => {
  await purgePetAndOrgs();
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

  const insertOrg = async (token: string, name: string, orgType: "shelter" | "clinic") => {
    const [org] = await db
      .insert(organizations)
      .values({
        publicToken: token,
        legalName: `${name} SRL`,
        displayName: name,
        orgType,
        email: `${token.toLowerCase()}@dim-test.local`,
        verified: true,
      })
      .returning({ id: organizations.id });
    return org.id;
  };
  orgAId = await insertOrg(ORG_A_TOKEN, "Refugio Padrino", "shelter");
  orgBId = await insertOrg(ORG_B_TOKEN, "Refugio Vecino", "shelter");
  orgVetId = await insertOrg(ORG_VET_TOKEN, "Clínica Sur", "clinic");
  orgFarId = await insertOrg(ORG_FAR_TOKEN, "Refugio Lejano", "shelter");

  // Coverage is what the picker offers on: A covers the pet's exact locality,
  // B covers the whole province (locality IS NULL), and "Refugio Lejano"
  // covers another province entirely — a verified shelter the picker would
  // never show for this pet.
  await db.insert(organizationCoverage).values([
    {
      organizationId: orgAId,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    },
    { organizationId: orgBId, jurisdictionProvince: "Buenos Aires", jurisdictionLocality: null },
    { organizationId: orgFarId, jurisdictionProvince: "Córdoba", jurisdictionLocality: "Córdoba" },
  ]);

  await db.insert(organizationMemberships).values([
    { organizationId: orgAId, userId: ids.coordA, role: "admin", canWritePetEvents: true },
    { organizationId: orgBId, userId: ids.coordB, role: "admin", canWritePetEvents: true },
  ]);

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Malena",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      inCustodyDispute: false,
      rabiesObservationStatus: null,
    })
    .returning({ id: pets.id });
  petId = pet.id;

  const now = new Date();
  const [ownerRow] = await db
    .insert(ownerships)
    .values({ petId, ownerUserId: ids.titular, role: "owner", startedAt: now })
    .returning({ id: ownerships.id });
  titularOwnershipId = ownerRow.id;
  // A foster on the same pet: they must never be able to open a request.
  await db
    .insert(ownerships)
    .values({ petId, ownerUserId: ids.fosterer, role: "foster", startedAt: now });
  // A caretaker (custodia temporal) on the same pet, for REQ-14's third
  // clause: the deny-list names the role explicitly, and the rule needs a
  // runtime fixture, not only the foster/co_owner siblings (verify report S-2).
  await db
    .insert(ownerships)
    .values({ petId, ownerUserId: ids.caretaker, role: "caretaker", startedAt: now });
});

afterAll(async () => {
  await purgePetAndOrgs();
  for (const email of Object.values(USERS)) await purgeUserByEmail(email);
});

async function requestCasesForPet() {
  return db
    .select()
    .from(cases)
    .where(and(eq(cases.primaryPetId, petId), eq(cases.caseKind, "rehome_request")));
}

async function liveOwnerships() {
  return db
    .select({ id: ownerships.id, role: ownerships.role, org: ownerships.ownerOrganizationId })
    .from(ownerships)
    .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
}

describe("request — who may ask, and whom (REQ-1, REQ-16)", () => {
  it("a foster on the pet cannot open a rehome_request — no case is created", async () => {
    const r = await requestRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.fosterer, targetOrgId: orgAId },
      deps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/titular/);
    expect(await requestCasesForPet()).toHaveLength(0);
  });

  it("a caretaker on the pet cannot open a rehome_request — REQ-14 names the role, the fixture holds the row", async () => {
    // `caretaker` is a live ownership row like foster's, granted by the titular
    // for a bounded period (custodia temporal). It may record medical events;
    // consent to hand the listing to an org is the titular's alone.
    const r = await requestRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.caretaker, targetOrgId: orgAId },
      deps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/titular/);
    expect(await requestCasesForPet()).toHaveLength(0);
  });

  it("a co-owner on the pet cannot open a rehome_request either — REQ-1 names the titular only", async () => {
    // `co_owner` is a live Path-1 row like foster's; the titular gate lets it
    // through for the other titular actions. Consent to hand the listing to an
    // org is the one thing it may not give (spec REQ-1, REQ-14).
    const [row] = await db
      .insert(ownerships)
      .values({ petId, ownerUserId: ids.coowner, role: "co_owner", startedAt: new Date() })
      .returning({ id: ownerships.id });
    try {
      const r = await requestRehomeSponsorship(
        { petPublicToken: PET_TOKEN, titularUserId: ids.coowner, targetOrgId: orgAId },
        deps(),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/titular/);
      expect(await requestCasesForPet()).toHaveLength(0);
    } finally {
      await db.delete(ownerships).where(eq(ownerships.id, row.id));
    }
  });

  it("a verified org of the wrong type is refused before anything is written", async () => {
    const r = await requestRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular, targetOrgId: orgVetId },
      deps(),
    );
    expect(r.ok).toBe(false);
    expect(await requestCasesForPet()).toHaveLength(0);
  });

  it("a verified shelter that does not cover the pet's zone is refused — the picker's filter is a rule, not a view", async () => {
    // The picker (buscar-hogar/page.tsx) only lists orgs whose coverage
    // includes the pet's province+locality, but the request is a server
    // action: any titular session can POST any orgId. Without the rule in the
    // domain, "Refugio Lejano" (Córdoba) gets a rehome_request for a pet in
    // La Plata and it lands in its inbox.
    const r = await requestRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular, targetOrgId: orgFarId },
      deps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Refugio Lejano no cubre la zona de Malena/);
    expect(await requestCasesForPet()).toHaveLength(0);
  });

  it("the titular opens a real case with a CAS- code addressed to the sponsoring org (REQ-2)", async () => {
    const r = await requestRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular, targetOrgId: orgAId },
      deps(),
    );
    expect(r.ok ? "" : r.error).toBe("");
    if (!r.ok) return;
    expect(r.value.casePublicCode).toMatch(/^CAS-/);

    const [row] = await requestCasesForPet();
    expect(row.publicCode).toBe(r.value.casePublicCode);
    expect(row.status).toBe("open");
    expect(row.receiverOrganizationId).toBe(orgAId);
    // The TITULAR opens this case. The org is the receiver, never the opener.
    expect(row.openedByOrganizationId).toBeNull();
    expect(row.openedByUserId).toBe(ids.titular);
    expect(row.jurisdictionProvince).toBe("Buenos Aires");
    expect(row.jurisdictionLocality).toBe("La Plata");
    expect(row.openedReasonCode).toBe("rehome_requested");
    expect(row.openedReasonParams).toEqual({ orgDisplayName: "Refugio Padrino" });

    // The org's admins/coordinators are told, and the CTA is the CASE — the
    // case is what solves the "zero consumers" problem, not the notification.
    expect(r.notifications.map((n) => n.userId)).toEqual([ids.coordA]);
    expect(r.notifications[0].notificationType).toBe("rehome_request_received");
    expect(r.notifications[0].ctaUrl).toBe(`/casos/${r.value.casePublicCode}`);
    expect(r.notifications[0].relatedCaseId).toBe(row.id);
    expect(r.notifications[0].body).toContain("Malena");
  });

  it("a pending request writes NOTHING to the spine and touches no ownership row", async () => {
    const events = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(eq(petEvents.petId, petId));
    expect(events).toHaveLength(0);
    const live = await liveOwnerships();
    expect(live.map((o) => o.role).sort()).toEqual(["caretaker", "foster", "owner"]);
    expect(live.find((o) => o.role === "owner")?.id).toBe(titularOwnershipId);
  });

  it("a second request while the first is pending is refused — one per pet at a time (REQ-16)", async () => {
    const r = await requestRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular, targetOrgId: orgBId },
      deps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pendiente/);
    expect(await requestCasesForPet()).toHaveLength(1);
  });

  it("a double-submit that slips past the pre-read is refused by the index with the SAME message — never a 500", async () => {
    // The port seam, used honestly: the pre-read is stale by construction under
    // a race (two submits, both read "no open request"), so the test makes it
    // stale on purpose while the index (`cases_open_per_pet_kind_idx`) is real.
    const staleRepo = { ...RehomeRepository, findOpenRequestForPet: async () => null };
    const r = await requestRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular, targetOrgId: orgBId },
      { repo: staleRepo, now: () => new Date() },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pendiente/);
    expect(await requestCasesForPet()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The org answers
// ---------------------------------------------------------------------------

let firstCode: string;
let secondCode: string;

async function openRequest() {
  const [row] = (await requestCasesForPet()).filter((c) => c.status === "open");
  return row ?? null;
}

async function closedEntryFor(caseId: string) {
  const [entry] = await db
    .select({
      notes: caseEvents.notes,
      payload: caseEvents.payload,
      by: caseEvents.recordedByUserId,
    })
    .from(caseEvents)
    .where(and(eq(caseEvents.caseId, caseId), eq(caseEvents.entryType, "case_closed")));
  return entry ?? null;
}

describe("decline — the case closes with a reason the titular can read (REQ-5)", () => {
  it("a member of a different org cannot answer — the case stays open", async () => {
    const open = await openRequest();
    firstCode = open?.publicCode ?? "";
    const r = await respondToRehomeRequest(
      { casePublicCode: firstCode, decision: "decline" },
      answerDeps(ids.coordB, { id: orgBId, displayName: "Refugio Vecino" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/otra organización/);
    expect((await openRequest())?.publicCode).toBe(firstCode);
  });

  it("the sponsoring org declines: closed as cancelled BY the org, nothing about the animal changes", async () => {
    const r = await respondToRehomeRequest(
      { casePublicCode: firstCode, decision: "decline" },
      answerDeps(ids.coordA, { id: orgAId, displayName: "Refugio Padrino" }),
    );
    expect(r.ok ? "" : r.error).toBe("");
    if (!r.ok) return;

    const [row] = (await requestCasesForPet()).filter((c) => c.publicCode === firstCode);
    expect(row.status).toBe("closed");
    expect(row.closedReason).toBe("cancelled");
    expect(row.closedByUserId).toBe(ids.coordA);

    // The decline-specific signal: a timeline entry naming the org as the actor,
    // so "Cancelada" never reads like the titular's own cancel or an operator's.
    const entry = await closedEntryFor(row.id);
    expect(entry?.notes).toContain("Refugio Padrino");
    expect(entry?.notes).toMatch(/rechaz/);
    expect((entry?.payload as { rehome_decision?: string }).rehome_decision).toBe("declined");

    const live = await liveOwnerships();
    expect(live.map((o) => o.role).sort()).toEqual(["caretaker", "foster", "owner"]);
    const events = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(eq(petEvents.petId, petId));
    expect(events).toHaveLength(0);
    const [pet] = await db
      .select({ listedAt: pets.adoptionListedAt })
      .from(pets)
      .where(eq(pets.id, petId));
    expect(pet.listedAt).toBeNull();

    expect(r.notifications).toHaveLength(1);
    expect(r.notifications[0].userId).toBe(ids.titular);
    expect(r.notifications[0].notificationType).toBe("rehome_request_declined");
    expect(r.notifications[0].title).toContain("Refugio Padrino");
    expect(r.notifications[0].ctaUrl).toBe(`/casos/${firstCode}`);
  });

  it("answering an already-answered request is refused", async () => {
    const r = await respondToRehomeRequest(
      { casePublicCode: firstCode, decision: "accept" },
      answerDeps(ids.coordA, { id: orgAId, displayName: "Refugio Padrino" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ya fue respondida/);
  });

  it("after a decline the titular can ask again — a new case, not a reopen", async () => {
    const r = await requestRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular, targetOrgId: orgAId },
      deps(),
    );
    expect(r.ok ? "" : r.error).toBe("");
    if (!r.ok) return;
    secondCode = r.value.casePublicCode;
    expect(secondCode).not.toBe(firstCode);
    expect(await requestCasesForPet()).toHaveLength(2);
  });
});

describe("accept — custody opens beside the owner row, consent goes on the spine (REQ-4, ADR-1)", () => {
  const acceptAsA = () =>
    respondToRehomeRequest(
      { casePublicCode: secondCode, decision: "accept" },
      answerDeps(ids.coordA, { id: orgAId, displayName: "Refugio Padrino" }),
    );

  it("step 4: a pet in custody dispute is refused with a reason and nothing is written", async () => {
    await db.update(pets).set({ inCustodyDispute: true }).where(eq(pets.id, petId));
    const r = await acceptAsA();
    await db.update(pets).set({ inCustodyDispute: false }).where(eq(pets.id, petId));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/disputa de custodia/);
    expect((await openRequest())?.publicCode).toBe(secondCode);
    expect((await liveOwnerships()).map((o) => o.role).sort()).toEqual([
      "caretaker",
      "foster",
      "owner",
    ]);
  });

  it("step 4: a time-boxed ineligibility set by an earlier custodian is refused, not erased (L-3)", async () => {
    // A previous org (a decomiso receiver, say) marked the pet "not eligible
    // until" a date and then released custody. The accept's setEligibility(true)
    // would null that column; while the date is in force it must refuse instead.
    const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db
      .update(pets)
      .set({
        adoptionEligible: false,
        adoptionEligibilitySetAt: new Date(),
        adoptionIneligibleReason: "quarantine",
        adoptionIneligibleUntil: until,
      })
      .where(eq(pets.id, petId));
    try {
      const r = await acceptAsA();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/no apta para adopción hasta/);
      expect((await openRequest())?.publicCode).toBe(secondCode);
      expect((await liveOwnerships()).map((o) => o.role).sort()).toEqual([
        "caretaker",
        "foster",
        "owner",
      ]);
      const [pet] = await db
        .select({ until: pets.adoptionIneligibleUntil, reason: pets.adoptionIneligibleReason })
        .from(pets)
        .where(eq(pets.id, petId));
      expect(pet.until?.getTime()).toBe(until.getTime());
      expect(pet.reason).toBe("quarantine");
    } finally {
      await db
        .update(pets)
        .set({
          adoptionEligible: null,
          adoptionEligibilitySetAt: null,
          adoptionIneligibleReason: null,
          adoptionIneligibleUntil: null,
        })
        .where(eq(pets.id, petId));
    }
  });

  it("step 2: consent expires with title — a request from an ex-owner is refused", async () => {
    await db
      .update(ownerships)
      .set({ endedAt: new Date() })
      .where(eq(ownerships.id, titularOwnershipId));
    const r = await acceptAsA();
    await db.update(ownerships).set({ endedAt: null }).where(eq(ownerships.id, titularOwnershipId));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ya no es titular/);
    expect((await liveOwnerships()).map((o) => o.role).sort()).toEqual([
      "caretaker",
      "foster",
      "owner",
    ]);
  });

  it("step 1b: an org de-verified since the request is refused under the lock — zero writes", async () => {
    // The session snapshot still says verified (answerDeps passes `verified:
    // true`); the use-case re-reads the org row inside the transaction and
    // must believe the row, not the session. Otherwise: custody + eligible +
    // listed + spine event + "ya figura en la búsqueda" — and the catalog never
    // shows the pet, because adoption-listing-read.ts requires verified=true.
    await db.update(organizations).set({ verified: false }).where(eq(organizations.id, orgAId));
    try {
      const r = await acceptAsA();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/no está verificada/);
      expect((await openRequest())?.publicCode).toBe(secondCode);
      expect((await liveOwnerships()).map((o) => o.role).sort()).toEqual([
        "caretaker",
        "foster",
        "owner",
      ]);
      const events = await db
        .select({ id: petEvents.id })
        .from(petEvents)
        .where(eq(petEvents.petId, petId));
      expect(events).toHaveLength(0);
      const [pet] = await db
        .select({ listedAt: pets.adoptionListedAt })
        .from(pets)
        .where(eq(pets.id, petId));
      expect(pet.listedAt).toBeNull();
    } finally {
      await db.update(organizations).set({ verified: true }).where(eq(organizations.id, orgAId));
    }
  });

  it("step 1b: an org whose type the catalog does not list is refused the same way", async () => {
    await db.update(organizations).set({ orgType: "clinic" }).where(eq(organizations.id, orgAId));
    try {
      const r = await acceptAsA();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/refugio o una red de rescate/);
      expect((await openRequest())?.publicCode).toBe(secondCode);
      expect((await liveOwnerships()).map((o) => o.role).sort()).toEqual([
        "caretaker",
        "foster",
        "owner",
      ]);
    } finally {
      await db
        .update(organizations)
        .set({ orgType: "shelter" })
        .where(eq(organizations.id, orgAId));
    }
  });

  it("step 3: a pet already under another org's custody is refused by the pre-check — nothing is written", async () => {
    const [bRow] = await db
      .insert(ownerships)
      .values({
        petId,
        ownerOrganizationId: orgBId,
        role: "shelter_custody",
        startedAt: new Date(),
      })
      .returning({ id: ownerships.id });
    try {
      const r = await acceptAsA();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/bajo custodia de una organización/);
      expect((await openRequest())?.publicCode).toBe(secondCode);
    } finally {
      await db.delete(ownerships).where(eq(ownerships.id, bRow.id));
    }
  });

  it("step 3 under a race: a custody row committed after the pre-read hits the index, is mapped to the same refusal, and the transaction rolls back", async () => {
    // Org B won a race for custody between the pre-read and the insert. The
    // port seam makes the pre-read stale on purpose (countLiveShelterCustody
    // says 0, as it would have a moment earlier) while the index
    // `ownerships_one_active_org_shelter_custody_per_pet` is real. Under the
    // old code this surfaced as a thrown DrizzleQueryError — a 500 for the org.
    const petColumns = {
      eligible: pets.adoptionEligible,
      eligibleAt: pets.adoptionEligibilitySetAt,
      listedAt: pets.adoptionListedAt,
    };
    const [petBefore] = await db.select(petColumns).from(pets).where(eq(pets.id, petId));
    expect(petBefore.listedAt).toBeNull();

    const [bRow] = await db
      .insert(ownerships)
      .values({
        petId,
        ownerOrganizationId: orgBId,
        role: "shelter_custody",
        startedAt: new Date(),
      })
      .returning({ id: ownerships.id });
    try {
      const staleRepo = { ...RehomeRepository, countLiveShelterCustody: async () => 0 };
      const r = await respondToRehomeRequest(
        { casePublicCode: secondCode, decision: "accept" },
        {
          ...answerDeps(ids.coordA, { id: orgAId, displayName: "Refugio Padrino" }),
          repo: staleRepo,
        },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/bajo custodia de una organización/);

      // Rolled back: the request is still open, nothing reached the spine, no
      // custody row for A landed, the pet's eligibility and listing columns
      // are byte-identical to before the call.
      expect((await openRequest())?.publicCode).toBe(secondCode);
      const live = await liveOwnerships();
      expect(live.map((o) => o.role).sort()).toEqual([
        "caretaker",
        "foster",
        "owner",
        "shelter_custody",
      ]);
      expect(live.find((o) => o.role === "shelter_custody")?.org).toBe(orgBId);
      const events = await db
        .select({ id: petEvents.id })
        .from(petEvents)
        .where(eq(petEvents.petId, petId));
      expect(events).toHaveLength(0);
      const [petAfter] = await db.select(petColumns).from(pets).where(eq(pets.id, petId));
      expect(petAfter).toEqual(petBefore);
    } finally {
      await db.delete(ownerships).where(eq(ownerships.id, bRow.id));
    }
  });

  it("the sponsoring org accepts: two live rows, the consent event attached to the request, the listing open", async () => {
    const r = await acceptAsA();
    expect(r.ok ? "" : r.error).toBe("");
    if (!r.ok) return;
    expect(r.value.ownershipId).toBeTruthy();
    expect(r.value.listingCaseId).toBeTruthy();

    // Ownership: the titular's row is UNTOUCHED, the org's row is NEW, no foster
    // row was created for the titular (the fixture's foster row is the other user's).
    const live = await liveOwnerships();
    expect(live.map((o) => o.role).sort()).toEqual([
      "caretaker",
      "foster",
      "owner",
      "shelter_custody",
    ]);
    expect(live.find((o) => o.role === "owner")?.id).toBe(titularOwnershipId);
    const custody = live.find((o) => o.role === "shelter_custody");
    expect(custody?.id).toBe(r.value.ownershipId);
    expect(custody?.org).toBe(orgAId);
    const titularRows = await db
      .select({ role: ownerships.role })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), eq(ownerships.ownerUserId, ids.titular)));
    expect(titularRows.map((x) => x.role)).toEqual(["owner"]);

    // The spine: eligibility set by the org, consent recorded and attached to
    // the REQUEST case (requires-open), naming the custody row it opened.
    const events = await db
      .select({ type: petEvents.eventType, payload: petEvents.payload, caseId: petEvents.caseId })
      .from(petEvents)
      .where(eq(petEvents.petId, petId));
    expect(events.map((e) => e.type).sort()).toEqual([
      "adoption_eligibility_set",
      "rehome_sponsorship_started",
    ]);
    const [requestRow] = (await requestCasesForPet()).filter((c) => c.publicCode === secondCode);
    const started = events.find((e) => e.type === "rehome_sponsorship_started");
    expect(started?.caseId).toBe(requestRow.id);
    expect(started?.payload).toMatchObject({
      ownership_id: r.value.ownershipId,
      sponsoring_organization_id: orgAId,
      consented_by_user_id: ids.titular,
      request_case_public_code: secondCode,
      listing_case_id: r.value.listingCaseId,
    });

    // Cases: the request is answered (resolved, by the org member), the
    // adoption_listing — the sponsorship itself — is open and the org's.
    expect(requestRow.status).toBe("closed");
    expect(requestRow.closedReason).toBe("resolved");
    expect(requestRow.closedByUserId).toBe(ids.coordA);
    const entry = await closedEntryFor(requestRow.id);
    expect(entry?.notes).toContain("Refugio Padrino");
    expect((entry?.payload as { rehome_decision?: string }).rehome_decision).toBe("accepted");
    const [listing] = await db
      .select()
      .from(cases)
      .where(eq(cases.id, r.value.listingCaseId ?? ""));
    expect(listing.caseKind).toBe("adoption_listing");
    expect(listing.status).toBe("open");
    expect(listing.openedByOrganizationId).toBe(orgAId);

    // The cache: eligible + published, and the catalog lists the pet with no
    // predicate change (the PO's accepted "custodia" overload, proven).
    const [pet] = await db
      .select({
        eligible: pets.adoptionEligible,
        listedAt: pets.adoptionListedAt,
        pausedAt: pets.adoptionListingPausedAt,
      })
      .from(pets)
      .where(eq(pets.id, petId));
    expect(pet.eligible).toBe(true);
    expect(pet.listedAt).not.toBeNull();
    expect(pet.pausedAt).toBeNull();
    const { items } = await queryAdoptionListing({ organizationToken: ORG_A_TOKEN }, null);
    expect(items.map((i) => i.petPublicToken)).toContain(PET_TOKEN);

    expect(r.notifications).toHaveLength(1);
    expect(r.notifications[0].userId).toBe(ids.titular);
    expect(r.notifications[0].notificationType).toBe("rehome_request_accepted");
    expect(r.notifications[0].title).toContain("Refugio Padrino");
    expect(r.notifications[0].ctaUrl).toBe(`/casos/${secondCode}`);
  });

  it("accepting the same request again is refused and leaves exactly one live custody row", async () => {
    const r = await acceptAsA();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ya fue respondida/);
    const live = await liveOwnerships();
    expect(live.filter((o) => o.role === "shelter_custody")).toHaveLength(1);
  });

  it("REQ-16 while sponsored: a new request is refused because a sponsorship is running", async () => {
    const r = await requestRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular, targetOrgId: orgBId },
      deps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ya tiene una organización acompañando/);
    expect(await requestCasesForPet()).toHaveLength(2);
  });
});
