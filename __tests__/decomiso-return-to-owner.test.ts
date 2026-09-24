// Integration tests for the decomiso return-to-owner terminal — the
// `closed_to_owner_return` phase documented in
// src/modules/cases/domain/lifecycles/custody-episode.ts that no action
// reached until returnCustodyToOwner. PO decision 2026-07-18: "Si se lo
// devuelve, nunca se le fue" — the former owner's SAME ownership row is
// reactivated, not re-inserted.
//
// Test approach: exercises the real DB, calling the real use-case functions
// directly (executeDecomiso, validateReturnCustodyToOwner,
// returnCustodyToOwnerInTx) — same approach as
// __tests__/former-owner-custody-read-access.test.ts, which this file
// extends: that file's "full-access continuity on return" describe block
// simulated the ownership-layer effect of a return path by hand (no such
// path existed yet); this file exercises the REAL path end to end.
//
// Coverage:
//   - Happy path: episode closes (status='closed', closedReason='resolved'),
//     the SAME ownership row is reactivated (same id, endedAt back to null,
//     startedAt untouched), the govt shelter_custody ownership closes, a new
//     custody_transferred event is emitted (reason='return_to_original_owner'),
//     an audit row is written, and a notification is returned for the owner.
//   - Post-return: requirePetAccess grants FULL owner access via Path 1;
//     getFormerOwnerReadAccess no longer applies (no open custody_episode).
//   - Append-only: the original decomiso events (shelter_intake_recorded,
//     custody_transfer_proposed) are untouched; the return only ADDS a new
//     custody_transferred event.
//   - Authorization: an org without opener authority over the case is
//     rejected by validateReturnCustodyToOwner.
//   - Guards: case not found, wrong case kind is n/a here (only
//     custody_episode is exercised), already-closed episode is rejected,
//     unowned animal (no former owner) is rejected.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  auditLog,
  cases,
  db,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { setAuditMutationGucs, withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Mock: @/lib/supabase/server — only the requirePetAccess/getFormerOwnerReadAccess
// assertions need a controllable session; every DB read/write underneath
// stays the REAL Postgres instance.
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: () => mockGetUser() } })),
}));

function sessionFor(userId: string) {
  return { data: { user: { id: userId, email: `${userId}@dim-test.local` } }, error: null };
}

// Imported AFTER the mock is registered.
import { getFormerOwnerReadAccess, requirePetAccess } from "@/lib/infra/pet-access";
import { executeDecomiso } from "@/src/modules/decomiso/application/execute-decomiso";
import {
  returnCustodyToOwnerInTx,
  validateReturnCustodyToOwner,
} from "@/src/modules/decomiso/application/return-custody-to-owner";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GOVT_ORG_TOKEN = "DIM-RTO-GOVT1";
const OTHER_GOVT_ORG_TOKEN = "DIM-RTO-GOVT2";
const RECEIVER_ORG_TOKEN = "DIM-RTO-RCV1";
const PET_TOKEN = "DIM-RTO-PET1";
const UNOWNED_PET_TOKEN = "DIM-RTO-STRAY1";

// Jurisdiction assignments of the acting govt operator (RA-8 R3). The fixture
// pet — and therefore the custody_episode opened over it — is CABA with a NULL
// locality, so a WHOLE-CABA assignment is what covers it: `Ciudad Autónoma de
// Buenos Aires` is CABA's whole-province INDEC locality, which subsumes every
// barrio and matches on province alone. Passing the govt org's own
// (province, locality) here instead would be the bug the fence exists to stop:
// org membership is not scope.
const CABA_ACTOR = {
  role: "govt",
  jurisdictions: [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }],
};
// Same operator, reassigned to another province. Their membership in the CABA
// authority org is untouched — that is the whole point.
const MENDOZA_ACTOR = {
  role: "govt",
  jurisdictions: [{ province: "Mendoza", locality: "Godoy Cruz" }],
};

const govtUserId = randomUUID();
const otherGovtUserId = randomUUID();
const ownerId = randomUUID();

let govtOrgId: string;
let otherGovtOrgId: string;
let receiverOrgId: string;
let petId: string;

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token IN (${PET_TOKEN}, ${UNOWNED_PET_TOKEN})
    )`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token IN (${PET_TOKEN}, ${UNOWNED_PET_TOKEN})
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token IN (${PET_TOKEN}, ${UNOWNED_PET_TOKEN})
    )`);
    await tx.execute(
      sql`DELETE FROM pets WHERE public_token IN (${PET_TOKEN}, ${UNOWNED_PET_TOKEN})`,
    );
    await tx.execute(sql`DELETE FROM organization_memberships WHERE organization_id IN (
      SELECT id FROM organizations WHERE public_token IN (
        ${GOVT_ORG_TOKEN}, ${OTHER_GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN}
      )
    )`);
    await tx.execute(sql`DELETE FROM organizations WHERE public_token IN (
      ${GOVT_ORG_TOKEN}, ${OTHER_GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN}
    )`);
    await tx.execute(
      sql`DELETE FROM profiles WHERE id IN (${govtUserId}, ${otherGovtUserId}, ${ownerId})`,
    );
  });

  await withMutationOverride(async (tx) => {
    await tx.insert(profiles).values([
      { id: govtUserId, displayName: "RTO Govt", role: "govt", accountType: "institutional" },
      {
        id: otherGovtUserId,
        displayName: "RTO Other Govt",
        role: "govt",
        accountType: "institutional",
      },
      { id: ownerId, displayName: "RTO Owner", role: "owner", accountType: "personal" },
    ]);

    const [govtOrg] = await tx
      .insert(organizations)
      .values({
        publicToken: GOVT_ORG_TOKEN,
        legalName: "Autoridad Sanitaria RTO Test",
        displayName: "Autoridad RTO",
        orgType: "sanitary_authority",
        email: "rto-govt@dim-test.local",
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

    // A SECOND sanitary_authority org that did NOT open the case — used for
    // the authorization guard test.
    const [otherGovtOrg] = await tx
      .insert(organizations)
      .values({
        publicToken: OTHER_GOVT_ORG_TOKEN,
        legalName: "Autoridad Sanitaria RTO Test 2",
        displayName: "Autoridad RTO Dos",
        orgType: "sanitary_authority",
        email: "rto-govt2@dim-test.local",
        verified: true,
        status: "active",
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "Buenos Aires",
      })
      .returning({ id: organizations.id });
    otherGovtOrgId = otherGovtOrg.id;
    await tx.insert(organizationMemberships).values({
      userId: otherGovtUserId,
      organizationId: otherGovtOrgId,
      role: "coordinator",
    });

    const [receiverOrg] = await tx
      .insert(organizations)
      .values({
        publicToken: RECEIVER_ORG_TOKEN,
        legalName: "Refugio RTO Test",
        displayName: "Refugio RTO",
        orgType: "shelter",
        email: "rto-receiver@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning({ id: organizations.id });
    receiverOrgId = receiverOrg.id;

    const [pet] = await tx
      .insert(pets)
      .values({
        publicToken: PET_TOKEN,
        name: "Return To Owner Pet",
        species: "dog",
        sex: "male",
        jurisdictionProvince: "CABA",
      })
      .returning({ id: pets.id });
    petId = pet.id;
    await tx.insert(ownerships).values({
      petId,
      ownerUserId: ownerId,
      role: "owner",
      startedAt: new Date("2026-01-01"),
    });
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token IN (${PET_TOKEN}, ${UNOWNED_PET_TOKEN})
    )`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token IN (${PET_TOKEN}, ${UNOWNED_PET_TOKEN})
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token IN (${PET_TOKEN}, ${UNOWNED_PET_TOKEN})
    )`);
    await tx.execute(
      sql`DELETE FROM pets WHERE public_token IN (${PET_TOKEN}, ${UNOWNED_PET_TOKEN})`,
    );
    await tx.execute(sql`DELETE FROM organization_memberships WHERE organization_id IN (
      SELECT id FROM organizations WHERE public_token IN (
        ${GOVT_ORG_TOKEN}, ${OTHER_GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN}
      )
    )`);
    await tx.execute(sql`DELETE FROM organizations WHERE public_token IN (
      ${GOVT_ORG_TOKEN}, ${OTHER_GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN}
    )`);
    await tx.execute(
      sql`DELETE FROM profiles WHERE id IN (${govtUserId}, ${otherGovtUserId}, ${ownerId})`,
    );
  });
  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.execute(
      sql`DELETE FROM audit_log WHERE actor_user_id IN (${govtUserId}, ${otherGovtUserId})`,
    );
  });
});

// ---------------------------------------------------------------------------
// Helper: run executeDecomiso for the fixture pet, returns the case
// publicCode.
// ---------------------------------------------------------------------------

async function runDecomisoOnFixturePet(): Promise<string> {
  const fakeFiles = [new File([new Uint8Array(10)], "acta.pdf", { type: "application/pdf" })];
  let publicCode = "";
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
          displayName: "Autoridad RTO",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Buenos Aires",
        },
        receiverOrg: {
          id: receiverOrgId,
          displayName: "Refugio RTO",
          verified: true,
          status: "active",
          orgType: "shelter",
        },
        existingPet: { id: petId, name: "Return To Owner Pet", publicToken: PET_TOKEN },
        unownedData: null,
        uploadedAttachments: [
          {
            filename: "acta.pdf",
            storagePath: "decomiso/rto/acta.pdf",
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

describe("returnCustodyToOwner", () => {
  let casePublicCode: string;
  let originalOwnershipId: string;
  let preExistingEventCount: number;

  it("executeDecomiso ends the owner's ownership and opens the custody episode", async () => {
    const [before] = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), eq(ownerships.ownerUserId, ownerId)))
      .limit(1);
    originalOwnershipId = before.id;

    casePublicCode = await runDecomisoOnFixturePet();

    const [ownerRow] = await db
      .select({ id: ownerships.id, endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), eq(ownerships.ownerUserId, ownerId)))
      .limit(1);
    expect(ownerRow.id).toBe(originalOwnershipId);
    expect(ownerRow.endedAt).not.toBeNull();

    const preExistingEvents = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(eq(petEvents.petId, petId));
    preExistingEventCount = preExistingEvents.length;
    expect(preExistingEventCount).toBeGreaterThan(0);
  });

  it("wrong-authority org cannot return: validateReturnCustodyToOwner rejects a non-opener govt org", async () => {
    const result = await validateReturnCustodyToOwner(
      { casePublicCode },
      {
        govtOrg: {
          id: otherGovtOrgId,
          displayName: "Autoridad RTO Dos",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Buenos Aires",
        },
        actor: CABA_ACTOR,
      },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Solo la autoridad que abrió el decomiso");
    }
  });

  // -------------------------------------------------------------------------
  // RA-8 R3 — the jurisdictional fence
  // -------------------------------------------------------------------------

  it("out-of-jurisdiction operator cannot return, even holding the OPENING org's membership", async () => {
    // The exact reachable scenario: this operator's assignments were moved to
    // Mendoza, but nobody revoked their membership in the CABA authority that
    // opened this episode. Every pre-fence check passes for them — the case
    // exists, is a custody_episode, is open, and openedByOrganizationId is
    // their own org — so returning an animal in a province they no longer
    // govern was one button click.
    const result = await validateReturnCustodyToOwner(
      { casePublicCode },
      {
        govtOrg: {
          id: govtOrgId,
          displayName: "Autoridad RTO",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Buenos Aires",
        },
        actor: MENDOZA_ACTOR,
      },
      db,
    );
    expect(result.ok, "an out-of-jurisdiction operator was allowed to return custody").toBe(false);
    // Indistinguishable from a bad code: no existence oracle over the national
    // custody register.
    if (!result.ok) expect(result.error).toBe("Caso no encontrado.");
  });

  it("an operator with ZERO assignments is fenced out (fail-closed, not wide-open)", async () => {
    const result = await validateReturnCustodyToOwner(
      { casePublicCode },
      {
        govtOrg: {
          id: govtOrgId,
          displayName: "Autoridad RTO",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Buenos Aires",
        },
        actor: { role: "govt", jurisdictions: [] },
      },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Caso no encontrado.");
  });

  it("admin is universal — the fence does not fence the national role out", async () => {
    const result = await validateReturnCustodyToOwner(
      { casePublicCode },
      {
        govtOrg: {
          id: govtOrgId,
          displayName: "Autoridad RTO",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Buenos Aires",
        },
        actor: { role: "admin", jurisdictions: [] },
      },
      db,
    );
    expect(result.ok, "admin was blocked by the jurisdiction fence").toBe(true);
  });

  it("unknown case public code is rejected cleanly", async () => {
    const result = await validateReturnCustodyToOwner(
      { casePublicCode: "CAS-DOES-NOTEXIST" },
      {
        govtOrg: {
          id: govtOrgId,
          displayName: "Autoridad RTO",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Buenos Aires",
        },
        actor: CABA_ACTOR,
      },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Caso no encontrado.");
  });

  it("happy path: validate + in-tx close the episode, reactivate the SAME ownership row, emit events, notify", async () => {
    const validated = await validateReturnCustodyToOwner(
      { casePublicCode },
      {
        govtOrg: {
          id: govtOrgId,
          displayName: "Autoridad RTO",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Buenos Aires",
        },
        actor: CABA_ACTOR,
      },
      db,
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(`validate failed: ${validated.error}`);

    expect(validated.formerOwner.id).toBe(originalOwnershipId);
    expect(validated.formerOwner.ownerUserId).toBe(ownerId);
    expect(validated.petPublicToken).toBe(PET_TOKEN);

    let pendingNotifications: Awaited<
      ReturnType<typeof returnCustodyToOwnerInTx>
    >["pendingNotifications"] = [];

    await db.transaction(async (tx) => {
      const result = await returnCustodyToOwnerInTx(
        validated.caseRow,
        validated.formerOwner,
        validated.petName,
        {
          user: { id: govtUserId },
          govtOrg: {
            id: govtOrgId,
            displayName: "Autoridad RTO",
            jurisdictionProvince: "CABA",
            jurisdictionLocality: "Buenos Aires",
          },
        },
        tx,
      );
      expect(result.ok).toBe(true);
      pendingNotifications = result.pendingNotifications;
    });

    // --- Case closed with reason='resolved' ---
    const [caseRow] = await db
      .select()
      .from(cases)
      .where(eq(cases.publicCode, casePublicCode))
      .limit(1);
    expect(caseRow.status).toBe("closed");
    expect(caseRow.closedReason).toBe("resolved");
    expect(caseRow.closedByUserId).toBe(govtUserId);

    // --- SAME ownership row reactivated (same id, endedAt back to null) ---
    const [ownerRow] = await db
      .select()
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), eq(ownerships.ownerUserId, ownerId)))
      .limit(1);
    expect(ownerRow.id).toBe(originalOwnershipId);
    expect(ownerRow.endedAt).toBeNull();
    expect(ownerRow.role).toBe("owner");
    // startedAt preserved from the ORIGINAL row — this is reactivation, not a
    // fresh insert. (Compared to the year, since exact ms round-trip through
    // Postgres timestamptz can differ from the JS Date literal.)
    expect(ownerRow.startedAt.getUTCFullYear()).toBe(2026);

    // --- Govt shelter_custody ownership closed ---
    const [govtCustody] = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, govtOrgId),
          eq(ownerships.role, "shelter_custody"),
        ),
      )
      .limit(1);
    expect(govtCustody).not.toBeUndefined();
    expect(govtCustody.endedAt).not.toBeNull();

    // --- New custody_transferred event ---
    const [transferEvent] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transferred")))
      .limit(1);
    expect(transferEvent).not.toBeUndefined();
    const tp = transferEvent.payload as Record<string, unknown>;
    expect(tp.from_organization_id).toBe(govtOrgId);
    expect(tp.to_user_id).toBe(ownerId);
    expect(tp.from_role).toBe("shelter_custody");
    expect(tp.to_role).toBe("owner");
    expect(tp.reason).toBe("return_to_original_owner");
    expect(transferEvent.caseId).toBe(validated.caseRow.id);

    // --- Append-only: original events untouched, only a NEW row added ---
    const allEvents = await db.select().from(petEvents).where(eq(petEvents.petId, petId));
    expect(allEvents.length).toBe(preExistingEventCount + 1);
    const intakeEvent = allEvents.find((e) => e.eventType === "shelter_intake_recorded");
    expect(intakeEvent).not.toBeUndefined();
    const proposalEvent = allEvents.find((e) => e.eventType === "custody_transfer_proposed");
    expect(proposalEvent).not.toBeUndefined();

    // --- Audit row ---
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, govtUserId),
          eq(auditLog.action, "decomiso_returned_to_owner"),
        ),
      )
      .limit(1);
    expect(auditRow).not.toBeUndefined();
    const ap = auditRow.payload as Record<string, unknown>;
    expect(ap.pet_id).toBe(petId);
    expect(ap.returned_owner_user_id).toBe(ownerId);
    expect(ap.reactivated_ownership_id).toBe(originalOwnershipId);

    // --- Notification to the returned owner ---
    expect(pendingNotifications.length).toBeGreaterThan(0);
    const ownerNotif = pendingNotifications.find((n) => n.userId === ownerId);
    expect(ownerNotif).not.toBeUndefined();
    expect(ownerNotif?.notificationType).toBe("decomiso_returned_to_owner");
    expect(ownerNotif?.body).toContain("te fue devuelta");
  });

  it("post-return: requirePetAccess grants FULL owner access via Path 1 (unmodified)", async () => {
    mockGetUser.mockResolvedValue(sessionFor(ownerId));
    const access = await requirePetAccess(PET_TOKEN);
    expect(access.ok).toBe(true);
    if (access.ok) {
      expect(access.accessPath).toBe("owner");
      expect(access.pet.id).toBe(petId);
    }
  });

  it("post-return: getFormerOwnerReadAccess no longer applies (no open custody_episode)", async () => {
    const access = await getFormerOwnerReadAccess(PET_TOKEN, ownerId);
    expect(access.ok).toBe(false);
  });

  it("idempotency: returning an already-closed episode is rejected cleanly", async () => {
    const result = await validateReturnCustodyToOwner(
      { casePublicCode },
      {
        govtOrg: {
          id: govtOrgId,
          displayName: "Autoridad RTO",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Buenos Aires",
        },
        actor: CABA_ACTOR,
      },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Este caso ya no está abierto.");
  });
});

describe("returnCustodyToOwner — unowned animal guard", () => {
  let strayPetId: string;
  let strayCasePublicCode: string;

  beforeAll(async () => {
    await withMutationOverride(async (tx) => {
      const fakeFiles = [new File([new Uint8Array(10)], "acta.pdf", { type: "application/pdf" })];
      const result = await executeDecomiso(
        {
          subjectKind: "unowned_animal",
          unownedAnimal: { species: "dog", sex: "unknown" },
          seizureMotive: "sin_refugio_critico",
          intendedReceiverOrganizationId: receiverOrgId,
          intakeCondition: "regular",
          attachmentFiles: fakeFiles,
        },
        {
          user: { id: govtUserId },
          govtOrg: {
            id: govtOrgId,
            displayName: "Autoridad RTO",
            jurisdictionProvince: "CABA",
            jurisdictionLocality: "Buenos Aires",
          },
          receiverOrg: {
            id: receiverOrgId,
            displayName: "Refugio RTO",
            verified: true,
            status: "active",
            orgType: "shelter",
          },
          existingPet: null,
          unownedData: { species: "dog", sex: "unknown" },
          uploadedAttachments: [
            {
              filename: "acta.pdf",
              storagePath: "decomiso/rto/stray-acta.pdf",
              mimeType: "application/pdf",
              size: 10,
            },
          ],
        },
        tx,
      );
      expect(result.ok).toBe(true);
      if (!result.ok)
        throw new Error(`executeDecomiso (unowned) failed: ${JSON.stringify(result)}`);
      strayCasePublicCode = result.publicCode;
    });

    const [caseRow] = await db
      .select({ primaryPetId: cases.primaryPetId })
      .from(cases)
      .where(eq(cases.publicCode, strayCasePublicCode))
      .limit(1);
    strayPetId = caseRow.primaryPetId as string;
  });

  afterAll(async () => {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${strayPetId}`);
      await tx.execute(sql`DELETE FROM ownerships WHERE pet_id = ${strayPetId}`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${strayPetId}`);
      await tx.execute(sql`DELETE FROM pets WHERE id = ${strayPetId}`);
    });
  });

  it("rejects a return for an unowned animal (no former owner to return to)", async () => {
    const result = await validateReturnCustodyToOwner(
      { casePublicCode: strayCasePublicCode },
      {
        govtOrg: {
          id: govtOrgId,
          displayName: "Autoridad RTO",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Buenos Aires",
        },
        actor: CABA_ACTOR,
      },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("No se encontró un dueño anterior");
    }
  });
});
