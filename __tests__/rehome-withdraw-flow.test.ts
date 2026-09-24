// The titular's two exits from rehome-by-titular, end to end (WU4):
//   - WITHDRAW an ACTIVE sponsorship (spec REQ-8, REQ-10, REQ-15; design WU4)
//   - CANCEL a still-PENDING request (spec REQ-3; WU3 review M-3)
//
// WHY THIS HITS REAL POSTGRES (the `db` vitest project, serial)
// ---------------------------------------------------------------------------
// The withdraw is the one-way door's escape hatch: the design says never ship
// WU3 without it. Its claims are about what survives ONE transaction across
// ownerships, pets, pet_events and cases — and about what the catalog query
// and the org's own listing use-case see afterwards. A mocked repository
// would pass against a withdraw that closes the row and forgets the spine.
//
// TEST ORDER IS LOAD-BEARING: the fixture is sponsored going in; the cases
// consume and rebuild that state in sequence. Do not reorder.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, eq, isNull, sql } from "drizzle-orm";
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
import { dniLast4, hashDni } from "@/lib/utils/dni-hash";
import { finalizeAdoption } from "@/src/modules/adoption/application/finalize-adoption";
import { setAdoptionListingStatus } from "@/src/modules/adoption/application/set-adoption-listing-status";
import { queryAdoptionListing } from "@/src/modules/adoption/infrastructure/adoption-listing-read";
import { AdoptionRepository } from "@/src/modules/adoption/infrastructure/adoption-repository";
import { findOpenSponsorship } from "@/src/modules/adoption/infrastructure/rehome-sponsorship-writer";
import { requestRehomeSponsorship } from "@/src/modules/rehome/application/request-rehome-sponsorship";
import { respondToRehomeRequest } from "@/src/modules/rehome/application/respond-to-rehome-request";
import { withdrawRehomeRequest } from "@/src/modules/rehome/application/withdraw-rehome-request";
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
  titular: "rehome-withdraw-titular@dim-test.local",
  fosterer: "rehome-withdraw-fosterer@dim-test.local",
  coordA: "rehome-withdraw-coord-a@dim-test.local",
  // The cascade's two applicants (WU5 carry-forward 1): one the org already
  // APPROVED and was about to finalize, one still PENDING review.
  applicantApproved: "rehome-withdraw-applicant-a@dim-test.local",
  applicantPending: "rehome-withdraw-applicant-b@dim-test.local",
  // The finalize-vs-withdraw race (WU5 carry-forward 3): a registered adopter
  // resolved by the manual-DNI branch of finalize-adoption.
  adopter: "rehome-withdraw-adopter@dim-test.local",
} as const;
const PASS = "RehomeWithdraw_2026!";

const ORG_A_TOKEN = "DIM-RHWD-0001";
const PET_TOKEN = "DIM-RHWD-PET1";
const ADOPTER_DNI = "30777002";

const ids = {} as Record<keyof typeof USERS, string>;
let orgAId: string;
let petId: string;
let titularOwnershipId: string;
let firstCustodyId: string;
let firstListingCaseId: string;
let firstRequestCode: string;

/**
 * The bearer door's replay keys (2026-09-10). The titular's two exits below
 * carry one each, and the step after each exit re-sends the SAME key: the
 * ledger must answer the way the first attempt did, over a spine that now has
 * nothing to withdraw.
 */
const WITHDRAW_KEY = "0b1e7a52-6c3d-4f8e-9a1b-2c3d4e5f6071";
const CANCEL_KEY = "9c8b7a65-4d3e-4f2a-8b1c-0d9e8f7a6b5c";

const transaction = db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
const requestDeps = () => ({ repo: RehomeRepository, now: () => new Date() });
const withdrawDeps = () => ({ repo: RehomeRepository, now: () => new Date(), transaction });
const answerDeps = (userId: string) => ({
  repo: RehomeRepository,
  actor: {
    user: { id: userId },
    organization: { id: orgAId, displayName: "Refugio Padrino", verified: true },
  },
  now: () => new Date(),
  transaction,
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

async function purgePetAndOrg(): Promise<void> {
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
  const staleOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, ORG_A_TOKEN));
  for (const { id } of staleOrgs) {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, id));
    await db.delete(organizations).where(eq(organizations.id, id));
  }
}

/** The real path to a sponsored pet: the titular asks, the org accepts. */
async function sponsor(): Promise<{
  custodyId: string;
  listingCaseId: string;
  requestCode: string;
}> {
  const requested = await requestRehomeSponsorship(
    { petPublicToken: PET_TOKEN, titularUserId: ids.titular, targetOrgId: orgAId },
    requestDeps(),
  );
  if (!requested.ok) throw new Error(`request failed: ${requested.error}`);
  const accepted = await respondToRehomeRequest(
    { casePublicCode: requested.value.casePublicCode, decision: "accept" },
    answerDeps(ids.coordA),
  );
  if (!accepted.ok) throw new Error(`accept failed: ${accepted.error}`);
  if (!accepted.value.ownershipId || !accepted.value.listingCaseId) {
    throw new Error("accept returned no custody row / listing case");
  }
  return {
    custodyId: accepted.value.ownershipId,
    listingCaseId: accepted.value.listingCaseId,
    requestCode: requested.value.casePublicCode,
  };
}

beforeAll(async () => {
  await purgePetAndOrg();
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
  // The manual-DNI branch of finalize-adoption matches on dniHash and requires
  // a real auth account (no stub creation since org-pilot-pack).
  await db
    .update(profiles)
    .set({
      phone: "+541133330002",
      dniHash: hashDni(ADOPTER_DNI),
      dniLast4: dniLast4(ADOPTER_DNI),
      dniVerified: true,
    })
    .where(eq(profiles.id, ids.adopter));

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_A_TOKEN,
      legalName: "Refugio Padrino SRL",
      displayName: "Refugio Padrino",
      orgType: "shelter",
      email: `${ORG_A_TOKEN.toLowerCase()}@dim-test.local`,
      verified: true,
    })
    .returning({ id: organizations.id });
  orgAId = org.id;
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

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Tango",
      species: "dog",
      sex: "male",
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
  await db
    .insert(ownerships)
    .values({ petId, ownerUserId: ids.fosterer, role: "foster", startedAt: now });

  const sponsored = await sponsor();
  firstCustodyId = sponsored.custodyId;
  firstListingCaseId = sponsored.listingCaseId;
  firstRequestCode = sponsored.requestCode;
});

afterAll(async () => {
  await purgePetAndOrg();
  for (const email of Object.values(USERS)) await purgeUserByEmail(email);
});

async function liveOwnerships() {
  return db
    .select({ id: ownerships.id, role: ownerships.role, org: ownerships.ownerOrganizationId })
    .from(ownerships)
    .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
}

async function petListingColumns() {
  const [row] = await db
    .select({
      eligible: pets.adoptionEligible,
      listedAt: pets.adoptionListedAt,
      pausedAt: pets.adoptionListingPausedAt,
    })
    .from(pets)
    .where(eq(pets.id, petId));
  return row;
}

async function spineTypes() {
  const rows = await db
    .select({ type: petEvents.eventType })
    .from(petEvents)
    .where(eq(petEvents.petId, petId));
  return rows.map((r) => r.type).sort();
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

async function inCatalog(): Promise<boolean> {
  const { items } = await queryAdoptionListing({ organizationToken: ORG_A_TOKEN }, null);
  return items.some((i) => i.petPublicToken === PET_TOKEN);
}

const openSponsorship = () =>
  findOpenSponsorship(petId, db as unknown as Parameters<typeof findOpenSponsorship>[1]);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function resolvedEventsFor(applicationId: string) {
  const rows = await db
    .select({
      payload: petEvents.payload,
      authorRole: petEvents.authorRole,
      authorOrganizationId: petEvents.authorOrganizationId,
      recordedByUserId: petEvents.recordedByUserId,
    })
    .from(petEvents)
    .where(
      and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_application_resolved")),
    );
  return rows.filter(
    (r) => (r.payload as { application_event_id?: string }).application_event_id === applicationId,
  );
}

async function applicationCaseFor(applicantUserId: string) {
  const [row] = await db
    .select({
      id: cases.id,
      status: cases.status,
      closedReason: cases.closedReason,
      closedByUserId: cases.closedByUserId,
    })
    .from(cases)
    .where(
      and(
        eq(cases.primaryPetId, petId),
        eq(cases.caseKind, "adoption_application"),
        eq(cases.applicantUserId, applicantUserId),
      ),
    );
  return row ?? null;
}

/** Submit an application through the repository writer (opens its case). */
async function apply(applicantUserId: string): Promise<string> {
  return db.transaction(async (tx) => {
    const { eventId } = await AdoptionRepository.insertApplication(
      {
        petId,
        userId: applicantUserId,
        orgId: orgAId,
        housingType: "casa_con_patio",
        otherPets: null,
        dailyRoutine: null,
        notes: null,
        motivation: "Quiero darle un hogar a Tango.",
        priorPets: "no",
        now: new Date(),
      },
      tx as Tx,
    );
    return eventId;
  });
}

let approvedApplicationId: string;
let pendingApplicationId: string;

// ---------------------------------------------------------------------------
// Withdraw an ACTIVE sponsorship
// ---------------------------------------------------------------------------

describe("withdraw — the control: the pet is sponsored going in", () => {
  it("open sponsorship on the live custody row, listed, in the catalog", async () => {
    expect((await openSponsorship())?.ownershipId).toBe(firstCustodyId);
    const live = await liveOwnerships();
    expect(live.map((o) => o.role).sort()).toEqual(["foster", "owner", "shelter_custody"]);
    const cols = await petListingColumns();
    expect(cols.eligible).toBe(true);
    expect(cols.listedAt).not.toBeNull();
    expect(await inCatalog()).toBe(true);
  });

  it("two applicants are waiting: one approved by the org, one still pending (the cascade's fixture)", async () => {
    approvedApplicationId = await apply(ids.applicantApproved);
    pendingApplicationId = await apply(ids.applicantPending);
    await db.transaction(async (tx) => {
      await AdoptionRepository.resolveApplication(
        {
          petId,
          applicationEventId: approvedApplicationId,
          outcome: "approved",
          reviewerUserId: ids.coordA,
          orgId: orgAId,
          orgVerified: true,
          notes: null,
          now: new Date(),
        },
        tx as Tx,
      );
    });

    expect((await resolvedEventsFor(approvedApplicationId)).length).toBe(1);
    expect((await resolvedEventsFor(pendingApplicationId)).length).toBe(0);
    expect((await applicationCaseFor(ids.applicantApproved))?.status).toBe("open");
    expect((await applicationCaseFor(ids.applicantPending))?.status).toBe("open");
    // Both org-side readers see their application today — this is what the
    // withdraw below must close honestly rather than leave stranded.
    const forFinalize = await AdoptionRepository.findApprovedApplicationForFinalize(
      approvedApplicationId,
      orgAId,
      petId,
    );
    expect("error" in forFinalize).toBe(false);
    const forReview = await AdoptionRepository.findApplicationForReview(
      pendingApplicationId,
      orgAId,
    );
    expect("error" in forReview).toBe(false);
  });
});

describe("withdraw — who may, and what one transaction does (REQ-8, REQ-10, REQ-14)", () => {
  it("a foster on the pet cannot withdraw — the arrangement is untouched", async () => {
    const r = await withdrawRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.fosterer },
      withdrawDeps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/titular/);
    expect((await openSponsorship())?.ownershipId).toBe(firstCustodyId);
    expect((await liveOwnerships()).map((o) => o.role).sort()).toEqual([
      "foster",
      "owner",
      "shelter_custody",
    ]);
    expect(await inCatalog()).toBe(true);
  });

  it("the titular withdraws: custody closes, the listing clears, the spine says withdrawn_by_titular, the listing case closes, the owner row is never touched, the org is told", async () => {
    const r = await withdrawRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular, clientIdempotencyKey: WITHDRAW_KEY },
      withdrawDeps(),
    );
    expect(r.ok ? "" : r.error).toBe("");
    if (!r.ok) return;
    expect(r.value.replayed).toBe(false);
    expect(r.value.sponsoringOrganizationId).toBe(orgAId);
    expect(r.value.petPublicToken).toBe(PET_TOKEN);

    // Ownership: the org's row is closed; the titular's row is the SAME row,
    // still live (REQ-8: withdraw only ever closes the org's row).
    const live = await liveOwnerships();
    expect(live.map((o) => o.role).sort()).toEqual(["foster", "owner"]);
    expect(live.find((o) => o.role === "owner")?.id).toBe(titularOwnershipId);
    const [custody] = await db
      .select({ endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(eq(ownerships.id, firstCustodyId));
    expect(custody.endedAt).not.toBeNull();

    // The cache: not listed, not paused. (Eligibility is the org's assessment
    // and stays as the spine recorded it — without custody it lists nothing.)
    const cols = await petListingColumns();
    expect(cols.listedAt).toBeNull();
    expect(cols.pausedAt).toBeNull();

    // The spine: the closing fact names the custody row, is signed by the
    // TITULAR (not the org, not the platform), and is attached to the
    // listing case — written while that case was still open. The two
    // submitted applications and the org's approval are there from the
    // fixture; the cascade's own resolution of the PENDING one is the extra
    // `adoption_application_resolved` (asserted below).
    expect(await spineTypes()).toEqual([
      "adoption_application_resolved",
      "adoption_application_resolved",
      "adoption_application_submitted",
      "adoption_application_submitted",
      "adoption_eligibility_set",
      "rehome_sponsorship_ended",
      "rehome_sponsorship_started",
    ]);
    const [ended] = await db
      .select({
        payload: petEvents.payload,
        authorRole: petEvents.authorRole,
        authorOrganizationId: petEvents.authorOrganizationId,
        recordedByUserId: petEvents.recordedByUserId,
        caseId: petEvents.caseId,
      })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "rehome_sponsorship_ended")));
    expect(ended.payload).toMatchObject({
      ownership_id: firstCustodyId,
      outcome: "withdrawn_by_titular",
    });
    expect(ended.authorRole).toBe("owner");
    expect(ended.authorOrganizationId).toBeNull();
    expect(ended.recordedByUserId).toBe(ids.titular);
    expect(ended.caseId).toBe(firstListingCaseId);
    expect(await openSponsorship()).toBeNull();

    // The listing case (the sponsorship itself) is closed, cancelled BY the
    // titular, with a timeline entry that says who ended it and that the
    // animal is still with its family.
    const [listing] = await db.select().from(cases).where(eq(cases.id, firstListingCaseId));
    expect(listing.status).toBe("closed");
    expect(listing.closedReason).toBe("cancelled");
    expect(listing.closedByUserId).toBe(ids.titular);
    const entry = await closedEntryFor(firstListingCaseId);
    expect(entry?.notes).toMatch(/titular/);
    expect(entry?.notes).toMatch(/dio de baja/);
    expect(entry?.notes).toContain("Refugio Padrino");
    expect((entry?.payload as { rehome_decision?: string }).rehome_decision).toBe("withdrawn");

    // The catalog no longer resolves the pet — same transaction, not eventually.
    expect(await inCatalog()).toBe(false);

    // The org's admins are told, and the CTA is the case they worked on.
    const orgNotice = r.notifications.find((n) => n.userId === ids.coordA);
    expect(orgNotice?.notificationType).toBe("rehome_sponsorship_withdrawn");
    expect(orgNotice?.title).toContain("Tango");
    expect(orgNotice?.body).toMatch(/sigue (con|viviendo con) su familia/);
    expect(orgNotice?.ctaUrl).toBe(`/casos/${listing.publicCode}`);
    expect(orgNotice?.relatedCaseId).toBe(firstListingCaseId);

    // THE CASCADE (WU5 carry-forward 1). With the custody row ended, every
    // org-side reader of an application inner-joins a LIVE custody and finds
    // nothing; the applicant's own readers do the same. Left alone, both
    // applications would be stranded: un-reviewable, un-retractable, hidden
    // from both inboxes, with nobody told. The withdraw closes them in its
    // own transaction.
    //
    // PENDING: resolved on the spine as an auto-generated rejection whose
    // reason names the cause, signed by the TITULAR (the person whose act
    // closed the listing — "the test is who the author IS"), never the org.
    const pendingResolved = await resolvedEventsFor(pendingApplicationId);
    expect(pendingResolved).toHaveLength(1);
    expect(pendingResolved[0].payload).toMatchObject({
      outcome: "rejected",
      reason: "listing_withdrawn_by_titular",
      auto_generated: true,
    });
    expect(pendingResolved[0].authorRole).toBe("owner");
    expect(pendingResolved[0].authorOrganizationId).toBeNull();
    expect(pendingResolved[0].recordedByUserId).toBe(ids.titular);
    // APPROVED: the org's approval stays the single resolution on the spine —
    // a second, contradictory `rejected` for the same application would be a
    // lie on an append-only ledger. Its fate is the case close below plus the
    // `rehome_sponsorship_ended{withdrawn_by_titular}` on the same pet.
    expect(await resolvedEventsFor(approvedApplicationId)).toHaveLength(1);

    // Both application cases close, cancelled BY the titular, with a note.
    for (const applicant of [ids.applicantApproved, ids.applicantPending]) {
      const appCase = await applicationCaseFor(applicant);
      expect(appCase?.status).toBe("closed");
      expect(appCase?.closedReason).toBe("cancelled");
      expect(appCase?.closedByUserId).toBe(ids.titular);
      const entry = appCase ? await closedEntryFor(appCase.id) : null;
      expect(entry?.notes).toMatch(/titular/);
      expect(entry?.notes).toMatch(/retir/);
    }

    // Both applicants are told, in words that say what happened and that
    // nothing is asked of them — and NOT the same words (WU5 review, LOW):
    // the approved adopter was days from an adoption and is told the
    // approval existed and the adoption will not happen; the pending one
    // had been promised nothing and gets the plain close.
    for (const applicant of [ids.applicantApproved, ids.applicantPending]) {
      const notice = r.notifications.find((n) => n.userId === applicant);
      expect(notice?.notificationType).toBe("adoption_application_closed");
      expect(notice?.title).toContain("Tango");
      expect(notice?.body).toMatch(/titular retiró la búsqueda de hogar/);
      expect(notice?.body).toMatch(/No hace falta que hagas nada/);
      expect(notice?.relatedPetId).toBe(petId);
    }
    const approvedNotice = r.notifications.find((n) => n.userId === ids.applicantApproved);
    expect(approvedNotice?.title).toMatch(/había sido aprobada/);
    expect(approvedNotice?.body).toMatch(/antes de concretar la adopción/);
    const pendingNotice = r.notifications.find((n) => n.userId === ids.applicantPending);
    expect(pendingNotice?.title).toBe("Tu postulación por Tango quedó cerrada");
    expect(pendingNotice?.body).not.toMatch(/aprobada/);
    expect(r.notifications).toHaveLength(3);

    // And the org gets the same refusal it gets today for a pet it no longer
    // holds — on the finalize path for the approved one, on the review path
    // for the pending one.
    const forFinalize = await AdoptionRepository.findApprovedApplicationForFinalize(
      approvedApplicationId,
      orgAId,
      petId,
    );
    expect("error" in forFinalize ? forFinalize.error : "").toMatch(
      /no pertenece a tu organización/,
    );
    const forReview = await AdoptionRepository.findApplicationForReview(
      pendingApplicationId,
      orgAId,
    );
    expect("error" in forReview ? forReview.error : "").toMatch(/no pertenece a tu organización/);
  });

  it("REQ-8: after the withdraw the org cannot publish — its own listing use-case finds no custody", async () => {
    const r = await setAdoptionListingStatus(
      { petPublicToken: PET_TOKEN, action: "publish" },
      {
        repo: AdoptionRepository,
        actor: {
          user: { id: ids.coordA },
          organization: { id: orgAId, publicToken: ORG_A_TOKEN, verified: true },
        },
        transaction,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no está bajo custodia de tu organización/);
    expect((await petListingColumns()).listedAt).toBeNull();
    expect(await inCatalog()).toBe(false);
  });

  it("withdrawing again is refused — there is nothing active", async () => {
    const r = await withdrawRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular },
      withdrawDeps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no tiene un acompañamiento .*activo/);
    expect(await spineTypes()).toHaveLength(7);
  });

  it("the SAME key replays the withdraw: ok, replayed, the same custody row and org, nothing written, nobody told again", async () => {
    // The closing fact carries the key — that is the ledger the replay reads.
    const [ended] = await db
      .select({ key: petEvents.clientIdempotencyKey })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "rehome_sponsorship_ended")));
    expect(ended.key).toBe(WITHDRAW_KEY);

    const r = await withdrawRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular, clientIdempotencyKey: WITHDRAW_KEY },
      withdrawDeps(),
    );
    // THE ASSERTION THIS TEST EXISTS FOR: over a spine with nothing active, the
    // retry of a withdraw that landed answers the way the first attempt did —
    // never "no tiene un acompañamiento activo".
    expect(r.ok ? "" : r.error).toBe("");
    if (!r.ok) return;
    expect(r.value.replayed).toBe(true);
    expect(r.value.ownershipId).toBe(firstCustodyId);
    expect(r.value.sponsoringOrganizationId).toBe(orgAId);
    expect(r.value.sponsoringOrganizationPublicToken).toBe(ORG_A_TOKEN);
    expect(r.notifications).toEqual([]);
    expect(await spineTypes()).toHaveLength(7);
  });

  it("a DIFFERENT key with nothing active is the ordinary refusal — the ledger knows only its own", async () => {
    const r = await withdrawRehomeSponsorship(
      {
        petPublicToken: PET_TOKEN,
        titularUserId: ids.titular,
        clientIdempotencyKey: "11111111-2222-4333-8444-555555555555",
      },
      withdrawDeps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no tiene un acompañamiento .*activo/);
  });

  it("the foster replaying the titular's key is still refused — the ledger is scoped to the actor", async () => {
    const r = await withdrawRehomeSponsorship(
      {
        petPublicToken: PET_TOKEN,
        titularUserId: ids.fosterer,
        clientIdempotencyKey: WITHDRAW_KEY,
      },
      withdrawDeps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/titular/);
  });
});

// ---------------------------------------------------------------------------
// Cancel a PENDING request (REQ-3)
// ---------------------------------------------------------------------------

let pendingCode: string;
let pendingCaseId: string;

describe("cancel — the titular withdraws a request the org has not answered (REQ-3)", () => {
  it("REQ-16 cleared by the withdraw: the titular can ask again — a new, pending request", async () => {
    const r = await requestRehomeSponsorship(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular, targetOrgId: orgAId },
      requestDeps(),
    );
    expect(r.ok ? "" : r.error).toBe("");
    if (!r.ok) return;
    pendingCode = r.value.casePublicCode;
    pendingCaseId = r.value.caseId;
    expect(pendingCode).not.toBe(firstRequestCode);
  });

  it("a foster cannot cancel the titular's pending request", async () => {
    const r = await withdrawRehomeRequest(
      { petPublicToken: PET_TOKEN, titularUserId: ids.fosterer },
      withdrawDeps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/titular/);
    const [row] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, pendingCaseId));
    expect(row.status).toBe("open");
  });

  it("the titular cancels: closed as cancelled BY the titular, the note says so, nothing on the spine, the org is told", async () => {
    const before = await spineTypes();
    const r = await withdrawRehomeRequest(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular, clientIdempotencyKey: CANCEL_KEY },
      withdrawDeps(),
    );
    expect(r.ok ? "" : r.error).toBe("");
    if (!r.ok) return;
    expect(r.value.replayed).toBe(false);
    expect(r.value.casePublicCode).toBe(pendingCode);

    // The row: the same closedReason an org decline uses, told apart by the
    // ACTOR on the row (design ADR-1) — and it is the titular, not coordA.
    const [row] = await db.select().from(cases).where(eq(cases.id, pendingCaseId));
    expect(row.status).toBe("closed");
    expect(row.closedReason).toBe("cancelled");
    expect(row.closedByUserId).toBe(ids.titular);
    expect(row.closedByUserId).not.toBe(ids.coordA);

    // The timeline entry reads as the titular's own cancel, not as a decline
    // ("rechaz…") and not as an operator's close.
    const entry = await closedEntryFor(pendingCaseId);
    expect(entry?.notes).toMatch(/titular/);
    expect(entry?.notes).toMatch(/cancel/);
    expect(entry?.notes).not.toMatch(/rechaz/);
    expect(entry?.notes).toContain("Refugio Padrino");
    expect((entry?.payload as { rehome_decision?: string }).rehome_decision).toBe("withdrawn");
    expect(entry?.by).toBe(ids.titular);
    // The entry keeps the client's key — the ledger the replay below reads.
    expect((entry?.payload as { client_idempotency_key?: string }).client_idempotency_key).toBe(
      CANCEL_KEY,
    );

    // Nothing about the animal changed: spine and rows are as they were.
    expect(await spineTypes()).toEqual(before);
    expect((await liveOwnerships()).map((o) => o.role).sort()).toEqual(["foster", "owner"]);

    expect(r.notifications.map((n) => n.userId)).toEqual([ids.coordA]);
    expect(r.notifications[0].notificationType).toBe("rehome_request_withdrawn");
    expect(r.notifications[0].title).toContain("Tango");
    expect(r.notifications[0].ctaUrl).toBe(`/casos/${pendingCode}`);
    expect(r.notifications[0].relatedCaseId).toBe(pendingCaseId);
  });

  it("the org answering a cancelled request is refused", async () => {
    const r = await respondToRehomeRequest(
      { casePublicCode: pendingCode, decision: "accept" },
      answerDeps(ids.coordA),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ya fue respondida/);
    expect((await liveOwnerships()).map((o) => o.role).sort()).toEqual(["foster", "owner"]);
  });

  it("cancelling again is refused — there is no pending request", async () => {
    const r = await withdrawRehomeRequest(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular },
      withdrawDeps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no hay una solicitud .*pendiente/i);
  });

  it("the SAME key replays the cancel: ok, replayed, the same case, closed once, nobody told again", async () => {
    const r = await withdrawRehomeRequest(
      { petPublicToken: PET_TOKEN, titularUserId: ids.titular, clientIdempotencyKey: CANCEL_KEY },
      withdrawDeps(),
    );
    // THE ASSERTION THIS TEST EXISTS FOR: with no pending request left, the
    // retry of the cancel that closed it answers the way the first attempt did.
    expect(r.ok ? "" : r.error).toBe("");
    if (!r.ok) return;
    expect(r.value.replayed).toBe(true);
    expect(r.value.caseId).toBe(pendingCaseId);
    expect(r.value.casePublicCode).toBe(pendingCode);
    expect(r.value.receiverOrganizationId).toBe(orgAId);
    expect(r.notifications).toEqual([]);
    // One `case_closed` entry, not two: the replay wrote nothing.
    const entries = await db
      .select({ id: caseEvents.id })
      .from(caseEvents)
      .where(and(eq(caseEvents.caseId, pendingCaseId), eq(caseEvents.entryType, "case_closed")));
    expect(entries).toHaveLength(1);
  });

  it("a DIFFERENT key with nothing pending is the ordinary refusal", async () => {
    const r = await withdrawRehomeRequest(
      {
        petPublicToken: PET_TOKEN,
        titularUserId: ids.titular,
        clientIdempotencyKey: "22222222-3333-4444-8555-666666666666",
      },
      withdrawDeps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no hay una solicitud .*pendiente/i);
  });
});

// ---------------------------------------------------------------------------
// A new listing needs a NEW accepted request (REQ-7)
// ---------------------------------------------------------------------------

describe("re-list — only through a new accepted request (REQ-7)", () => {
  it("request again, accept again: a NEW custody row with its own started event, and the pet is back in the catalog", async () => {
    const sponsored = await sponsor();
    expect(sponsored.custodyId).not.toBe(firstCustodyId);
    expect(sponsored.listingCaseId).not.toBe(firstListingCaseId);

    const live = await liveOwnerships();
    expect(live.map((o) => o.role).sort()).toEqual(["foster", "owner", "shelter_custody"]);
    expect(live.find((o) => o.role === "owner")?.id).toBe(titularOwnershipId);
    expect(live.find((o) => o.role === "shelter_custody")?.id).toBe(sponsored.custodyId);

    expect((await openSponsorship())?.ownershipId).toBe(sponsored.custodyId);
    expect(await spineTypes()).toEqual([
      "adoption_application_resolved",
      "adoption_application_resolved",
      "adoption_application_submitted",
      "adoption_application_submitted",
      "adoption_eligibility_set",
      "adoption_eligibility_set",
      "rehome_sponsorship_ended",
      "rehome_sponsorship_started",
      "rehome_sponsorship_started",
    ]);
    expect(await inCatalog()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finalize vs withdraw — the custody row is locked under finalize (carry-forward 3)
// ---------------------------------------------------------------------------

describe("finalize vs withdraw — the custody row is locked under the finalize transaction", () => {
  it("a withdraw that commits between finalize's pre-read and its transaction makes finalize refuse, with nothing written", async () => {
    // The foster-shortcut rules would otherwise route this finalize through
    // the foster; the race is about the DNI path and the custody row only.
    await db
      .update(ownerships)
      .set({ endedAt: new Date() })
      .where(
        and(eq(ownerships.petId, petId), eq(ownerships.role, "foster"), isNull(ownerships.endedAt)),
      );
    const spineBefore = await spineTypes();
    const custodyBefore = (await liveOwnerships()).find((o) => o.role === "shelter_custody");
    expect(custodyBefore, "sponsored going in").toBeDefined();

    // The race, made deterministic: finalize's pre-transaction read sees the
    // live custody; the moment its transaction reaches for its FIRST lock —
    // the pet advisory lock, which every custody writer of this feature now
    // takes before any row lock (WU5 review, lock order) — the titular's
    // withdraw has ALREADY committed (its own transaction, its own
    // connection, its own advisory lock, released at its commit). The real
    // locks then run in order and the custody read finds an ended row.
    //
    // The interception MUST sit before the advisory lock, not on the row
    // lock: a withdraw started while finalize already holds the pet lock
    // would block on that lock while finalize awaits the withdraw — a hang
    // in the test harness, not a Postgres deadlock, since the finalize
    // transaction is merely idle.
    let raced = false;
    const racingRepo = new Proxy(AdoptionRepository, {
      get(target, prop, receiver) {
        if (prop === "acquirePetAdvisoryLock") {
          return async (lockedPetId: string, tx: unknown) => {
            if (!raced) {
              raced = true;
              const w = await withdrawRehomeSponsorship(
                { petPublicToken: PET_TOKEN, titularUserId: ids.titular },
                withdrawDeps(),
              );
              if (!w.ok) throw new Error(`the racing withdraw failed: ${w.error}`);
            }
            return target.acquirePetAdvisoryLock(lockedPetId, tx as Tx);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await finalizeAdoption(
      {
        petPublicToken: PET_TOKEN,
        applicationEventId: null,
        adopterUserId: null,
        adopterDni: ADOPTER_DNI,
        adopterDisplayName: "Rehome Withdraw Adopter",
        adopterPhone: "+541133330002",
        followupMonths: 0,
        notes: "Finalize que pierde la carrera contra la baja del titular",
        contractAttachmentId: null,
        contractStoragePath: null,
        contractMimeType: null,
        contractFileSize: null,
      },
      {
        repo: racingRepo,
        actor: {
          user: { id: ids.coordA },
          organization: {
            id: orgAId,
            publicToken: ORG_A_TOKEN,
            verified: true,
            displayName: "Refugio Padrino",
          },
        },
        transaction,
      },
    );

    expect(raced, "the withdraw ran inside the window").toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/custodia/i);

    // Nothing of the adoption landed: no adoption_finalized, no second
    // rehome_sponsorship_ended, the titular's owner row still the only live
    // row, and the custody row closed exactly once — by the withdraw.
    const spineAfter = await spineTypes();
    expect(spineAfter).not.toContain("adoption_finalized");
    expect(spineAfter.filter((t) => t === "rehome_sponsorship_ended")).toHaveLength(
      spineBefore.filter((t) => t === "rehome_sponsorship_ended").length + 1,
    );
    const live = await liveOwnerships();
    expect(live.map((o) => o.role)).toEqual(["owner"]);
    expect(live[0].id).toBe(titularOwnershipId);
    expect(await openSponsorship()).toBeNull();
  });
});

// WU5 review (LOW), lock order — NON-VACUITY. The source pins say both
// transactions CALL `acquirePetAdvisoryLock` first; this proves the method is
// a real transaction-scoped lock on the pet and not a no-op: while one
// transaction holds it through the repository, a second connection's
// `pg_try_advisory_xact_lock` on the same key returns false, and true again
// once the first transaction ends.
describe("the pet advisory lock both transactions take first is a real lock", () => {
  async function otherConnectionCanTakeIt(): Promise<boolean> {
    return db.transaction(async (other) => {
      const rows = await other.execute<{ got: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${petId})) AS got`,
      );
      return rows[0].got;
    });
  }

  it("pg_try_advisory_xact_lock(hashtext(petId)) is refused while RehomeRepository holds it", async () => {
    let heldByOther: boolean | null = null;
    await transaction(async (tx) => {
      await RehomeRepository.acquirePetAdvisoryLock(petId, tx);
      heldByOther = await otherConnectionCanTakeIt();
    });
    expect(heldByOther).toBe(false);
    expect(await otherConnectionCanTakeIt()).toBe(true);
  });

  it("AdoptionRepository takes the SAME key — finalize and withdraw serialise on one lock", async () => {
    let heldByOther: boolean | null = null;
    await transaction(async (tx) => {
      await AdoptionRepository.acquirePetAdvisoryLock(petId, tx as Tx);
      heldByOther = await otherConnectionCanTakeIt();
    });
    expect(heldByOther).toBe(false);
  });
});
