// Regression for the vet-greeting bug (QA 2026-07-03): "Dra. Lilian Marrone"
// greeted as "Buen día, Dra.." — honorific token taken as the first name.

import { describe, expect, it } from "vitest";

import { greetingFirstName } from "@/lib/utils/greeting";

describe("greetingFirstName", () => {
  it("skips honorific prefixes and returns the first name", () => {
    expect(greetingFirstName("Dra. Lilian Marrone")).toBe("Lilian");
    expect(greetingFirstName("Dr. Juan Pérez")).toBe("Juan");
    expect(greetingFirstName("Lic Ana Suárez")).toBe("Ana");
  });

  it("returns the first token for plain names", () => {
    expect(greetingFirstName("Alejo Caride")).toBe("Alejo");
    expect(greetingFirstName("Ignacio")).toBe("Ignacio");
  });

  it("does not treat name-like tokens as honorifics", () => {
    // "Dra" only matches as a standalone token, not as a prefix of a name.
    expect(greetingFirstName("Drago Núñez")).toBe("Drago");
  });

  it("falls back when there is no usable name", () => {
    expect(greetingFirstName("Dra.")).toBe("amigo");
    expect(greetingFirstName("   ")).toBe("amigo");
    expect(greetingFirstName(null)).toBe("amigo");
    expect(greetingFirstName(undefined, "colega")).toBe("colega");
  });
});
