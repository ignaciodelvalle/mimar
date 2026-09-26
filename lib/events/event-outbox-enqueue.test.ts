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

function makeMockTx(caseRows: Record<string, unknown>[] = []) {
  const inserted: InsertedRow[] = [];
  // Rows written through ON CONFLICT (a keyed case) — the SQL itself is
  // exercised against the real database in
  // src/modules/surveillance/application/professional-close-observation.eno.test.ts.
  const upserted: InsertedRow[] = [];

  // A case-keyed row reads its bite case to route (eno-target-jurisdiction.ts).
  // No case here: every read answers nothing, so the row falls back to PET.
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy"]) chain[m] = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(caseRows));

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

// A diagnosis-derived signal by default: since PO S1 (2026-09-26) a matcher
// signal mints no ENO row at all.
function makeOutbreakSignalEvent(
  diseaseCode: string,
  triggeredBy: "direct_diagnosis" | "matcher" = "direct_diagnosis",
) {
  return {
    id: "evt-signal-1",
    petId: "pet-1",
    eventType: "outbreak_signal" as const,
    payload: {
      triggered_by: triggeredBy,
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

  it("a diagnosis-derived outbreak_signal (rabies_suspected) → inserts one row with 24h SLA", async () => {
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

  // -------------------------------------------------------------------------
  // PO S5 (2026-09-26): the legal clock starts when the fact OCCURRED — the
  // diagnosis date, the event's own date — not when somebody typed it in. A
  // late entry is visibly overdue the moment it lands; a future date never
  // pushes the clock past now.
  // -------------------------------------------------------------------------
  describe("the legal clock starts at the occurrence (S5)", () => {
    const HOUR = 60 * 60 * 1000;

    it("a diagnosis entered five days late is already overdue: diagnosis_date + 48h", async () => {
      const { tx, inserted } = makeMockTx();
      const diagnosed = new Date(NOW.getTime() - 5 * 24 * HOUR);
      const event = makeDiseaseDiagnosisEvent("leptospirosis");
      await enqueueOutboxForEvent(
        tx as never,
        { ...event, payload: { ...event.payload, diagnosis_date: diagnosed.toISOString() } },
        PET,
        NOW,
      );
      const due = inserted[0].slaDueAt as Date;
      expect(due).toEqual(new Date(diagnosed.getTime() + 48 * HOUR));
      expect(due.getTime()).toBeLessThan(NOW.getTime());
    });

    it("with no date in the payload, the event's own occurredAt starts the clock", async () => {
      const { tx, inserted } = makeMockTx();
      const occurred = new Date(NOW.getTime() - 3 * HOUR);
      await enqueueOutboxForEvent(
        tx as never,
        { ...makeOutbreakSignalEvent("rabies_suspected"), occurredAt: occurred },
        PET,
        NOW,
      );
      expect(inserted[0].slaDueAt).toEqual(new Date(occurred.getTime() + 24 * HOUR));
    });

    it("a date in the future never moves the clock past now", async () => {
      const { tx, inserted } = makeMockTx();
      const event = makeDiseaseDiagnosisEvent("rabies_confirmed");
      await enqueueOutboxForEvent(
        tx as never,
        {
          ...event,
          occurredAt: new Date(NOW.getTime() + 72 * HOUR),
          payload: {
            ...event.payload,
            diagnosis_date: new Date(NOW.getTime() + 72 * HOUR).toISOString(),
          },
        },
        PET,
        NOW,
      );
      expect(inserted[0].slaDueAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
    });

    it("an unparseable diagnosis_date falls back to occurredAt, then now", async () => {
      const { tx, inserted } = makeMockTx();
      const event = makeDiseaseDiagnosisEvent("rabies_confirmed");
      await enqueueOutboxForEvent(
        tx as never,
        { ...event, payload: { ...event.payload, diagnosis_date: "not a date" } },
        PET,
        NOW,
      );
      expect(inserted[0].slaDueAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
    });
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

  it("a symptom (matcher) signal inserts nothing (S1); the diagnosis-derived one is the case", async () => {
    const a = makeMockTx();
    await enqueueOutboxForEvent(
      a.tx as never,
      makeOutbreakSignalEvent("rabies_suspected", "matcher"),
      PET,
      NOW,
    );
    expect(a.inserted).toHaveLength(0);

    const b = makeMockTx();
    await enqueueOutboxForEvent(
      b.tx as never,
      makeOutbreakSignalEvent("rabies_suspected"),
      PET,
      NOW,
    );
    expect(b.inserted[0].enoCaseKey).toBe("rabies:pet:pet-1:AR-B|La Plata");
  });

  // -------------------------------------------------------------------------
  // The target place BY ID (localidades-por-id D3 prerequisite). Snapshotted
  // at enqueue time from the same source as the target names — the event's
  // own place, else the bite case it routes to, else the caller's snapshot —
  // and never re-read from the pet. A place that named no single row is
  // NULL + 'unresolved'; a caller that snapshots no id records nothing.
  // -------------------------------------------------------------------------
  describe("target place by id", () => {
    const ALBERTI = "11111111-1111-4111-8111-111111111111";
    const BRAGADO = "22222222-2222-4222-8222-222222222222";
    const placed = (resolved: Record<string, unknown> | null) => ({
      ...makeOutbreakSignalEvent("rabies_suspected"),
      payload: {
        ...makeOutbreakSignalEvent("rabies_suspected").payload,
        place: {
          entered: { province: "Buenos Aires", locality: "Mechita", indec_id: null },
          resolved,
        },
      },
    });

    it("an event carrying a resolved place targets that catalogue row", async () => {
      const { tx, inserted } = makeMockTx();
      const event = placed({ locality_id: ALBERTI, province_code: "AR-B", method: "catalogue_id" });
      await enqueueOutboxForEvent(tx as never, event, { ...PET, localityId: BRAGADO }, NOW);
      expect(inserted[0].targetLocalityId).toBe(ALBERTI);
      expect(inserted[0].targetPlaceMethod).toBe("catalogue_id");
    });

    it("an event whose place never resolved stays NULL + 'unresolved'", async () => {
      const { tx, inserted } = makeMockTx();
      await enqueueOutboxForEvent(tx as never, placed(null), { ...PET, localityId: BRAGADO }, NOW);
      expect(inserted[0].targetLocalityId).toBeNull();
      expect(inserted[0].targetPlaceMethod).toBe("unresolved");
    });

    it("an event without a place takes the caller's snapshot row", async () => {
      const { tx, inserted } = makeMockTx();
      await enqueueOutboxForEvent(
        tx as never,
        makeDiseaseDiagnosisEvent("leptospirosis"),
        { ...PET, localityId: BRAGADO, placeMethod: "legacy_unique_name" },
        NOW,
      );
      expect(inserted[0].targetLocalityId).toBe(BRAGADO);
      expect(inserted[0].targetPlaceMethod).toBe("legacy_unique_name");
    });

    it("a snapshot with no row is NULL + 'unresolved'; no snapshot at all records nothing", async () => {
      const a = makeMockTx();
      await enqueueOutboxForEvent(
        a.tx as never,
        makeDiseaseDiagnosisEvent("leptospirosis"),
        { ...PET, localityId: null, placeMethod: "unresolved" },
        NOW,
      );
      expect(a.inserted[0].targetLocalityId).toBeNull();
      expect(a.inserted[0].targetPlaceMethod).toBe("unresolved");

      const b = makeMockTx();
      await enqueueOutboxForEvent(
        b.tx as never,
        makeDiseaseDiagnosisEvent("leptospirosis"),
        PET,
        NOW,
      );
      expect(b.inserted[0].targetLocalityId).toBeNull();
      expect(b.inserted[0].targetPlaceMethod).toBeNull();
    });

    it("a row routed to a bite case takes the CASE's row, not a same-named home", async () => {
      // The homonym: the bite happened in Alberti's Mechita, the pet lives in
      // Bragado's. Same names, two rows — the notification follows the case.
      const { tx, inserted } = makeMockTx([
        {
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Mechita",
          localityId: ALBERTI,
          placeMethod: "indec_id",
        },
      ]);
      await enqueueOutboxForEvent(
        tx as never,
        makeDiseaseDiagnosisEvent("rabies_confirmed"),
        {
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Mechita",
          localityId: BRAGADO,
          placeMethod: "indec_id",
        },
        NOW,
      );
      expect(inserted[0].targetLocalityId).toBe(ALBERTI);
      expect(inserted[0].targetPlaceMethod).toBe("indec_id");
      // The case key stays name-keyed, exactly as before (legacy parity).
      expect(inserted[0].enoCaseKey).toBe("rabies:pet:pet-1:Buenos Aires|Mechita");
    });
  });
});
