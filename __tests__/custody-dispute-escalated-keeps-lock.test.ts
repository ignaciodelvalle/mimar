// An ESCALATED custody dispute keeps the custody lock (PO decision 2A, 2026-09-22).
//
// WHAT THIS PINS, AND WHY IT IS ONE FILE
// ---------------------------------------------------------------------------
// `custody_disputes.status` has four values and TWO of them mean the animal is
// locked: 'open' and 'escalated'. Escalation moves a dispute to judicial
// channels; it is not an outcome. Before this change every reader in the system
// understood "in dispute" as the literal 'open', so writing 'escalated' would
// have released the lock everywhere at once, silently: the pet becomes
// transferable, adoption finalize opens, `pets.in_custody_dispute` re-derives
// to false on the next reconcile sweep, a SECOND dispute can be raised over the
// same animal, and the file vanishes from the authority's queue.
//
// Each of those is a different module, and asserting them separately in their
// own suites would have let any one of them regress while the others stayed
// green — which is exactly the shape of the bug. They are pinned together here
// because they are ONE property: escalation changes the channel and nothing
// else. `scripts/check-dispute-lock-predicate.ts` is the static half of the
// same rule; this is the behavioural half.
//
// Companion file: __tests__/custody-dispute-escalated-status.test.ts pins the
// DB CHECK constraints that make 'escalated' representable at all (migration
// 0235). This file pins what the value MEANS (migration 0242).
//
// Fixture: one pet + one dispute per test, seeded through the production
// raise-path sequencing (openCase BEFORE the raising event, then
// openDisputeFromEvent), torn down in afterAll.

import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditLog,
  cases,
  custodyDisputeParties,
  custodyDisputes,
  db,
  disputeHoldsCustodyLock,
  petEvents,
  pets,
} from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { openCase } from "@/lib/infra/case-helpers";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { rederivePetCache } from "@/lib/infra/rederive-pet-cache";
import { escalateDisputeUseCase } from "@/src/modules/custody-disputes/application/escalate-dispute";
import { openDisputeFromEvent } from "@/src/modules/custody-disputes/application/open-dispute";
import { resolveDisputeUseCase } from "@/src/modules/custody-disputes/application/resolve-dispute";
import { withdrawDisputeUseCase } from "@/src/modules/custody-disputes/application/withdraw-dispute";
import { TransfersRepository } from "@/src/modules/transfers/infrastructure/transfers-repository";

import { withMutationOverride } from "./_helpers/db-overrides";
import { expectDbError } from "./_helpers/expect-db-error";

const PROV = "Buenos Aires";
const LOCALITY = "La Plata";

// A reason long enough for every use-case's minimum (escalate: 20 chars,
// resolve: 100 chars).
const ESCALATION_REASON = "Pasa a sede judicial por medida cautelar del juzgado interviniente.";
const RESOLUTION_SUMMARY =
  "El juzgado interviniente resolvio la titularidad a favor del titular registrado y la disputa se cierra con esa constancia en el expediente.";

let adminUserId!: string;

const insertedPetIds: string[] = [];

function adminSession() {
  return {
    user: { id: adminUserId },
    profile: { role: "admin" as const },
    jurisdictions: [] as { province: string; locality: string }[],
  };
}

/** Seeds a pet with an OPEN custody dispute, through the production sequencing. */
async function seedOpenDispute(
  name: string,
): Promise<{ petId: string; disputeId: string; disputeToken: string }> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      name,
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
        openedByUserId: adminUserId,
        openedByOrganizationId: null,
        openedReason: { code: "custody_dispute_raised", raisedByRole: "govt" },
      },
      tx,
    );
    const payload = validateEventPayload("custody_dispute_raised", {
      raised_by_role: "govt",
      raised_by_user_id: adminUserId,
      external_proceeding_reference: null,
      reason: "Disputa de prueba para el fence del bloqueo de custodia escalado.",
    });
    const [raisingEvent] = await tx
      .insert(petEvents)
      .values({
        petId: pet.id,
        eventType: "custody_dispute_raised",
        occurredAt: new Date(),
        recordedAt: new Date(),
        recordedByUserId: adminUserId,
        authorRole: "govt",
        payload,
        caseId: disputeCase.id,
      })
      .returning({ id: petEvents.id });
    return openDisputeFromEvent(tx, {
      petId: pet.id,
      raisingEventId: raisingEvent.id,
      raisedByUserId: adminUserId,
      raisedByOrgId: null,
      raisedByRole: "govt",
      jurisdictionProvince: PROV,
      jurisdictionLocality: LOCALITY,
      initialParties: [{ userId: adminUserId, role: "current_owner" }],
      preCreatedCaseId: disputeCase.id,
    });
  });

  return { petId: pet.id, disputeId, disputeToken: publicToken };
}

/** Seeds a pet whose dispute has already been escalated. */
async function seedEscalatedDispute(
  name: string,
): Promise<{ petId: string; disputeId: string; disputeToken: string }> {
  const seeded = await seedOpenDispute(name);
  const result = await escalateDisputeUseCase(adminSession(), {
    disputeToken: seeded.disputeToken,
    notes: ESCALATION_REASON,
  });
  // A failure here is a fixture failure, not an assertion — surface it loudly
  // rather than letting every test below assert against an OPEN dispute and
  // pass for the wrong reason.
  if ("error" in result) throw new Error(`fixture escalation failed: ${result.error}`);
  return seeded;
}

async function statusOf(disputeId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: custodyDisputes.status })
    .from(custodyDisputes)
    .where(eq(custodyDisputes.id, disputeId))
    .limit(1);
  return row?.status;
}

async function lockFlagOf(petId: string): Promise<boolean | undefined> {
  const [row] = await db
    .select({ inCustodyDispute: pets.inCustodyDispute })
    .from(pets)
    .where(eq(pets.id, petId))
    .limit(1);
  return row?.inCustodyDispute;
}

beforeAll(async () => {
  const [admin] = (await db.execute(sql`
    select p.id::text as id from public.profiles p
    join auth.users u on u.id = p.id where u.email = 'admin@dim.test' limit 1
  `)) as unknown as Array<{ id: string }>;
  if (!admin) throw new Error("seeded admin@dim.test missing — run pnpm db:bootstrap");
  adminUserId = admin.id;
}, 60_000);

afterAll(async () => {
  for (const petId of insertedPetIds) {
    const disputeRows = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.petId, petId));
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM notifications WHERE related_pet_id = ${petId}`);
      // audit_log is NOT cleaned up, and must not be: the table is append-only
      // and `enforce_audit_log_append_only()` refuses DELETE outright. An
      // earlier draft of this teardown tried anyway, to make the "exactly one
      // audit row" assertion exact — and every run ended with the file
      // reporting an error OUTSIDE any test while all 13 tests passed, which is
      // a BROKEN FILE under scripts/check-suite-coverage.ts.
      //
      // The cleanup was never needed. That assertion keys on `dispute_id`, and
      // every run mints a fresh dispute UUID, so no accumulation across runs
      // can ever match it. The exactness comes from the key, not from deleting
      // history — which is what Invariant 2 says in the first place.
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
      for (const { id } of disputeRows) {
        await tx.delete(custodyDisputeParties).where(eq(custodyDisputeParties.disputeId, id));
      }
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}`);
      await tx.execute(sql`DELETE FROM ownerships WHERE pet_id = ${petId}`);
      await tx.delete(custodyDisputes).where(eq(custodyDisputes.petId, petId));
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
}, 90_000);

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

describe("escalateDisputeUseCase writes the status", () => {
  it("flips the dispute to 'escalated' and leaves the pet locked", async () => {
    const { petId, disputeId, disputeToken } = await seedOpenDispute("Dispute Lock Pet Writer");
    expect(await statusOf(disputeId)).toBe("open");

    const result = await escalateDisputeUseCase(adminSession(), {
      disputeToken,
      notes: ESCALATION_REASON,
    });

    expect(result).not.toHaveProperty("error");
    expect(await statusOf(disputeId)).toBe("escalated");
    // The whole point: the STATUS moved and the LOCK did not.
    expect(await lockFlagOf(petId)).toBe(true);
  });

  it("leaves the resolver columns null — the unresolved shape the CHECK requires", async () => {
    const { disputeId } = await seedEscalatedDispute("Dispute Lock Pet Shape");
    const [row] = await db
      .select({
        resolution: custodyDisputes.resolution,
        resolvedAt: custodyDisputes.resolvedAt,
        resolvedByUserId: custodyDisputes.resolvedByUserId,
      })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.id, disputeId))
      .limit(1);
    expect(row?.resolution).toBeNull();
    expect(row?.resolvedAt).toBeNull();
    expect(row?.resolvedByUserId).toBeNull();
  });

  it("records the acting role honestly: audit says admin, spine author says govt", async () => {
    // TWO CLAIMS, AND THEY DISAGREE ON PURPOSE.
    //
    // The security review read `authorRole: "govt"` as a wrong value written
    // into the append-only spine by an admin. It is not a free choice: the
    // `author_role` pgEnum has seven values and 'admin' is not one of them, so
    // writing the acting role there would make every admin escalation throw.
    // resolve-dispute.ts hits the same wall and resolves it the same way, and
    // 0240 keys erasure redaction on this column — where 'govt' is the honest
    // answer for both roles, because an institutional act outlives the person.
    //
    // So the acting role is preserved where it CAN be: the audit_log payload.
    // This pins both halves, because fixing one by breaking the other is the
    // obvious wrong move for the next person who reads that comment.
    const { petId, disputeId } = await seedEscalatedDispute("Dispute Lock Pet Author Role");

    // Keyed on the dispute id inside the payload, not on "the most recent row":
    // this file escalates several disputes and a newest-wins lookup would read
    // another test's entry and still pass.
    const audits = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "dispute_escalated"),
          sql`${auditLog.payload}->>'dispute_id' = ${disputeId}`,
        ),
      );
    expect(audits).toHaveLength(1);
    const payload = audits[0]?.payload as { dispute_id?: string; actor_role?: string } | undefined;
    expect(payload?.actor_role).toBe("admin");

    const [event] = await db
      .select({ authorRole: petEvents.authorRole, recordedByUserId: petEvents.recordedByUserId })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "note_added")))
      .orderBy(desc(petEvents.recordedAt))
      .limit(1);
    // Not 'admin' — the enum forbids it — but the ACTOR is still on the row.
    expect(event?.authorRole).toBe("govt");
    expect(event?.recordedByUserId).toBe(adminUserId);
  });

  it("refuses to escalate an already-escalated dispute", async () => {
    const { disputeToken } = await seedEscalatedDispute("Dispute Lock Pet Twice");
    const again = await escalateDisputeUseCase(adminSession(), {
      disputeToken,
      notes: ESCALATION_REASON,
    });
    expect(again).toHaveProperty("error");
    expect((again as { error: string }).error).toContain("ya está escalada");
  });
});

// ---------------------------------------------------------------------------
// The lock holds
// ---------------------------------------------------------------------------

describe("an escalated dispute still holds the custody lock", () => {
  it("the transfer guard still finds it (no transfer)", async () => {
    const { petId } = await seedEscalatedDispute("Dispute Lock Pet Transfer");
    // The repository read every transfer path consults before moving custody.
    // Named findOpenDispute for history; its predicate is the lock, not 'open'.
    await expect(TransfersRepository.findOpenDispute(petId)).resolves.not.toBeNull();
  });

  it("pets.in_custody_dispute stays true, so adoption finalize stays blocked", async () => {
    const { petId } = await seedEscalatedDispute("Dispute Lock Pet Adoption");
    // Every adoption/rehome guard in the app reads this one column
    // (src/modules/rehome/domain/rehome-rules.ts, the /adoptar routes,
    // owner-transfer-rules.ts). If it is true, they all refuse.
    expect(await lockFlagOf(petId)).toBe(true);
  });

  it("rederivePetCache agrees — the reconcile sweep will not clear the flag", async () => {
    const { petId } = await seedEscalatedDispute("Dispute Lock Pet Rederive");
    // This is the one that would have unlocked the pet WITHOUT anybody acting:
    // the nightly reconcile cron re-derives in_custody_dispute from the
    // custody_disputes table and writes the result back. A re-derivation that
    // keyed on 'open' would have reported drift and cleared the flag.
    const report = await rederivePetCache(petId);
    expect(report.inCustodyDispute?.derived).toBe(true);
    expect(report.inCustodyDispute?.matches).toBe(true);
  });

  it("shows for the arbiter and for govt — the shared queue predicate matches it", async () => {
    const { disputeId } = await seedEscalatedDispute("Dispute Lock Pet Queue");
    // The predicate /gob/disputas (DisputasScreen) and the custody_disputes_open
    // KPI both read. One predicate, so the queue and the count cannot disagree.
    const rows = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(and(eq(custodyDisputes.id, disputeId), disputeHoldsCustodyLock()));
    expect(rows).toHaveLength(1);
  });

  it("a second dispute cannot be opened over the same pet (use-case guard)", async () => {
    const { petId, disputeId } = await seedEscalatedDispute("Dispute Lock Pet Second UC");

    // NOTE ON WHAT THIS TEST DOES *NOT* DO. The obvious spelling — replay the
    // whole raise path, openCase included — never reaches openDisputeFromEvent:
    // `cases` refuses a second live custody_dispute case over one pet first, so
    // the assertion would have passed on a guard in a different module and told
    // us nothing about this one. The case is reused on purpose, so the ONLY
    // thing that can refuse here is openDisputeFromEvent's own guard.
    const [linkedCase] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(eq(cases.custodyDisputeId, disputeId))
      .limit(1);
    expect(linkedCase?.id).toBeTruthy();

    await expect(
      db.transaction(async (tx) => {
        const payload = validateEventPayload("custody_dispute_raised", {
          raised_by_role: "govt",
          raised_by_user_id: adminUserId,
          external_proceeding_reference: null,
          reason: "Segunda disputa que no deberia poder abrirse sobre la misma mascota.",
        });
        const [ev] = await tx
          .insert(petEvents)
          .values({
            petId,
            eventType: "custody_dispute_raised",
            occurredAt: new Date(),
            recordedAt: new Date(),
            recordedByUserId: adminUserId,
            authorRole: "govt",
            payload,
            caseId: linkedCase.id,
          })
          .returning({ id: petEvents.id });
        return openDisputeFromEvent(tx, {
          petId,
          raisingEventId: ev.id,
          raisedByUserId: adminUserId,
          raisedByOrgId: null,
          raisedByRole: "govt",
          jurisdictionProvince: PROV,
          jurisdictionLocality: LOCALITY,
          initialParties: [],
          preCreatedCaseId: linkedCase.id,
        });
      }),
    ).rejects.toThrow(/disputa de custodia en curso/i);
  });

  it("a second dispute cannot be opened over the same pet (DB unique index)", async () => {
    // The use-case guard above is a clean error, not a boundary — a writer that
    // does not go through it must still be refused. This inserts straight into
    // the table, bypassing every application guard, and relies on
    // custody_disputes_one_open_per_pet (widened by migration 0242).
    const { petId } = await seedEscalatedDispute("Dispute Lock Pet Second Index");
    await expectDbError(
      db.transaction(async (tx) => {
        const [ev] = await tx
          .insert(petEvents)
          .values({
            petId,
            eventType: "custody_dispute_raised",
            occurredAt: new Date(),
            recordedAt: new Date(),
            authorRole: "system",
            payload: {},
          })
          .returning({ id: petEvents.id });
        await tx.insert(custodyDisputes).values({
          publicToken: generatePublicToken(),
          petId,
          raisedByRole: "govt",
          raisingEventId: ev.id,
          jurisdictionProvince: PROV,
          jurisdictionLocality: LOCALITY,
          status: "open",
        });
      }),
      { constraint: /custody_disputes_one_open_per_pet/ },
    );
  });
});

// ---------------------------------------------------------------------------
// The lock releases, the same way it always did
// ---------------------------------------------------------------------------

describe("resolving or withdrawing an escalated dispute releases the lock", () => {
  it("resolve works from 'escalated' exactly as from 'open'", async () => {
    const { petId, disputeId, disputeToken } = await seedEscalatedDispute(
      "Dispute Lock Pet Resolve",
    );
    expect(await lockFlagOf(petId)).toBe(true);

    const result = await resolveDisputeUseCase(adminSession(), {
      disputeToken,
      resolution: "ownership_confirmed",
      resolutionSummary: RESOLUTION_SUMMARY,
    });

    expect(result).not.toHaveProperty("error");
    expect(await statusOf(disputeId)).toBe("resolved");
    expect(await lockFlagOf(petId)).toBe(false);
  });

  it("the pet is free again — the queue predicate no longer matches it", async () => {
    const { petId, disputeId, disputeToken } = await seedEscalatedDispute(
      "Dispute Lock Pet Resolve Queue",
    );
    await resolveDisputeUseCase(adminSession(), {
      disputeToken,
      resolution: "ownership_confirmed",
      resolutionSummary: RESOLUTION_SUMMARY,
    });
    const rows = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(and(eq(custodyDisputes.id, disputeId), disputeHoldsCustodyLock()));
    expect(rows).toHaveLength(0);
    await expect(TransfersRepository.findOpenDispute(petId)).resolves.toBeNull();
  });

  it("withdraw works from 'escalated' exactly as from 'open'", async () => {
    const { petId, disputeId, disputeToken } = await seedEscalatedDispute(
      "Dispute Lock Pet Withdraw",
    );
    const result = await withdrawDisputeUseCase(adminSession(), {
      disputeToken,
      reason: "Se retira la disputa a pedido de la parte reclamante.",
    });
    expect(result).not.toHaveProperty("error");
    expect(await statusOf(disputeId)).toBe("withdrawn");
    expect(await lockFlagOf(petId)).toBe(false);
  });
});
