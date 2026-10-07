// Integration tests for SurveillanceRepository.
// Exercises WU-2 scope: bite/rabies reads+writes, ENO queue ops, outbreak reads+writes.
//
// Postgres is REQUIRED. If unavailable, this file will fail at connection —
// that is expected and reported as an infra block (not a code failure).
//
// Key contracts verified here (parity quirks from spec):
//   - insertIncidentEventIdempotent: wasNoop=true on re-insert (same clientIdempotencyKey)
//   - autoExpireBiteCase: direct UPDATE with closedReason='auto_expired' (NOT closeCase)
//   - findEscalatingSymptom: jsonb @> query for rabies_suspected
//   - ENO queue: onConflictDoNothing(petEventId) idempotency
//
// Note: pet_events is append-only (db/triggers.sql). Cleanup uses withMutationOverride.

import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, enoProcessingQueue, petEvents, pets, profiles } from "@/db";
import { openCase } from "@/lib/infra/case-helpers";
import { hashDni } from "@/lib/utils/dni-hash";
import { withMutationOverride } from "../../../../__tests__/_helpers/db-overrides";
import { OBSERVATION_OPEN_ERROR, reportBite } from "../application/report-bite";
import { isRabiesVaccineValid } from "../domain/rabies-observation";
import { SurveillanceRepository } from "./surveillance-repository";

// ---------------------------------------------------------------------------
// Fixture tokens
// ---------------------------------------------------------------------------

const PET_TOKEN = "SURV-REPO-TEST-02";

const repo = new SurveillanceRepository();

// Track inserted pet_events for cleanup
const eventIds: string[] = [];

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

async function cleanupFixtures() {
  // ENO queue rows have no FK to pet directly, clean them first.
  await db.execute(sql`
    DELETE FROM eno_processing_queue
    WHERE pet_event_id IN (
      SELECT id FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
      )
    )
  `);
  // cases cleanup
  await db.execute(sql`
    DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )
  `);
  // pet_events cleanup via mutation override (append-only trigger)
  if (eventIds.length > 0) {
    await withMutationOverride(async (tx) => {
      for (const eid of eventIds) {
        await tx
          .delete(petEvents)
          .where(eq(petEvents.id, eid))
          .catch(() => {});
      }
    }).catch(() => {});
    eventIds.length = 0;
  }
  // Also nuke any remaining events for the pet via override
  await withMutationOverride(async (tx) => {
    await tx
      .delete(petEvents)
      .where(sql`pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`);
  }).catch(() => {});
  // Finally delete the pet
  await db.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let petId: string;

beforeAll(async () => {
  await cleanupFixtures();

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "SurveillanceRepoTestPet",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;
});

afterAll(async () => {
  await cleanupFixtures();
});

// ---------------------------------------------------------------------------
// findPetByToken
// ---------------------------------------------------------------------------

describe("SurveillanceRepository.findPetByToken", () => {
  it("returns pet data when found", async () => {
    const result = await repo.findPetByToken(PET_TOKEN);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(petId);
    expect(result?.publicToken).toBe(PET_TOKEN);
    expect(result?.name).toBe("SurveillanceRepoTestPet");
  });

  it("returns null when token does not exist", async () => {
    const result = await repo.findPetByToken("NONEXISTENT-TOKEN-XYZ");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findLatestRabiesVaccineEvent
// ---------------------------------------------------------------------------

describe("SurveillanceRepository.findLatestRabiesVaccineEvent", () => {
  it("returns null when no rabies vaccine event exists for the pet", async () => {
    // The pet has no events at this point.
    const result = await repo.findLatestRabiesVaccineEvent(petId);
    expect(result).toBeNull();
  });

  it("returns the latest rabies vaccine event when one exists", async () => {
    const now = new Date();
    const [event] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "vaccination_administered",
        occurredAt: now,
        recordedAt: now,
        payload: { vaccine_name: "antirrábica triple", next_due_at: null },
      })
      .returning();
    eventIds.push(event.id);

    const result = await repo.findLatestRabiesVaccineEvent(petId);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(event.id);
    // payload comes back as the shape we need for isRabiesVaccineValid
    expect((result?.payload as Record<string, unknown>).vaccine_name).toBe("antirrábica triple");
  });
});

// T3-A1b — the answer is frozen into the NON-amendable incident_reported
// payload (rabies_vaccine_valid_at_incident) and into the authority's alert,
// so it must read the CORRECTED dose, never the raw one.
describe("SurveillanceRepository.findLatestRabiesVaccineEvent — amendments", () => {
  // Only this pet's doses and corrections; the other describes own their rows.
  async function clearDoses(): Promise<void> {
    await withMutationOverride(async (tx) => {
      await tx
        .delete(petEvents)
        .where(
          and(
            eq(petEvents.petId, petId),
            inArray(petEvents.eventType, ["vaccination_administered", "event_amended"]),
          ),
        );
    });
  }

  async function insertDose(payload: Record<string, unknown>): Promise<string> {
    const [event] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "vaccination_administered",
        occurredAt: new Date("2026-03-01T12:00:00Z"),
        recordedAt: new Date(),
        payload: { payload_version: 1, ...payload },
      })
      .returning({ id: petEvents.id });
    eventIds.push(event.id);
    return event.id;
  }

  async function amend(
    targetEventId: string,
    changes: Array<{ field: string; old: unknown; new: unknown }>,
  ): Promise<void> {
    const [event] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "event_amended",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        recordedAt: new Date(),
        payload: { payload_version: 1, target_event_id: targetEventId, reason: null, changes },
      })
      .returning({ id: petEvents.id });
    eventIds.push(event.id);
  }

  const biteDate = new Date("2026-06-01T12:00:00Z");

  it("(a) finds a dose corrected TO a rabies vaccine", async () => {
    await clearDoses();
    const id = await insertDose({ vaccine_name: "Séxtuple", next_due_at: "2027-03-01" });
    await amend(id, [{ field: "vaccine_name", old: "Séxtuple", new: "Antirrábica" }]);

    const result = await repo.findLatestRabiesVaccineEvent(petId);
    expect(result?.id).toBe(id);
    expect(isRabiesVaccineValid(result, biteDate)).toBe(true);
  });

  it("(b) ignores a dose corrected AWAY from a rabies vaccine", async () => {
    await clearDoses();
    const id = await insertDose({ vaccine_name: "Antirrábica", next_due_at: "2027-03-01" });
    await amend(id, [{ field: "vaccine_name", old: "Antirrábica", new: "Séxtuple" }]);

    const result = await repo.findLatestRabiesVaccineEvent(petId);
    expect(result).toBeNull();
    expect(isRabiesVaccineValid(result, biteDate)).toBe(false);
  });

  it("(c) a corrected next_due_at reaches the vigencia check", async () => {
    await clearDoses();
    const id = await insertDose({ vaccine_name: "Antirrábica", next_due_at: "2027-03-01" });
    await amend(id, [{ field: "next_due_at", old: "2027-03-01", new: "2025-03-01" }]);

    const result = await repo.findLatestRabiesVaccineEvent(petId);
    expect(result?.id).toBe(id);
    expect(result?.payload.next_due_at).toBe("2025-03-01");
    expect(isRabiesVaccineValid(result, biteDate)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// insertIncidentEventIdempotent — parity quirk: owner path uses idempotency
// ---------------------------------------------------------------------------

// Generate a deterministic-enough v4-shaped UUID for test idempotency keys.
function testUUID(suffix: number): string {
  const hex = suffix.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex.slice(0, 12)}`;
}

describe("SurveillanceRepository.insertIncidentEventIdempotent", () => {
  it("inserts a new event and returns wasNoop=false", async () => {
    const now = new Date();
    const key = testUUID(Date.now() % 0xffffffffffff);
    const result = await repo.insertIncidentEventIdempotent(
      {
        petId,
        eventType: "incident_reported",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: null,
        payload: {
          incident_type: "bite_inflicted",
          severity: "minor",
          injuries_summary: null,
          vet_involved: null,
          reporter_role: "owner",
        },
        clientIdempotencyKey: key,
      },
      db,
    );

    expect(result.wasNoop).toBe(false);
    expect(result.event.id).toBeDefined();
    expect(result.event.petId).toBe(petId);
    eventIds.push(result.event.id);
  });

  it("returns wasNoop=true on duplicate key (idempotency)", async () => {
    const now = new Date();
    const key = testUUID((Date.now() + 1) % 0xffffffffffff);
    const values = {
      petId,
      eventType: "incident_reported" as const,
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: null as string | null,
      payload: {
        incident_type: "bite_inflicted",
        severity: "moderate",
        injuries_summary: null,
        vet_involved: null,
        reporter_role: "owner",
      },
      clientIdempotencyKey: key,
    };

    const first = await repo.insertIncidentEventIdempotent(values, db);
    expect(first.wasNoop).toBe(false);
    eventIds.push(first.event.id);

    const second = await repo.insertIncidentEventIdempotent(values, db);
    expect(second.wasNoop).toBe(true);
    // Returns the original row — same id
    expect(second.event.id).toBe(first.event.id);
  });
});

// ---------------------------------------------------------------------------
// findEscalatingSymptom — jsonb @> query (parity quirk #4)
// ---------------------------------------------------------------------------

describe("SurveillanceRepository.findEscalatingSymptom", () => {
  it("returns null when no symptom_observed event exists during the period", async () => {
    // Use a future 'since' date so existing events are excluded
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
    const result = await repo.findEscalatingSymptom(petId, futureDate);
    expect(result).toBeNull();
  });

  it("returns the escalating event when alerted_disease_codes contains rabies_suspected", async () => {
    const since = new Date("2000-01-01Z");
    const now = new Date();

    const [event] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "symptom_observed",
        occurredAt: now,
        recordedAt: now,
        payload: {
          alerted_disease_codes: ["rabies_suspected", "other_code"],
          symptoms: ["aggression"],
        },
      })
      .returning();
    eventIds.push(event.id);

    const result = await repo.findEscalatingSymptom(petId, since);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(event.id);
  });

  it("returns null when alerted_disease_codes does not contain rabies_suspected", async () => {
    const since = new Date("2000-01-01Z");
    const now = new Date();

    const [event] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "symptom_observed",
        occurredAt: now,
        recordedAt: now,
        payload: {
          alerted_disease_codes: ["leptospirosis"],
        },
      })
      .returning();
    eventIds.push(event.id);

    // The previous test already inserted a rabies_suspected event, so this
    // tests the opposite: when ONLY non-rabies symptoms exist before the
    // other events are cleaned up in afterAll, we would still return the
    // rabies_suspected one. So we use a more-recent since date to isolate.
    // We test the predicate directly: a pet with ONLY leptospirosis
    // should return null — we do this with a fresh pet to avoid interference.
    const [tmpPet] = await db
      .insert(pets)
      .values({
        publicToken: "SURV-REPO-ESCALATING-TMP",
        name: "TmpEscalatingPet",
        species: "dog",
        sex: "unknown",
        potentiallyDangerousBreed: false,
      })
      .returning();

    const [tmpEvent] = await db
      .insert(petEvents)
      .values({
        petId: tmpPet.id,
        eventType: "symptom_observed",
        occurredAt: now,
        recordedAt: now,
        payload: { alerted_disease_codes: ["leptospirosis"] },
      })
      .returning();

    const result = await repo.findEscalatingSymptom(tmpPet.id, since);
    expect(result).toBeNull();

    // Cleanup tmp pet (via override since it has events)
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(eq(petEvents.id, tmpEvent.id));
    });
    await db.delete(pets).where(eq(pets.id, tmpPet.id));
  });
});

// ---------------------------------------------------------------------------
// autoExpireBiteCase — parity quirk: direct UPDATE with closedReason='auto_expired'
// ---------------------------------------------------------------------------

describe("SurveillanceRepository.autoExpireBiteCase", () => {
  it("sets status=closed, closedReason=auto_expired, closedAt on the case row", async () => {
    const now = new Date();
    const publicCode = `SURV-AE-${Date.now()}`;
    const [caseRow] = await db
      .insert(cases)
      .values({
        publicCode,
        caseKind: "bite_incident",
        primarySubjectKind: "registered_pet",
        primaryPetId: petId,
        openedReason: "Integration test — auto-expire",
        status: "open",
      })
      .returning();

    await db.transaction(async (tx) => {
      await repo.autoExpireBiteCase(caseRow.id, now, tx);
    });

    const [updated] = await db.select().from(cases).where(eq(cases.id, caseRow.id));
    expect(updated.status).toBe("closed");
    expect(updated.closedReason).toBe("auto_expired");
    expect(updated.closedAt).not.toBeNull();

    // Cleanup
    await db.delete(cases).where(eq(cases.id, caseRow.id));
  });

  it("does NOT change closedReason when case is already closed (WHERE status='open' guard)", async () => {
    const now = new Date();
    const publicCode = `SURV-AE2-${Date.now()}`;
    const [caseRow] = await db
      .insert(cases)
      .values({
        publicCode,
        caseKind: "bite_incident",
        primarySubjectKind: "registered_pet",
        primaryPetId: petId,
        openedReason: "Integration test — already closed guard",
        status: "closed",
        closedReason: "resolved",
        closedAt: new Date(),
      })
      .returning();

    await db.transaction(async (tx) => {
      await repo.autoExpireBiteCase(caseRow.id, now, tx);
    });

    const [after] = await db.select().from(cases).where(eq(cases.id, caseRow.id));
    // closedReason must remain 'resolved' — NOT overwritten to 'auto_expired'
    expect(after.closedReason).toBe("resolved");

    // Cleanup
    await db.delete(cases).where(eq(cases.id, caseRow.id));
  });
});

// ---------------------------------------------------------------------------
// ENO queue: insertEnoQueueRow (onConflictDoNothing on pet_event_id)
// ---------------------------------------------------------------------------

describe("SurveillanceRepository.insertEnoQueueRow", () => {
  it("enqueues a new row and returns it with status=pending", async () => {
    const now = new Date();
    const [event] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "clinical_info_logged",
        occurredAt: now,
        recordedAt: now,
        payload: { sub_kind: "disease_diagnosis", disease_code: "rabies_confirmed" },
      })
      .returning();
    eventIds.push(event.id);

    const row = await repo.insertEnoQueueRow(event.id);
    expect(row).not.toBeNull();
    expect(row?.petEventId).toBe(event.id);
    expect(row?.status).toBe("pending");
  });

  it("returns null on second enqueue with same pet_event_id (onConflictDoNothing)", async () => {
    const now = new Date();
    const [event] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "clinical_info_logged",
        occurredAt: now,
        recordedAt: now,
        payload: { sub_kind: "disease_diagnosis", disease_code: "rabies_confirmed" },
      })
      .returning();
    eventIds.push(event.id);

    const first = await repo.insertEnoQueueRow(event.id);
    expect(first).not.toBeNull();

    // Second call must be a no-op
    const second = await repo.insertEnoQueueRow(event.id);
    expect(second).toBeNull();

    // Confirm exactly one queue row exists
    const rows = await db
      .select()
      .from(enoProcessingQueue)
      .where(eq(enoProcessingQueue.petEventId, event.id));
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// markEnoProcessed
// ---------------------------------------------------------------------------

describe("SurveillanceRepository.markEnoProcessed", () => {
  it("sets status=processed and processedAt", async () => {
    const now = new Date();
    const [event] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "clinical_info_logged",
        occurredAt: now,
        recordedAt: now,
        payload: { sub_kind: "disease_diagnosis", disease_code: "leptospirosis" },
      })
      .returning();
    eventIds.push(event.id);

    const qRow = await repo.insertEnoQueueRow(event.id);
    expect(qRow).not.toBeNull();

    await repo.markEnoProcessed(qRow!.id);

    const [updated] = await db
      .select()
      .from(enoProcessingQueue)
      .where(eq(enoProcessingQueue.id, qRow!.id));
    expect(updated.status).toBe("processed");
    expect(updated.processedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// markEnoFailed — retry logic: pending until retryCount>=2, then failed
// ---------------------------------------------------------------------------

describe("SurveillanceRepository.markEnoFailed", () => {
  it("increments retryCount and sets lastError; status stays pending when retryCount < 2", async () => {
    const now = new Date();
    const [event] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "clinical_info_logged",
        occurredAt: now,
        recordedAt: now,
        payload: { sub_kind: "disease_diagnosis", disease_code: "hidatidosis" },
      })
      .returning();
    eventIds.push(event.id);

    const qRow = await repo.insertEnoQueueRow(event.id);
    expect(qRow).not.toBeNull();

    await repo.markEnoFailed(qRow!.id, "first error");

    const [after] = await db
      .select()
      .from(enoProcessingQueue)
      .where(eq(enoProcessingQueue.id, qRow!.id));
    expect(after.retryCount).toBe(1);
    expect(after.lastError).toBe("first error");
    expect(after.status).toBe("pending"); // still pending — can retry
  });

  it("sets status=failed when retryCount reaches 2", async () => {
    const now = new Date();
    const [event] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "clinical_info_logged",
        occurredAt: now,
        recordedAt: now,
        payload: { sub_kind: "disease_diagnosis", disease_code: "leishmaniasis" },
      })
      .returning();
    eventIds.push(event.id);

    // Pre-seed retryCount=1 so the next failure triggers 'failed'
    const [qRow] = await db
      .insert(enoProcessingQueue)
      .values({ petEventId: event.id, retryCount: 1 })
      .returning();

    await repo.markEnoFailed(qRow.id, "fatal error");

    const [after] = await db
      .select()
      .from(enoProcessingQueue)
      .where(eq(enoProcessingQueue.id, qRow.id));
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(2);
    expect(after.lastError).toBe("fatal error");
  });
});

// ---------------------------------------------------------------------------
// findOpenBiteCase
// ---------------------------------------------------------------------------

describe("SurveillanceRepository.findOpenBiteCase", () => {
  it("returns null when no open bite case exists for the pet", async () => {
    // Use a fresh pet with no cases
    const [tmpPet] = await db
      .insert(pets)
      .values({
        publicToken: "SURV-REPO-BITE-CASE-TMP",
        name: "TmpBiteCasePet",
        species: "cat",
        sex: "unknown",
        potentiallyDangerousBreed: false,
      })
      .returning();

    const result = await repo.findOpenBiteCase(tmpPet.id);
    expect(result).toBeNull();

    // Cleanup (no events on this pet)
    await db.delete(pets).where(eq(pets.id, tmpPet.id));
  });

  it("returns the case when an open bite_incident case exists", async () => {
    const publicCode = `SURV-OBC-${Date.now()}`;
    const [caseRow] = await db
      .insert(cases)
      .values({
        publicCode,
        caseKind: "bite_incident",
        primarySubjectKind: "registered_pet",
        primaryPetId: petId,
        openedReason: "Integration test — open bite case find",
        status: "open",
      })
      .returning();

    const result = await repo.findOpenBiteCase(petId);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(caseRow.id);

    // Cleanup
    await db.delete(cases).where(eq(cases.id, caseRow.id));
  });
});

// ---------------------------------------------------------------------------
// setObservationStatus
// ---------------------------------------------------------------------------

describe("SurveillanceRepository.setObservationStatus", () => {
  it("updates the rabiesObservationStatus on the pets row", async () => {
    await db.transaction(async (tx) => {
      await repo.setObservationStatus(petId, "in_progress", new Date(), tx);
    });

    const [pet] = await db.select().from(pets).where(eq(pets.id, petId));
    expect(pet.rabiesObservationStatus).toBe("in_progress");

    // Reset to null
    await db.update(pets).set({ rabiesObservationStatus: null }).where(eq(pets.id, petId));
  });
});

// ---------------------------------------------------------------------------
// findActiveOwnerUserIds — the State's rabies close notifies these
// ---------------------------------------------------------------------------

describe("SurveillanceRepository.findActiveOwnerUserIds", () => {
  // A fake executor: the predicate is what matters, and it is compiled and read
  // back rather than trusted. `findActiveOwnership` (one `role = 'owner'` row,
  // limit 1) is what this replaced on the close — a co-owner never heard.
  function fakeExecutor(rows: Array<{ ownerUserId: string | null }>) {
    const seen: { where?: unknown; limited: boolean } = { limited: false };
    const executor = {
      select: () => ({
        from: () => ({
          where: (predicate: unknown) => {
            seen.where = predicate;
            const result = Promise.resolve(rows);
            return Object.assign(result, {
              limit: () => {
                seen.limited = true;
                return result;
              },
            });
          },
        }),
      }),
    };
    return { executor: executor as never, seen };
  }

  it("asks for owners AND co-owners still active, with no row limit", async () => {
    const { executor, seen } = fakeExecutor([]);
    await repo.findActiveOwnerUserIds("pet-x", executor);

    const compiled = new PgDialect().sqlToQuery(seen.where as never);
    expect(compiled.sql).toContain('"ownerships"."pet_id" = $1');
    expect(compiled.sql).toContain('"ownerships"."role" in ($2, $3)');
    expect(compiled.sql).toContain('"ownerships"."ended_at" is null');
    expect(compiled.params).toEqual(["pet-x", "owner", "co_owner"]);
    expect(seen.limited).toBe(false);
  });

  it("returns every distinct user id and drops org-held rows with no human owner", async () => {
    const { executor } = fakeExecutor([
      { ownerUserId: "owner-1" },
      { ownerUserId: "co-owner-2" },
      { ownerUserId: "owner-1" },
      { ownerUserId: null },
    ]);
    expect(await repo.findActiveOwnerUserIds("pet-x", executor)).toEqual(["owner-1", "co-owner-2"]);
  });
});

// ---------------------------------------------------------------------------
// findOpenInvestigationsForDisease
// ---------------------------------------------------------------------------

describe("SurveillanceRepository.findOpenInvestigationsForDisease", () => {
  it("returns empty array when no outbreak investigation exists for the disease/jurisdiction", async () => {
    const results = await repo.findOpenInvestigationsForDisease(
      "some-disease-no-investigation",
      "Fake Province",
      "Fake Locality",
    );
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findGovtTargetsForJurisdiction
// ---------------------------------------------------------------------------

describe("SurveillanceRepository.findGovtTargetsForJurisdiction", () => {
  it("returns an array (may be empty) for an unlikely jurisdiction", async () => {
    const results = await repo.findGovtTargetsForJurisdiction("Nowhere Province", "Nowhere City");
    expect(Array.isArray(results)).toBe(true);
    for (const r of results) {
      expect(typeof r.userId).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// findIncidentReplay + reportBite on the real database (plan A5c)
// ---------------------------------------------------------------------------
//
// The bug this pins lived in the database, not in the use case's branches: a
// retry of a report that SUCCEEDED opened a second bite_incident case, and
// `cases_open_per_pet_kind_idx` threw. So the proof is the real index, the
// real ledger and the real transaction — no fakes between them.

describe("reportBite — replay check before state guard (real database)", () => {
  // Per-run token: a run that lost its afterAll leaves a pet whose events and
  // case a plain DELETE cannot remove, and a fixed token would inherit it.
  const REPLAY_PET_TOKEN = `SURV-REPO-BITE-REPLAY-${randomUUID().slice(0, 8)}`;
  let replayPetId: string;
  let reporterId: string;

  beforeAll(async () => {
    reporterId = randomUUID();
    await db.insert(profiles).values({
      id: reporterId,
      displayName: "Bite Replay Reporter",
      dniHash: hashDni(String(30_000_000 + Math.floor(Math.random() * 9_999_999))),
      dniVerified: true,
      role: "owner",
    });
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: REPLAY_PET_TOKEN,
        name: "BiteReplayPet",
        species: "dog",
        sex: "unknown",
        potentiallyDangerousBreed: false,
      })
      .returning();
    replayPetId = pet.id;
  });

  afterAll(async () => {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${replayPetId}::uuid`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${replayPetId}::uuid`);
      await tx.execute(sql`DELETE FROM pets WHERE id = ${replayPetId}::uuid`);
      await tx.execute(sql`DELETE FROM profiles WHERE id = ${reporterId}::uuid`);
    });
  });

  // Each call reads the pet AFTER the previous one, the way a real retry does.
  async function report(key: string) {
    const [pet] = await db.select().from(pets).where(eq(pets.id, replayPetId));
    return reportBite(
      {
        pet: {
          id: pet.id,
          publicToken: pet.publicToken,
          name: pet.name,
          species: pet.species,
          status: pet.status,
          rabiesObservationStatus: pet.rabiesObservationStatus ?? null,
          jurisdictionProvince: null,
          jurisdictionLocality: null,
          localityId: null,
        },
        user: { id: reporterId },
        eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
        occurredAt: new Date("2026-01-10T12:00:00Z"),
        victimKind: "human",
        severity: "minor",
        locationDescription: null,
        context: null,
        victimContactName: null,
        victimContactPhone: null,
        victimAgeEstimate: null,
        clientIdempotencyKey: key,
        eventJurisdictionProvince: null,
        eventJurisdictionLocality: null,
        locationLat: null,
        locationLng: null,
        locationSource: null,
      },
      {
        repo,
        openCase: async (input, tx) =>
          openCase(input as Parameters<typeof openCase>[0], tx as Parameters<typeof openCase>[1]),
        transaction: db.transaction.bind(db),
        findAuthoritiesForJurisdiction: async () => [],
        resolveObservationWindow: async () => ({ days: 10 }),
      },
    );
  }

  it("the same key twice returns the original result and leaves ONE case; another key is refused", async () => {
    const key = randomUUID();

    const first = await report(key);
    expect(first.ok).toBe(true);
    const retry = await report(key);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(first.value.casePublicCode).toMatch(/^CAS-/);
    expect(retry.value).toEqual({ ...first.value, wasDuplicate: true });

    const biteCases = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.primaryPetId, replayPetId), eq(cases.caseKind, "bite_incident")));
    expect(biteCases).toHaveLength(1);
    const incidents = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, replayPetId), eq(petEvents.eventType, "incident_reported")));
    expect(incidents).toHaveLength(1);

    // The ledger, asked directly, names the same incident and case code.
    const replay = await db.transaction((tx) =>
      repo.findIncidentReplay(
        { petId: replayPetId, clientIdempotencyKey: key, recordedByUserId: reporterId },
        tx,
      ),
    );
    expect(replay).toEqual({
      eventId: first.value.eventId,
      caseId: biteCases[0].id,
      casePublicCode: first.value.casePublicCode,
    });

    // A NEW report (another key) still meets the open-observation guard.
    const other = await report(randomUUID());
    expect(other).toEqual({ ok: false, error: OBSERVATION_OPEN_ERROR });
    const stillOne = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.primaryPetId, replayPetId), eq(cases.caseKind, "bite_incident")));
    expect(stillOne).toHaveLength(1);
  });

  it("an unknown key finds nothing in the ledger", async () => {
    const replay = await db.transaction((tx) =>
      repo.findIncidentReplay(
        { petId: replayPetId, clientIdempotencyKey: randomUUID(), recordedByUserId: reporterId },
        tx,
      ),
    );
    expect(replay).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reportBite — concurrency, actor scope and last-stable-wins (real database)
// ---------------------------------------------------------------------------
//
// Each test gets its own pet, so the open observation one leaves behind cannot
// decide another's outcome.

describe("reportBite — concurrency, actor scope, last-stable-wins (real database)", () => {
  const petIds: string[] = [];
  const profileIds: string[] = [];

  async function freshProfile(): Promise<string> {
    const id = randomUUID();
    await db.insert(profiles).values({
      id,
      displayName: "Bite Replay Concurrency",
      dniHash: hashDni(String(40_000_000 + Math.floor(Math.random() * 9_999_999))),
      dniVerified: true,
      role: "owner",
    });
    profileIds.push(id);
    return id;
  }

  async function freshPet(): Promise<string> {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: `SURV-BITE-CONC-${randomUUID().slice(0, 8)}`,
        name: "BiteConcurrencyPet",
        species: "dog",
        sex: "unknown",
        potentiallyDangerousBreed: false,
      })
      .returning();
    petIds.push(pet.id);
    return pet.id;
  }

  afterAll(async () => {
    await withMutationOverride(async (tx) => {
      for (const id of petIds) {
        await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${id}::uuid`);
        await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${id}::uuid`);
        await tx.execute(sql`DELETE FROM pets WHERE id = ${id}::uuid`);
      }
      for (const id of profileIds) {
        await tx.execute(sql`DELETE FROM profiles WHERE id = ${id}::uuid`);
      }
    });
  });

  // Reads the pet when called, the way the web action and the v1 route do.
  async function report(
    petId: string,
    reporterId: string,
    key: string,
    severity: "minor" | "moderate" | "severe" = "minor",
  ) {
    const [pet] = await db.select().from(pets).where(eq(pets.id, petId));
    return reportBite(
      {
        pet: {
          id: pet.id,
          publicToken: pet.publicToken,
          name: pet.name,
          species: pet.species,
          status: pet.status,
          rabiesObservationStatus: pet.rabiesObservationStatus ?? null,
          jurisdictionProvince: null,
          jurisdictionLocality: null,
          localityId: null,
        },
        user: { id: reporterId },
        eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
        occurredAt: new Date("2026-01-10T12:00:00Z"),
        victimKind: "human",
        severity,
        locationDescription: null,
        context: null,
        victimContactName: null,
        victimContactPhone: null,
        victimAgeEstimate: null,
        clientIdempotencyKey: key,
        eventJurisdictionProvince: null,
        eventJurisdictionLocality: null,
        locationLat: null,
        locationLng: null,
        locationSource: null,
      },
      {
        repo,
        openCase: async (input, tx) =>
          openCase(input as Parameters<typeof openCase>[0], tx as Parameters<typeof openCase>[1]),
        transaction: db.transaction.bind(db),
        findAuthoritiesForJurisdiction: async () => [],
        resolveObservationWindow: async () => ({ days: 10 }),
      },
    );
  }

  async function biteCaseCount(petId: string): Promise<number> {
    const rows = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.primaryPetId, petId), eq(cases.caseKind, "bite_incident")));
    return rows.length;
  }

  it("two SAME-key requests at once: one writes, the other replays it", async () => {
    const petId = await freshPet();
    const reporterId = await freshProfile();
    const key = randomUUID();

    const results = await Promise.all([
      report(petId, reporterId, key),
      report(petId, reporterId, key),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    const values = results.flatMap((r) => (r.ok ? [r.value] : []));
    expect(values.map((v) => v.wasDuplicate).sort()).toEqual([false, true]);
    expect(values[0].eventId).toBe(values[1].eventId);
    expect(values[0].casePublicCode).toBe(values[1].casePublicCode);
    expect(await biteCaseCount(petId)).toBe(1);
  });

  it("two DIFFERENT-key requests at once: one writes, the other is the guard's refusal — not a 500", async () => {
    const petId = await freshPet();
    const reporterId = await freshProfile();

    const results = await Promise.all([
      report(petId, reporterId, randomUUID()),
      report(petId, reporterId, randomUUID()),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: OBSERVATION_OPEN_ERROR }]);
    expect(await biteCaseCount(petId)).toBe(1);
  });

  it("someone else's key is not this caller's replay: it meets the guard", async () => {
    const petId = await freshPet();
    const key = randomUUID();

    const first = await report(petId, await freshProfile(), key);
    expect(first.ok).toBe(true);
    const stranger = await report(petId, await freshProfile(), key);

    expect(stranger).toEqual({ ok: false, error: OBSERVATION_OPEN_ERROR });
  });

  it("same key, different payload: the ORIGINAL result stands (B8 last-stable-wins)", async () => {
    const petId = await freshPet();
    const reporterId = await freshProfile();
    const key = randomUUID();

    const first = await report(petId, reporterId, key, "minor");
    const edited = await report(petId, reporterId, key, "severe");

    expect(first.ok && edited.ok).toBe(true);
    if (!first.ok || !edited.ok) return;
    expect(edited.value).toEqual({ ...first.value, wasDuplicate: true });
    const incidents = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "incident_reported")));
    expect(incidents).toHaveLength(1);
    expect((incidents[0].payload as { severity: string }).severity).toBe("minor");
  });
});
