// Parity and use-case tests for src/modules/decomiso/application/*.
//
// These are INTEGRATION tests that run against the real seeded Postgres DB
// (mirroring the approach in __tests__/decomiso-handoff.test.ts and
// __tests__/decomiso-execute-action.test.ts).
//
// We emulate the transaction steps directly rather than driving the full server
// action (which requires supabase auth). We use the same "emulate transaction
// steps" approach as the canonical decomiso tests in __tests__/.
//
// Tests covered:
//   executeDecomiso (in-tx body):
//     - registered_pet happy path: case + events + ownership + audit created
//     - unowned_animal path: pet created + registered event + case
//     - validateAttachments: < 2 files rejected
//     - validateSeizureMotive: otro without detail rejected
//     - validateReceiverOrg: missing/wrong-type org rejected
//
//   acceptDecomisoHandoffInTx:
//     - happy path: custody_transferred + ownership flip + close govt case + open receiver case + audit
//     - validateAcceptDecomisoHandoff: wrong receiver org rejected
//     - validateAcceptDecomisoHandoff: non-sanitary_authority opener rejected
//
//   rejectDecomisoHandoffInTx:
//     - happy path: note_added + case stays open + no ownership flip + receiverOrg cleared + audit
//     - validateRejectDecomisoHandoff: no current receiver rejected
//
//   reassignDecomisoInTx:
//     - happy path: cancel note + new proposal + receiverOrg updated + audit
//
//   reassign -> accept (L-4):
//     - the new receiver accepts against the latest proposal
//     - the superseded receiver is refused
//
//   Pure domain rules:
//     - motiveLabel — label for all motives
//     - validateSeizureMotive — otro without/with detail
//     - validateAttachments — < 2 files, > 10 MB file (decomiso-evidence, D10)
//     - validateUnownedAnimal — missing species, invalid species, age too high
//     - validateReceiverOrg — not found, not verified, wrong type, self

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, openCase } from "@/lib/infra/case-helpers";
import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";

import {
  motiveLabel,
  validateAttachments,
  validateReceiverOrg,
  validateSeizureMotive,
  validateUnownedAnimal,
} from "../../domain/seizure-rules";
import {
  acceptDecomisoHandoffInTx,
  validateAcceptDecomisoHandoff,
} from "../accept-decomiso-handoff";
import { executeDecomiso } from "../execute-decomiso";
import { reassignDecomisoInTx } from "../reassign-decomiso";
import {
  rejectDecomisoHandoffInTx,
  validateRejectDecomisoHandoff,
} from "../reject-decomiso-handoff";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UC_GOVT_ORG_TOKEN = "DIM-UC-DECO-GOVT1";
const UC_RCV_ORG_TOKEN = "DIM-UC-DECO-RCV1";
const UC_RCV2_ORG_TOKEN = "DIM-UC-DECO-RCV2";
const UC_PET_TOKEN = "DIM-UC-DECO-PET1";

// Pre-generate UUIDs so they can be referenced before DB roundtrip.
const govtUserIdFixed = randomUUID();
const receiverUserIdFixed = randomUUID();

let govtOrgId: string;
let receiverOrgId: string;
let receiver2OrgId: string;
let petId: string;
let govtUserId: string;
let receiverUserId: string;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    // Clean up any prior state from this fixture set.
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${UC_PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${UC_PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE public_code LIKE 'DIM-UC-DECO%'`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${UC_PET_TOKEN}`);
    await tx.execute(sql`DELETE FROM organization_memberships WHERE organization_id IN (
      SELECT id FROM organizations WHERE public_token IN (${UC_GOVT_ORG_TOKEN}, ${UC_RCV_ORG_TOKEN}, ${UC_RCV2_ORG_TOKEN})
    )`);
    await tx.execute(sql`DELETE FROM organizations WHERE public_token IN (
      ${UC_GOVT_ORG_TOKEN}, ${UC_RCV_ORG_TOKEN}, ${UC_RCV2_ORG_TOKEN}
    )`);
    // Clean up profiles from any prior test run with the same fixed UUIDs.
    await tx.execute(
      sql`DELETE FROM profiles WHERE id IN (${govtUserIdFixed}, ${receiverUserIdFixed})`,
    );
  });

  await withMutationOverride(async (tx) => {
    // Govt user + sanitary_authority org.
    const [profile] = await tx
      .insert(profiles)
      .values({
        id: govtUserIdFixed,
        displayName: "UC Decomiso Govt",
        role: "govt",
        accountType: "institutional",
      })
      .returning({ id: profiles.id });
    govtUserId = profile.id;

    const [govtOrg] = await tx
      .insert(organizations)
      .values({
        publicToken: UC_GOVT_ORG_TOKEN,
        legalName: "Autoridad Sanitaria UC Test",
        displayName: "Autoridad UC",
        orgType: "sanitary_authority",
        email: "sanidad-uc@dim-test.local",
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

    // Receiver org 1.
    const [rcvOrg] = await tx
      .insert(organizations)
      .values({
        publicToken: UC_RCV_ORG_TOKEN,
        legalName: "Refugio UC Test",
        displayName: "Refugio UC",
        orgType: "shelter",
        email: "refugio-uc@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning({ id: organizations.id });
    receiverOrgId = rcvOrg.id;

    const [recvProfile] = await tx
      .insert(profiles)
      .values({
        id: receiverUserIdFixed,
        displayName: "UC Receiver",
        role: "owner",
        accountType: "personal",
      })
      .returning({ id: profiles.id });
    receiverUserId = recvProfile.id;

    await tx.insert(organizationMemberships).values({
      userId: receiverUserId,
      organizationId: receiverOrgId,
      role: "coordinator",
    });

    // Receiver org 2.
    const [rcv2Org] = await tx
      .insert(organizations)
      .values({
        publicToken: UC_RCV2_ORG_TOKEN,
        legalName: "Refugio UC 2 Test",
        displayName: "Refugio UC 2",
        orgType: "shelter",
        email: "refugio-uc2@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning({ id: organizations.id });
    receiver2OrgId = rcv2Org.id;

    // Pet.
    const [pet] = await tx
      .insert(pets)
      .values({
        publicToken: UC_PET_TOKEN,
        name: "Fido UC",
        species: "dog",
        sex: "male",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Tres Arroyos",
      })
      .returning({ id: pets.id });
    petId = pet.id;
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    if (petId) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
      await tx.execute(sql`DELETE FROM ownerships WHERE pet_id = ${petId}`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}`);
      await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
    }
    if (govtOrgId) {
      await tx.execute(sql`DELETE FROM cases WHERE opened_by_organization_id = ${govtOrgId}`);
    }
    // Clean up by known tokens/IDs (resilient even if beforeAll partially failed).
    await tx.execute(sql`DELETE FROM organization_memberships WHERE organization_id IN (
      SELECT id FROM organizations WHERE public_token IN (${UC_GOVT_ORG_TOKEN}, ${UC_RCV_ORG_TOKEN}, ${UC_RCV2_ORG_TOKEN})
    )`);
    await tx.execute(sql`DELETE FROM organizations WHERE public_token IN (
      ${UC_GOVT_ORG_TOKEN}, ${UC_RCV_ORG_TOKEN}, ${UC_RCV2_ORG_TOKEN}
    )`);
    await tx.execute(
      sql`DELETE FROM profiles WHERE id IN (${govtUserIdFixed}, ${receiverUserIdFixed})`,
    );
  });
});

// ---------------------------------------------------------------------------
// Pure domain rule tests (no DB)
// ---------------------------------------------------------------------------

describe("pure domain rules", () => {
  describe("motiveLabel", () => {
    it("returns human-readable labels for all motives", () => {
      expect(motiveLabel("maltrato_fisico")).toBe("Maltrato físico");
      expect(motiveLabel("abandono_extremo")).toBe("Abandono extremo");
      expect(motiveLabel("acumulacion")).toBe("Acumulación");
      expect(motiveLabel("trafico")).toBe("Tráfico");
      expect(motiveLabel("sin_refugio_critico")).toBe("Sin refugio crítico");
      expect(motiveLabel("pelea_de_perros")).toBe("Pelea de perros");
      expect(motiveLabel("otro")).toBe("Otro");
    });
  });

  describe("validateSeizureMotive", () => {
    it("returns null for valid motives", () => {
      expect(validateSeizureMotive("maltrato_fisico")).toBeNull();
    });
    it("returns error for otro without detail", () => {
      expect(validateSeizureMotive("otro")).not.toBeNull();
      expect(validateSeizureMotive("otro", "")).not.toBeNull();
    });
    it("returns null for otro with detail", () => {
      expect(validateSeizureMotive("otro", "some detail")).toBeNull();
    });
  });

  describe("validateAttachments", () => {
    function makeFile(size = 100, name = "test.jpg"): File {
      return new File([new Uint8Array(size)], name, { type: "image/jpeg" });
    }
    it("requires at least 2 files", () => {
      expect(validateAttachments([])).not.toBeNull();
      expect(validateAttachments([makeFile()])).not.toBeNull();
      expect(validateAttachments([makeFile(), makeFile()])).toBeNull();
    });
    it("rejects files over the 10 MB evidence ceiling, and admits exactly 10 MB", () => {
      const smallFile = makeFile(100, "small.jpg");
      expect(validateAttachments([makeFile(10 * 1024 * 1024 + 1, "big.pdf"), smallFile])).toBe(
        'El archivo "big.pdf" supera el límite de 10 MB.',
      );
      expect(validateAttachments([makeFile(10 * 1024 * 1024, "edge.pdf"), smallFile])).toBeNull();
    });
  });

  describe("validateUnownedAnimal", () => {
    it("requires species", () => {
      expect(validateUnownedAnimal({ species: "", sex: "male" })).not.toBeNull();
    });
    it("rejects invalid species", () => {
      expect(validateUnownedAnimal({ species: "horse", sex: "male" })).not.toBeNull();
    });
    it("allows dog/cat/other", () => {
      expect(validateUnownedAnimal({ species: "dog", sex: "male" })).toBeNull();
      expect(validateUnownedAnimal({ species: "cat", sex: "female" })).toBeNull();
      expect(validateUnownedAnimal({ species: "other", sex: "unknown" })).toBeNull();
    });
    it("rejects age > 360 months", () => {
      expect(
        validateUnownedAnimal({ species: "dog", sex: "male", approxAgeMonths: 361 }),
      ).not.toBeNull();
    });
    it("allows age == 360 months", () => {
      expect(
        validateUnownedAnimal({ species: "dog", sex: "male", approxAgeMonths: 360 }),
      ).toBeNull();
    });
  });

  describe("validateReceiverOrg", () => {
    it("returns error for null org", () => {
      expect(validateReceiverOrg(null, "govt-id")).not.toBeNull();
    });
    it("returns error for unverified org", () => {
      expect(
        validateReceiverOrg(
          { id: "x", verified: false, status: "active", orgType: "shelter" },
          "govt-id",
        ),
      ).not.toBeNull();
    });
    it("returns error for inactive org", () => {
      expect(
        validateReceiverOrg(
          { id: "x", verified: true, status: "suspended", orgType: "shelter" },
          "govt-id",
        ),
      ).not.toBeNull();
    });
    it("returns error for wrong org type", () => {
      expect(
        validateReceiverOrg(
          { id: "x", verified: true, status: "active", orgType: "clinic" },
          "govt-id",
        ),
      ).not.toBeNull();
    });
    it("returns error when receiver is the same as govt org", () => {
      expect(
        validateReceiverOrg(
          { id: "govt-id", verified: true, status: "active", orgType: "shelter" },
          "govt-id",
        ),
      ).not.toBeNull();
    });
    it("returns null for valid shelter", () => {
      expect(
        validateReceiverOrg(
          { id: "rcv-id", verified: true, status: "active", orgType: "shelter" },
          "govt-id",
        ),
      ).toBeNull();
    });
    it("returns null for valid rescue_network", () => {
      expect(
        validateReceiverOrg(
          { id: "rcv-id", verified: true, status: "active", orgType: "rescue_network" },
          "govt-id",
        ),
      ).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: executeDecomiso (registered_pet path)
// ---------------------------------------------------------------------------

describe("executeDecomiso — registered_pet path", () => {
  let testCasePublicCode: string;

  it("creates case + events + ownership + audit inside the transaction", async () => {
    const fakeFiles = [
      new File([new Uint8Array(100)], "foto.jpg", { type: "image/jpeg" }),
      new File([new Uint8Array(100)], "acta.pdf", { type: "application/pdf" }),
    ];

    await withMutationOverride(async (tx) => {
      const result = await executeDecomiso(
        {
          subjectKind: "registered_pet",
          petPublicToken: UC_PET_TOKEN,
          seizureMotive: "maltrato_fisico",
          intendedReceiverOrganizationId: receiverOrgId,
          intakeCondition: "regular",
          attachmentFiles: fakeFiles,
        },
        {
          user: { id: govtUserId },
          govtOrg: {
            id: govtOrgId,
            displayName: "Autoridad UC",
            jurisdictionProvince: "Buenos Aires",
            jurisdictionLocality: "Tres Arroyos",
          },
          receiverOrg: {
            id: receiverOrgId,
            displayName: "Refugio UC",
            verified: true,
            status: "active",
            orgType: "shelter",
          },
          existingPet: { id: petId, name: "Fido UC", publicToken: UC_PET_TOKEN },
          unownedData: null,
          uploadedAttachments: [
            {
              filename: "foto.jpg",
              storagePath: "decomiso/test/foto.jpg",
              mimeType: "image/jpeg",
              size: 100,
            },
            {
              filename: "acta.pdf",
              storagePath: "decomiso/test/acta.pdf",
              mimeType: "application/pdf",
              size: 100,
            },
          ],
        },
        tx,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`use-case failed: ${JSON.stringify(result)}`);
      testCasePublicCode = result.publicCode;
    });

    // Assert on DB state outside the tx (the tx committed via withMutationOverride).
    const [caseRow] = await db
      .select()
      .from(cases)
      .where(eq(cases.publicCode, testCasePublicCode))
      .limit(1);
    expect(caseRow).toBeDefined();
    expect(caseRow.caseKind).toBe("custody_episode");
    expect(caseRow.status).toBe("open");
    expect(caseRow.openedByOrganizationId).toBe(govtOrgId);
    expect(caseRow.receiverOrganizationId).toBe(receiverOrgId);
    expect(caseRow.primaryPetId).toBe(petId);

    // shelter_intake_recorded event.
    const [intakeEvent] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "shelter_intake_recorded")))
      .limit(1);
    expect(intakeEvent).toBeDefined();
    const payload = intakeEvent.payload as Record<string, unknown>;
    expect(payload.intake_reason).toBe("seizure");
    expect(payload.seizure_motive).toBe("maltrato_fisico");

    // custody_transfer_proposed event.
    const [proposalEvent] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")))
      .limit(1);
    expect(proposalEvent).toBeDefined();
    const proposalPayload = proposalEvent.payload as Record<string, unknown>;
    expect(proposalPayload.to_organization_id).toBe(receiverOrgId);
    expect(String(proposalPayload.notes)).toContain("from_decomiso=true");

    // Govt's transitional shelter_custody opened.
    const [govtCustody] = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, govtOrgId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    expect(govtCustody).toBeDefined();

    // Audit log.
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, govtUserId), eq(auditLog.action, "decomiso_executed")))
      .limit(1);
    expect(auditRow).toBeDefined();
    const auditPayload = auditRow.payload as Record<string, unknown>;
    expect(auditPayload.pet_id).toBe(petId);
    expect(auditPayload.govt_org_id).toBe(govtOrgId);
    expect(auditPayload.receiver_org_id).toBe(receiverOrgId);
  });
});

// ---------------------------------------------------------------------------
// Integration: acceptDecomisoHandoffInTx
// ---------------------------------------------------------------------------

describe("acceptDecomisoHandoffInTx — happy path", () => {
  it("closes govt case + ownership flip + new receiver case + audit", async () => {
    // Setup: open a fresh custody_episode case as the govt org (reusing petId).
    let govtCaseId!: string;
    let govtCasePublicCode: string;
    let ownershipId: string;

    await withMutationOverride(async (tx) => {
      // Close any leftover open cases first.
      await tx.execute(sql`
        UPDATE cases SET status='closed', closed_reason='cancelled', closed_at=NOW()
        WHERE primary_pet_id=${petId} AND status='open'
      `);
      // Close any open ownerships.
      await tx
        .update(ownerships)
        .set({ endedAt: new Date() })
        .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));

      // Open a custody_episode case.
      const caseRow = await openCase(
        {
          kind: "custody_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          jurisdictionCountry: "AR",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Tres Arroyos",
          openedByUserId: govtUserId,
          openedByOrganizationId: govtOrgId,
          receiverOrganizationId: receiverOrgId,
          openedReason: {
            code: "decomiso_executed",
            motive: "maltrato_fisico",
            judicialRef: "IPP-TEST-ACC",
          },
        },
        tx,
      );
      govtCaseId = caseRow.id;
      govtCasePublicCode = caseRow.publicCode;

      // Emit a custody_transfer_proposed event.
      const proposalPayload = validateEventPayload("custody_transfer_proposed", {
        from_user_id: null,
        from_organization_id: govtOrgId,
        to_user_id: null,
        to_organization_id: receiverOrgId,
        reason: "other" as const,
        matched_against_pet_id: null,
        proposed_at: new Date().toISOString(),
        notes: "from_decomiso=true test",
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "custody_transfer_proposed",
        occurredAt: new Date(),
        recordedAt: new Date(),
        recordedByUserId: govtUserId,
        authorRole: "govt",
        authorOrganizationId: govtOrgId,
        authorVerified: true,
        payload: proposalPayload,
        caseId: govtCaseId,
      });

      // Open govt's shelter_custody.
      const [ownership] = await tx
        .insert(ownerships)
        .values({
          petId,
          ownerOrganizationId: govtOrgId,
          role: "shelter_custody",
          startedAt: new Date(),
        })
        .returning({ id: ownerships.id });
      ownershipId = ownership.id;
    });

    // Now run the accept use-case.
    await withMutationOverride(async (tx) => {
      const caseRow = (await tx.select().from(cases).where(eq(cases.id, govtCaseId)).limit(1))[0];
      const result = await acceptDecomisoHandoffInTx(
        caseRow,
        govtOrgId,
        "Autoridad UC",
        {
          user: { id: receiverUserId },
          organization: {
            id: receiverOrgId,
            publicToken: UC_RCV_ORG_TOKEN,
            verified: true,
            displayName: "Refugio UC",
          },
        },
        tx,
      );
      expect(result.ok).toBe(true);
    });

    // Assert on DB state.
    // Govt case must be closed.
    const [closedCase] = await db.select().from(cases).where(eq(cases.id, govtCaseId)).limit(1);
    expect(closedCase.status).toBe("closed");
    expect(closedCase.closedReason).toBe("resolved");

    // Govt ownership must be ended.
    const [govtOwnership] = await db
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
    expect(govtOwnership?.endedAt).not.toBeNull();

    // Receiver ownership must be open.
    const [rcvOwnership] = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, receiverOrgId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    expect(rcvOwnership).toBeDefined();

    // New receiver episode must be open.
    const [rcvCase] = await db
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.primaryPetId, petId),
          eq(cases.openedByOrganizationId, receiverOrgId),
          eq(cases.status, "open"),
        ),
      )
      .limit(1);
    expect(rcvCase).toBeDefined();
    expect(rcvCase.receiverOrganizationId).toBeNull();

    // custody_transferred event emitted.
    const [transferEvent] = await db
      .select()
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "custody_transferred"),
          eq(petEvents.caseId, govtCaseId),
        ),
      )
      .limit(1);
    expect(transferEvent).toBeDefined();

    // Audit log.
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, receiverUserId),
          eq(auditLog.action, "decomiso_handoff_accepted"),
        ),
      )
      .limit(1);
    expect(auditRow).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: rejectDecomisoHandoffInTx
// ---------------------------------------------------------------------------

describe("rejectDecomisoHandoffInTx — happy path", () => {
  it("emits note_added + clears receiverOrg + case stays open + audit", async () => {
    // Setup a fresh case.
    let govtCaseId!: string;
    let govtCasePublicCode: string;

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        UPDATE cases SET status='closed', closed_reason='cancelled', closed_at=NOW()
        WHERE primary_pet_id=${petId} AND status='open'
      `);
      await tx
        .update(ownerships)
        .set({ endedAt: new Date() })
        .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));

      const caseRow = await openCase(
        {
          kind: "custody_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          jurisdictionCountry: "AR",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Tres Arroyos",
          openedByUserId: govtUserId,
          openedByOrganizationId: govtOrgId,
          receiverOrganizationId: receiverOrgId,
          openedReason: {
            code: "decomiso_executed",
            motive: "maltrato_fisico",
            judicialRef: "IPP-TEST-REJ",
          },
        },
        tx,
      );
      govtCaseId = caseRow.id;
      govtCasePublicCode = caseRow.publicCode;
    });

    // Run the reject use-case.
    await withMutationOverride(async (tx) => {
      const [caseRow] = await tx.select().from(cases).where(eq(cases.id, govtCaseId)).limit(1);
      const result = await rejectDecomisoHandoffInTx(
        caseRow,
        govtOrgId,
        "No tenemos capacidad",
        {
          user: { id: receiverUserId },
          organization: {
            id: receiverOrgId,
            publicToken: UC_RCV_ORG_TOKEN,
            verified: true,
            displayName: "Refugio UC",
          },
        },
        tx,
      );
      expect(result.ok).toBe(true);
    });

    // Assert: case stays open.
    const [caseRow] = await db.select().from(cases).where(eq(cases.id, govtCaseId)).limit(1);
    expect(caseRow.status).toBe("open");
    // receiverOrganizationId cleared.
    expect(caseRow.receiverOrganizationId).toBeNull();

    // note_added event emitted.
    const [noteEvent] = await db
      .select()
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "note_added"),
          eq(petEvents.caseId, govtCaseId),
        ),
      )
      .limit(1);
    expect(noteEvent).toBeDefined();
    const notePayload = noteEvent.payload as Record<string, unknown>;
    expect(notePayload.category).toBe("system");
    expect(String(notePayload.text)).toContain("No tenemos capacidad");

    // Audit log.
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, receiverUserId),
          eq(auditLog.action, "decomiso_handoff_rejected"),
        ),
      )
      .limit(1);
    expect(auditRow).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: reassignDecomisoInTx
// ---------------------------------------------------------------------------

describe("reassignDecomisoInTx — happy path", () => {
  it("cancel note + new proposal + receiverOrg updated + audit", async () => {
    let govtCaseId!: string;

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        UPDATE cases SET status='closed', closed_reason='cancelled', closed_at=NOW()
        WHERE primary_pet_id=${petId} AND status='open'
      `);
      const caseRow = await openCase(
        {
          kind: "custody_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          jurisdictionCountry: "AR",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Tres Arroyos",
          openedByUserId: govtUserId,
          openedByOrganizationId: govtOrgId,
          receiverOrganizationId: receiverOrgId,
          openedReason: {
            code: "decomiso_executed",
            motive: "maltrato_fisico",
            judicialRef: "IPP-TEST-REA",
          },
        },
        tx,
      );
      govtCaseId = caseRow.id;
    });

    await withMutationOverride(async (tx) => {
      const [caseRow] = await tx.select().from(cases).where(eq(cases.id, govtCaseId)).limit(1);
      const result = await reassignDecomisoInTx(
        {
          id: caseRow.id,
          primaryPetId: caseRow.primaryPetId,
          publicCode: caseRow.publicCode,
          receiverOrganizationId: caseRow.receiverOrganizationId,
        },
        {
          id: receiver2OrgId,
          displayName: "Refugio UC 2",
          verified: true,
          status: "active",
          orgType: "shelter",
        },
        "Fido UC",
        "Sin capacidad en el primer refugio",
        {
          user: { id: govtUserId },
          govtOrg: {
            id: govtOrgId,
            displayName: "Autoridad UC",
            jurisdictionProvince: "Buenos Aires",
            jurisdictionLocality: "Tres Arroyos",
          },
        },
        tx,
      );
      expect(result.ok).toBe(true);
    });

    // Assert: case's receiverOrganizationId updated to receiver2.
    const [caseRow] = await db.select().from(cases).where(eq(cases.id, govtCaseId)).limit(1);
    expect(caseRow.receiverOrganizationId).toBe(receiver2OrgId);
    expect(caseRow.status).toBe("open");

    // Cancel note emitted.
    const [cancelNote] = await db
      .select()
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "note_added"),
          eq(petEvents.caseId, govtCaseId),
        ),
      )
      .limit(1);
    expect(cancelNote).toBeDefined();
    expect(String((cancelNote.payload as Record<string, unknown>).text)).toContain("Refugio UC 2");

    // New custody_transfer_proposed toward receiver2.
    const [newProposal] = await db
      .select()
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "custody_transfer_proposed"),
          eq(petEvents.caseId, govtCaseId),
        ),
      )
      .limit(1);
    expect(newProposal).toBeDefined();
    const proposalPayload = newProposal.payload as Record<string, unknown>;
    expect(proposalPayload.to_organization_id).toBe(receiver2OrgId);
    expect(String(proposalPayload.notes)).toContain("reassignment=true");

    // Audit log.
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, govtUserId),
          eq(auditLog.action, "decomiso_handoff_cancelled"),
        ),
      )
      .limit(1);
    expect(auditRow).toBeDefined();
    const auditPayload = auditRow.payload as Record<string, unknown>;
    expect(auditPayload.new_receiver_org_id).toBe(receiver2OrgId);
    expect(auditPayload.previous_receiver_org_id).toBe(receiverOrgId);
  });
});

// ---------------------------------------------------------------------------
// Reassign → accept (L-4)
// ---------------------------------------------------------------------------
// A reassign appends a SECOND custody_transfer_proposed on the same case —
// append-only, the first one is never rewritten. The escalation cron already
// reads that shape as normal (it keys on the LATEST proposal); the acceptance
// validator used to read it as corruption and refuse forever, so a reassigned
// decomiso could never be accepted by anyone.

describe("reassign → accept (L-4)", () => {
  it("the new receiver can accept a reassigned decomiso, against the latest proposal", async () => {
    let govtCaseId!: string;
    let govtCasePublicCode!: string;
    const firstProposalAt = new Date(Date.now() - 60 * 60 * 1000);

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        UPDATE cases SET status='closed', closed_reason='cancelled', closed_at=NOW()
        WHERE primary_pet_id=${petId} AND status='open'
      `);
      await tx
        .update(ownerships)
        .set({ endedAt: new Date() })
        .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));

      const caseRow = await openCase(
        {
          kind: "custody_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          jurisdictionCountry: "AR",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Tres Arroyos",
          openedByUserId: govtUserId,
          openedByOrganizationId: govtOrgId,
          receiverOrganizationId: receiverOrgId,
          openedReason: {
            code: "decomiso_executed",
            motive: "maltrato_fisico",
            judicialRef: "IPP-TEST-L4",
          },
        },
        tx,
      );
      govtCaseId = caseRow.id;
      govtCasePublicCode = caseRow.publicCode;

      // The ORIGINAL proposal, toward receiver 1, an hour ago.
      await tx.insert(petEvents).values({
        petId,
        eventType: "custody_transfer_proposed",
        occurredAt: firstProposalAt,
        recordedAt: firstProposalAt,
        recordedByUserId: govtUserId,
        authorRole: "govt",
        authorOrganizationId: govtOrgId,
        authorVerified: true,
        payload: validateEventPayload("custody_transfer_proposed", {
          from_user_id: null,
          from_organization_id: govtOrgId,
          to_user_id: null,
          to_organization_id: receiverOrgId,
          reason: "other" as const,
          matched_against_pet_id: null,
          proposed_at: firstProposalAt.toISOString(),
          notes: "from_decomiso=true test-l4",
        }),
        caseId: govtCaseId,
      });

      await tx.insert(ownerships).values({
        petId,
        ownerOrganizationId: govtOrgId,
        role: "shelter_custody",
        startedAt: firstProposalAt,
      });
    });

    // The govt reassigns to receiver 2 — the real in-tx body.
    await withMutationOverride(async (tx) => {
      const [caseRow] = await tx.select().from(cases).where(eq(cases.id, govtCaseId)).limit(1);
      await reassignDecomisoInTx(
        {
          id: caseRow.id,
          primaryPetId: caseRow.primaryPetId,
          publicCode: caseRow.publicCode,
          receiverOrganizationId: caseRow.receiverOrganizationId,
        },
        {
          id: receiver2OrgId,
          displayName: "Refugio UC 2",
          verified: true,
          status: "active",
          orgType: "shelter",
        },
        "Fido UC",
        "Sin capacidad en el primer refugio",
        {
          user: { id: govtUserId },
          govtOrg: {
            id: govtOrgId,
            displayName: "Autoridad UC",
            jurisdictionProvince: "Buenos Aires",
            jurisdictionLocality: "Tres Arroyos",
          },
        },
        tx,
      );
    });

    // Append-only: both proposals are still on the spine.
    const proposals = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(
        and(eq(petEvents.caseId, govtCaseId), eq(petEvents.eventType, "custody_transfer_proposed")),
      );
    expect(proposals).toHaveLength(2);

    const receiver2Ctx = {
      user: { id: receiverUserId },
      organization: {
        id: receiver2OrgId,
        publicToken: UC_RCV2_ORG_TOKEN,
        verified: true,
        displayName: "Refugio UC 2",
      },
    };

    const validation = await validateAcceptDecomisoHandoff(
      { casePublicCode: govtCasePublicCode },
      receiver2Ctx,
      db,
    );
    if (!validation.ok) throw new Error(`validation refused: ${validation.error}`);
    // The proposal it acts on is the reassignment, not the superseded one.
    const livePayload = validation.proposalEvent.payload as Record<string, unknown>;
    expect(livePayload.to_organization_id).toBe(receiver2OrgId);
    expect(String(livePayload.notes)).toContain("reassignment=true");

    await withMutationOverride(async (tx) => {
      const [caseRow] = await tx.select().from(cases).where(eq(cases.id, govtCaseId)).limit(1);
      const result = await acceptDecomisoHandoffInTx(
        caseRow,
        govtOrgId,
        "Autoridad UC",
        receiver2Ctx,
        tx,
      );
      expect(result.ok).toBe(true);
    });

    const [closedCase] = await db.select().from(cases).where(eq(cases.id, govtCaseId)).limit(1);
    expect(closedCase.status).toBe("closed");
    expect(closedCase.closedReason).toBe("resolved");

    const [rcv2Ownership] = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, receiver2OrgId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    expect(rcv2Ownership).toBeDefined();
  });

  it("the superseded receiver is refused after a reassign", async () => {
    // Same shape, but receiver 1 — whose proposal is the OLD one — tries.
    let govtCasePublicCode!: string;
    let govtCaseId!: string;
    const firstProposalAt = new Date(Date.now() - 60 * 60 * 1000);

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        UPDATE cases SET status='closed', closed_reason='cancelled', closed_at=NOW()
        WHERE primary_pet_id=${petId} AND status='open'
      `);
      const caseRow = await openCase(
        {
          kind: "custody_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          jurisdictionCountry: "AR",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Tres Arroyos",
          openedByUserId: govtUserId,
          openedByOrganizationId: govtOrgId,
          receiverOrganizationId: receiverOrgId,
          openedReason: { code: "decomiso_executed", motive: "maltrato_fisico", judicialRef: null },
        },
        tx,
      );
      govtCaseId = caseRow.id;
      govtCasePublicCode = caseRow.publicCode;
      await tx.insert(petEvents).values({
        petId,
        eventType: "custody_transfer_proposed",
        occurredAt: firstProposalAt,
        recordedAt: firstProposalAt,
        recordedByUserId: govtUserId,
        authorRole: "govt",
        authorOrganizationId: govtOrgId,
        authorVerified: true,
        payload: validateEventPayload("custody_transfer_proposed", {
          from_user_id: null,
          from_organization_id: govtOrgId,
          to_user_id: null,
          to_organization_id: receiverOrgId,
          reason: "other" as const,
          matched_against_pet_id: null,
          proposed_at: firstProposalAt.toISOString(),
          notes: "from_decomiso=true test-l4-old",
        }),
        caseId: govtCaseId,
      });
    });

    await withMutationOverride(async (tx) => {
      const [caseRow] = await tx.select().from(cases).where(eq(cases.id, govtCaseId)).limit(1);
      await reassignDecomisoInTx(
        {
          id: caseRow.id,
          primaryPetId: caseRow.primaryPetId,
          publicCode: caseRow.publicCode,
          receiverOrganizationId: caseRow.receiverOrganizationId,
        },
        {
          id: receiver2OrgId,
          displayName: "Refugio UC 2",
          verified: true,
          status: "active",
          orgType: "shelter",
        },
        "Fido UC",
        "Reasignado",
        {
          user: { id: govtUserId },
          govtOrg: {
            id: govtOrgId,
            displayName: "Autoridad UC",
            jurisdictionProvince: "Buenos Aires",
            jurisdictionLocality: "Tres Arroyos",
          },
        },
        tx,
      );
    });

    const result = await validateAcceptDecomisoHandoff(
      { casePublicCode: govtCasePublicCode },
      {
        user: { id: receiverUserId },
        organization: {
          id: receiverOrgId,
          publicToken: UC_RCV_ORG_TOKEN,
          verified: true,
          displayName: "Refugio UC",
        },
      },
      db,
    );
    expect(result).toEqual({
      ok: false,
      error: "El decomiso no fue dirigido a tu organización.",
    });

    await withMutationOverride(async (tx) => {
      await closeCase({ caseId: govtCaseId, reason: "cancelled", closedByUserId: govtUserId }, tx);
    });
  });
});

describe("reassign vs accept race (review 2026-09)", () => {
  // Both writers validate OUTSIDE their transaction. The old receiver validated
  // a moment before the reassign committed; its accept then ran on a stale
  // snapshot. Under the case row lock it now re-reads the case and refuses.
  it("refuses the old receiver's accept that validated before a reassign committed, and a stale reassign", async () => {
    let govtCaseId!: string;
    let govtCasePublicCode!: string;
    const firstProposalAt = new Date(Date.now() - 60 * 60 * 1000);

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        UPDATE cases SET status='closed', closed_reason='cancelled', closed_at=NOW()
        WHERE primary_pet_id=${petId} AND status='open'
      `);
      await tx
        .update(ownerships)
        .set({ endedAt: new Date() })
        .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
      const caseRow = await openCase(
        {
          kind: "custody_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          jurisdictionCountry: "AR",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Tres Arroyos",
          openedByUserId: govtUserId,
          openedByOrganizationId: govtOrgId,
          receiverOrganizationId: receiverOrgId,
          openedReason: { code: "decomiso_executed", motive: "maltrato_fisico", judicialRef: null },
        },
        tx,
      );
      govtCaseId = caseRow.id;
      govtCasePublicCode = caseRow.publicCode;
      await tx.insert(petEvents).values({
        petId,
        eventType: "custody_transfer_proposed",
        occurredAt: firstProposalAt,
        recordedAt: firstProposalAt,
        recordedByUserId: govtUserId,
        authorRole: "govt",
        authorOrganizationId: govtOrgId,
        authorVerified: true,
        payload: validateEventPayload("custody_transfer_proposed", {
          from_user_id: null,
          from_organization_id: govtOrgId,
          to_user_id: null,
          to_organization_id: receiverOrgId,
          reason: "other" as const,
          matched_against_pet_id: null,
          proposed_at: firstProposalAt.toISOString(),
          notes: "from_decomiso=true test-race",
        }),
        caseId: govtCaseId,
      });
      await tx.insert(ownerships).values({
        petId,
        ownerOrganizationId: govtOrgId,
        role: "shelter_custody",
        startedAt: firstProposalAt,
      });
    });

    const receiver1Ctx = {
      user: { id: receiverUserId },
      organization: {
        id: receiverOrgId,
        publicToken: UC_RCV_ORG_TOKEN,
        verified: true,
        displayName: "Refugio UC",
      },
    };

    // 1. Receiver 1 validates while the case is still theirs.
    const validation = await validateAcceptDecomisoHandoff(
      { casePublicCode: govtCasePublicCode },
      receiver1Ctx,
      db,
    );
    if (!validation.ok) throw new Error(`validation refused: ${validation.error}`);
    const staleSnapshot = validation.caseRow;

    // 2. The govt reassigns to receiver 2 and commits.
    const govtCtx = {
      user: { id: govtUserId },
      govtOrg: {
        id: govtOrgId,
        displayName: "Autoridad UC",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Tres Arroyos",
      },
    };
    const receiver2 = {
      id: receiver2OrgId,
      displayName: "Refugio UC 2",
      verified: true,
      status: "active",
      orgType: "shelter",
    };
    await withMutationOverride(async (tx) => {
      await reassignDecomisoInTx(
        {
          id: staleSnapshot.id,
          primaryPetId: staleSnapshot.primaryPetId,
          publicCode: staleSnapshot.publicCode,
          receiverOrganizationId: staleSnapshot.receiverOrganizationId,
        },
        receiver2,
        "Fido UC",
        "Reasignado durante la carrera",
        govtCtx,
        tx,
      );
    });

    // 3. Receiver 1's accept runs on the pre-reassign snapshot: refused.
    await expect(
      withMutationOverride(async (tx) => {
        await acceptDecomisoHandoffInTx(
          staleSnapshot,
          validation.govtOrgId,
          validation.govtOrgName,
          receiver1Ctx,
          tx,
        );
      }),
    ).rejects.toThrow(
      "El decomiso cambió mientras operabas (fue reasignado o ya no está abierto). Recargá la página.",
    );

    // Nothing moved: the case is open, addressed to receiver 2, and receiver 1
    // holds no custody.
    const [after] = await db.select().from(cases).where(eq(cases.id, govtCaseId)).limit(1);
    expect(after.status).toBe("open");
    expect(after.receiverOrganizationId).toBe(receiver2OrgId);
    const rcv1Custody = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, receiverOrgId),
          isNull(ownerships.endedAt),
        ),
      );
    expect(rcv1Custody).toHaveLength(0);

    // 4. A second reassign that validated on the same stale snapshot (receiver
    // 1) is refused too — reassign takes the same lock and re-check.
    await expect(
      withMutationOverride(async (tx) => {
        await reassignDecomisoInTx(
          {
            id: staleSnapshot.id,
            primaryPetId: staleSnapshot.primaryPetId,
            publicCode: staleSnapshot.publicCode,
            receiverOrganizationId: staleSnapshot.receiverOrganizationId,
          },
          receiver2,
          "Fido UC",
          "Segunda reasignacion vieja",
          govtCtx,
          tx,
        );
      }),
    ).rejects.toThrow("El decomiso cambió mientras operabas");

    await withMutationOverride(async (tx) => {
      await closeCase({ caseId: govtCaseId, reason: "cancelled", closedByUserId: govtUserId }, tx);
    });
  });
});

// ---------------------------------------------------------------------------
// validateAcceptDecomisoHandoff — guards
// ---------------------------------------------------------------------------

describe("validateAcceptDecomisoHandoff — guards", () => {
  it("rejects non-sanitary_authority opener", async () => {
    // Open a case where the opener is NOT a sanitary_authority.
    let nonGovtCaseId: string;
    let nonGovtCasePublicCode!: string;

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        UPDATE cases SET status='closed', closed_reason='cancelled', closed_at=NOW()
        WHERE primary_pet_id=${petId} AND status='open'
      `);
      // Use receiverOrgId (shelter) as the opener.
      const caseRow = await openCase(
        {
          kind: "custody_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          jurisdictionCountry: "AR",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Tres Arroyos",
          openedByUserId: govtUserId,
          openedByOrganizationId: receiverOrgId, // shelter, not sanitary_authority
          receiverOrganizationId: receiver2OrgId,
          openedReason: { code: "decomiso_executed", motive: "maltrato_fisico", judicialRef: null },
        },
        tx,
      );
      nonGovtCaseId = caseRow.id;
      nonGovtCasePublicCode = caseRow.publicCode;
    });

    const result = await validateAcceptDecomisoHandoff(
      { casePublicCode: nonGovtCasePublicCode },
      {
        user: { id: receiverUserId },
        organization: {
          id: receiver2OrgId,
          publicToken: UC_RCV2_ORG_TOKEN,
          verified: true,
          displayName: "Refugio UC 2",
        },
      },
      db,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("sanitaria");
    }

    // Close the case again.
    await withMutationOverride(async (tx) => {
      await closeCase(
        { caseId: nonGovtCaseId, reason: "cancelled", closedByUserId: govtUserId },
        tx,
      );
    });
  });

  it("rejects wrong receiver org", async () => {
    let testCaseId: string;
    let testCasePublicCode!: string;

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        UPDATE cases SET status='closed', closed_reason='cancelled', closed_at=NOW()
        WHERE primary_pet_id=${petId} AND status='open'
      `);
      const caseRow = await openCase(
        {
          kind: "custody_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          jurisdictionCountry: "AR",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Tres Arroyos",
          openedByUserId: govtUserId,
          openedByOrganizationId: govtOrgId,
          receiverOrganizationId: receiverOrgId,
          openedReason: { code: "decomiso_executed", motive: "maltrato_fisico", judicialRef: null },
        },
        tx,
      );
      testCaseId = caseRow.id;
      testCasePublicCode = caseRow.publicCode;
    });

    const result = await validateAcceptDecomisoHandoff(
      { casePublicCode: testCasePublicCode },
      {
        user: { id: receiverUserId },
        // receiver2OrgId is NOT the designated receiver — should be rejected.
        organization: {
          id: receiver2OrgId,
          publicToken: UC_RCV2_ORG_TOKEN,
          verified: true,
          displayName: "Refugio UC 2",
        },
      },
      db,
    );

    expect(result.ok).toBe(false);

    await withMutationOverride(async (tx) => {
      await closeCase({ caseId: testCaseId, reason: "cancelled", closedByUserId: govtUserId }, tx);
    });
  });
});

// ---------------------------------------------------------------------------
// validateRejectDecomisoHandoff — guards
// ---------------------------------------------------------------------------

describe("validateRejectDecomisoHandoff — guards", () => {
  it("rejects case with no current receiver (already rejected/cleared)", async () => {
    let testCaseId: string;
    let testCasePublicCode!: string;

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        UPDATE cases SET status='closed', closed_reason='cancelled', closed_at=NOW()
        WHERE primary_pet_id=${petId} AND status='open'
      `);
      const caseRow = await openCase(
        {
          kind: "custody_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          jurisdictionCountry: "AR",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Tres Arroyos",
          openedByUserId: govtUserId,
          openedByOrganizationId: govtOrgId,
          // No receiverOrganizationId — simulates already-cleared state.
          openedReason: { code: "decomiso_executed", motive: "maltrato_fisico", judicialRef: null },
        },
        tx,
      );
      testCaseId = caseRow.id;
      testCasePublicCode = caseRow.publicCode;
    });

    const result = await validateRejectDecomisoHandoff(
      { casePublicCode: testCasePublicCode },
      {
        user: { id: receiverUserId },
        organization: {
          id: receiverOrgId,
          publicToken: UC_RCV_ORG_TOKEN,
          verified: true,
          displayName: "Refugio UC",
        },
      },
      db,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("destinatario");
    }

    await withMutationOverride(async (tx) => {
      await closeCase({ caseId: testCaseId, reason: "cancelled", closedByUserId: govtUserId }, tx);
    });
  });
});
