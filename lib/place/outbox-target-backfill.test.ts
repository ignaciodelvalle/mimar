// Historic outbox target places (localidades-por-id): the rows queued before
// the enqueue snapshotted target_locality_id get it from the same sources the
// live enqueue uses — the bite case the row was bound for, else the source
// event's own place — and ONLY when that source names exactly the row's
// target (province, locality). Never the pet's current home; never a guess
// between two sources that disagree; an unresolved source stays unresolved.

import { describe, expect, it } from "vitest";

import { planOutboxTarget } from "./outbox-target-backfill";

const row = { targetProvince: "Buenos Aires", targetLocality: "Mechita" };
const ALBERTI = "11111111-1111-4111-8111-111111111111";
const BRAGADO = "22222222-2222-4222-8222-222222222222";

describe("planOutboxTarget", () => {
  it("takes the bite case bound for the row's names", () => {
    expect(
      planOutboxTarget(row, [
        {
          source: "case",
          province: "Buenos Aires",
          locality: "Mechita",
          localityId: ALBERTI,
          method: "indec_id",
        },
        {
          source: "event",
          province: "Buenos Aires",
          locality: "Otro",
          localityId: BRAGADO,
          method: "spine_rederived",
        },
      ]),
    ).toEqual({ localityId: ALBERTI, placeMethod: "indec_id" });
  });

  it("falls back to the event's own place when no case names the row", () => {
    expect(
      planOutboxTarget(row, [
        {
          source: "event",
          province: "Buenos Aires",
          locality: "Mechita",
          localityId: BRAGADO,
          method: "spine_rederived",
        },
      ]),
    ).toEqual({ localityId: BRAGADO, placeMethod: "spine_rederived" });
  });

  it("an unresolved source stays unresolved; a source with no recorded method is 'unresolved' only without a row", () => {
    expect(
      planOutboxTarget(row, [
        {
          source: "case",
          province: "Buenos Aires",
          locality: "Mechita",
          localityId: null,
          method: null,
        },
      ]),
    ).toEqual({ localityId: null, placeMethod: "unresolved" });
    expect(
      planOutboxTarget(row, [
        {
          source: "case",
          province: "Buenos Aires",
          locality: "Mechita",
          localityId: ALBERTI,
          method: null,
        },
      ]),
    ).toEqual({ localityId: ALBERTI, placeMethod: "catalogue_id" });
  });

  it("two matching sources that disagree, or none, decide nothing", () => {
    expect(
      planOutboxTarget(row, [
        {
          source: "case",
          province: "Buenos Aires",
          locality: "Mechita",
          localityId: ALBERTI,
          method: "indec_id",
        },
        {
          source: "case",
          province: "Buenos Aires",
          locality: "Mechita",
          localityId: BRAGADO,
          method: "indec_id",
        },
      ]),
    ).toBeNull();
    expect(
      planOutboxTarget(row, [
        {
          source: "event",
          province: "Córdoba",
          locality: "Mechita",
          localityId: ALBERTI,
          method: "indec_id",
        },
      ]),
    ).toBeNull();
    expect(planOutboxTarget(row, [])).toBeNull();
  });
});
