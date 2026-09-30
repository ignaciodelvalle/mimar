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
  getAirline,
  isAirlineId,
} from "@/lib/reference/airlines";
import {
  BRACHYCEPHALIC_BREEDS,
  brachycephalicBreedsFor,
} from "@/lib/reference/brachycephalic-breeds";
import { ALL_BREEDS, CAT_BREEDS, DOG_BREEDS } from "@/lib/reference/breeds";

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
