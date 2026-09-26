// Regression fence: a caretaker arrangement does not outlive the owner who made
// it (H4, parts b and c).
//
// THE BUG THIS EXISTS FOR
// ---------------------------------------------------------------------------
// A caretaker grant is an agreement between the TITULAR and one person. When
// the pet changes hands the titular who made it is gone, and neither half of
// the grant may survive them:
//
//   (b) A PENDING invitation stayed pending across the hand-off, so the invitee
//       could accept days later onto the NEW owner's pet — write access on a
//       stranger's animal, and with the lost-mode disclosure toggle their name
//       and phone on that pet's public credential. The new owner could not
//       cancel it (cancel is the granter's) and could not designate their own
//       caretaker either (`pet_caretaker_grants_one_pending_per_pet`).
//
//   (c) An ACCEPTED grant survived a PERSON-TO-PERSON transfer outright.
//       Adoption finalize, decomiso and dispute resolution all route their
//       ownership close through `endAllLiveOwnerships`, which ends caretaker
//       grants properly; `TransfersRepository.closeOwnerOwnerships` — the P2P
//       path — did not mention caretakers at all. It closed `role='owner'` rows
//       and left the caretaker's row open with its grant still 'accepted'.
//       `caretaker-public-contact.ts` decides the public disclosure from the
//       GRANT alone and never joins `ownerships`, so the zombie kept publishing
//       a stranger's contact on the new owner's credential until `ends_at` —
//       up to 180 days.
//
//   (d) Audit K, W2: two more hand-offs ended the titular's owner row by id
//       and never looked at caretakers — an ADOPTION REVERSAL (custody back
//       to the refugio) and an ORG ACCEPTING AN OWNER'S RETURN. Same leak as
//       (c), deterministically, on two paths `closeOwnerOwnerships` does not
//       cover. Both now call `endCaretakerArrangementsForPet` in the same
//       transaction.
//
// WHY THIS HITS REAL POSTGRES (the `db` vitest project, serial)
// ---------------------------------------------------------------------------
// The claim is about what a transaction leaves behind across three tables
// (`ownerships`, `pet_caretaker_grants`, `pet_events`) and about CHECK
// constraints that only fire on a real write — the grant's biconditional accept
// check makes several plausible "fixes" illegal. A fake transaction cannot show
// any of that. Each test asserts its precondition first (the NON-VACUITY
// CONTROL): the grant is live going in, so a green result cannot come from a
// fixture that was already closed.

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  db,
  notifications,
  organizations,
  ownerships,
  petCaretakerGrants,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { endAllLiveOwnerships } from "@/lib/infra/end-pet-ownerships";
import { hashDni } from "@/lib/utils/dni-hash";
import { reverseAdoption } from "@/src/modules/adoption/application/reverse-adoption";
import { AdoptionRepository } from "@/src/modules/adoption/infrastructure/adoption-repository";
import { orgAcceptOwnerReturnUseCase } from "@/src/modules/return-to-owner/application/org-accept-owner-return";
import { TransfersRepository } from "@/src/modules/transfers/infrastructure/transfers-repository";

import { withMutationOverride } from "./_helpers/db-overrides";

const PENDING_PET_TOKEN = "DIM-CGOC-PEND1";
const ACCEPTED_PET_TOKEN = "DIM-CGOC-ACCP1";

let titularId: string;
let caretakerId: string;
let pendingPetId: string;
let acceptedPetId: string;
let acceptedGrantId: string;
let caretakerOwnershipId: string;

function randomDni(): string {
  return `${Math.floor(Math.random() * 90000000 + 10000000)}`;
}

async function purge(): Promise<void> {
  await withMutationOverride(async (tx) => {
    for (const token of [PENDING_PET_TOKEN, ACCEPTED_PET_TOKEN]) {
      const stale = await tx.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
      for (const { id } of stale) {
        await tx.delete(petEvents).where(eq(petEvents.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    }
  });
}

beforeAll(async () => {
  await purge();

  titularId = randomUUID();
  caretakerId = randomUUID();
  await db.insert(profiles).values([
    {
      id: titularId,
      displayName: "CGOC Titular",
      dniHash: hashDni(randomDni()),
      dniVerified: true,
      role: "owner",
      phone: "1112350001",
    },
    {
      id: caretakerId,
      displayName: "CGOC Cuidador",
      dniHash: hashDni(randomDni()),
      dniVerified: true,
      role: "owner",
      phone: "1112350002",
    },
  ]);

  const [pendingPet] = await db
    .insert(pets)
    .values({
      publicToken: PENDING_PET_TOKEN,
      name: "CgocPendingPet",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      status: "active",
    })
    .returning();
  pendingPetId = pendingPet.id;
  await db
    .insert(ownerships)
    .values({ petId: pendingPetId, ownerUserId: titularId, role: "owner" });

  // A PENDING invitation: no caretaker row, no ownership pointer. The accept
  // CHECK forbids both pointers on a non-accepted row, which is why this half
  // of the fix is a status flip and not an ownership close.
  await db.insert(petCaretakerGrants).values({
    publicToken: `CG-cgoc-${randomUUID().slice(0, 8)}`,
    petId: pendingPetId,
    grantedByUserId: titularId,
    caretakerEmail: "cgoc-invitee@dim-test.local",
    status: "pending",
    endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  const [acceptedPet] = await db
    .insert(pets)
    .values({
      publicToken: ACCEPTED_PET_TOKEN,
      name: "CgocAcceptedPet",
      species: "cat",
      sex: "female",
      potentiallyDangerousBreed: false,
      status: "active",
    })
    .returning();
  acceptedPetId = acceptedPet.id;
  await db
    .insert(ownerships)
    .values({ petId: acceptedPetId, ownerUserId: titularId, role: "owner" });

  const [caretakerRow] = await db
    .insert(ownerships)
    .values({ petId: acceptedPetId, ownerUserId: caretakerId, role: "caretaker" })
    .returning({ id: ownerships.id });
  caretakerOwnershipId = caretakerRow.id;

  const [acceptedGrant] = await db
    .insert(petCaretakerGrants)
    .values({
      publicToken: `CG-cgoc-${randomUUID().slice(0, 8)}`,
      petId: acceptedPetId,
      grantedByUserId: titularId,
      caretakerUserId: caretakerId,
      caretakerEmail: "cgoc-caretaker@dim-test.local",
      status: "accepted",
      ownershipId: caretakerOwnershipId,
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: petCaretakerGrants.id });
  acceptedGrantId = acceptedGrant.id;

  // A PENDING invitation on the same pet as well: one pending and one accepted
  // per pet are both legal, and the P2P path has to resolve BOTH.
  await db.insert(petCaretakerGrants).values({
    publicToken: `CG-cgoc-${randomUUID().slice(0, 8)}`,
    petId: acceptedPetId,
    grantedByUserId: titularId,
    caretakerEmail: "cgoc-second-invitee@dim-test.local",
    status: "pending",
    endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
});

// Hand-off fixtures of part (d): generated tokens, tracked for teardown.
const handoffPetIds: string[] = [];
const handoffOrgIds: string[] = [];
const handoffProfileIds: string[] = [];

afterAll(async () => {
  await purge();
  await withMutationOverride(async (tx) => {
    for (const id of handoffPetIds) await tx.delete(pets).where(eq(pets.id, id));
    for (const id of handoffOrgIds) await tx.delete(organizations).where(eq(organizations.id, id));
    for (const id of [titularId, caretakerId, ...handoffProfileIds]) {
      if (!id) continue;
      await tx.delete(notifications).where(eq(notifications.userId, id));
      await tx.delete(ownerships).where(eq(ownerships.ownerUserId, id));
      await tx.delete(profiles).where(eq(profiles.id, id));
    }
  });
});

describe("a pending invitation does not survive the ownership close (H4/b)", () => {
  it("endAllLiveOwnerships cancels every pending grant on the pet", async () => {
    // NON-VACUITY CONTROL: pending going in.
    const before = await db
      .select({ status: petCaretakerGrants.status })
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.petId, pendingPetId));
    expect(before.map((r) => r.status)).toEqual(["pending"]);

    await db.transaction(async (tx) => {
      await endAllLiveOwnerships(
        {
          petId: pendingPetId,
          outcome: "ownership_transferred",
          sponsorshipOutcome: "adopted",
          actorUserId: titularId,
          now: new Date(),
        },
        tx,
      );
    });

    const after = await db
      .select({ status: petCaretakerGrants.status, respondedAt: petCaretakerGrants.respondedAt })
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.petId, pendingPetId));
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("cancelled");
    // Stamped, not silently flipped: the cockpit and the drift harness both read
    // "when was this resolved" and a NULL there is indistinguishable from a row
    // nobody ever answered.
    expect(after[0].respondedAt).not.toBeNull();
  });
});

describe("a P2P transfer closes the caretaker arrangement (H4/c)", () => {
  it("closeOwnerOwnerships ends the accepted grant, its row and its event", async () => {
    // NON-VACUITY CONTROL: the arrangement is live going in.
    const [liveBefore] = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(and(eq(ownerships.id, caretakerOwnershipId), isNull(ownerships.endedAt)));
    expect(liveBefore).toBeDefined();

    await db.transaction(async (tx) => {
      await TransfersRepository.closeOwnerOwnerships(
        acceptedPetId,
        tx as Parameters<typeof TransfersRepository.closeOwnerOwnerships>[1],
      );
    });

    const [caretakerRowAfter] = await db
      .select({ endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(eq(ownerships.id, caretakerOwnershipId));
    expect(caretakerRowAfter.endedAt).not.toBeNull();

    const [grantAfter] = await db
      .select({ status: petCaretakerGrants.status, endedReason: petCaretakerGrants.endedReason })
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.id, acceptedGrantId));
    expect(grantAfter.status).toBe("ended");
    // `ownership_transferred` and not one of the other four: nobody returned the
    // animal, nothing expired, the titular did not revoke and the caretaker did
    // not withdraw. Reaching for a nearer outcome writes a false sentence into
    // an append-only spine and into the copy the caretaker reads.
    expect(grantAfter.endedReason).toBe("ownership_transferred");

    const endedEvents = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, acceptedPetId), eq(petEvents.eventType, "caretaker_ended")));
    expect(endedEvents).toHaveLength(1);

    // And the pending invitation on the same pet goes with it — otherwise the
    // new owner inherits an invitation they cannot cancel and cannot replace.
    const [pendingAfter] = await db
      .select({ status: petCaretakerGrants.status })
      .from(petCaretakerGrants)
      .where(
        and(
          eq(petCaretakerGrants.petId, acceptedPetId),
          eq(petCaretakerGrants.caretakerEmail, "cgoc-second-invitee@dim-test.local"),
        ),
      );
    expect(pendingAfter.status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// (d) Audit K, W2 — the reversal and the owner-return accept
// ---------------------------------------------------------------------------

/**
 * A pet the TITULAR holds (owner row) with a live arrangement on it: an
 * accepted caretaker grant (row + grant) AND a pending invitation — the two
 * halves `endCaretakerArrangementsForPet` must both resolve.
 */
async function petWithArrangements(label: string) {
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: `DIM-CGOC-O${randomUUID().slice(0, 5).toUpperCase()}`,
      legalName: `CGOC Refugio ${label}`,
      displayName: `CGOC Refugio ${label}`,
      orgType: "shelter",
      email: `cgoc-${label.toLowerCase()}-${randomUUID().slice(0, 6)}@dim-test.local`,
      verified: true,
    })
    .returning({ id: organizations.id });
  handoffOrgIds.push(org.id);

  const coordinatorId = randomUUID();
  await db.insert(profiles).values({
    id: coordinatorId,
    displayName: `CGOC Coordinador ${label}`,
    dniHash: hashDni(randomDni()),
    dniVerified: true,
    role: "owner",
  });
  handoffProfileIds.push(coordinatorId);

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `DIM-CGOC-${randomUUID().slice(0, 6).toUpperCase()}`,
      name: `Cgoc${label}`,
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      status: "active",
    })
    .returning({ id: pets.id, publicToken: pets.publicToken });
  handoffPetIds.push(pet.id);

  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: titularId, role: "owner" });
  const [careRow] = await db
    .insert(ownerships)
    .values({ petId: pet.id, ownerUserId: caretakerId, role: "caretaker" })
    .returning({ id: ownerships.id });
  const [accepted] = await db
    .insert(petCaretakerGrants)
    .values({
      publicToken: `CG-cgoc-${randomUUID().slice(0, 8)}`,
      petId: pet.id,
      grantedByUserId: titularId,
      caretakerUserId: caretakerId,
      caretakerEmail: "cgoc-caretaker@dim-test.local",
      status: "accepted",
      ownershipId: careRow.id,
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: petCaretakerGrants.id });
  const [pending] = await db
    .insert(petCaretakerGrants)
    .values({
      publicToken: `CG-cgoc-${randomUUID().slice(0, 8)}`,
      petId: pet.id,
      grantedByUserId: titularId,
      caretakerEmail: `cgoc-${label.toLowerCase()}-invitee@dim-test.local`,
      status: "pending",
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: petCaretakerGrants.id });

  return {
    orgId: org.id,
    coordinatorId,
    pet,
    careRowId: careRow.id,
    acceptedGrantId: accepted.id,
    pendingGrantId: pending.id,
  };
}

type ArrangementFixture = Awaited<ReturnType<typeof petWithArrangements>>;

async function expectArrangementsLive(f: ArrangementFixture): Promise<void> {
  const grants = await db
    .select({ id: petCaretakerGrants.id, status: petCaretakerGrants.status })
    .from(petCaretakerGrants)
    .where(eq(petCaretakerGrants.petId, f.pet.id));
  const byId = new Map(grants.map((g) => [g.id, g.status]));
  expect(byId.get(f.acceptedGrantId)).toBe("accepted");
  expect(byId.get(f.pendingGrantId)).toBe("pending");
}

async function expectArrangementsClosed(f: ArrangementFixture): Promise<void> {
  const [careRow] = await db
    .select({ endedAt: ownerships.endedAt })
    .from(ownerships)
    .where(eq(ownerships.id, f.careRowId));
  expect(careRow.endedAt).not.toBeNull();

  const [accepted] = await db
    .select({ status: petCaretakerGrants.status, endedReason: petCaretakerGrants.endedReason })
    .from(petCaretakerGrants)
    .where(eq(petCaretakerGrants.id, f.acceptedGrantId));
  expect(accepted).toEqual({ status: "ended", endedReason: "ownership_transferred" });

  const [pending] = await db
    .select({ status: petCaretakerGrants.status })
    .from(petCaretakerGrants)
    .where(eq(petCaretakerGrants.id, f.pendingGrantId));
  expect(pending.status).toBe("cancelled");

  // Exactly one ending fact, signed by the refugio that made the hand-off —
  // not by the titular, who did not end anything.
  const ended = await db
    .select({ authorRole: petEvents.authorRole, org: petEvents.authorOrganizationId })
    .from(petEvents)
    .where(and(eq(petEvents.petId, f.pet.id), eq(petEvents.eventType, "caretaker_ended")));
  expect(ended).toEqual([{ authorRole: "shelter", org: f.orgId }]);
}

describe("an adoption reversal ends the caretaker arrangement (audit K, W2)", () => {
  it("reverseAdoption ends the accepted grant, cancels the pending one, and signs as the refugio", async () => {
    const f = await petWithArrangements("Rev");
    const now = new Date();
    await db.insert(petEvents).values({
      petId: f.pet.id,
      eventType: "adoption_finalized",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: f.coordinatorId,
      authorRole: "shelter",
      authorOrganizationId: f.orgId,
      payload: validateEventPayload("adoption_finalized", {
        previous_owner_organization_id: f.orgId,
        adopter_user_id: titularId,
        foster_user_id: null,
        contract_attachment_id: null,
        post_adoption_followup_months: null,
        notes: null,
      }),
    });
    // NON-VACUITY CONTROL: both halves live going in.
    await expectArrangementsLive(f);

    const result = await reverseAdoption(
      { petPublicToken: f.pet.publicToken, reason: null },
      {
        repo: AdoptionRepository,
        actor: {
          user: { id: f.coordinatorId },
          organization: {
            id: f.orgId,
            publicToken: "unused",
            verified: true,
            displayName: "CGOC Refugio",
          },
        },
        transaction: db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>,
      },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await expectArrangementsClosed(f);
  });
});

describe("an org accepting an owner's return ends the caretaker arrangement (audit K, W2)", () => {
  it("orgAcceptOwnerReturnUseCase ends the accepted grant, cancels the pending one, and signs as the refugio", async () => {
    const f = await petWithArrangements("Ret");
    const proposedAt = new Date(Date.now() - 1000);
    await db.insert(petEvents).values({
      petId: f.pet.id,
      eventType: "custody_transfer_proposed",
      occurredAt: proposedAt,
      recordedAt: proposedAt,
      recordedByUserId: titularId,
      authorRole: "owner",
      payload: validateEventPayload("custody_transfer_proposed", {
        from_user_id: titularId,
        from_organization_id: null,
        to_user_id: null,
        to_organization_id: f.orgId,
        reason: "post_adoption_failed_return",
        notes: null,
        matched_against_pet_id: null,
        proposed_at: proposedAt.toISOString(),
      }),
    });
    await expectArrangementsLive(f);

    const result = await orgAcceptOwnerReturnUseCase({
      orgId: f.orgId,
      orgDisplayName: "CGOC Refugio",
      actingUserId: f.coordinatorId,
      petPublicToken: f.pet.publicToken,
    });
    expect("error" in result ? result.error : null).toBeNull();
    await expectArrangementsClosed(f);
  });
});
