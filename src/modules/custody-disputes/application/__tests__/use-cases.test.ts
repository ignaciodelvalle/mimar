// Parity and use-case tests for src/modules/custody-disputes/application/*.
//
// These are INTEGRATION tests that run against the real seeded Postgres DB,
// mirroring the approach used in __tests__/custody-disputes.test.ts.
//
// We drive the use-cases directly (no auth wrappers) and assert on DB state
// and return values to confirm parity with the original monolithic action.
//
// Tests covered:
//
//   openDisputeFromEvent:
//     - happy path: dispute row inserted, parties created, case linked, pet flagged
//     - duplicate open dispute rejected
//     - bogus preCreatedCaseId throws
//
//   addDisputePartyUseCase:
//     - happy path: party row + audit row + notification
//     - rejects when neither user nor org provided
//     - rejects when both user and org provided
//     - rejects when dispute not found
//     - rejects when dispute is not open
//     - rejects govt caller outside their jurisdiction
//
//   resolveDisputeUseCase:
//     - happy path (ownership_confirmed): dispute resolved + pet flag cleared + audit + event
//     - rejects short resolution summary (< 100 chars)
//     - rejects ownership_transferred without a transfer target
//     - rejects resolving an already-resolved dispute
//     - ownership_transferred commits and records the outgoing holder as from
//
//   withdrawDisputeUseCase:
//     - happy path: status=withdrawn + pet flag cleared + audit row
//     - rejects govt who is not the raiser
//     - rejects withdrawing an unknown dispute token
//     - rejects withdrawing an already-resolved dispute
//
//   lookupTransferTargetUseCase:
//     - user found: returns displayName + active
//     - user not found: returns error
//     - org found and active: returns active=true
//     - org found but not active: returns active=false
//     - org not found: returns error
//     - empty id: returns error
//
//   escalateDisputeUseCase:
//     - happy path: note_added event + audit log entry
//     - rejects notes shorter than 20 characters
//     - rejects escalating a dispute that is no longer in curso
//     - rejects govt caller outside their jurisdiction

import { createClient } from "@supabase/supabase-js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditLog,
  custodyDisputeParties,
  custodyDisputes,
  db,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { openCase } from "@/lib/infra/case-helpers";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";

import { createFreshTestUser, deleteTestUser } from "@/__tests__/_helpers/fresh-test-user";
import { addDisputePartyUseCase } from "../add-dispute-party";
import { escalateDisputeUseCase } from "../escalate-dispute";
import { lookupTransferTargetUseCase } from "../lookup-transfer-target";
import { openDisputeFromEvent } from "../open-dispute";
import { resolveDisputeUseCase } from "../resolve-dispute";
import { withdrawDisputeUseCase } from "../withdraw-dispute";

// ---------------------------------------------------------------------------
// Supabase admin client
// ---------------------------------------------------------------------------

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Fixture emails / passwords
// ---------------------------------------------------------------------------

const UC_ADMIN_EMAIL = "uc-cd-admin@dim-test.local";
const UC_GOVT_EMAIL = "uc-cd-govt@dim-test.local";
const UC_OWNER_EMAIL = "uc-cd-owner@dim-test.local";
const UC_CLAIMANT_EMAIL = "uc-cd-claimant@dim-test.local";
const UC_TRANSFEREE_EMAIL = "uc-cd-transferee@dim-test.local";
const UC_PASS = "UcCustDisp_2026!";

const PROV = "Buenos Aires";
const LOCALITY = "La Plata";

let adminUserId!: string;
let govtUserId!: string;
let ownerUserId!: string;
let claimantUserId!: string;
let transfereeUserId!: string;

// Track pets for teardown.
const insertedPetIds: string[] = [];

// ---------------------------------------------------------------------------
// Session stubs (no HTTP needed — use-cases receive pre-authorized sessions)
// ---------------------------------------------------------------------------

function adminSession() {
  return {
    user: { id: adminUserId },
    profile: { role: "admin" as const },
    jurisdictions: [] as { province: string; locality: string }[],
  };
}

function govtSession() {
  return {
    user: { id: govtUserId },
    profile: { role: "govt" as const },
    jurisdictions: [{ province: PROV, locality: LOCALITY }],
  };
}

function govtOojSession() {
  return {
    user: { id: govtUserId },
    profile: { role: "govt" as const },
    jurisdictions: [{ province: "Córdoba", locality: "Córdoba Capital" }],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createUser(email: string): Promise<string> {
  const r = await createFreshTestUser(supabase, {
    email,
    password: UC_PASS,
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser ${email}: ${r.error?.message}`);
  return r.data.user.id;
}

async function purgeUserByEmail(email: string) {
  // `deleteTestUser` removes BOTH the auth user and its `public.profiles`
  // row (profiles carries no FK to auth.users — see fresh-test-user.ts). The
  // old body here (a bare, unpaged `listUsers()` + `deleteUser`) left the
  // profile behind every run: for UC_ADMIN_EMAIL that was an ACTIVE
  // role='admin' fixture that polluted admin-institutional.test.ts's
  // last-human-admin floor. The unpaged lookup could also silently miss the
  // target past the first 50 auth users and skip cleanup altogether.
  await deleteTestUser(supabase, db, email).catch(() => {});
}

/**
 * Seeds a pet owned by ownerUserId + an open custody dispute against it,
 * raised by claimantUserId. Mirrors the production raise-path sequencing:
 * openCase BEFORE the raising event, then openDisputeFromEvent.
 */
async function seedOpenDispute(
  petToken: string,
  petName: string,
): Promise<{ petId: string; disputeToken: string; disputeId: string }> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: petToken,
      name: petName,
      species: "dog",
      status: "active",
      jurisdictionProvince: PROV,
      jurisdictionLocality: LOCALITY,
    })
    .returning({ id: pets.id });
  insertedPetIds.push(pet.id);

  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId,
    role: "owner",
    startedAt: new Date(),
  });

  const result = await db.transaction(async (tx) => {
    const disputeCase = await openCase(
      {
        kind: "custody_dispute",
        primarySubjectKind: "registered_pet",
        primaryPetId: pet.id,
        jurisdictionProvince: PROV,
        jurisdictionLocality: LOCALITY,
        openedByUserId: claimantUserId,
        openedByOrganizationId: null,
        openedReason: { code: "custody_dispute_raised", raisedByRole: "owner" },
      },
      tx,
    );
    const payload = validateEventPayload("custody_dispute_raised", {
      raised_by_role: "owner",
      raised_by_user_id: claimantUserId,
      external_proceeding_reference: null,
      reason: "Reclamo de prueba con motivo suficientemente largo para el test.",
    });
    const [raisingEvent] = await tx
      .insert(petEvents)
      .values({
        petId: pet.id,
        eventType: "custody_dispute_raised",
        occurredAt: new Date(),
        recordedAt: new Date(),
        recordedByUserId: claimantUserId,
        authorRole: "owner",
        payload,
        caseId: disputeCase.id,
      })
      .returning({ id: petEvents.id });
    const { publicToken, disputeId } = await openDisputeFromEvent(tx, {
      petId: pet.id,
      raisingEventId: raisingEvent.id,
      raisedByUserId: claimantUserId,
      raisedByOrgId: null,
      raisedByRole: "owner",
      jurisdictionProvince: PROV,
      jurisdictionLocality: LOCALITY,
      initialParties: [
        { userId: ownerUserId, role: "current_owner" },
        { userId: claimantUserId, role: "claimant_owner" },
      ],
      preCreatedCaseId: disputeCase.id,
    });
    return { publicToken, disputeId };
  });

  return { petId: pet.id, disputeToken: result.publicToken, disputeId: result.disputeId };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  for (const e of [
    UC_ADMIN_EMAIL,
    UC_GOVT_EMAIL,
    UC_OWNER_EMAIL,
    UC_CLAIMANT_EMAIL,
    UC_TRANSFEREE_EMAIL,
  ]) {
    await purgeUserByEmail(e);
  }

  adminUserId = await createUser(UC_ADMIN_EMAIL);
  govtUserId = await createUser(UC_GOVT_EMAIL);
  ownerUserId = await createUser(UC_OWNER_EMAIL);
  claimantUserId = await createUser(UC_CLAIMANT_EMAIL);
  transfereeUserId = await createUser(UC_TRANSFEREE_EMAIL);

  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminUserId));
  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional" })
    .where(eq(profiles.id, govtUserId));
  await db.execute(sql`
    INSERT INTO govt_assignments (user_id, jurisdiction_province, jurisdiction_locality, granted_by_user_id)
    VALUES (${govtUserId}, ${PROV}, ${LOCALITY}, ${adminUserId})
  `);
}, 90_000);

afterAll(async () => {
  for (const petId of insertedPetIds) {
    const disputeRows = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.petId, petId));
    await withMutationOverride(async (tx) => {
      await tx.delete(notifications).where(eq(notifications.relatedPetId, petId));
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
      for (const { id } of disputeRows) {
        await tx.delete(custodyDisputeParties).where(eq(custodyDisputeParties.disputeId, id));
      }
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}`);
      await tx.delete(custodyDisputes).where(eq(custodyDisputes.petId, petId));
      await tx.delete(ownerships).where(eq(ownerships.petId, petId));
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
  await db.execute(sql`DELETE FROM govt_assignments WHERE user_id = ${govtUserId}`).catch(() => {});
  for (const e of [
    UC_ADMIN_EMAIL,
    UC_GOVT_EMAIL,
    UC_OWNER_EMAIL,
    UC_CLAIMANT_EMAIL,
    UC_TRANSFEREE_EMAIL,
  ]) {
    await purgeUserByEmail(e);
  }
}, 90_000);

// ---------------------------------------------------------------------------
// openDisputeFromEvent
// ---------------------------------------------------------------------------

describe("openDisputeFromEvent", () => {
  it("happy path: dispute row inserted, parties created, case linked, pet flagged", async () => {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: generatePublicToken(),
        name: "UC CD Open Happy",
        species: "dog",
        status: "active",
        jurisdictionProvince: PROV,
        jurisdictionLocality: LOCALITY,
      })
      .returning({ id: pets.id });
    insertedPetIds.push(pet.id);

    const { disputeId, publicToken } = await db.transaction(async (tx) => {
      const disputeCase = await openCase(
        {
          kind: "custody_dispute",
          primarySubjectKind: "registered_pet",
          primaryPetId: pet.id,
          jurisdictionProvince: PROV,
          jurisdictionLocality: LOCALITY,
          openedByUserId: claimantUserId,
          openedByOrganizationId: null,
          openedReason: { code: "custody_dispute_raised", raisedByRole: "owner" },
        },
        tx,
      );
      const payload = validateEventPayload("custody_dispute_raised", {
        raised_by_role: "owner",
        raised_by_user_id: claimantUserId,
        external_proceeding_reference: null,
        reason: "Reclamo de prueba happy path.",
      });
      const [ev] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "custody_dispute_raised",
          occurredAt: new Date(),
          recordedAt: new Date(),
          recordedByUserId: claimantUserId,
          authorRole: "owner",
          payload,
          caseId: disputeCase.id,
        })
        .returning({ id: petEvents.id });
      return openDisputeFromEvent(tx, {
        petId: pet.id,
        raisingEventId: ev.id,
        raisedByUserId: claimantUserId,
        raisedByOrgId: null,
        raisedByRole: "owner",
        jurisdictionProvince: PROV,
        jurisdictionLocality: LOCALITY,
        initialParties: [{ userId: ownerUserId, role: "current_owner" }],
        preCreatedCaseId: disputeCase.id,
      });
    });

    expect(typeof disputeId).toBe("string");
    expect(publicToken).toMatch(/^DIS-/);

    const [row] = await db
      .select({ status: custodyDisputes.status })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.id, disputeId))
      .limit(1);
    expect(row?.status).toBe("open");

    const [flag] = await db
      .select({ inCustodyDispute: pets.inCustodyDispute })
      .from(pets)
      .where(eq(pets.id, pet.id))
      .limit(1);
    expect(flag?.inCustodyDispute).toBe(true);
  });

  it("duplicate open dispute is rejected (guard or DB constraint)", async () => {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: generatePublicToken(),
        name: "UC CD Open Dup",
        species: "dog",
        status: "active",
        jurisdictionProvince: PROV,
        jurisdictionLocality: LOCALITY,
      })
      .returning({ id: pets.id });
    insertedPetIds.push(pet.id);

    // Open the first dispute.
    await db.transaction(async (tx) => {
      const c = await openCase(
        {
          kind: "custody_dispute",
          primarySubjectKind: "registered_pet",
          primaryPetId: pet.id,
          jurisdictionProvince: PROV,
          jurisdictionLocality: LOCALITY,
          openedByUserId: claimantUserId,
          openedByOrganizationId: null,
          openedReason: { code: "custody_dispute_raised", raisedByRole: "owner" },
        },
        tx,
      );
      const payload = validateEventPayload("custody_dispute_raised", {
        raised_by_role: "owner",
        raised_by_user_id: claimantUserId,
        external_proceeding_reference: null,
        reason: "Primer reclamo.",
      });
      const [ev] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "custody_dispute_raised",
          occurredAt: new Date(),
          recordedAt: new Date(),
          recordedByUserId: claimantUserId,
          authorRole: "owner",
          payload,
          caseId: c.id,
        })
        .returning({ id: petEvents.id });
      await openDisputeFromEvent(tx, {
        petId: pet.id,
        raisingEventId: ev.id,
        raisedByUserId: claimantUserId,
        raisedByOrgId: null,
        raisedByRole: "owner",
        jurisdictionProvince: PROV,
        jurisdictionLocality: LOCALITY,
        initialParties: [],
        preCreatedCaseId: c.id,
      });
    });

    // The cases table has a partial unique index on (primary_pet_id, case_kind)
    // for open cases — so openCase itself rejects a second open custody_dispute.
    // Both the openCase DB constraint and the openDisputeFromEvent guard prevent
    // double-opening; the DB fires first here.
    await expect(
      db.transaction(async (tx) => {
        const c2 = await openCase(
          {
            kind: "custody_dispute",
            primarySubjectKind: "registered_pet",
            primaryPetId: pet.id,
            jurisdictionProvince: PROV,
            jurisdictionLocality: LOCALITY,
            openedByUserId: claimantUserId,
            openedByOrganizationId: null,
            openedReason: { code: "custody_dispute_raised", raisedByRole: "owner" },
          },
          tx,
        );
        const payload2 = validateEventPayload("custody_dispute_raised", {
          raised_by_role: "owner",
          raised_by_user_id: claimantUserId,
          external_proceeding_reference: null,
          reason: "Segundo reclamo.",
        });
        const [ev2] = await tx
          .insert(petEvents)
          .values({
            petId: pet.id,
            eventType: "custody_dispute_raised",
            occurredAt: new Date(),
            recordedAt: new Date(),
            recordedByUserId: claimantUserId,
            authorRole: "owner",
            payload: payload2,
            caseId: c2.id,
          })
          .returning({ id: petEvents.id });
        return openDisputeFromEvent(tx, {
          petId: pet.id,
          raisingEventId: ev2.id,
          raisedByUserId: claimantUserId,
          raisedByOrgId: null,
          raisedByRole: "owner",
          jurisdictionProvince: PROV,
          jurisdictionLocality: LOCALITY,
          initialParties: [],
          preCreatedCaseId: c2.id,
        });
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// addDisputePartyUseCase
// ---------------------------------------------------------------------------

describe("addDisputePartyUseCase", () => {
  it("happy path: party row + audit row + notification", async () => {
    const { disputeToken, disputeId } = await seedOpenDispute(
      generatePublicToken(),
      "UC CD AddParty Happy",
    );

    const result = await addDisputePartyUseCase(adminSession(), {
      disputeToken,
      partyUserId: transfereeUserId,
      partyRole: "witness",
      positionSummary: "Vio al animal.",
    });

    expect(result).toHaveProperty("partyId");
    const partyId = (result as { partyId: string }).partyId;

    const [party] = await db
      .select({ role: custodyDisputeParties.partyRole })
      .from(custodyDisputeParties)
      .where(eq(custodyDisputeParties.id, partyId))
      .limit(1);
    expect(party?.role).toBe("witness");

    const [notif] = await db
      .select({ type: notifications.notificationType })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, transfereeUserId),
          eq(notifications.notificationType, "custody_dispute_party_added"),
        ),
      )
      .limit(1);
    expect(notif?.type).toBe("custody_dispute_party_added");

    const [audit] = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, adminUserId), eq(auditLog.action, "dispute_party_added")))
      .limit(1);
    expect(audit).toBeDefined();

    // Suppress unused variable warning — disputeId used for traceability.
    void disputeId;
  });

  it("rejects when neither user nor org is provided", async () => {
    const { disputeToken } = await seedOpenDispute(generatePublicToken(), "UC CD AddParty NoActor");
    const result = await addDisputePartyUseCase(adminSession(), {
      disputeToken,
      partyRole: "witness",
    });
    expect(result).toEqual({ error: "Indicá un usuario o una organización para la parte." });
  });

  it("rejects when both user and org are provided", async () => {
    const { disputeToken } = await seedOpenDispute(
      generatePublicToken(),
      "UC CD AddParty BothActors",
    );
    const result = await addDisputePartyUseCase(adminSession(), {
      disputeToken,
      partyUserId: transfereeUserId,
      partyOrgId: "some-org-id",
      partyRole: "witness",
    });
    expect(result).toEqual({
      error: "La parte tiene que ser un usuario O una organización, no ambos.",
    });
  });

  it("rejects when dispute is not found", async () => {
    const result = await addDisputePartyUseCase(adminSession(), {
      disputeToken: "DIS-NOPE-XYZ",
      partyUserId: transfereeUserId,
      partyRole: "witness",
    });
    expect(result).toEqual({ error: "Disputa no encontrada." });
  });

  it("rejects govt caller outside their jurisdiction", async () => {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: generatePublicToken(),
        name: "UC CD AddParty OOJ",
        species: "dog",
        status: "active",
        jurisdictionProvince: "Córdoba",
        jurisdictionLocality: "Córdoba Capital",
      })
      .returning({ id: pets.id });
    insertedPetIds.push(pet.id);

    const oojToken = await db.transaction(async (tx) => {
      const c = await openCase(
        {
          kind: "custody_dispute",
          primarySubjectKind: "registered_pet",
          primaryPetId: pet.id,
          jurisdictionProvince: "Córdoba",
          jurisdictionLocality: "Córdoba Capital",
          openedByUserId: claimantUserId,
          openedByOrganizationId: null,
          openedReason: { code: "custody_dispute_raised", raisedByRole: "owner" },
        },
        tx,
      );
      const payload = validateEventPayload("custody_dispute_raised", {
        raised_by_role: "owner",
        raised_by_user_id: claimantUserId,
        external_proceeding_reference: null,
        reason: "Reclamo fuera de jurisdiccion.",
      });
      const [ev] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "custody_dispute_raised",
          occurredAt: new Date(),
          recordedAt: new Date(),
          recordedByUserId: claimantUserId,
          authorRole: "owner",
          payload,
          caseId: c.id,
        })
        .returning({ id: petEvents.id });
      const { publicToken } = await openDisputeFromEvent(tx, {
        petId: pet.id,
        raisingEventId: ev.id,
        raisedByUserId: claimantUserId,
        raisedByOrgId: null,
        raisedByRole: "owner",
        jurisdictionProvince: "Córdoba",
        jurisdictionLocality: "Córdoba Capital",
        initialParties: [],
        preCreatedCaseId: c.id,
      });
      return publicToken;
    });

    // govtSession has La Plata jurisdiction; dispute is in Córdoba — out of scope.
    const result = await addDisputePartyUseCase(govtSession(), {
      disputeToken: oojToken,
      partyUserId: transfereeUserId,
      partyRole: "witness",
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("jurisdicción");
  });
});

// ---------------------------------------------------------------------------
// resolveDisputeUseCase
// ---------------------------------------------------------------------------

describe("resolveDisputeUseCase", () => {
  const LONG_SUMMARY =
    "El gobierno local revisó la evidencia presentada por ambas partes y resolvió " +
    "la disputa de custodia de forma definitiva conforme la normativa vigente aplicable.";

  it("happy path (ownership_confirmed): dispute resolved + pet flag cleared + audit + event", async () => {
    const { petId, disputeToken } = await seedOpenDispute(
      generatePublicToken(),
      "UC CD Resolve Conf",
    );

    const result = await resolveDisputeUseCase(adminSession(), {
      disputeToken,
      resolution: "ownership_confirmed",
      resolutionSummary: LONG_SUMMARY,
    });
    expect(result).toHaveProperty("resolvedAt");

    const [dispute] = await db
      .select({ status: custodyDisputes.status, resolution: custodyDisputes.resolution })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, disputeToken))
      .limit(1);
    expect(dispute?.status).toBe("resolved");
    expect(dispute?.resolution).toBe("ownership_confirmed");

    const [flag] = await db
      .select({ inCustodyDispute: pets.inCustodyDispute })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    expect(flag?.inCustodyDispute).toBe(false);

    const [evt] = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_dispute_resolved")))
      .limit(1);
    expect(evt).toBeDefined();
  });

  it("rejects short resolution summary (< 100 chars)", async () => {
    const { disputeToken } = await seedOpenDispute(generatePublicToken(), "UC CD Resolve Short");
    const result = await resolveDisputeUseCase(adminSession(), {
      disputeToken,
      resolution: "ownership_confirmed",
      resolutionSummary: "muy corto",
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("100 caracteres");
  });

  it("rejects ownership_transferred without a transfer target", async () => {
    const { disputeToken } = await seedOpenDispute(generatePublicToken(), "UC CD Resolve NoTarget");
    const result = await resolveDisputeUseCase(adminSession(), {
      disputeToken,
      resolution: "ownership_transferred",
      resolutionSummary: LONG_SUMMARY,
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("destino");
  });

  it("rejects resolving an already-resolved dispute", async () => {
    const { disputeToken } = await seedOpenDispute(generatePublicToken(), "UC CD Resolve Dup");
    const first = await resolveDisputeUseCase(adminSession(), {
      disputeToken,
      resolution: "case_dismissed",
      resolutionSummary: LONG_SUMMARY,
    });
    expect(first).toHaveProperty("resolvedAt");

    const second = await resolveDisputeUseCase(adminSession(), {
      disputeToken,
      resolution: "case_dismissed",
      resolutionSummary: LONG_SUMMARY,
    });
    expect(second).toHaveProperty("error");
    expect((second as { error: string }).error).toContain("ya no está en curso");
  });

  // TR-M1: two concurrent resolves must serialize on the dispute row (FOR
  // UPDATE). Exactly one wins; the loser gets a friendly "ya no está en curso"
  // error — never a raw PG 23505 and never a second (duplicate) resolution.
  it("serializes concurrent resolves: one wins cleanly, the other gets a friendly error", async () => {
    const { disputeToken } = await seedOpenDispute(
      generatePublicToken(),
      "UC CD Resolve Concurrent",
    );

    const [a, b] = await Promise.all([
      resolveDisputeUseCase(adminSession(), {
        disputeToken,
        resolution: "case_dismissed",
        resolutionSummary: LONG_SUMMARY,
      }),
      resolveDisputeUseCase(adminSession(), {
        disputeToken,
        resolution: "case_dismissed",
        resolutionSummary: LONG_SUMMARY,
      }),
    ]);

    const winners = [a, b].filter((r) => "resolvedAt" in r);
    const losers = [a, b].filter((r) => "error" in r);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loserError = (losers[0] as { error: string }).error;
    expect(loserError).toContain("ya no está en curso");
    // Not a raw Postgres unique-violation / duplicate-key leak.
    expect(loserError).not.toMatch(/23505|duplicate key|violates/i);
  });

  // REGRESSION (V1-9, fixed 2026-08-04). The "from" actor used to be hardcoded
  // null/null, which the custody_transferred refine rejects, so every
  // resolution-by-transfer rolled back. It now comes from the ownership row the
  // use case closes. Like its sibling in __tests__/custody-disputes.test.ts,
  // this test used to pin the broken behavior.
  it("ownership_transferred commits and records the outgoing holder as 'from'", async () => {
    const { petId, disputeToken } = await seedOpenDispute(
      generatePublicToken(),
      "UC CD Resolve Xfer",
    );

    const result = await resolveDisputeUseCase(adminSession(), {
      disputeToken,
      resolution: "ownership_transferred",
      resolutionSummary: LONG_SUMMARY,
      transferToUserId: transfereeUserId,
    });

    expect(result).not.toHaveProperty("error");

    const [dispute] = await db
      .select({ status: custodyDisputes.status })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, disputeToken))
      .limit(1);
    expect(dispute?.status).toBe("resolved");

    // Custody moved to the transferee, and only there.
    const activeRows = await db
      .select({ ownerUserId: ownerships.ownerUserId })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].ownerUserId).toBe(transfereeUserId);

    // The event carries real provenance instead of a null pair.
    const [transferEvent] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transferred")))
      .limit(1);
    const payload = transferEvent?.payload as {
      from_user_id: string | null;
      from_role: string;
    };
    expect(payload.from_user_id).toBe(ownerUserId);
    expect(payload.from_role).toBe("owner");
  });
});

// ---------------------------------------------------------------------------
// resolveDisputeUseCase — the ORG party
// ---------------------------------------------------------------------------
//
// The resolution fan-out read `party_user_id` alone. `custody_dispute_parties`
// is polymorphic by CHECK (`dispute_party_exactly_one_subject`), so an org-side
// party has that column NULL and was dropped from the notification set without
// a trace — harmless while no writer produced one, which stopped being true
// when the claim wizard started filing a `current_org_custody` party for
// animals held by a refugio (submit-claim-dispute.ts). A shelter told its
// animal was claimed would otherwise never be told the authority had ruled.

describe("resolveDisputeUseCase — an ORG party is an address, not a dropped row", () => {
  const LONG_SUMMARY =
    "El gobierno local revisó la evidencia presentada por ambas partes y resolvió " +
    "la disputa de custodia de forma definitiva conforme la normativa vigente aplicable.";

  const UC_ORG_MEMBER_EMAIL = "uc-cd-orgmember@dim-test.local";
  let partyOrgId!: string;
  let orgMemberUserId!: string;
  let orgHeldPetId: string | null = null;

  beforeAll(async () => {
    await purgeUserByEmail(UC_ORG_MEMBER_EMAIL);
    orgMemberUserId = await createUser(UC_ORG_MEMBER_EMAIL);
    const [org] = await db
      .insert(organizations)
      .values({
        publicToken: generatePublicToken(),
        legalName: "Refugio Parte Asociación Civil",
        displayName: "Refugio Parte",
        orgType: "shelter",
        email: "uc-cd-party-org@dim-test.local",
        verified: true,
        jurisdictionProvince: PROV,
        jurisdictionLocality: LOCALITY,
      })
      .returning({ id: organizations.id });
    partyOrgId = org.id;
    await db.insert(organizationMemberships).values({
      organizationId: partyOrgId,
      userId: orgMemberUserId,
      role: "admin",
      canWritePetEvents: true,
    });
  }, 90_000);

  afterAll(async () => {
    // The pet goes FIRST and by hand. `party_organization_id` is ON DELETE SET
    // NULL, so dropping the org while a party row still points at it would set
    // both subject columns to NULL and trip the exactly-one-subject CHECK.
    if (orgHeldPetId) {
      const petId = orgHeldPetId;
      const disputeRows = await db
        .select({ id: custodyDisputes.id })
        .from(custodyDisputes)
        .where(eq(custodyDisputes.petId, petId));
      await withMutationOverride(async (tx) => {
        await tx.delete(notifications).where(eq(notifications.relatedPetId, petId));
        await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
        for (const { id } of disputeRows) {
          await tx.delete(custodyDisputeParties).where(eq(custodyDisputeParties.disputeId, id));
        }
        await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}`);
        await tx.delete(custodyDisputes).where(eq(custodyDisputes.petId, petId));
        await tx.delete(ownerships).where(eq(ownerships.petId, petId));
        await tx.delete(pets).where(eq(pets.id, petId));
      });
    }
    await withMutationOverride(async (tx) => {
      await tx.delete(organizations).where(eq(organizations.id, partyOrgId));
    });
    await purgeUserByEmail(UC_ORG_MEMBER_EMAIL);
  }, 90_000);

  /** A dispute over an animal held by `partyOrgId`, filed the way the claim
   * wizard files it: the org as `current_org_custody`, the claimant as the
   * `claimant_owner`. */
  async function seedOrgHeldDispute(): Promise<{ disputeToken: string }> {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: generatePublicToken(),
        name: "UC CD Org Party",
        species: "dog",
        status: "active",
        jurisdictionProvince: PROV,
        jurisdictionLocality: LOCALITY,
      })
      .returning({ id: pets.id });
    orgHeldPetId = pet.id;

    await db.insert(ownerships).values({
      petId: pet.id,
      ownerOrganizationId: partyOrgId,
      role: "shelter_custody",
      startedAt: new Date(),
    });

    return db.transaction(async (tx) => {
      const disputeCase = await openCase(
        {
          kind: "custody_dispute",
          primarySubjectKind: "registered_pet",
          primaryPetId: pet.id,
          jurisdictionProvince: PROV,
          jurisdictionLocality: LOCALITY,
          openedByUserId: claimantUserId,
          openedByOrganizationId: null,
          openedReason: { code: "custody_dispute_raised", raisedByRole: "owner" },
        },
        tx,
      );
      const payload = validateEventPayload("custody_dispute_raised", {
        raised_by_role: "owner",
        raised_by_user_id: claimantUserId,
        external_proceeding_reference: null,
        reason: "Reclamo sobre un animal que tiene el refugio, con motivo suficiente.",
      });
      const [raisingEvent] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "custody_dispute_raised",
          occurredAt: new Date(),
          recordedAt: new Date(),
          recordedByUserId: claimantUserId,
          authorRole: "finder",
          payload,
          caseId: disputeCase.id,
        })
        .returning({ id: petEvents.id });
      const { publicToken } = await openDisputeFromEvent(tx, {
        petId: pet.id,
        raisingEventId: raisingEvent.id,
        raisedByUserId: claimantUserId,
        raisedByOrgId: null,
        raisedByRole: "owner",
        jurisdictionProvince: PROV,
        jurisdictionLocality: LOCALITY,
        initialParties: [
          { orgId: partyOrgId, role: "current_org_custody" },
          { userId: claimantUserId, role: "claimant_owner" },
        ],
        preCreatedCaseId: disputeCase.id,
      });
      return { disputeToken: publicToken };
    });
  }

  it("tells the org party's active members that the authority ruled", async () => {
    const { disputeToken } = await seedOrgHeldDispute();

    // The claimant is shared with every other resolve test in this file, so
    // count the DELTA rather than the total — an absolute count would assert
    // this file's execution order instead of this use-case's behaviour.
    const claimantBefore = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, claimantUserId),
          eq(notifications.notificationType, "custody_dispute_resolved"),
        ),
      );

    const result = await resolveDisputeUseCase(adminSession(), {
      disputeToken,
      resolution: "case_dismissed",
      resolutionSummary: LONG_SUMMARY,
    });
    expect(result).toHaveProperty("resolvedAt");

    const memberRows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, orgMemberUserId),
          eq(notifications.notificationType, "custody_dispute_resolved"),
        ),
      );
    expect(memberRows).toHaveLength(1);

    // The user-side party still gets exactly one — the org leg adds an
    // address, it does not duplicate the existing ones.
    const claimantAfter = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, claimantUserId),
          eq(notifications.notificationType, "custody_dispute_resolved"),
        ),
      );
    expect(claimantAfter.length - claimantBefore.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// withdrawDisputeUseCase
// ---------------------------------------------------------------------------

describe("withdrawDisputeUseCase", () => {
  it("happy path: status=withdrawn + pet flag cleared + audit row", async () => {
    const { petId, disputeToken } = await seedOpenDispute(
      generatePublicToken(),
      "UC CD Withdraw Happy",
    );

    const result = await withdrawDisputeUseCase(adminSession(), {
      disputeToken,
      reason: "Retiro administrativo de prueba.",
    });
    expect(result).toHaveProperty("withdrawnAt");

    const [dispute] = await db
      .select({ status: custodyDisputes.status })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, disputeToken))
      .limit(1);
    expect(dispute?.status).toBe("withdrawn");

    const [flag] = await db
      .select({ inCustodyDispute: pets.inCustodyDispute })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    expect(flag?.inCustodyDispute).toBe(false);

    const [audit] = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, adminUserId), eq(auditLog.action, "dispute_withdrawn")))
      .limit(1);
    expect(audit).toBeDefined();
  });

  it("rejects govt who is not the raiser", async () => {
    const { disputeToken } = await seedOpenDispute(
      generatePublicToken(),
      "UC CD Withdraw NotRaiser",
    );
    // Dispute was raised by claimantUserId, not govtUserId.
    const result = await withdrawDisputeUseCase(govtSession(), { disputeToken });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("quien la levantó");
  });

  it("rejects withdrawing an unknown dispute token", async () => {
    const result = await withdrawDisputeUseCase(adminSession(), {
      disputeToken: "DIS-NOPE-UC",
    });
    expect(result).toEqual({ error: "Disputa no encontrada." });
  });

  it("rejects withdrawing an already-resolved dispute", async () => {
    const { disputeToken } = await seedOpenDispute(
      generatePublicToken(),
      "UC CD Withdraw AlreadyResolved",
    );
    const LONG_SUMMARY =
      "El gobierno local revisó la evidencia presentada por ambas partes y resolvió " +
      "la disputa de custodia de forma definitiva conforme la normativa vigente aplicable.";
    await resolveDisputeUseCase(adminSession(), {
      disputeToken,
      resolution: "case_dismissed",
      resolutionSummary: LONG_SUMMARY,
    });
    const result = await withdrawDisputeUseCase(adminSession(), { disputeToken });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("ya no está en curso");
  });
});

// ---------------------------------------------------------------------------
// lookupTransferTargetUseCase
// ---------------------------------------------------------------------------

describe("lookupTransferTargetUseCase", () => {
  let testOrgId!: string;
  let inactiveOrgId!: string;
  // A dispute in the govt session's jurisdiction (La Plata) to bind lookups to.
  let scopedDisputeToken!: string;

  beforeAll(async () => {
    ({ disputeToken: scopedDisputeToken } = await seedOpenDispute(
      generatePublicToken(),
      "UC CD Lookup Scope",
    ));

    const [activeOrg] = await db
      .insert(organizations)
      .values({
        publicToken: generatePublicToken(),
        legalName: "UC CD Lookup Active Org",
        displayName: "UC CD Active Org",
        orgType: "shelter",
        email: "uc-cd-lookup-active@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning({ id: organizations.id });
    testOrgId = activeOrg.id;

    const [inactiveOrg] = await db
      .insert(organizations)
      .values({
        publicToken: generatePublicToken(),
        legalName: "UC CD Lookup Inactive Org",
        displayName: "UC CD Inactive Org",
        orgType: "shelter",
        email: "uc-cd-lookup-inactive@dim-test.local",
        verified: true,
        status: "suspended",
      })
      .returning({ id: organizations.id });
    inactiveOrgId = inactiveOrg.id;
  });

  afterAll(async () => {
    if (testOrgId) await db.delete(organizations).where(eq(organizations.id, testOrgId));
    if (inactiveOrgId) await db.delete(organizations).where(eq(organizations.id, inactiveOrgId));
  });

  it("user found: returns displayName + active=true", async () => {
    const result = await lookupTransferTargetUseCase(adminSession(), {
      kind: "user",
      id: transfereeUserId,
      disputeToken: scopedDisputeToken,
    });
    expect(result).toMatchObject({ found: true, active: true });
    expect((result as { found: true; displayName: string }).displayName).toBeTruthy();
  });

  it("user not found: returns error", async () => {
    const result = await lookupTransferTargetUseCase(adminSession(), {
      kind: "user",
      id: "00000000-0000-0000-0000-000000000000",
      disputeToken: scopedDisputeToken,
    });
    expect(result).toMatchObject({ found: false, error: "Usuario no encontrado." });
  });

  it("org found and active: returns active=true", async () => {
    const result = await lookupTransferTargetUseCase(adminSession(), {
      kind: "org",
      id: testOrgId,
      disputeToken: scopedDisputeToken,
    });
    expect(result).toMatchObject({ found: true, active: true });
  });

  it("org found but not active: returns active=false", async () => {
    const result = await lookupTransferTargetUseCase(adminSession(), {
      kind: "org",
      id: inactiveOrgId,
      disputeToken: scopedDisputeToken,
    });
    expect(result).toMatchObject({ found: true, active: false });
  });

  it("org not found: returns error", async () => {
    const result = await lookupTransferTargetUseCase(adminSession(), {
      kind: "org",
      id: "00000000-0000-0000-0000-000000000000",
      disputeToken: scopedDisputeToken,
    });
    expect(result).toMatchObject({ found: false, error: "Organización no encontrada." });
  });

  it("empty id: returns error", async () => {
    const result = await lookupTransferTargetUseCase(adminSession(), {
      kind: "user",
      id: "   ",
      disputeToken: scopedDisputeToken,
    });
    expect(result).toMatchObject({ found: false, error: "ID vacío." });
  });

  it("govt in scope: resolves within their jurisdiction", async () => {
    const result = await lookupTransferTargetUseCase(govtSession(), {
      kind: "user",
      id: transfereeUserId,
      disputeToken: scopedDisputeToken,
    });
    expect(result).toMatchObject({ found: true, active: true });
  });

  it("rejects govt caller outside the dispute's jurisdiction (no identity oracle)", async () => {
    const result = await lookupTransferTargetUseCase(govtOojSession(), {
      kind: "user",
      id: transfereeUserId,
      disputeToken: scopedDisputeToken,
    });
    expect(result).toMatchObject({ found: false });
    expect((result as { found: false; error: string }).error).toContain("jurisdicción");
  });

  it("rejects an unknown dispute token before any lookup", async () => {
    const result = await lookupTransferTargetUseCase(adminSession(), {
      kind: "user",
      id: transfereeUserId,
      disputeToken: "DIS-NOPE-LOOKUP",
    });
    expect(result).toMatchObject({ found: false, error: "Disputa no encontrada." });
  });
});

// ---------------------------------------------------------------------------
// escalateDisputeUseCase
// ---------------------------------------------------------------------------

describe("escalateDisputeUseCase", () => {
  it("happy path: note_added event + audit log entry", async () => {
    const { petId, disputeToken } = await seedOpenDispute(
      generatePublicToken(),
      "UC CD Escalate Happy",
    );

    const result = await escalateDisputeUseCase(adminSession(), {
      disputeToken,
      notes: "Se remite la causa a instancia judicial para revisión por falta de acuerdo.",
    });
    expect(result).toHaveProperty("escalatedAt");

    const [evt] = await db
      .select({ eventType: petEvents.eventType })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "note_added")))
      .limit(1);
    expect(evt?.eventType).toBe("note_added");

    const [audit] = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, adminUserId), eq(auditLog.action, "dispute_escalated")))
      .limit(1);
    expect(audit).toBeDefined();
  });

  it("rejects notes shorter than 20 characters", async () => {
    const { disputeToken } = await seedOpenDispute(generatePublicToken(), "UC CD Escalate Short");
    const result = await escalateDisputeUseCase(adminSession(), {
      disputeToken,
      notes: "corto",
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("20 caracteres");
  });

  it("rejects escalating a dispute that is no longer in curso", async () => {
    const { disputeToken } = await seedOpenDispute(generatePublicToken(), "UC CD Escalate NotOpen");
    const LONG_SUMMARY =
      "El gobierno local revisó la evidencia presentada por ambas partes y resolvió " +
      "la disputa de custodia de forma definitiva conforme la normativa vigente aplicable.";
    await resolveDisputeUseCase(adminSession(), {
      disputeToken,
      resolution: "case_dismissed",
      resolutionSummary: LONG_SUMMARY,
    });
    const result = await escalateDisputeUseCase(adminSession(), {
      disputeToken,
      notes: "Motivo de escalada suficientemente largo para el test.",
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("en curso");
  });

  it("rejects govt caller outside their jurisdiction", async () => {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: generatePublicToken(),
        name: "UC CD Escalate OOJ",
        species: "dog",
        status: "active",
        jurisdictionProvince: "Córdoba",
        jurisdictionLocality: "Córdoba Capital",
      })
      .returning({ id: pets.id });
    insertedPetIds.push(pet.id);

    const oojToken = await db.transaction(async (tx) => {
      const c = await openCase(
        {
          kind: "custody_dispute",
          primarySubjectKind: "registered_pet",
          primaryPetId: pet.id,
          jurisdictionProvince: "Córdoba",
          jurisdictionLocality: "Córdoba Capital",
          openedByUserId: claimantUserId,
          openedByOrganizationId: null,
          openedReason: { code: "custody_dispute_raised", raisedByRole: "owner" },
        },
        tx,
      );
      const payload = validateEventPayload("custody_dispute_raised", {
        raised_by_role: "owner",
        raised_by_user_id: claimantUserId,
        external_proceeding_reference: null,
        reason: "Reclamo fuera de jurisdiccion para test de escalada.",
      });
      const [ev] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "custody_dispute_raised",
          occurredAt: new Date(),
          recordedAt: new Date(),
          recordedByUserId: claimantUserId,
          authorRole: "owner",
          payload,
          caseId: c.id,
        })
        .returning({ id: petEvents.id });
      const { publicToken } = await openDisputeFromEvent(tx, {
        petId: pet.id,
        raisingEventId: ev.id,
        raisedByUserId: claimantUserId,
        raisedByOrgId: null,
        raisedByRole: "owner",
        jurisdictionProvince: "Córdoba",
        jurisdictionLocality: "Córdoba Capital",
        initialParties: [],
        preCreatedCaseId: c.id,
      });
      return publicToken;
    });

    // govtSession has La Plata jurisdiction; dispute is in Córdoba — out of scope.
    const result = await escalateDisputeUseCase(govtSession(), {
      disputeToken: oojToken,
      notes: "Escalada fallida por jurisdicción incorrecta.",
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("jurisdicción");
  });
});
