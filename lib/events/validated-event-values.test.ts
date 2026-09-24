// Validated insert boundary — event-sourcing integrity review 2026-07-04
// item 2.
//
// Proves, WITHOUT a database, that the repository insert methods reject an
// invalid payload BEFORE any row is written: the fake executor throws if its
// insert() is ever reached, so a passing rejection test guarantees the
// validation fired first. Also proves the parsed payload (payload_version
// filled) is what gets stored, per the upcaster contract.

import { describe, expect, it, vi } from "vitest";

import { insertEventIdempotent } from "@/lib/events/event-idempotency";
import { EventPayloadValidationError } from "@/lib/events/event-schemas";
import { validatedEventValues } from "@/lib/events/validated-event-values";
import { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";
import { SurveillanceRepository } from "@/src/modules/surveillance/infrastructure/surveillance-repository";
import { WelfareRepository } from "@/src/modules/welfare/infrastructure/welfare-repository";

const PET_ID = "00000000-0000-4000-8000-000000000001";

const baseValues = {
  petId: PET_ID,
  occurredAt: new Date(),
  recordedAt: new Date(),
  recordedByUserId: null,
  authorRole: "owner" as const,
};

// Executor whose insert() records the values it receives; never touches a DB.
function fakeExecutor() {
  const captured: unknown[] = [];
  const executor = {
    insert: vi.fn(() => ({
      values: (v: unknown) => {
        captured.push(v);
        return {
          returning: async () => [{ ...(v as Record<string, unknown>), id: "fake-id" }],
        };
      },
    })),
  };
  return { executor, captured };
}

// ---------------------------------------------------------------------------
// validatedEventValues (unit)
// ---------------------------------------------------------------------------

describe("validatedEventValues", () => {
  it("throws EventPayloadValidationError for a payload violating its schema", () => {
    expect(() =>
      validatedEventValues({
        ...baseValues,
        eventType: "weight_recorded",
        // kg must be a string per the schema — a numeric payload is exactly
        // the kind of raw write the boundary must refuse.
        payload: { kg: 12.5 },
      }),
    ).toThrow(EventPayloadValidationError);
  });

  it("returns the PARSED payload with payload_version: 1 filled in", () => {
    const out = validatedEventValues({
      ...baseValues,
      eventType: "note_added",
      payload: { category: "system", text: "hola" },
    });
    expect((out.payload as Record<string, unknown>).payload_version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// EventsRepository boundary
// ---------------------------------------------------------------------------

describe("EventsRepository insert boundary validation", () => {
  const repo = new EventsRepository();

  it("insertEvent rejects an invalid payload before touching the executor", async () => {
    const { executor } = fakeExecutor();
    await expect(
      repo.insertEvent(
        {
          ...baseValues,
          eventType: "vaccination_administered",
          // vaccine_name is required — missing it must be rejected.
          payload: { brand: "X" },
        },
        executor as never,
      ),
    ).rejects.toBeInstanceOf(EventPayloadValidationError);
    expect(executor.insert).not.toHaveBeenCalled();
  });

  it("insertEvent stores the parsed payload (payload_version filled)", async () => {
    const { executor, captured } = fakeExecutor();
    await repo.insertEvent(
      {
        ...baseValues,
        eventType: "note_added",
        payload: { category: "system", text: "corrected boundary" },
      },
      executor as never,
    );
    expect(captured).toHaveLength(1);
    const stored = captured[0] as { payload: Record<string, unknown> };
    expect(stored.payload.payload_version).toBe(1);
    expect(stored.payload.text).toBe("corrected boundary");
  });

  it("insertEventIdempotent rejects an invalid payload before touching the executor", async () => {
    const { executor } = fakeExecutor();
    await expect(
      repo.insertEventIdempotent(
        {
          ...baseValues,
          eventType: "weight_recorded",
          payload: { kg: 12.5 },
        },
        executor as never,
      ),
    ).rejects.toBeInstanceOf(EventPayloadValidationError);
    expect(executor.insert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WelfareRepository boundary
// ---------------------------------------------------------------------------

describe("WelfareRepository insert boundary validation", () => {
  const repo = new WelfareRepository();

  it("insertPetEvent rejects an invalid payload before touching the executor", async () => {
    const { executor } = fakeExecutor();
    await expect(
      repo.insertPetEvent(
        {
          ...baseValues,
          eventType: "note_added",
          // text is required for note_added — reject.
          payload: { category: "system" },
        },
        executor as never,
      ),
    ).rejects.toBeInstanceOf(EventPayloadValidationError);
    expect(executor.insert).not.toHaveBeenCalled();
  });

  it("insertPetEventIdempotent rejects an invalid payload before touching the executor", async () => {
    const { executor } = fakeExecutor();
    await expect(
      repo.insertPetEventIdempotent(
        {
          ...baseValues,
          eventType: "symptom_observed",
          payload: { severity: 99 },
        },
        executor as never,
      ),
    ).rejects.toBeInstanceOf(EventPayloadValidationError);
    expect(executor.insert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The shared helper itself (finding A08-7)
// ---------------------------------------------------------------------------
//
// The two repository wrappers above used to be the ONLY validation; every
// other caller of lib/events/event-idempotency.ts (adoption, the caretaker
// alert, the v1 API writers, surveillance) inserted whatever it was handed.
// These cases call the helper directly, with no wrapper in between.

describe("insertEventIdempotent (shared helper) validates before writing", () => {
  it("rejects an invalid payload on the keyless path before touching the executor", async () => {
    const { executor } = fakeExecutor();
    await expect(
      insertEventIdempotent(
        { ...baseValues, eventType: "weight_recorded", payload: { kg: 12.5 } },
        executor as never,
      ),
    ).rejects.toBeInstanceOf(EventPayloadValidationError);
    expect(executor.insert).not.toHaveBeenCalled();
  });

  it("rejects an invalid payload on the keyed path before the lock and the insert", async () => {
    const { executor } = fakeExecutor();
    const execute = vi.fn();
    await expect(
      insertEventIdempotent(
        {
          ...baseValues,
          eventType: "weight_recorded",
          payload: { kg: 12.5 },
          clientIdempotencyKey: "11111111-1111-4111-8111-111111111111",
        },
        { ...executor, execute } as never,
      ),
    ).rejects.toBeInstanceOf(EventPayloadValidationError);
    expect(execute).not.toHaveBeenCalled();
    expect(executor.insert).not.toHaveBeenCalled();
  });

  it("stores the PARSED payload (payload_version filled)", async () => {
    const { executor, captured } = fakeExecutor();
    await insertEventIdempotent(
      {
        ...baseValues,
        eventType: "note_added",
        payload: { category: "system", text: "via the helper" },
      },
      executor as never,
    );
    const stored = captured[0] as { payload: Record<string, unknown> };
    expect(stored.payload.payload_version).toBe(1);
  });
});

describe("SurveillanceRepository — the three formerly raw inserts", () => {
  const repo = new SurveillanceRepository();
  const invalid = { ...baseValues, payload: { unexpected_shape: 42 } };

  it.each([
    ["insertIncidentEvent", "incident_reported"],
    ["insertObservationStarted", "rabies_observation_started"],
    ["insertObservationEnded", "rabies_observation_ended"],
  ] as const)(
    "%s rejects an invalid %s payload before touching the executor",
    async (method, eventType) => {
      const { executor } = fakeExecutor();
      await expect(
        repo[method]({ ...invalid, eventType }, executor as never),
      ).rejects.toBeInstanceOf(EventPayloadValidationError);
      expect(executor.insert).not.toHaveBeenCalled();
    },
  );
});
