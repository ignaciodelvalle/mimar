// Regression fence: a custody hand-off over a SPONSORED pet ends the
// sponsorship on the spine (rehome-by-titular; WU3 review, M-2).
//
// THE BUG THIS EXISTS FOR
// ---------------------------------------------------------------------------
// `endAllLiveOwnerships` closes every live ownership row on a pet — decomiso,
// dispute resolution, adoption finalize, foster conversion all route through
// it. Closing the org's `shelter_custody` row ends a rehome sponsorship in
// fact, but the ledger did not say so: no `rehome_sponsorship_ended` was
// written, so `findOpenSponsorship` (keyed on an UNMATCHED
// `rehome_sponsorship_started`) stayed true forever. Consequences:
//
//   - REQ-16 refuses every future request on the pet ("ya tiene una
//     organización acompañando") with nothing left to withdraw — the titular
//     is locked out of the feature for good, by a seizure they did not cause.
//   - The rollback script (ADR-7) keys on the same predicate and would "end"
//     an arrangement that ended months earlier, onto whoever holds the pet now.
//
// Same shape as the zombie caretaker grant (2b7cb5be): a blanket row close
// that skipped the spine fact the row's lifecycle owes. The fix mirrors it —
// when the closed custody row is the one an open sponsorship points at,
// `endAllLiveOwnerships` writes the closing fact in the same transaction.
//
// WHY THIS HITS REAL POSTGRES (the `db` vitest project, serial)
// ---------------------------------------------------------------------------
// The claim is about what survives a real decomiso transaction across
// ownerships, pet_events and cases. The first `it` is the NON-VACUITY
// CONTROL: the sponsorship is open going in.

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  db,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { findOpenSponsorship } from "@/src/modules/adoption/infrastructure/rehome-sponsorship-writer";
import { executeDecomiso } from "@/src/modules/decomiso/application/execute-decomiso";
import { RehomeRepository } from "@/src/modules/rehome/infrastructure/rehome-repository";

import { setAuditMutationGucs, withMutationOverride } from "./_helpers/db-overrides";

const GOVT_ORG_TOKEN = "DIM-DRSP-GOVT1";
const RECEIVER_ORG_TOKEN = "DIM-DRSP-RCV1";
const SPONSOR_ORG_TOKEN = "DIM-DRSP-SPN1";
const PET_TOKEN = "DIM-DRSP-PET1";

const govtUserId = randomUUID();
const titularId = randomUUID();

let govtOrgId: string;
let receiverOrgId: string;
let sponsorOrgId: string;
let petId: string;
let sponsorCustodyId: string;

async function purge(): Promise<void> {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
    await tx.execute(sql`DELETE FROM organization_memberships WHERE organization_id IN (
      SELECT id FROM organizations WHERE public_token IN (
        ${GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN}, ${SPONSOR_ORG_TOKEN}
      )
    )`);
    await tx.execute(sql`DELETE FROM organizations WHERE public_token IN (
      ${GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN}, ${SPONSOR_ORG_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM profiles WHERE display_name IN ('DRSP Govt', 'DRSP Titular')`);
  });
  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.execute(sql`DELETE FROM audit_log WHERE actor_user_id = ${govtUserId}`);
  });
}

beforeAll(async () => {
  await purge();
  await withMutationOverride(async (tx) => {
    await tx.insert(profiles).values([
      { id: govtUserId, displayName: "DRSP Govt", role: "govt", accountType: "institutional" },
      { id: titularId, displayName: "DRSP Titular", role: "owner", accountType: "personal" },
    ]);

    const [govtOrg] = await tx
      .insert(organizations)
      .values({
        publicToken: GOVT_ORG_TOKEN,
        legalName: "Autoridad Sanitaria DRSP",
        displayName: "Autoridad DRSP",
        orgType: "sanitary_authority",
        email: "drsp-govt@dim-test.local",
        verified: true,
        status: "active",
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "Buenos Aires",
      })
      .returning({ id: organizations.id });
    govtOrgId = govtOrg.id;
    await tx.insert(organizationMemberships).values({
      userId: govtUserId,
      organizationId: govtOrgId,
      role: "coordinator",
    });

    const [receiverOrg] = await tx
      .insert(organizations)
      .values({
        publicToken: RECEIVER_ORG_TOKEN,
        legalName: "Refugio Receptor DRSP",
        displayName: "Refugio Receptor",
        orgType: "shelter",
        email: "drsp-receiver@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning({ id: organizations.id });
    receiverOrgId = receiverOrg.id;

    const [sponsorOrg] = await tx
      .insert(organizations)
      .values({
        publicToken: SPONSOR_ORG_TOKEN,
        legalName: "Refugio Padrino DRSP",
        displayName: "Refugio Padrino",
        orgType: "shelter",
        email: "drsp-sponsor@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning({ id: organizations.id });
    sponsorOrgId = sponsorOrg.id;

    const [pet] = await tx
      .insert(pets)
      .values({
        publicToken: PET_TOKEN,
        name: "Decomiso Sponsored Pet",
        species: "dog",
        sex: "female",
        jurisdictionProvince: "CABA",
        adoptionEligible: true,
        adoptionEligibilitySetAt: new Date(),
        adoptionListedAt: new Date(),
      })
      .returning({ id: pets.id });
    petId = pet.id;

    // THE SHAPE UNDER TEST: the titular keeps the title while a verified org
    // sponsors the listing — owner + shelter_custody, both live — and the
    // spine says the sponsorship started on that custody row.
    const now = new Date();
    await tx
      .insert(ownerships)
      .values({ petId, ownerUserId: titularId, role: "owner", startedAt: now });
    const [custody] = await tx
      .insert(ownerships)
      .values({ petId, ownerOrganizationId: sponsorOrgId, role: "shelter_custody", startedAt: now })
      .returning({ id: ownerships.id });
    sponsorCustodyId = custody.id;
    await tx.insert(petEvents).values({
      petId,
      eventType: "rehome_sponsorship_started",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: govtUserId,
      authorRole: "shelter",
      authorOrganizationId: sponsorOrgId,
      authorVerified: true,
      payload: validateEventPayload("rehome_sponsorship_started", {
        ownership_id: sponsorCustodyId,
        sponsoring_organization_id: sponsorOrgId,
        consented_by_user_id: titularId,
        request_case_public_code: "CAS-DRSP-0001",
        listing_case_id: null,
        note: null,
      }),
    });
  });
});

afterAll(async () => {
  await purge();
});

// TEST ORDER IS LOAD-BEARING: the control must run before the decomiso.
describe("decomiso over a sponsored pet — the control", () => {
  it("goes in with an open sponsorship pointing at the live custody row", async () => {
    const open = await findOpenSponsorship(
      petId,
      db as unknown as Parameters<typeof findOpenSponsorship>[1],
    );
    expect(open?.ownershipId).toBe(sponsorCustodyId);
    expect(open?.sponsoringOrganizationId).toBe(sponsorOrgId);
    expect(await RehomeRepository.hasOpenSponsorship(petId)).toBe(true);
  });
});

describe("decomiso over a sponsored pet — the arrangement ends with the hand-off", () => {
  it("writes rehome_sponsorship_ended for the seized custody row, signed by the authority", async () => {
    const fakeFiles = [new File([new Uint8Array(10)], "acta.pdf", { type: "application/pdf" })];
    await withMutationOverride(async (tx) => {
      const result = await executeDecomiso(
        {
          subjectKind: "registered_pet",
          petPublicToken: PET_TOKEN,
          seizureMotive: "maltrato_fisico",
          intendedReceiverOrganizationId: receiverOrgId,
          intakeCondition: "regular",
          attachmentFiles: fakeFiles,
        },
        {
          user: { id: govtUserId },
          govtOrg: {
            id: govtOrgId,
            displayName: "Autoridad DRSP",
            jurisdictionProvince: "CABA",
            jurisdictionLocality: "Buenos Aires",
          },
          receiverOrg: {
            id: receiverOrgId,
            displayName: "Refugio Receptor",
            verified: true,
            status: "active",
            orgType: "shelter",
          },
          existingPet: { id: petId, name: "Decomiso Sponsored Pet", publicToken: PET_TOKEN },
          unownedData: null,
          uploadedAttachments: [
            {
              filename: "acta.pdf",
              storagePath: "decomiso/drsp/acta.pdf",
              mimeType: "application/pdf",
              size: 10,
            },
          ],
        },
        tx,
      );
      expect(result.ok, `executeDecomiso failed: ${JSON.stringify(result)}`).toBe(true);
    });

    // 1. The spine says the sponsorship is over, and names WHICH custody row.
    const ended = await db
      .select({
        payload: petEvents.payload,
        authorRole: petEvents.authorRole,
        authorOrganizationId: petEvents.authorOrganizationId,
        authorVerified: petEvents.authorVerified,
        recordedByUserId: petEvents.recordedByUserId,
      })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "rehome_sponsorship_ended")));
    expect(ended).toHaveLength(1);
    const payload = ended[0].payload as { ownership_id: string; outcome: string };
    expect(payload.ownership_id).toBe(sponsorCustodyId);
    // Not adopted, not withdrawn by the titular, not ended by the org, not
    // deceased: the authority took the animal. The platform-side outcome is
    // the one the catalog has for an end no party to the arrangement chose.
    expect(payload.outcome).toBe("withdrawn_by_platform");
    // Signed by the authority that ran the decomiso, like every other event
    // it writes — not as the org, not as the titular.
    expect(ended[0].authorRole).toBe("govt");
    expect(ended[0].authorOrganizationId).toBe(govtOrgId);
    expect(ended[0].authorVerified).toBe(true);
    expect(ended[0].recordedByUserId).toBe(govtUserId);
  });

  it("the sponsorship is no longer open — REQ-16 would no longer refuse a future request for it", async () => {
    expect(
      await findOpenSponsorship(petId, db as unknown as Parameters<typeof findOpenSponsorship>[1]),
    ).toBeNull();
    expect(await RehomeRepository.hasOpenSponsorship(petId)).toBe(false);
  });

  it("leaves the authority's custody as the only live ownership row", async () => {
    const live = await db
      .select({ role: ownerships.role, org: ownerships.ownerOrganizationId })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
    expect(live).toEqual([{ role: "shelter_custody", org: govtOrgId }]);
    const [sponsorRow] = await db
      .select({ endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(eq(ownerships.id, sponsorCustodyId));
    expect(sponsorRow.endedAt).not.toBeNull();
  });
});
