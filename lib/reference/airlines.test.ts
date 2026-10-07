// The airline and brachycephalic registries (viajes-fase-2, design D1).
//
// What is pinned: the 20 slugs, one row each; every breed a restriction names
// is a CATALOGUE label (so resolveBreedLabel can ever match it); every
// unverified value says why; Iberia's list carries the Dogo Argentino and Air
// Europa applies the same list with a muzzle; the three restriction kinds stay
// distinct.

import { describe, expect, it } from "vitest";

import {
  AIRLINES,
  AIRLINE_IDS,
  type Airline,
  type BreedRestriction,
  ROUTE_SUGGESTIONS_REVIEWED_AT,
  ROUTE_SUGGESTIONS_REVIEW_BY,
  getAirline,
  isAirlineId,
} from "@/lib/reference/airlines";
import {
  BRACHYCEPHALIC_BREEDS,
  brachycephalicBreedsFor,
} from "@/lib/reference/brachycephalic-breeds";
import { ALL_BREEDS, CAT_BREEDS, DOG_BREEDS } from "@/lib/reference/breeds";
import { CORRIDOR_IDS, type CorridorId } from "@/lib/reference/cross-border-corridors";

function restrictionsOf(airline: Airline): BreedRestriction[] {
  return Object.values(airline.modalities).flatMap((rule) => [
    ...(rule?.breedRestrictions?.value ?? []),
  ]);
}

function leavesOf(airline: Airline) {
  return Object.values(airline.modalities).flatMap((rule) =>
    Object.entries(rule ?? {}).map(([field, leaf]) => ({ field, leaf })),
  );
}

describe("airline registry", () => {
  it("has exactly the 20 slugs, one airline each", () => {
    expect(AIRLINE_IDS).toHaveLength(20);
    expect(new Set(AIRLINE_IDS).size).toBe(20);
    expect(AIRLINES.map((a) => a.id).sort()).toEqual([...AIRLINE_IDS].sort());
  });

  it("every airline has a name, an IATA code and at least one modality", () => {
    for (const airline of AIRLINES) {
      expect(airline.name.length, airline.id).toBeGreaterThan(0);
      expect(airline.iata, airline.id).toMatch(/^[A-Z0-9]{2}$/);
      expect(Object.keys(airline.modalities).length, airline.id).toBeGreaterThan(0);
    }
  });

  it("every restricted breed is a catalogue label", () => {
    const catalogue = new Set<string>(ALL_BREEDS);
    const offList = AIRLINES.flatMap((a) =>
      restrictionsOf(a).flatMap((r) =>
        r.breeds === "BRACHYCEPHALIC_LIST"
          ? []
          : r.breeds.filter((b) => !catalogue.has(b)).map((b) => `${a.id}: ${b}`),
      ),
    );
    expect(offList).toEqual([]);
  });

  it("every unverified value says why", () => {
    const silent = AIRLINES.flatMap((a) =>
      leavesOf(a)
        .filter(({ leaf }) => leaf.verification === "unverified" && !leaf.note?.trim())
        .map(({ field }) => `${a.id}.${field}`),
    );
    expect(silent).toEqual([]);
  });

  it("Iberia's dangerous-breed list names the Dogo Argentino; Air Europa applies it with a muzzle", () => {
    const iberia = restrictionsOf(getAirline("iberia")).find((r) => r.kind === "dangerous_list");
    expect(iberia?.breeds).toContain("Dogo Argentino");
    expect(iberia?.effect).toBe("banned");
    const airEuropa = restrictionsOf(getAirline("air_europa")).find(
      (r) => r.kind === "dangerous_list",
    );
    expect(airEuropa?.breeds).toEqual(iberia?.breeds);
    expect(airEuropa?.effect).toBe("muzzle");
  });

  it("keeps the three restriction kinds apart", () => {
    const kinds = new Set(AIRLINES.flatMap((a) => restrictionsOf(a).map((r) => r.kind)));
    expect([...kinds].sort()).toEqual(["airline_veto", "brachycephalic", "dangerous_list"]);
    // Emirates' veto is its own list, not the brachycephalic category.
    const emirates = restrictionsOf(getAirline("emirates"));
    expect(emirates.map((r) => r.kind)).toEqual(["airline_veto"]);
  });

  it("isAirlineId accepts the slugs and nothing else", () => {
    expect(isAirlineId("latam")).toBe(true);
    expect(isAirlineId("aerolineas")).toBe(false);
    expect(isAirlineId(42)).toBe(false);
  });
});

describe("brachycephalic list", () => {
  it("uses only labels of the right species' catalogue", () => {
    const dogs = new Set<string>(DOG_BREEDS);
    const cats = new Set<string>(CAT_BREEDS);
    expect(BRACHYCEPHALIC_BREEDS.value.dog.filter((b) => !dogs.has(b))).toEqual([]);
    expect(BRACHYCEPHALIC_BREEDS.value.cat.filter((b) => !cats.has(b))).toEqual([]);
  });

  it("is miMAR's reading, so it is never verified and says so", () => {
    expect(BRACHYCEPHALIC_BREEDS.verification).toBe("unverified");
    expect(BRACHYCEPHALIC_BREEDS.note?.length).toBeGreaterThan(0);
  });

  it("answers per species", () => {
    expect(brachycephalicBreedsFor("dog")).toContain("Pug");
    expect(brachycephalicBreedsFor("cat")).toContain("Persa");
    expect(brachycephalicBreedsFor("rabbit")).toEqual([]);
  });
});

describe("destination → airline suggestions (v14, PO 2026-10-07)", () => {
  function suggestedFor(corridor: CorridorId): string[] {
    return AIRLINES.filter((a) => a.servesCorridors.includes(corridor)).map((a) => a.id);
  }

  it("lists, per destination, the airlines the approved design puts first", () => {
    expect(suggestedFor("chile").sort()).toEqual(
      ["aerolineas_argentinas", "jetsmart", "latam", "sky"].sort(),
    );
    expect(suggestedFor("uruguay")).toEqual(["aerolineas_argentinas"]);
    expect(suggestedFor("brasil").sort()).toEqual(
      ["aerolineas_argentinas", "gol", "jetsmart", "latam"].sort(),
    );
    expect(suggestedFor("ue_espana").sort()).toEqual(
      ["aerolineas_argentinas", "air_europa", "iberia"].sort(),
    );
    expect(suggestedFor("usa").sort()).toEqual(
      ["aerolineas_argentinas", "american", "delta", "united"].sort(),
    );
  });

  it("never suggests an airline against its own published policy", () => {
    // Flybondi's pet policy is domestic only; Sky publishes no pets to or from the US.
    expect(getAirline("flybondi").servesCorridors).toEqual([]);
    expect(getAirline("sky").servesCorridors).not.toContain("usa");
  });

  it("names only real destinations, once each", () => {
    for (const a of AIRLINES) {
      for (const c of a.servesCorridors) expect(CORRIDOR_IDS, a.id).toContain(c);
      expect(new Set(a.servesCorridors).size, a.id).toBe(a.servesCorridors.length);
    }
  });

  it("is reviewed on the airlines' 90-day clock", () => {
    const days =
      (Date.parse(`${ROUTE_SUGGESTIONS_REVIEW_BY}T00:00:00Z`) -
        Date.parse(`${ROUTE_SUGGESTIONS_REVIEWED_AT}T00:00:00Z`)) /
      86_400_000;
    expect(days).toBe(90);
  });
});
