// The door comes off, the landmark stays on.
//
// This pins a PRIVACY posture, not a formatting preference: the place a pet went
// missing is very often its owner's doorstep, and the public credential is an
// open page. If an assertion here starts failing, somebody has either put a
// street number back on that page or coarsened the line until it stopped helping
// anyone search.

import { describe, expect, it } from "vitest";

import { publicPlaceReference } from "@/lib/domain/public-place-reference";

describe("publicPlaceReference", () => {
  it("drops the house number and keeps the street, the barrio and the city", () => {
    expect(publicPlaceReference("Av. Rivadavia 1234, Balvanera, CABA")).toBe(
      "Av. Rivadavia, Balvanera, CABA",
    );
  });

  it("keeps a number that is part of the street's NAME", () => {
    // "Ruta 8" and "17 de Agosto" are not doors. A rule that stripped every
    // digit would erase the landmark it exists to preserve, which is why the
    // pattern is anchored to the end of the first segment.
    expect(publicPlaceReference("Ruta 8, Pilar, Buenos Aires")).toBe("Ruta 8, Pilar, Buenos Aires");
    expect(publicPlaceReference("Barrio 17 de Agosto, Moreno")).toBe("Barrio 17 de Agosto, Moreno");
  });

  it("keeps a THREE-DIGIT route number, which only the keyword list can save", () => {
    // The sharp case, and the one that caught a dead guard. "Ruta 8" survives
    // on the two-digit floor alone, so it cannot tell whether the keyword list
    // works — and for a while it did not: a stray control character had left
    // that pattern matching nothing, with every test still green. "Ruta 188" is
    // three digits, so the house-number rule WOULD strip it and only the
    // keyword check stops that. A route stripped of its number is not a
    // landmark, it is a word.
    expect(publicPlaceReference("Ruta 188, Pilar")).toBe("Ruta 188, Pilar");
    expect(publicPlaceReference("Autopista 25 de Mayo, CABA")).toBe("Autopista 25 de Mayo, CABA");
    expect(publicPlaceReference("Km 42, Escobar")).toBe("Km 42, Escobar");
  });

  it("handles the Argentine suffixes a door actually carries", () => {
    expect(publicPlaceReference("Sarmiento 450 bis, Rosario")).toBe("Sarmiento, Rosario");
    expect(publicPlaceReference("Mitre 1200 B, Córdoba")).toBe("Mitre, Córdoba");
  });

  it("leaves free prose alone — the native app writes a reference point, not an address", () => {
    expect(publicPlaceReference("La plaza, frente al kiosco")).toBe("La plaza, frente al kiosco");
    expect(publicPlaceReference("el portón de casa")).toBe("el portón de casa");
  });

  it("drops a segment that was ONLY a number rather than publishing a leading comma", () => {
    expect(publicPlaceReference("1234, Balvanera, CABA")).toBe("Balvanera, CABA");
  });

  it("answers null for nothing, so the caller renders no line at all", () => {
    expect(publicPlaceReference(null)).toBeNull();
    expect(publicPlaceReference(undefined)).toBeNull();
    expect(publicPlaceReference("   ")).toBeNull();
  });

  it("strips a number from a single-segment address too", () => {
    expect(publicPlaceReference("Corrientes 3247")).toBe("Corrientes");
  });
});
