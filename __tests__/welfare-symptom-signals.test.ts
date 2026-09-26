// Integration test (real DB) — the surveillance leg of a denuncia (PO S7,
// 2026-09-26): the matcher runs over the witness's text, one outbreak signal
// per alert lands in the report's transaction where the report says it
// happened (S10), and NOTHING enters the legal ENO queue (S1).

import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, eventNotificationOutbox, petEvents, pets } from "@/db";
import {
  emitWelfareSymptomSignals,
  matchWelfareSymptoms,
} from "@/src/modules/events/application/surveillance/welfare-symptom-signals";

import { withMutationOverride } from "./_helpers/db-overrides";

const created: string[] = [];

async function insertPet() {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `WSSTEST-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      name: "Witness",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionCountry: "AR",
      jurisdictionProvince: "Córdoba",
      jurisdictionLocality: "Río Cuarto",
    })
    .returning();
  created.push(pet.id);
  return pet;
}

afterAll(async () => {
  for (const id of created) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, id));
    });
  }
});

describe("welfare symptom signals (S7)", () => {
  it("a witness's rabies-like text → a matcher signal where it happened, and no ENO row", async () => {
    const pet = await insertPet();
    const place = {
      entered: { province: "Santa Fe", locality: "Localidad Inexistente", indec_id: null },
      resolved: null,
    };

    const flush = await db.transaction(async (tx) => {
      const match = await matchWelfareSymptoms(pet.id, "tiene espuma en la boca y muerde todo", tx);
      expect(match.alertedDiseaseCodes).toContain("rabies_suspected");
      return emitWelfareSymptomSignals(
        {
          petId: pet.id,
          symptomEventId: "00000000-0000-4000-8000-000000000001",
          match,
          place,
          now: new Date(),
        },
        tx,
      );
    });
    expect(typeof flush).toBe("function");

    const signals = await db
      .select({ id: petEvents.id, payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "outbreak_signal")));
    expect(signals.length).toBeGreaterThan(0);
    const payload = signals[0].payload as Record<string, unknown>;
    expect(payload.triggered_by).toBe("matcher");
    expect(payload.place).toEqual(place);

    const outbox = await db
      .select({ id: eventNotificationOutbox.id })
      .from(eventNotificationOutbox)
      .where(eq(eventNotificationOutbox.sourceEventId, signals[0].id));
    expect(outbox).toHaveLength(0);
  });

  it("text that matches nothing emits nothing", async () => {
    const pet = await insertPet();
    await db.transaction(async (tx) => {
      const match = await matchWelfareSymptoms(pet.id, "está muy flaco y sucio", tx);
      expect(match.alertedDiseaseCodes).toEqual([]);
      await emitWelfareSymptomSignals(
        {
          petId: pet.id,
          symptomEventId: "00000000-0000-4000-8000-000000000002",
          match,
          place: null,
          now: new Date(),
        },
        tx,
      );
    });
    const signals = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "outbreak_signal")));
    expect(signals).toHaveLength(0);
  });
});
