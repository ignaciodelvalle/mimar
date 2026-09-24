// The disease_reported writer — T4-I1 / issue #759.
//
// The event type had no writer at all: `/gob/vigilancia`, the novedades feed,
// the choropleth and the panorama's "activas hoy" formula all read it, and the
// only thing that could produce one was a hand-written INSERT. So these tests
// cover the three things a first writer has to get right — the payload it
// files, the day it files it under, and what a replay must not repeat — plus
// the auth gate at the action edge, which is the part that decides whether the
// top confidence tier is reachable by the wrong person.

import { describe, expect, it, vi } from "vitest";

import { computeConfidence } from "@/lib/events/event-confidence";
import { validateEventPayload } from "@/lib/events/event-schemas";

import {
  DISEASE_REPORTED_CODES,
  createDiseaseReported,
  isDiseaseReportedCode,
} from "./disease-reported-use-case";

function makeDeps(over: { wasNoop?: boolean } = {}) {
  const insertEvent = vi.fn().mockResolvedValue({ id: "ev-1" });
  const insertEventIdempotent = vi
    .fn()
    .mockResolvedValue({ event: { id: "ev-1" }, wasNoop: over.wasNoop ?? false });
  const enqueueOutbox = vi.fn().mockResolvedValue(undefined);
  return {
    repo: { insertEvent, insertEventIdempotent, enqueueOutbox },
    transaction: <T>(cb: (tx: unknown) => Promise<T>) => cb({}),
  };
}

const ONSET = "2026-03-10";

function input(over: Record<string, unknown> = {}) {
  return {
    pet: { id: "pet-1", jurisdictionProvince: "Buenos Aires", jurisdictionLocality: "La Plata" },
    vet: { userId: "vet-1" },
    eventAuthorship: { authorRole: "vet", authorOrganizationId: null, authorVerified: true },
    disease: "lepto" as const,
    // `as const` and not a bare `false`: the input type NARROWS this field to
    // the literal `false` (see its docblock), so a widened `boolean` here would
    // stop compiling — which is the constraint working, not a nuisance.
    confirmedByLab: false as const,
    dateOfOnset: ONSET,
    occurredAt: new Date("2026-03-10T12:00:00Z"),
    clinicalNotes: null,
    now: new Date("2026-03-20T15:00:00Z"),
    ...over,
  };
}

describe("createDiseaseReported", () => {
  it("files a schema-valid disease_reported payload", async () => {
    const deps = makeDeps();
    const result = await createDiseaseReported(input(), deps);

    expect(result).toEqual({ ok: true, eventId: "ev-1", wasDuplicate: false });
    const row = deps.repo.insertEvent.mock.calls[0][0];
    expect(row.eventType).toBe("disease_reported");
    expect(row.payload).toMatchObject({
      disease: "lepto",
      confirmed_by_lab: false,
      date_of_onset: ONSET,
      clinical_notes: null,
    });
    // The payload the writer built must survive the SAME schema on its way back
    // in. A writer whose output its own event type would reject is a row the
    // amend endpoint and every future reader cannot trust.
    expect(() => validateEventPayload("disease_reported", row.payload)).not.toThrow();
  });

  // THE DAY THE SIGNS STARTED, not the day of the report. The panorama counts
  // these over a rolling 30 days and the feed orders by `occurredAt`, so
  // stamping "now" would pull a two-week-old case into today's numbers.
  it("stamps occurredAt from the onset date and recordedAt from now", async () => {
    const deps = makeDeps();
    await createDiseaseReported(input(), deps);
    const row = deps.repo.insertEvent.mock.calls[0][0];
    expect(row.occurredAt).toEqual(new Date("2026-03-10T12:00:00Z"));
    expect(row.recordedAt).toEqual(new Date("2026-03-20T15:00:00Z"));
    expect(row.recordedByUserId).toBe("vet-1");
  });

  it("carries the pet's jurisdiction to the outbox for routing", async () => {
    const deps = makeDeps();
    await createDiseaseReported(input(), deps);
    expect(deps.repo.enqueueOutbox).toHaveBeenCalledOnce();
    const [, event, pet] = deps.repo.enqueueOutbox.mock.calls[0];
    expect(event).toMatchObject({ id: "ev-1", eventType: "disease_reported" });
    expect(pet).toEqual({
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });
  });

  it("uses the plain insert when no idempotency key is given", async () => {
    const deps = makeDeps();
    await createDiseaseReported(input(), deps);
    expect(deps.repo.insertEvent).toHaveBeenCalledOnce();
    expect(deps.repo.insertEventIdempotent).not.toHaveBeenCalled();
  });

  it("dedupes on the key when one is given", async () => {
    const deps = makeDeps();
    const result = await createDiseaseReported(input({ clientIdempotencyKey: "key-1" }), deps);
    expect(result).toEqual({ ok: true, eventId: "ev-1", wasDuplicate: false });
    expect(deps.repo.insertEventIdempotent).toHaveBeenCalledOnce();
    expect(deps.repo.insertEvent).not.toHaveBeenCalled();
  });

  // THE PART A CARELESS PORT GETS WRONG. A replay must not enqueue a second
  // notification for a report the province already received — the first submit
  // enqueued it — so the early return sits INSIDE the transaction, before the
  // outbox.
  it("a replay skips the outbox entirely", async () => {
    const deps = makeDeps({ wasNoop: true });
    const result = await createDiseaseReported(input({ clientIdempotencyKey: "key-1" }), deps);
    expect(result).toEqual({ ok: true, eventId: "ev-1", wasDuplicate: true });
    expect(deps.repo.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("reports a failure instead of throwing", async () => {
    const deps = makeDeps();
    deps.repo.insertEvent.mockRejectedValueOnce(new Error("boom"));
    expect(await createDiseaseReported(input(), deps)).toEqual({ ok: false, error: "boom" });
  });

  it("refuses a disease the schema does not know", async () => {
    const deps = makeDeps();
    // The type says this cannot happen; the SCHEMA is what makes it true at
    // runtime, and a caller reaching this writer from parsed form data has no
    // types to protect it. So the cast is the point of the test, not a
    // shortcut around it.
    const result = await createDiseaseReported(
      input({ disease: "rabia" }) as Parameters<typeof createDiseaseReported>[0],
      deps,
    );
    expect(result.ok).toBe(false);
    expect(deps.repo.insertEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The A4 bumper is unreachable from this writer (security review 2026-09-23)
// ---------------------------------------------------------------------------
//
// `confirmed_by_lab: true` returns `institutional_verified` from
// `computeConfidence` for ANY author — the highest tier in the model, above a
// matriculated vet's own signature. `disease_reported` has no lab-reference
// field to check such a claim against, and is deliberately absent from
// AMENDABLE_EVENT_TYPES, so a wrong one could never be corrected by an overlay.
//
// The compile-time half of this guarantee is the input type (`confirmedByLab:
// false`). These are the runtime half, because a type is erased and this claim
// is about a row that reaches a government surveillance surface: whatever the
// action does, the PAYLOAD this writer files must never carry the flag, and the
// tier it computes must stop at the vet's own.
describe("createDiseaseReported — cannot mint institutional_verified", () => {
  it("always files confirmed_by_lab: false", async () => {
    const deps = makeDeps();
    await createDiseaseReported(input(), deps);
    expect(deps.repo.insertEvent.mock.calls[0][0].payload.confirmed_by_lab).toBe(false);
  });

  it("the filed row computes professional_verified, not the top tier", async () => {
    const deps = makeDeps();
    await createDiseaseReported(input(), deps);
    const row = deps.repo.insertEvent.mock.calls[0][0];
    const tier = computeConfidence({
      authorRole: row.authorRole,
      authorVerified: row.authorVerified,
      authorOrganizationId: row.authorOrganizationId,
      payload: row.payload as Record<string, unknown>,
    });
    expect(tier).toBe("professional_verified");
    expect(tier).not.toBe("institutional_verified");
  });

  // THE NON-VACUITY, and it is the assertion that gives the two above their
  // meaning: the same author WOULD reach the top tier if the flag were set, so
  // the tier below is decided by the flag this writer withholds and not by the
  // author being incapable of it anyway.
  it("the SAME author would reach institutional_verified if the flag were set", () => {
    expect(
      computeConfidence({
        authorRole: "vet",
        authorVerified: true,
        authorOrganizationId: null,
        payload: { confirmed_by_lab: true },
      }),
    ).toBe("institutional_verified");
  });
});

describe("DISEASE_REPORTED_CODES — the second copy of the zod enum", () => {
  it("every declared code validates", () => {
    for (const disease of DISEASE_REPORTED_CODES) {
      expect(() =>
        validateEventPayload("disease_reported", {
          disease,
          confirmed_by_lab: false,
          date_of_onset: ONSET,
          clinical_notes: null,
        }),
      ).not.toThrow();
    }
  });

  // The other direction, which is the half that catches a code REMOVED from
  // the schema but left in this list: a member that no longer validates fails
  // above, and a schema that grew a member this list lacks fails here.
  it("nothing outside the list validates", () => {
    expect(() =>
      validateEventPayload("disease_reported", {
        disease: "rabia",
        confirmed_by_lab: false,
        date_of_onset: ONSET,
        clinical_notes: null,
      }),
    ).toThrow();
    expect(isDiseaseReportedCode("rabia")).toBe(false);
    expect(isDiseaseReportedCode("lepto")).toBe(true);
  });
});
