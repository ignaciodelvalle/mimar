// Server-side breed catalog enforcement — QA finding A4 (2026-08-13).
//
// Regression origin: QA typed "Raza-Falsa-CW0813" into the alta form's
// <datalist> field and the server persisted it verbatim. A datalist suggests;
// it does not restrict — and the write sites trusted it as if it did.

import { describe, expect, it } from "vitest";

import { BREED_NOT_IN_CATALOG_MSG, resolveBreedForWrite } from "@/lib/domain/breed-validation";

describe("resolveBreedForWrite", () => {
  it("accepts a canonical catalog label verbatim", () => {
    expect(resolveBreedForWrite("dog", "Pit Bull Terrier")).toEqual({
      ok: true,
      breed: "Pit Bull Terrier",
    });
    expect(resolveBreedForWrite("cat", "Común europeo")).toEqual({
      ok: true,
      breed: "Común europeo",
    });
  });

  it("persists the CANONICAL label for aliases and spelling variants", () => {
    // Colloquial alias — the exact PPP escape QA exploited.
    expect(resolveBreedForWrite("dog", "pitbull")).toEqual({
      ok: true,
      breed: "Pit Bull Terrier",
    });
    // Case/accent/separator folding.
    expect(resolveBreedForWrite("dog", "MASTIN NAPOLITANO")).toEqual({
      ok: true,
      breed: "Mastín Napolitano",
    });
    expect(resolveBreedForWrite("dog", "  dogo-argentino ")).toEqual({
      ok: true,
      breed: "Dogo Argentino",
    });
    // The honest answer for a dog without a defined breed must resolve, not bounce.
    expect(resolveBreedForWrite("dog", "mestizo")).toEqual({ ok: true, breed: "Mixto / Cruza" });
  });

  it("rejects an invented breed with the Spanish field error", () => {
    expect(resolveBreedForWrite("dog", "Raza-Falsa-CW0813")).toEqual({
      ok: false,
      error: BREED_NOT_IN_CATALOG_MSG,
    });
  });

  it("rejects a label that only exists in ANOTHER species' catalog", () => {
    // "Persa" resolves — but to the CAT catalog. A dog must not carry it.
    expect(resolveBreedForWrite("dog", "Persa")).toEqual({
      ok: false,
      error: BREED_NOT_IN_CATALOG_MSG,
    });
  });

  it("keeps breed optional: empty and null pass through as null", () => {
    expect(resolveBreedForWrite("dog", null)).toEqual({ ok: true, breed: null });
    expect(resolveBreedForWrite("dog", "   ")).toEqual({ ok: true, breed: null });
    expect(resolveBreedForWrite("dog", undefined)).toEqual({ ok: true, breed: null });
  });

  it("accepts the special options for species with no named catalog", () => {
    expect(resolveBreedForWrite("ferret", "Mixto / Cruza")).toEqual({
      ok: true,
      breed: "Mixto / Cruza",
    });
    expect(resolveBreedForWrite("hamster", "Pura raza no listada")).toEqual({
      ok: true,
      breed: "Pura raza no listada",
    });
  });

  it("grandfathers an UPDATE that re-submits the stored breed unchanged (QA A5)", () => {
    expect(
      resolveBreedForWrite("dog", "Perro Callejero Legacy", {
        storedBreed: "Perro Callejero Legacy",
      }),
    ).toEqual({ ok: true, breed: "Perro Callejero Legacy" });
  });

  it("does NOT grandfather a DIFFERENT off-catalog value on update", () => {
    expect(
      resolveBreedForWrite("dog", "Otra Cosa Inventada", { storedBreed: "Perro Callejero Legacy" }),
    ).toEqual({ ok: false, error: BREED_NOT_IN_CATALOG_MSG });
  });

  it("still canonicalizes an alias on update when it differs from the stored value", () => {
    expect(resolveBreedForWrite("dog", "pitbull", { storedBreed: "Labrador" })).toEqual({
      ok: true,
      breed: "Pit Bull Terrier",
    });
  });
});
