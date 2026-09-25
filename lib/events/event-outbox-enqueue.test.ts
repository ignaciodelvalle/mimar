// Unit tests for lib/event-outbox-enqueue.ts
//
// Strict TDD mode: tests written before implementation.
// Uses a minimal mock of the Drizzle transaction interface — no real DB needed.

import { describe, expect, it, vi } from "vitest";

import { enqueueOutboxForEvent } from "./event-outbox-enqueue";

// ---------------------------------------------------------------------------
// Mock tx factory
// ---------------------------------------------------------------------------

type InsertedRow = Record<string, unknown>;

function makeMockTx() {
  const inserted: InsertedRow[] = [];
  // Rows written through ON CONFLICT (a keyed case) — the SQL itself is
  // exercised against the real database in
  // src/modules/surveillance/application/professional-close-observation.eno.test.ts.
  const upserted: InsertedRow[] = [];

  // A case-keyed row reads its bite case to route (eno-target-jurisdiction.ts).
  // No case here: every read answers nothing, so the row falls back to PET.
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy"]) chain[m] = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve([]));

  const tx = {
    select: vi.fn(() => chain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((row: InsertedRow) => {
        inserted.push(row);
        const done = Promise.resolve();
        return Object.assign(done, {
          onConflictDoUpdate: vi.fn().mockImplementation(() => {
            upserted.push(row);
            return Promise.resolve();
          }),
        });
      }),
    }),
  };

  return { tx, inserted, upserted };
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-22T12:00:00.000Z");

function makeDiseaseDiagnosisEvent(diseaseCode: string) {
  return {
    id: "evt-ddx-1",
    petId: "pet-1",
    eventType: "clinical_info_logged" as const,
    payload: {
      sub_kind: "disease_diagnosis",
      disease_code: diseaseCode,
      title: `Diagnóstico: ${diseaseCode}`,
    },
  };
}

function makeOutbreakSignalEvent(diseaseCode: string) {
  return {
    id: "evt-signal-1",
    petId: "pet-1",
    eventType: "outbreak_signal" as const,
    payload: {
      disease_code: diseaseCode,
      disease_label: diseaseCode,
      match_strength: { high_count: 1, medium_count: 0, low_count: 0, matched_symptom_codes: [] },
      pet_jurisdiction_country: "AR",
      pet_jurisdiction_province: "AR-B",
      pet_jurisdiction_locality: "La Plata",
      pet_species: "dog",
    },
  };
}

const PET = {
  jurisdictionProvince: "AR-B",
  jurisdictionLocality: "La Plata",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enqueueOutboxForEvent", () => {
  it("rabies_confirmed disease_diagnosis → inserts one outbox row with correct sla_due_at (24h)", async () => {
    const { tx, inserted } = makeMockTx();
    const event = makeDiseaseDiagnosisEvent("rabies_confirmed");

    await enqueueOutboxForEvent(tx as never, event, PET, NOW);

    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.sourceEventId).toBe("evt-ddx-1");
    expect(row.targetKind).toBe("govt_webhook");
    expect(row.targetJurisdictionProvince).toBe("AR-B");
    expect(row.targetJurisdictionLocality).toBe("La Plata");
    // SLA = now + 24h
    const expectedSla = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(row.slaDueAt).toEqual(expectedSla);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
  });

  it("leptospirosis disease_diagnosis → 48h SLA", async () => {
    const { tx, inserted } = makeMockTx();
    const event = makeDiseaseDiagnosisEvent("leptospirosis");

    await enqueueOutboxForEvent(tx as never, event, PET, NOW);

    expect(inserted).toHaveLength(1);
    const expectedSla = new Date(NOW.getTime() + 48 * 60 * 60 * 1000);
    expect(inserted[0].slaDueAt).toEqual(expectedSla);
  });

  it("outbreak_signal for ENO disease (rabies_suspected) → inserts one row with 24h SLA", async () => {
    const { tx, inserted } = makeMockTx();
    const event = makeOutbreakSignalEvent("rabies_suspected");

    await enqueueOutboxForEvent(tx as never, event, PET, NOW);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].targetKind).toBe("govt_webhook");
    const expectedSla = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(inserted[0].slaDueAt).toEqual(expectedSla);
  });

  it("unknown disease → no outbox rows inserted (silent no-op)", async () => {
    const { tx, inserted } = makeMockTx();
    const event = makeDiseaseDiagnosisEvent("unknown_xyz");

    await enqueueOutboxForEvent(tx as never, event, PET, NOW);

    expect(inserted).toHaveLength(0);
  });

  it("event type with no rules → no outbox rows (silent no-op)", async () => {
    const { tx, inserted } = makeMockTx();
    const event = {
      id: "evt-vax-1",
      petId: "pet-1",
      eventType: "vaccination_administered" as const,
      payload: { vaccine_name: "Rabia", lot_number: "L001" },
    };

    await enqueueOutboxForEvent(tx as never, event, PET, NOW);

    expect(inserted).toHaveLength(0);
  });

  it("payload snapshot contains the full event payload", async () => {
    const { tx, inserted } = makeMockTx();
    const event = makeDiseaseDiagnosisEvent("rabies_confirmed");

    await enqueueOutboxForEvent(tx as never, event, PET, NOW);

    expect(inserted[0].payloadSnapshot).toEqual(event.payload);
  });

  // FIX-25 #3 (PO 2026-09-25): one ENO record per case.
  it("a rabies diagnosis names the per-animal case and goes through ON CONFLICT", async () => {
    const { tx, inserted, upserted } = makeMockTx();
    await enqueueOutboxForEvent(
      tx as never,
      makeDiseaseDiagnosisEvent("rabies_confirmed"),
      PET,
      NOW,
    );
    expect(inserted[0].enoCaseKey).toBe("rabies:pet:pet-1:AR-B|La Plata");
    expect(upserted).toHaveLength(1);
  });

  it("leptospirosis stays unkeyed (a second episode is a second case) — plain insert", async () => {
    const { tx, inserted, upserted } = makeMockTx();
    await enqueueOutboxForEvent(tx as never, makeDiseaseDiagnosisEvent("leptospirosis"), PET, NOW);
    expect(inserted[0].enoCaseKey).toBeNull();
    expect(upserted).toHaveLength(0);
  });

  it("a symptom-cluster rabies signal is not the case; the diagnosis-derived one is", async () => {
    const symptom = makeOutbreakSignalEvent("rabies_suspected");
    const a = makeMockTx();
    await enqueueOutboxForEvent(a.tx as never, symptom, PET, NOW);
    expect(a.inserted[0].enoCaseKey).toBeNull();

    const b = makeMockTx();
    await enqueueOutboxForEvent(
      b.tx as never,
      { ...symptom, payload: { ...symptom.payload, triggered_by: "direct_diagnosis" } },
      PET,
      NOW,
    );
    expect(b.inserted[0].enoCaseKey).toBe("rabies:pet:pet-1:AR-B|La Plata");
  });
});
