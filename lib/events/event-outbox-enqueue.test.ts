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

  const tx = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((row: InsertedRow) => {
        inserted.push(row);
        return Promise.resolve();
      }),
    }),
  };

  return { tx, inserted };
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-22T12:00:00.000Z");

function makeDiseaseDiagnosisEvent(diseaseCode: string) {
  return {
    id: "evt-ddx-1",
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
});
