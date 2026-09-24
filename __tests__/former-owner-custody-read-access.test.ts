// Integration tests for the former-owner READ-ONLY custody access grant
// (PO decision 2026-07-18): "El ex-dueño conserva LECTURA durante el proceso
// [de custodia oficial / decomiso]. Si lo pierde [definitivamente], también
// los permisos. Si se lo devuelve, nunca se le fue."
//
// Exercises the real DB (same approach as
// src/modules/decomiso/application/__tests__/use-cases.test.ts and
// __tests__/decomiso-handoff.test.ts): executeDecomiso and
// acceptDecomisoHandoffInTx run against a real seeded pet/ownership chain,
// then lib/infra/pet-access.ts's getFormerOwnerReadAccess / requirePetAccess /
// requireAlivePetAccess are asserted against the resulting rows.
//
// Coverage:
//   - Before any custody episode: no read grant.
//   - During an OPEN custody episode (post-decomiso): the immediate former
//     owner gets a read-only grant; a different non-owner user does not.
//   - requireAlivePetAccess (the real write gate) still rejects the former
//     owner outright — the read grant never reaches the write boundary.
//   - Continuity across an org-to-org handoff: the govt episode closes and a
//     NEW episode opens for the receiver org in the same transaction — the
//     former owner's read grant survives, now scoped to the new case.
//   - Permanent loss: once the custody_episode closes with no successor
//     episode (adoption_finalized / death_recorded terminal), the read grant
//     is gone.
//   - Full-access continuity on return: once an active 'owner' ownership row
//     exists again for the former owner, requirePetAccess's EXISTING Path 1
//     grants full "owner" access automatically — no special-casing needed.
//   - No cross-pet leak: the former owner of pet A cannot read pet B's
//     custody record, even though pet B is ALSO under an open custody
//     episode with a different former owner.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  cases,
  db,
  organizationMemberships,
  organizations,
  ownerships,
  pets,
  profiles,
} from "@/db";
import { closeCase } from "@/lib/infra/case-helpers";
import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Mock: @/lib/supabase/server — the write-boundary tests (requirePetAccess /
// requireAlivePetAccess) need a controllable session, but every DB read/write
// underneath stays the REAL Postgres instance (unlike __tests__/pet-access.test.ts,
// which mocks @/db too — this file deliberately does not).
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: () => mockGetUser() } })),
}));

function sessionFor(userId: string) {
  return { data: { user: { id: userId, email: `${userId}@dim-test.local` } }, error: null };
}

// Imported AFTER the mock is registered.
import {
  getFormerOwnerReadAccess,
  requireAlivePetAccess,
  requirePetAccess,
} from "@/lib/infra/pet-access";
import { acceptDecomisoHandoffInTx } from "@/src/modules/decomiso/application/accept-decomiso-handoff";
import { executeDecomiso } from "@/src/modules/decomiso/application/execute-decomiso";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GOVT_ORG_TOKEN = "DIM-FOR-GOVT1";
const RECEIVER_ORG_TOKEN = "DIM-FOR-RCV1";
const PET_A_TOKEN = "DIM-FOR-PETA1";
const PET_B_TOKEN = "DIM-FOR-PETB1";

const govtUserId = randomUUID();
const receiverUserId = randomUUID();
const ownerAId = randomUUID();
const ownerBId = randomUUID();
const strangerId = randomUUID();

let govtOrgId: string;
let receiverOrgId: string;
let petAId: string;
let petBId: string;

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token IN (${PET_A_TOKEN}, ${PET_B_TOKEN})
    )`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token IN (${PET_A_TOKEN}, ${PET_B_TOKEN})
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token IN (${PET_A_TOKEN}, ${PET_B_TOKEN})
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token IN (${PET_A_TOKEN}, ${PET_B_TOKEN})`);
    await tx.execute(sql`DELETE FROM organization_memberships WHERE organization_id IN (
      SELECT id FROM organizations WHERE public_token IN (${GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN})
    )`);
    await tx.execute(sql`DELETE FROM organizations WHERE public_token IN (
      ${GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN}
    )`);
    await tx.execute(
      sql`DELETE FROM profiles WHERE id IN (${govtUserId}, ${receiverUserId}, ${ownerAId}, ${ownerBId}, ${strangerId})`,
    );
  });

  await withMutationOverride(async (tx) => {
    await tx.insert(profiles).values([
      { id: govtUserId, displayName: "FOR Govt", role: "govt", accountType: "institutional" },
      { id: receiverUserId, displayName: "FOR Receiver", role: "owner", accountType: "personal" },
      { id: ownerAId, displayName: "FOR Owner A", role: "owner", accountType: "personal" },
      { id: ownerBId, displayName: "FOR Owner B", role: "owner", accountType: "personal" },
      { id: strangerId, displayName: "FOR Stranger", role: "owner", accountType: "personal" },
    ]);

    const [govtOrg] = await tx
      .insert(organizations)
      .values({
        publicToken: GOVT_ORG_TOKEN,
        legalName: "Autoridad Sanitaria FOR Test",
        displayName: "Autoridad FOR",
        orgType: "sanitary_authority",
        email: "for-govt@dim-test.local",
        verified: true,
        status: "active",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Tres Arroyos",
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
        legalName: "Refugio FOR Test",
        displayName: "Refugio FOR",
        orgType: "shelter",
        email: "for-refugio@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning({ id: organizations.id });
    receiverOrgId = receiverOrg.id;
    await tx.insert(organizationMemberships).values({
      userId: receiverUserId,
      organizationId: receiverOrgId,
      role: "coordinator",
    });

    const [petA] = await tx
      .insert(pets)
      .values({
        publicToken: PET_A_TOKEN,
        name: "Former Owner Pet A",
        species: "dog",
        sex: "male",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Tres Arroyos",
      })
      .returning({ id: pets.id });
    petAId = petA.id;
    await tx.insert(ownerships).values({
      petId: petAId,
      ownerUserId: ownerAId,
      role: "owner",
      startedAt: new Date("2026-01-01"),
    });

    const [petB] = await tx
      .insert(pets)
      .values({
        publicToken: PET_B_TOKEN,
        name: "Former Owner Pet B",
        species: "cat",
        sex: "female",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Tres Arroyos",
      })
      .returning({ id: pets.id });
    petBId = petB.id;
    await tx.insert(ownerships).values({
      petId: petBId,
      ownerUserId: ownerBId,
      role: "owner",
      startedAt: new Date("2026-01-01"),
    });
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (${petAId}, ${petBId})`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (${petAId}, ${petBId})`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (${petAId}, ${petBId})`);
    await tx.execute(sql`DELETE FROM pets WHERE id IN (${petAId}, ${petBId})`);
    await tx.execute(sql`DELETE FROM organization_memberships WHERE organization_id IN (
      SELECT id FROM organizations WHERE public_token IN (${GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN})
    )`);
    await tx.execute(sql`DELETE FROM organizations WHERE public_token IN (
      ${GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN}
    )`);
    await tx.execute(
      sql`DELETE FROM profiles WHERE id IN (${govtUserId}, ${receiverUserId}, ${ownerAId}, ${ownerBId}, ${strangerId})`,
    );
  });
});

// ---------------------------------------------------------------------------
// Helper: run executeDecomiso for a registered pet, returns the case row.
// ---------------------------------------------------------------------------

async function runDecomisoOn(petPublicToken: string, petId: string, petName: string) {
  const fakeFiles = [
    new File([new Uint8Array(10)], "foto.jpg", { type: "image/jpeg" }),
    new File([new Uint8Array(10)], "acta.pdf", { type: "application/pdf" }),
  ];
  let publicCode = "";
  await withMutationOverride(async (tx) => {
    const result = await executeDecomiso(
      {
        subjectKind: "registered_pet",
        petPublicToken,
        seizureMotive: "maltrato_fisico",
        intendedReceiverOrganizationId: receiverOrgId,
        intakeCondition: "regular",
        attachmentFiles: fakeFiles,
      },
      {
        user: { id: govtUserId },
        govtOrg: {
          id: govtOrgId,
          displayName: "Autoridad FOR",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Tres Arroyos",
        },
        receiverOrg: {
          id: receiverOrgId,
          displayName: "Refugio FOR",
          verified: true,
          status: "active",
          orgType: "shelter",
        },
        existingPet: { id: petId, name: petName, publicToken: petPublicToken },
        unownedData: null,
        uploadedAttachments: [
          {
            filename: "foto.jpg",
            storagePath: "decomiso/for/foto.jpg",
            mimeType: "image/jpeg",
            size: 10,
          },
          {
            filename: "acta.pdf",
            storagePath: "decomiso/for/acta.pdf",
            mimeType: "application/pdf",
            size: 10,
          },
        ],
      },
      tx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`executeDecomiso failed: ${JSON.stringify(result)}`);
    publicCode = result.publicCode;
  });
  return publicCode;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("former-owner custody read access", () => {
  let petACasePublicCode: string;
  let petBCasePublicCode: string;

  it("before any custody episode: no read grant for the (still active) owner", async () => {
    const access = await getFormerOwnerReadAccess(PET_A_TOKEN, ownerAId);
    expect(access.ok).toBe(false);
  });

  it("executeDecomiso ends the owner's ownership and opens the custody episode", async () => {
    petACasePublicCode = await runDecomisoOn(PET_A_TOKEN, petAId, "Former Owner Pet A");
    petBCasePublicCode = await runDecomisoOn(PET_B_TOKEN, petBId, "Former Owner Pet B");

    const [ownerRow] = await db
      .select({ endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petAId),
          eq(ownerships.ownerUserId, ownerAId),
          eq(ownerships.role, "owner"),
        ),
      )
      .limit(1);
    expect(ownerRow?.endedAt).not.toBeNull();
  });

  describe("during the OPEN custody episode", () => {
    it("grants the immediate former owner a read-only, case-scoped grant", async () => {
      const access = await getFormerOwnerReadAccess(PET_A_TOKEN, ownerAId);
      expect(access.ok).toBe(true);
      if (!access.ok) return;
      expect(access.accessPath).toBe("former-owner-during-custody");
      expect(access.readOnly).toBe(true);
      expect(access.pet.id).toBe(petAId);
      expect(access.custodyCase.publicCode).toBe(petACasePublicCode);
    });

    it("denies a different non-owner user (the grant is scoped to the immediate former owner only)", async () => {
      const access = await getFormerOwnerReadAccess(PET_A_TOKEN, strangerId);
      expect(access.ok).toBe(false);
    });

    it("does not leak across pets: the former owner of pet A cannot read pet B's custody record", async () => {
      const crossAccess = await getFormerOwnerReadAccess(PET_B_TOKEN, ownerAId);
      expect(crossAccess.ok).toBe(false);

      // Sanity: pet B's OWN former owner (ownerB) does get a grant on pet B —
      // proves the denial above is a scoping decision, not a broken query.
      const ownAccess = await getFormerOwnerReadAccess(PET_B_TOKEN, ownerBId);
      expect(ownAccess.ok).toBe(true);
      if (ownAccess.ok) expect(ownAccess.custodyCase.publicCode).toBe(petBCasePublicCode);
    });

    it("requirePetAccess alone (no sibling call) still denies the former owner — read grant lives outside the write boundary", async () => {
      mockGetUser.mockResolvedValue(sessionFor(ownerAId));
      const access = await requirePetAccess(PET_A_TOKEN);
      expect(access.ok).toBe(false);
      if (!access.ok) expect(access.reason).toBe("not-found-or-forbidden");
    });

    it("requireAlivePetAccess (the real write gate) rejects the former owner — no write capability", async () => {
      mockGetUser.mockResolvedValue(sessionFor(ownerAId));
      const access = await requireAlivePetAccess(PET_A_TOKEN);
      expect(access.ok).toBe(false);
      if (!access.ok) {
        expect(access.reason).toBe("not-found-or-forbidden");
        expect(access.accessPath).toBeNull();
      }
    });
  });

  describe("continuity across an org-to-org handoff", () => {
    it("the former owner's read grant survives, now scoped to the receiver's NEW episode", async () => {
      const [govtCaseRow] = await db
        .select()
        .from(cases)
        .where(eq(cases.publicCode, petACasePublicCode))
        .limit(1);
      expect(govtCaseRow).toBeDefined();

      let receiverPublicCode = "";
      await withMutationOverride(async (tx) => {
        const [caseRow] = await tx
          .select()
          .from(cases)
          .where(eq(cases.id, govtCaseRow.id))
          .limit(1);
        const result = await acceptDecomisoHandoffInTx(
          caseRow,
          govtOrgId,
          "Autoridad FOR",
          {
            user: { id: receiverUserId },
            organization: {
              id: receiverOrgId,
              publicToken: RECEIVER_ORG_TOKEN,
              verified: true,
              displayName: "Refugio FOR",
            },
          },
          tx,
        );
        expect(result.ok).toBe(true);
        if (result.ok) receiverPublicCode = result.receiverPublicCode;
      });

      expect(receiverPublicCode).not.toBe(petACasePublicCode);

      const access = await getFormerOwnerReadAccess(PET_A_TOKEN, ownerAId);
      expect(access.ok).toBe(true);
      if (access.ok) expect(access.custodyCase.publicCode).toBe(receiverPublicCode);

      petACasePublicCode = receiverPublicCode;
    });
  });

  describe("permanent loss", () => {
    it("closing the custody episode with no successor episode ends the read grant", async () => {
      const [openCaseRow] = await db
        .select()
        .from(cases)
        .where(eq(cases.publicCode, petACasePublicCode))
        .limit(1);
      expect(openCaseRow).toBeDefined();

      // Simulates the adoption_finalized / death_recorded terminal cascade —
      // the case closes with NO new custody_episode opened.
      await withMutationOverride(async (tx) => {
        await closeCase(
          { caseId: openCaseRow.id, reason: "resolved", closedByUserId: govtUserId },
          tx,
        );
      });

      const access = await getFormerOwnerReadAccess(PET_A_TOKEN, ownerAId);
      expect(access.ok).toBe(false);
    });
  });

  describe("full-access continuity on return", () => {
    it("once an active 'owner' ownership row exists again, requirePetAccess grants FULL access via the existing owner path — no special-casing needed", async () => {
      // Simulates whatever a future decomiso-specific return path would do at
      // the ownership layer: the former owner has an active ownership row
      // again for this pet. (No such write-side use-case exists yet for
      // decomiso today — see the accompanying report — this test documents
      // the invariant the read-only grant relies on: once ownership is
      // reinstated, Path 1 of requirePetAccess takes over automatically and
      // this file's read-only resolver is never consulted.)
      await withMutationOverride(async (tx) => {
        await tx.insert(ownerships).values({
          petId: petAId,
          ownerUserId: ownerAId,
          role: "owner",
          startedAt: new Date(),
        });
      });

      mockGetUser.mockResolvedValue(sessionFor(ownerAId));
      const access = await requirePetAccess(PET_A_TOKEN);
      expect(access.ok).toBe(true);
      if (access.ok) {
        expect(access.accessPath).toBe("owner");
        expect(access.pet.id).toBe(petAId);
      }

      // The custody episode is already closed (previous describe block) —
      // the read-only resolver correctly has nothing to grant at this point
      // either way, since Path 1 already won.
      const formerOwnerAccess = await getFormerOwnerReadAccess(PET_A_TOKEN, ownerAId);
      expect(formerOwnerAccess.ok).toBe(false);
    });
  });
});
