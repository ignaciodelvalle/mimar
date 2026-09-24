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

import { and, eq, inArray, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, enoProcessingQueue, petEvents, pets } from "@/db";
import { withMutationOverride } from "../../../../__tests__/_helpers/db-overrides";
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
