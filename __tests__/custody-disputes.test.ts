// Action-level tests for app/actions/custody-disputes.ts (V1-9 coverage gap).
//
// Covers the three authority-facing actions:
//   - addDisputePartyAction   — register a party (auth gate, jurisdiction,
//                               validation, audit + party row).
//   - resolveDisputeAction    — close with an outcome; ownership_transferred
//                               re-points ownership atomically; audit + event.
//   - withdrawDisputeAction   — admin/raiser cancels; pet flag cleared; audit.
//
// Real local Postgres + Supabase stack. Authority sessions are mocked via
// `@/lib/supabase/server`; the disputes themselves are seeded directly with
// openCase + a raising pet_event + openDisputeFromEvent (the same sequencing
// the production raise path uses).

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import {
  addDisputePartyAction,
  resolveDisputeAction,
  withdrawDisputeAction,
} from "@/app/actions/custody-disputes";
import {
  auditLog,
  custodyDisputeParties,
  custodyDisputes,
  db,
  notifications,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { openCase } from "@/lib/infra/case-helpers";
import { createClient } from "@/lib/supabase/server";
import { openDisputeFromEvent } from "@/src/modules/custody-disputes/application/open-dispute";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const ADMIN_EMAIL = "custdisp-admin@dim-test.local";
const GOVT_EMAIL = "custdisp-govt@dim-test.local";
const OWNER_EMAIL = "custdisp-owner@dim-test.local";
const CLAIMANT_EMAIL = "custdisp-claimant@dim-test.local";
const TRANSFEREE_EMAIL = "custdisp-transferee@dim-test.local";
const PASS = "CustDisp_2026!";

const PROV = "Buenos Aires";
const LOCALITY = "La Plata";

let adminUserId: string;
let govtUserId: string;
let ownerUserId: string;
let claimantUserId: string;
let transfereeUserId: string;

const insertedPetIds: string[] = [];

function mockSessionAs(userId: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: userId ? ({ id: userId } as unknown) : null },
        error: null,
      }),
    },
  } as never);
}

async function createUser(email: string): Promise<string> {
  const r = await createFreshTestUser(supabaseAdmin, {
    email,
    password: PASS,
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser ${email}: ${r.error?.message}`);
  return r.data.user.id;
}

async function purgeUserByEmail(email: string) {
  const { data } = await supabaseAdmin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  await withMutationOverride(async (tx) => {
    for (const uid of ids) {
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabaseAdmin.auth.admin.deleteUser(found.id);
}

// Seed a pet owned by `ownerUserId` plus an OPEN custody dispute against it,
// raised by `claimantUserId`. Mirrors submitClaimDisputeAction's sequencing:
// openCase BEFORE the raising event, then openDisputeFromEvent.
async function seedOpenDispute(
  token: string,
  petName: string,
): Promise<{ petId: string; disputeToken: string }> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: petName,
      species: "dog",
      status: "active",
      jurisdictionProvince: PROV,
      jurisdictionLocality: LOCALITY,
    })
    .returning({ id: pets.id });
  insertedPetIds.push(pet.id);
  // Ownership lives in the ownerships table, not on pets directly.
  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId,
    role: "owner",
    startedAt: new Date(),
  });

  const disputeToken = await db.transaction(async (tx) => {
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
      reason: "Reclamo de prueba con motivo suficientemente largo.",
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
    const { publicToken } = await openDisputeFromEvent(tx, {
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
    return publicToken;
  });

  return { petId: pet.id, disputeToken };
}

beforeAll(async () => {
  for (const e of [ADMIN_EMAIL, GOVT_EMAIL, OWNER_EMAIL, CLAIMANT_EMAIL, TRANSFEREE_EMAIL]) {
    await purgeUserByEmail(e);
  }

  adminUserId = await createUser(ADMIN_EMAIL);
  govtUserId = await createUser(GOVT_EMAIL);
  ownerUserId = await createUser(OWNER_EMAIL);
  claimantUserId = await createUser(CLAIMANT_EMAIL);
  transfereeUserId = await createUser(TRANSFEREE_EMAIL);

  // Promote admin + govt profiles to institutional accounts. The consolidated
  // guard (loadActiveInstitutionalProfile) rejects accountType !== "institutional",
  // so role alone is no longer enough — createUser seeds accountType="personal".
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminUserId));
  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional" })
    .where(eq(profiles.id, govtUserId));
  // Give the govt user a jurisdiction matching the seeded disputes.
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
  for (const e of [ADMIN_EMAIL, GOVT_EMAIL, OWNER_EMAIL, CLAIMANT_EMAIL, TRANSFEREE_EMAIL]) {
    await purgeUserByEmail(e);
  }
});

// ---------------------------------------------------------------------------
// addDisputePartyAction
// ---------------------------------------------------------------------------

describe("addDisputePartyAction", () => {
  it("admin adds a party: party row + audit row + notification", async () => {
    const { disputeToken } = await seedOpenDispute("DIM-CD-ADDP-1", "AddParty Uno");
    mockSessionAs(adminUserId);

    const result = await addDisputePartyAction({
      disputeToken,
      partyUserId: transfereeUserId,
      partyRole: "witness",
      positionSummary: "Vio al animal con el reclamante.",
    });

    expect(result).toHaveProperty("partyId");
    const partyId = (result as { partyId: string }).partyId;

    const [party] = await db
      .select({ role: custodyDisputeParties.partyRole, uid: custodyDisputeParties.partyUserId })
      .from(custodyDisputeParties)
      .where(eq(custodyDisputeParties.id, partyId))
      .limit(1);
    expect(party?.role).toBe("witness");
    expect(party?.uid).toBe(transfereeUserId);

    const [audit] = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, adminUserId), eq(auditLog.action, "dispute_party_added")))
      .orderBy(desc(auditLog.performedAt))
      .limit(1);
    expect(audit).toBeDefined();
  });

  it("rejects an unauthenticated caller (redirect throws)", async () => {
    const { disputeToken } = await seedOpenDispute("DIM-CD-ADDP-NOAUTH", "AddParty NoAuth");
    mockSessionAs(null);
    await expect(
      addDisputePartyAction({ disputeToken, partyUserId: transfereeUserId, partyRole: "witness" }),
    ).rejects.toThrow();
  });

  it("rejects when neither a user nor an org is provided", async () => {
    const { disputeToken } = await seedOpenDispute("DIM-CD-ADDP-EMPTY", "AddParty Empty");
    mockSessionAs(adminUserId);
    const result = await addDisputePartyAction({ disputeToken, partyRole: "witness" });
    expect(result).toEqual({ error: "Indicá un usuario o una organización para la parte." });
  });

  it("rejects a govt caller outside their jurisdiction", async () => {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: "DIM-CD-ADDP-OOJ",
        name: "Fuera Jurisdiccion",
        species: "dog",
        status: "active",
        jurisdictionProvince: "Córdoba",
        jurisdictionLocality: "Córdoba Capital",
      })
      .returning({ id: pets.id });
    insertedPetIds.push(pet.id);
    await db.insert(ownerships).values({
      petId: pet.id,
      ownerUserId,
      role: "owner",
      startedAt: new Date(),
    });
    const disputeToken = await db.transaction(async (tx) => {
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
        reason: "Reclamo fuera de jurisdiccion del govt de prueba.",
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
        initialParties: [{ userId: ownerUserId, role: "current_owner" }],
        preCreatedCaseId: c.id,
      });
      return publicToken;
    });

    mockSessionAs(govtUserId);
    const result = await addDisputePartyAction({
      disputeToken,
      partyUserId: transfereeUserId,
      partyRole: "witness",
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("jurisdicción");
  });
});

// ---------------------------------------------------------------------------
// resolveDisputeAction
// ---------------------------------------------------------------------------

describe("resolveDisputeAction", () => {
  const LONG_SUMMARY =
    "El gobierno local revisó la evidencia presentada por ambas partes y resolvió la disputa de custodia de forma definitiva conforme la normativa vigente.";

  it("resolves ownership_confirmed: dispute resolved + pet flag cleared + audit + event", async () => {
    const { petId, disputeToken } = await seedOpenDispute("DIM-CD-RES-CONF", "Resolve Confirmada");
    mockSessionAs(adminUserId);

    const result = await resolveDisputeAction({
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

    const [pet] = await db
      .select({ flag: pets.inCustodyDispute })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    expect(pet?.flag).toBe(false);

    const [evt] = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_dispute_resolved")))
      .limit(1);
    expect(evt).toBeDefined();

    const [audit] = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, adminUserId), eq(auditLog.action, "dispute_resolved")))
      .orderBy(desc(auditLog.performedAt))
      .limit(1);
    expect((audit.payload as { resolution: string }).resolution).toBe("ownership_confirmed");
  });

  // REGRESSION (V1-9, fixed 2026-08-04). This branch used to hardcode BOTH
  // from_user_id and from_organization_id to null, which the custody_transferred
  // schema rejects ("at least one of from_user_id / from_organization_id must be
  // set") — so validateEventPayload threw inside the transaction and every
  // resolution-by-transfer rolled back with a raw error, while the UI happily
  // offered the option. The predecessor is now read from the ownership row the
  // use case closes, so the event carries real provenance.
  //
  // This test previously PINNED the broken behavior, which is how a green CI
  // protected the bug for weeks. It now asserts the transfer actually lands.
  it("ownership_transferred commits and records the outgoing holder as 'from'", async () => {
    const { petId, disputeToken } = await seedOpenDispute("DIM-CD-RES-XFER", "Resolve Transfer");
    mockSessionAs(adminUserId);

    const result = await resolveDisputeAction({
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

    // Custody moved: exactly one active row, held by the transferee.
    const activeRows = await db
      .select({ ownerUserId: ownerships.ownerUserId, role: ownerships.role })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].ownerUserId).toBe(transfereeUserId);
    expect(activeRows[0].role).toBe("owner");

    // The previous owner's row is closed, not deleted.
    const [priorRow] = await db
      .select({ endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), eq(ownerships.ownerUserId, ownerUserId)));
    expect(priorRow?.endedAt).not.toBeNull();

    // Provenance on the spine: the event names who it came from.
    const [transferEvent] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transferred")))
      .limit(1);
    const payload = transferEvent?.payload as {
      from_user_id: string | null;
      from_organization_id: string | null;
      from_role: string;
      to_user_id: string | null;
    };
    expect(payload.from_user_id).toBe(ownerUserId);
    expect(payload.from_organization_id).toBeNull();
    expect(payload.from_role).toBe("owner");
    expect(payload.to_user_id).toBe(transfereeUserId);
  });

  it("rejects ownership_transferred naming both a user and an organization", async () => {
    const { disputeToken } = await seedOpenDispute("DIM-CD-RES-XBOTH", "Resolve Both");
    mockSessionAs(adminUserId);

    const result = await resolveDisputeAction({
      disputeToken,
      resolution: "ownership_transferred",
      resolutionSummary: LONG_SUMMARY,
      transferToUserId: transfereeUserId,
      transferToOrgId: "00000000-0000-0000-0000-000000000001",
    });

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("un solo destino");
  });

  it("rejects a resolution summary shorter than 100 characters", async () => {
    const { disputeToken } = await seedOpenDispute("DIM-CD-RES-SHORT", "Resolve Short");
    mockSessionAs(adminUserId);
    const result = await resolveDisputeAction({
      disputeToken,
      resolution: "ownership_confirmed",
      resolutionSummary: "muy corto",
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("100 caracteres");
  });

  it("rejects ownership_transferred without a transfer target", async () => {
    const { disputeToken } = await seedOpenDispute("DIM-CD-RES-NOTGT", "Resolve NoTarget");
    mockSessionAs(adminUserId);
    const result = await resolveDisputeAction({
      disputeToken,
      resolution: "ownership_transferred",
      resolutionSummary: LONG_SUMMARY,
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("destino");
  });

  it("rejects resolving an already-resolved dispute", async () => {
    const { disputeToken } = await seedOpenDispute("DIM-CD-RES-DUP", "Resolve Dup");
    mockSessionAs(adminUserId);
    const first = await resolveDisputeAction({
      disputeToken,
      resolution: "case_dismissed",
      resolutionSummary: LONG_SUMMARY,
    });
    expect(first).toHaveProperty("resolvedAt");
    const second = await resolveDisputeAction({
      disputeToken,
      resolution: "case_dismissed",
      resolutionSummary: LONG_SUMMARY,
    });
    expect(second).toHaveProperty("error");
    expect((second as { error: string }).error).toContain("ya no está en curso");
  });
});

// ---------------------------------------------------------------------------
// withdrawDisputeAction
// ---------------------------------------------------------------------------

describe("withdrawDisputeAction", () => {
  it("admin withdraws: status=withdrawn + pet flag cleared + audit row", async () => {
    const { petId, disputeToken } = await seedOpenDispute("DIM-CD-WD-OK", "Withdraw Ok");
    mockSessionAs(adminUserId);

    const result = await withdrawDisputeAction({ disputeToken, reason: "Retiro administrativo." });
    expect(result).toHaveProperty("withdrawnAt");

    const [dispute] = await db
      .select({ status: custodyDisputes.status })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, disputeToken))
      .limit(1);
    expect(dispute?.status).toBe("withdrawn");

    const [pet] = await db
      .select({ flag: pets.inCustodyDispute })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    expect(pet?.flag).toBe(false);

    const [audit] = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, adminUserId), eq(auditLog.action, "dispute_withdrawn")))
      .orderBy(desc(auditLog.performedAt))
      .limit(1);
    expect(audit).toBeDefined();
  });

  it("rejects a govt who is neither admin nor the raiser", async () => {
    const { disputeToken } = await seedOpenDispute("DIM-CD-WD-NOTRAISER", "Withdraw NotRaiser");
    // The dispute was raised by claimantUserId, not the govt user.
    mockSessionAs(govtUserId);
    const result = await withdrawDisputeAction({ disputeToken });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("quien la levantó");

    // Dispute remains open.
    const [dispute] = await db
      .select({ status: custodyDisputes.status })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, disputeToken))
      .limit(1);
    expect(dispute?.status).toBe("open");
  });

  it("rejects withdrawing an unknown dispute token", async () => {
    mockSessionAs(adminUserId);
    const result = await withdrawDisputeAction({ disputeToken: "DIS-NOPE" });
    expect(result).toEqual({ error: "Disputa no encontrada." });
  });
});
