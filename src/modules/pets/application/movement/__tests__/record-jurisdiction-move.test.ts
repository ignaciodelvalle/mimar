// `recordJurisdictionMove` — the edge of MUDANZA.
//
// WHAT THIS FILE HAS TO PROVE, and why each one needs a test rather than a
// reading of the code:
//
//   1. STRICT IS ASKED FOR. `normalizeLocationForWrite` takes a MODE, and the
//      difference between `strict` and `soft` is invisible in every assertion
//      about a happy path — both hand back a pair. So the mode itself is
//      captured and asserted, the way `buscar-view-model.test.ts` captures the
//      `timeZone` a formatter was ASKED for rather than comparing a rendered
//      string that happens to agree. What the code REQUESTED is the half a
//      silent loosening breaks.
//   2. THE CANONICAL PAIR IS WHAT TRAVELS. The writer must receive what the
//      catalog returned, never what the client posted — otherwise an
//      uncanonicalized spelling lands in the columns every `resolveBusinessRule`
//      call site reads.
//   3. AN UNRESOLVABLE DESTINATION WRITES NOTHING. Both ways it can fail: the
//      catalog throwing, and the strict branch being SKIPPED because the
//      province did not canonicalize — the fall-through that hands back a pair
//      with no error at all.
//   4. THE NO-OP IS COMPUTED AND IT COSTS NO TRANSACTION. The web reads the
//      writer's Zod message with `.includes("no-op")`; this compares the three
//      fields the `superRefine` compares, against the CANONICAL destination.
//   5. NO GUARD LIVES HERE. There is no authorization in this file and there
//      must not be — the door decides. That is asserted by its absence being
//      load-bearing: the function is called with a pet it never re-reads.
//
// THE WRITER IS MOCKED AND THE CATALOG IS MOCKED, so this file needs no
// database. What it can therefore NOT see is stated rather than implied: that
// the event and the denormalization are one transaction is
// `__tests__/movement-writer.test.ts`'s subject, not this one's.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  /** Every `normalizeLocationForWrite` call, with the MODE it was asked for. */
  normalizeCalls: [] as Array<{ loc: Record<string, unknown>; opts: unknown }>,
  /** What the catalog answers, or a function that throws. */
  normalized: null as null | (() => unknown),
  /** Every `recordMovementWriter` call. Empty means nothing was written. */
  writes: [] as Array<Record<string, unknown>>,
  /** What the writer answers. */
  writeResult: { ok: true, eventId: "evt-1" } as Record<string, unknown>,
}));

vi.mock("@/lib/domain/location-normalize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain/location-normalize")>();
  return {
    ...actual,
    normalizeLocationForWrite: async (loc: Record<string, unknown>, opts: unknown) => {
      control.normalizeCalls.push({ loc, opts });
      if (control.normalized) return control.normalized();
      return {
        province: "Río Negro",
        locality: "San Carlos de Bariloche",
        localityCanonical: true,
        localityId: "loc-1",
        lat: null,
        lng: null,
        address: null,
      };
    },
  };
});

vi.mock("@/src/modules/pets/application/movement/record-movement", () => ({
  recordMovementWriter: async (params: Record<string, unknown>) => {
    control.writes.push(params);
    return control.writeResult;
  },
}));

import { JurisdictionValidationError } from "@/lib/domain/location-normalize";
import { OWNER_AUTHORSHIP } from "@/lib/infra/pet-access";
import { recordJurisdictionMove } from "@/src/modules/pets/application/movement/record-jurisdiction-move";

const PET_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
/**
 * THE INJECTED CLOCK IS DELIBERATELY NOT TODAY, and the first version of this
 * file got that wrong in a way worth writing down.
 *
 * It read `2026-08-30`, the day the file was written. The mutation the
 * `effective_date` case exists to catch — replacing `now` with a second
 * `new Date()` — was applied and the suite stayed **14/14 GREEN**, because the
 * host clock produced the same string. That is the `turnos-view-model.test.ts`
 * false-green one domain over: three cases pinning a timezone on a machine that
 * already resolves to it, passing over exactly the mutation they exist to catch.
 *
 * A date in the past cannot coincide with the host clock on any run.
 */
const NOW = new Date("2019-07-04T15:04:05.000Z");

function pet(over: Record<string, unknown> = {}) {
  return {
    id: PET_ID,
    publicToken: "DIM-PAMP-0001",
    jurisdictionCountry: "AR",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    ...over,
  } as Parameters<typeof recordJurisdictionMove>[0]["pet"];
}

function run(over: Partial<Parameters<typeof recordJurisdictionMove>[0]> = {}) {
  return recordJurisdictionMove({
    pet: pet(),
    recordedByUserId: USER_ID,
    eventAuthorship: OWNER_AUTHORSHIP,
    destination: { provinceCode: "AR-R", localityName: "bariloche" },
    reason: "Nos mudamos por trabajo",
    now: NOW,
    ...over,
  });
}

beforeEach(() => {
  control.normalizeCalls = [];
  control.normalized = null;
  control.writes = [];
  control.writeResult = { ok: true, eventId: "evt-1" };
});

describe("recordJurisdictionMove — the destination is resolved STRICTLY", () => {
  it("asks the catalog for `strict` locality resolution, not `soft`", async () => {
    // MUTATION APPLIED: `{ locality: "soft" }`. Red here and NOWHERE ELSE in
    // this file — every other case still passes, because a soft resolution
    // returns the same pair for a destination the catalog knows. That is the
    // whole reason the MODE is asserted and not just the result: the difference
    // only shows for a pair the catalog does NOT know, which is the case a
    // happy-path test never reaches.
    await run();
    expect(control.normalizeCalls).toHaveLength(1);
    expect(control.normalizeCalls[0].opts).toEqual({ locality: "strict" });
  });

  it("hands the catalog the province in BOTH fields the normalizer reads", async () => {
    // `canonicalProvinceNameForStorage(loc.provinceCode ?? loc.province ?? "")`
    // — it prefers `provinceCode`. Passing only `province` would still work
    // today and would break silently the day that precedence changes, so the
    // call site fills both from the one value a picker returns.
    // MUTATION APPLIED: drop `provinceCode` from the object. Red.
    await run();
    const { loc } = control.normalizeCalls[0];
    expect(loc.province).toBe("AR-R");
    expect(loc.provinceCode).toBe("AR-R");
    expect(loc.locality).toBe("bariloche");
  });

  it("writes the CANONICAL pair, never the one that was posted", async () => {
    // MUTATION APPLIED: `to_locality: input.destination.localityName`. Red —
    // and this is the assertion that separates "a move was recorded" from "the
    // right place was recorded". The posted value here is lowercase and short;
    // the catalog's is the official spelling.
    const result = await run();
    expect(result).toEqual({
      ok: true,
      eventId: "evt-1",
      province: "Río Negro",
      locality: "San Carlos de Bariloche",
    });
    const movement = control.writes[0].movement as Record<string, unknown>;
    expect(movement.to_province).toBe("Río Negro");
    expect(movement.to_locality).toBe("San Carlos de Bariloche");
  });

  it("refuses an off-catalog pair as `destination_invalid` and writes NOTHING", async () => {
    // MUTATION APPLIED: rethrow instead of catching `JurisdictionValidationError`.
    // Red (the call rejects). MUTATION APPLIED: map it to `write_failed`. Red —
    // and that second one matters more than it looks: a 500 tells the client to
    // retry an address the catalog will refuse identically forever.
    control.normalized = () => {
      throw new JurisdictionValidationError(
        "INVALID_LOCALITY",
        "Localidad no encontrada en el catálogo.",
      );
    };
    const result = await run();
    expect(result).toMatchObject({ ok: false, code: "destination_invalid" });
    expect(control.writes).toEqual([]);
  });

  it("refuses when the normalizer SKIPPED the catalog and handed back nulls", async () => {
    // THE FALL-THROUGH, and it is not a defensive branch. The strict path in
    // `normalizeLocationForWrite` runs only `if (province && rawLocality)`, and
    // `province` is `canonicalProvinceNameForStorage(...)` which returns null
    // for anything it cannot resolve. So an unresolvable PROVINCE does not
    // throw — it returns an uncanonicalized pair with no error, which is
    // exactly the state that must not reach the columns.
    //
    // MUTATION APPLIED: delete the `if (!province || !locality)` block. Green on
    // every other case in this file, red here — the writer is then called with
    // `to_province: null`, which the event schema accepts (`.nullable()`).
    control.normalized = () => ({
      province: null,
      locality: "Bariloche",
      localityCanonical: false,
      localityId: null,
      lat: null,
      lng: null,
      address: null,
    });
    const result = await run();
    expect(result).toMatchObject({ ok: false, code: "destination_invalid" });
    expect(control.writes).toEqual([]);
  });
});

describe("recordJurisdictionMove — a no-op is refused before any transaction", () => {
  it("compares the CANONICAL destination against the animal's stored pair", async () => {
    // The posted locality ("bariloche") is not equal to the stored one as a
    // string; the CANONICAL one is. So a comparison against the request would
    // let this through and append a `movement_recorded` that records nothing —
    // which the event schema then refuses, one layer down, with a sentence.
    //
    // MUTATION APPLIED: compare `input.destination.localityName` instead of
    // `locality`. Red here and green everywhere else.
    const result = await run({
      pet: pet({
        jurisdictionProvince: "Río Negro",
        jurisdictionLocality: "San Carlos de Bariloche",
      }),
    });
    expect(result).toEqual({
      ok: false,
      code: "same_locality",
      error: "El destino es igual a la localidad actual.",
    });
    expect(control.writes).toEqual([]);
  });

  it("still writes when only the LOCALITY differs inside one province", async () => {
    // The `superRefine` refuses only when country AND province AND locality all
    // match. A guard that refused on the province alone would lock every
    // intra-province move out of the app.
    // MUTATION APPLIED: drop the locality term from the comparison. Red.
    const result = await run({
      pet: pet({ jurisdictionProvince: "Río Negro", jurisdictionLocality: "El Bolsón" }),
    });
    expect(result).toMatchObject({ ok: true });
    expect(control.writes).toHaveLength(1);
  });

  it("writes the CORRECTION between two same-named localities of one province", async () => {
    // L2-5(b). The no-op check used to compare country, province and locality
    // TEXT, and `input.pet` was a `Pick` WITHOUT `localityId` — so for the one
    // case the INDEC id exists to decide, the two sides compared equal and the
    // registry answered `same_locality` to a move that is not one. The animal
    // was filed against the alphabetically first San Pedro and could not be
    // moved to the right one.
    //
    // MUTATION APPLIED: drop `sameCatalogueRow` from the condition. Red here,
    // green everywhere else in this file.
    const result = await run({
      pet: pet({
        jurisdictionProvince: "Río Negro",
        jurisdictionLocality: "San Carlos de Bariloche",
        // A DIFFERENT catalogue row from the one the destination resolves to
        // ("loc-1", what the mocked normalizer answers).
        localityId: "loc-OTHER",
      }),
    });
    expect(result).toMatchObject({ ok: true });
    expect(control.writes).toHaveLength(1);
  });

  it("still refuses when the stored row IS the destination row", async () => {
    // NON-VACUITY for the case above: it is the ids differing that makes it a
    // move, not the presence of an id. Same names, same row → still a no-op.
    const result = await run({
      pet: pet({
        jurisdictionProvince: "Río Negro",
        jurisdictionLocality: "San Carlos de Bariloche",
        localityId: "loc-1",
      }),
    });
    expect(result).toMatchObject({ ok: false, code: "same_locality" });
    expect(control.writes).toEqual([]);
  });

  it("falls back to the names for a pet whose row was never resolved", async () => {
    // A legacy pet carries `locality_id: null`. There is nothing to compare but
    // the text, and the text rule still decides — half an id must not become a
    // licence to append a non-event.
    const result = await run({
      pet: pet({
        jurisdictionProvince: "Río Negro",
        jurisdictionLocality: "San Carlos de Bariloche",
        localityId: null,
      }),
    });
    expect(result).toMatchObject({ ok: false, code: "same_locality" });
    expect(control.writes).toEqual([]);
  });

  it("treats a NULL stored country as `AR` on both sides of the comparison", async () => {
    // `pets.jurisdiction_country` is nullable and legacy rows carry null. The
    // web's action reads it as `pet.jurisdictionCountry ?? "AR"`; if this file
    // did not, a null-country animal already living at the destination would
    // pass the no-op check (null !== "AR") and append a non-event.
    // MUTATION APPLIED: `const fromCountry = input.pet.jurisdictionCountry` with
    // no fallback. Red.
    const result = await run({
      pet: pet({
        jurisdictionCountry: null,
        jurisdictionProvince: "Río Negro",
        jurisdictionLocality: "San Carlos de Bariloche",
      }),
    });
    expect(result).toMatchObject({ ok: false, code: "same_locality" });
    expect(control.writes).toEqual([]);
  });
});

describe("recordJurisdictionMove — what the writer is handed", () => {
  it("builds a `jurisdiction_changed` payload whose from_* is the stored row", async () => {
    // MUTATION APPLIED: `from_province: province` (the destination). Red — and
    // the payload would then claim the animal moved from where it moved TO,
    // which no later reader could detect.
    await run({ pet: pet({ localityId: "loc-FROM" }) });
    expect(control.writes[0].movement).toEqual({
      sub_kind: "jurisdiction_changed",
      from_country: "AR",
      from_province: "Buenos Aires",
      from_locality: "La Plata",
      // The ROW the animal is leaving, not just its two names (L2-3). Without
      // it no later reader could tell a correction between two same-named
      // localities from a no-op, and a rederivation would have to guess.
      from_locality_id: "loc-FROM",
      to_country: "AR",
      to_province: "Río Negro",
      to_locality: "San Carlos de Bariloche",
      effective_date: "2019-07-04",
      reason: "Nos mudamos por trabajo",
    });
  });

  it("hands the writer the row the catalog resolved, not just its name", async () => {
    // L2-2 at this seam. The use-case resolved the destination — possibly BY
    // INDEC ID, the only thing that separates two same-named localities — and
    // the writer must not throw that answer away and re-resolve the name.
    // MUTATION APPLIED: drop `resolvedLocalityId` from the call. Red.
    await run();
    expect(control.writes[0].resolvedLocalityId).toBe("loc-1");
  });

  it("hardcodes `to_country: AR` even for an animal whose stored country is not", async () => {
    // A move OUT of Argentina is `transport_recorded` / `cvi_issued` — the
    // `/viaje` form — and this door does not offer it. Carrying the animal's
    // stored country into `to_country` would make this endpoint able to record
    // an emigration by accident.
    // MUTATION APPLIED: `to_country: fromCountry`. Red.
    await run({ pet: pet({ jurisdictionCountry: "UY" }) });
    const movement = control.writes[0].movement as Record<string, unknown>;
    expect(movement.from_country).toBe("UY");
    expect(movement.to_country).toBe("AR");
  });

  it("passes the caller's authorship and user id through untouched", async () => {
    // The event's signature is the DOOR's decision, not this function's, and a
    // use-case that stamped one would let a native write sign itself.
    // MUTATION APPLIED: `eventAuthorship: OWNER_AUTHORSHIP` hardcoded. Red.
    const vetAuthorship = {
      authorRole: "vet" as const,
      authorOrganizationId: "org-1",
      authorVerified: true,
    };
    await run({ eventAuthorship: vetAuthorship });
    expect(control.writes[0].eventAuthorship).toEqual(vetAuthorship);
    expect(control.writes[0].recordedByUserId).toBe(USER_ID);
  });

  it("dates the move from the injected clock, not from a second `new Date()`", async () => {
    // `effective_date` and `occurredAt` must describe the same instant. Two
    // independent clock reads straddle midnight roughly once every 86.400
    // requests, and the row that lands then says the move took effect on a day
    // it did not occur.
    // MUTATION APPLIED: `effective_date: new Date().toISOString().slice(0, 10)`.
    // Red — the injected clock is a fixed 2019-07-04, which no host clock can
    // agree with. See the note on `NOW`: with a clock set to the day this file
    // was written, this exact mutation left the suite 14/14 green.
    await run();
    const movement = control.writes[0].movement as Record<string, unknown>;
    expect(movement.effective_date).toBe("2019-07-04");
    expect(control.writes[0].occurredAt).toEqual(NOW);
    expect(control.writes[0].now).toEqual(NOW);
  });

  it("reports a writer refusal as `write_failed` and carries its message nowhere else", async () => {
    control.writeResult = { ok: false, error: "connection terminated unexpectedly" };
    const result = await run();
    expect(result).toEqual({
      ok: false,
      code: "write_failed",
      error: "connection terminated unexpectedly",
    });
  });

  it("keeps a null reason null rather than inventing one", async () => {
    await run({ reason: null });
    const movement = control.writes[0].movement as Record<string, unknown>;
    expect(movement.reason).toBeNull();
  });
});
