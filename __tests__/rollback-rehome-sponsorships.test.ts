// scripts/rollback-rehome-sponsorships.ts against real rows (rehome-by-titular,
// design ADR-7; tasks 7.1). Serial `db` project.
//
// THE INCIDENT THIS SCRIPT IS FOR. Reverting the app commit leaves every
// sponsored pet satisfying `queryAdoptionListing` with the UI to unpublish it
// gone — listed animals nobody can take down — and `validateEventPayload` no
// longer knows `rehome_sponsorship_ended`, so the closing fact cannot be
// written AFTER the revert. The script runs FIRST, through the still-deployed
// app, and does per pet, in one transaction, what the titular's withdraw does:
// close the custody row, clear the listing, write `withdrawn_by_platform`,
// close the cases. It was written and reviewed with the change, not
// improvised during the incident.
//
// WHAT IT MUST NEVER DO. Select by the owner+shelter_custody shape (that is a
// decomiso and an intake too), or "end" an ORPHAN — a started event whose
// custody row already closed without its event. An orphan is drift for
// lint:spine to name and a human to heal; ending it here would stamp a
// platform withdrawal onto an arrangement that ended months earlier. The
// script lists orphans through the same query the fence uses and skips them.
//
// Fixtures are planted directly (no auth users needed): the script keys on
// the spine and the rows, which is what the fixture plants.

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { caseEvents, cases, db, organizations, ownerships, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { openCase } from "@/lib/infra/case-helpers";
import { DEFAULT_LOCAL_URL } from "@/scripts/_db-target";
import { queryOrphanedSponsorships } from "@/scripts/check-spine-integrity";
import { runRollback } from "@/scripts/rollback-rehome-sponsorships";
import { findOpenSponsorship } from "@/src/modules/adoption/infrastructure/rehome-sponsorship-writer";

import { withMutationOverride } from "./_helpers/db-overrides";

const ORG_TOKEN = "DIM-RBRS-ORG1";
const PET_LIVE = "DIM-RBRS-LIVE";
const PET_ORPHAN = "DIM-RBRS-ORPH";
const PET_PENDING = "DIM-RBRS-PEND";
const ALL_PET_TOKENS = [PET_LIVE, PET_ORPHAN, PET_PENDING];

const pgSql = postgres(process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL, {
  max: 1,
  connect_timeout: 5,
});

let orgId: string;
let livePetId: string;
let liveCustodyId: string;
let liveListingCaseId: string;
let orphanCustodyId: string;
let pendingRequestCaseId: string;

async function purge(): Promise<void> {
  await withMutationOverride(async (tx) => {
    for (const token of ALL_PET_TOKENS) {
      const stale = await tx.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
      for (const { id } of stale) {
        const staleCases = await tx
          .select({ id: cases.id })
          .from(cases)
          .where(eq(cases.primaryPetId, id));
        for (const c of staleCases) {
          await tx.delete(caseEvents).where(eq(caseEvents.caseId, c.id));
        }
        // pet_events.case_id references cases: the spine rows go first.
        await tx.delete(petEvents).where(eq(petEvents.petId, id));
        await tx.delete(cases).where(eq(cases.primaryPetId, id));
        await tx.delete(ownerships).where(eq(ownerships.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    }
    await tx.delete(organizations).where(eq(organizations.publicToken, ORG_TOKEN));
  });
}

/** A pet with a custody row and an unmatched `rehome_sponsorship_started` naming it. */
async function plantSponsoredPet(args: {
  token: string;
  name: string;
  endedAt: Date | null;
  listed: boolean;
}): Promise<{ petId: string; custodyId: string }> {
  const now = new Date();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: args.token,
      name: args.name,
      species: "dog",
      sex: "female",
      adoptionEligible: true,
      adoptionEligibilitySetAt: now,
      adoptionListedAt: args.listed ? now : null,
    })
    .returning({ id: pets.id });
  const [custody] = await db
    .insert(ownerships)
    .values({
      petId: pet.id,
      ownerOrganizationId: orgId,
      role: "shelter_custody",
      startedAt: now,
      endedAt: args.endedAt,
    })
    .returning({ id: ownerships.id });
  await db.insert(petEvents).values({
    petId: pet.id,
    eventType: "rehome_sponsorship_started",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: null,
    authorRole: "shelter",
    authorOrganizationId: orgId,
    authorVerified: true,
    payload: validateEventPayload("rehome_sponsorship_started", {
      ownership_id: custody.id,
      sponsoring_organization_id: orgId,
      consented_by_user_id: randomUUID(),
      request_case_public_code: "CAS-RBRS-0001",
      listing_case_id: null,
      note: null,
    }),
  });
  return { petId: pet.id, custodyId: custody.id };
}

beforeAll(async () => {
  await purge();
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Refugio Rollback SRL",
      displayName: "Refugio Rollback",
      orgType: "shelter",
      email: "rbrs-org@dim-test.local",
      verified: true,
    })
    .returning({ id: organizations.id });
  orgId = org.id;

  // 1. A RUNNING sponsorship: live row, listed, open adoption_listing case.
  const live = await plantSponsoredPet({
    token: PET_LIVE,
    name: "Rollback Live",
    endedAt: null,
    listed: true,
  });
  livePetId = live.petId;
  liveCustodyId = live.custodyId;
  const listing = await openCase({
    kind: "adoption_listing",
    primarySubjectKind: "registered_pet",
    primaryPetId: livePetId,
    openedByOrganizationId: orgId,
    openedReason: { code: "adoption_listing_opened" },
  });
  liveListingCaseId = listing.id;

  // 2. An ORPHAN: the row closed without its event — drift, not ours to end.
  const orphan = await plantSponsoredPet({
    token: PET_ORPHAN,
    name: "Rollback Orphan",
    endedAt: new Date(),
    listed: false,
  });
  orphanCustodyId = orphan.custodyId;

  // 3. A PENDING request nobody answered — a case the rollback must close too.
  const [pending] = await db
    .insert(pets)
    .values({ publicToken: PET_PENDING, name: "Rollback Pending", species: "cat", sex: "male" })
    .returning({ id: pets.id });
  const request = await openCase({
    kind: "rehome_request",
    primarySubjectKind: "registered_pet",
    primaryPetId: pending.id,
    openedByOrganizationId: null,
    receiverOrganizationId: orgId,
    openedReason: { code: "rehome_requested", orgDisplayName: "Refugio Rollback" },
  });
  pendingRequestCaseId = request.id;
});

afterAll(async () => {
  await purge();
  await pgSql.end({ timeout: 1 }).catch(() => {});
});

async function custodyRow(id: string) {
  const [row] = await db
    .select({ endedAt: ownerships.endedAt })
    .from(ownerships)
    .where(eq(ownerships.id, id));
  return row;
}

async function endedEventsFor(petId: string) {
  const rows = await db
    .select({
      payload: petEvents.payload,
      authorRole: petEvents.authorRole,
      by: petEvents.recordedByUserId,
    })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "rehome_sponsorship_ended")));
  return rows;
}

async function caseState(id: string) {
  const [row] = await db
    .select({
      status: cases.status,
      closedReason: cases.closedReason,
      closedBy: cases.closedByUserId,
    })
    .from(cases)
    .where(eq(cases.id, id));
  return row;
}

describe("rollback-rehome-sponsorships — dry-run is the default and writes nothing", () => {
  it("lists the live sponsorship it would end, the orphan it refuses, the pending request it would close", async () => {
    const lines: string[] = [];
    const report = await runRollback({
      apply: false,
      petTokens: ALL_PET_TOKENS,
      log: (l) => lines.push(l),
    });

    expect(report.mode).toBe("dry-run");
    expect(report.live.map((s) => s.petPublicToken)).toEqual([PET_LIVE]);
    expect(report.live[0].ownershipId).toBe(liveCustodyId);
    expect(report.orphans.map((o) => o.public_token)).toEqual([PET_ORPHAN]);
    expect(report.openRequests.map((r) => r.caseId)).toEqual([pendingRequestCaseId]);
    expect(report.ended).toHaveLength(0);
    expect(report.closedRequests).toHaveLength(0);

    // One line per would-be action, and the orphan named as skipped.
    expect(lines.some((l) => l.startsWith("WOULD END") && l.includes(PET_LIVE))).toBe(true);
    expect(lines.some((l) => l.startsWith("SKIPPED (orphan)") && l.includes(PET_ORPHAN))).toBe(
      true,
    );
    expect(lines.some((l) => l.startsWith("WOULD CLOSE REQUEST"))).toBe(true);

    // Nothing moved.
    expect((await custodyRow(liveCustodyId)).endedAt).toBeNull();
    expect(await endedEventsFor(livePetId)).toHaveLength(0);
    expect((await caseState(liveListingCaseId)).status).toBe("open");
    expect((await caseState(pendingRequestCaseId)).status).toBe("open");
  });
});

describe("rollback-rehome-sponsorships --apply", () => {
  it("ends the live sponsorship the way the titular's withdraw would, signed by the platform; skips the orphan; closes the pending request", async () => {
    const lines: string[] = [];
    const report = await runRollback({
      apply: true,
      petTokens: ALL_PET_TOKENS,
      log: (l) => lines.push(l),
    });
    expect(report.mode).toBe("apply");
    expect(report.ended.map((e) => e.petPublicToken)).toEqual([PET_LIVE]);
    expect(report.closedRequests.map((r) => r.caseId)).toEqual([pendingRequestCaseId]);
    expect(report.orphans.map((o) => o.public_token)).toEqual([PET_ORPHAN]);
    expect(lines.some((l) => l.startsWith("ENDED") && l.includes(PET_LIVE))).toBe(true);
    expect(lines.some((l) => l.startsWith("CLOSED REQUEST"))).toBe(true);

    // The custody row is closed, the listing cleared.
    expect((await custodyRow(liveCustodyId)).endedAt).not.toBeNull();
    const [cols] = await db
      .select({ l: pets.adoptionListedAt, p: pets.adoptionListingPausedAt })
      .from(pets)
      .where(eq(pets.id, livePetId));
    expect(cols.l).toBeNull();
    expect(cols.p).toBeNull();

    // The closing fact: withdrawn_by_platform, naming the row, signed by the
    // platform (no acting user), so the spine says who decided.
    const ended = await endedEventsFor(livePetId);
    expect(ended).toHaveLength(1);
    expect(ended[0].payload).toMatchObject({
      ownership_id: liveCustodyId,
      outcome: "withdrawn_by_platform",
    });
    expect(ended[0].authorRole).toBe("system");
    expect(ended[0].by).toBeNull();
    expect(await findOpenSponsorship(livePetId, db)).toBeNull();

    // The listing case closed as cancelled with a note that says the platform did it.
    const listing = await caseState(liveListingCaseId);
    expect(listing.status).toBe("closed");
    expect(listing.closedReason).toBe("cancelled");
    const [note] = await db
      .select({ notes: caseEvents.notes })
      .from(caseEvents)
      .where(
        and(eq(caseEvents.caseId, liveListingCaseId), eq(caseEvents.entryType, "case_closed")),
      );
    expect(note?.notes).toMatch(/plataforma/);

    // The pending request closed as cancelled, by nobody in particular.
    const request = await caseState(pendingRequestCaseId);
    expect(request.status).toBe("closed");
    expect(request.closedReason).toBe("cancelled");
    expect(request.closedBy).toBeNull();

    // The orphan is untouched: still an orphan for lint:spine to name.
    expect((await custodyRow(orphanCustodyId)).endedAt).not.toBeNull();
    const orphans = await queryOrphanedSponsorships(pgSql);
    expect(orphans.map((o) => o.public_token)).toContain(PET_ORPHAN);
    expect(orphans.map((o) => o.public_token)).not.toContain(PET_LIVE);
  });

  it("a second --apply finds nothing left to end — the script is safe to re-run", async () => {
    const report = await runRollback({ apply: true, petTokens: ALL_PET_TOKENS, log: () => {} });
    expect(report.live).toHaveLength(0);
    expect(report.ended).toHaveLength(0);
    expect(report.openRequests).toHaveLength(0);
    expect(report.orphans.map((o) => o.public_token)).toEqual([PET_ORPHAN]);
    expect(await endedEventsFor(livePetId)).toHaveLength(1);
  });

  it("non-vacuity: the live row the script ended is no longer live for the catalog predicate", async () => {
    const [row] = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, livePetId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(row).toBeUndefined();
  });
});
