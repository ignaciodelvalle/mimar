// Unit tests for deriveWidestJurisdiction (panorama widest-jurisdiction default,
// commit d4ccdb2) — the core decision behind the govt operator's initial view.
//
// PURE by construction: only in-memory lookups (provinceByName,
// isWholeProvinceLocality) — no DB, no network. resolveSeedLocalitySlug is the
// thin wrapper around the ONE downstream DB-dependent step (localityByName's
// slug resolution), extracted so its graceful null fallback is testable
// without a database too.
//
// Fresh-review follow-up (692928f + d4ccdb2 review): deriveWidestJurisdiction
// was unexported and untested despite being the core of the widest-jurisdiction
// commit. This file exists to close that gap and pin the review's named edge
// cases so the ALIAS/null-slug regressions it called out can't return.

import { describe, expect, it } from "vitest";

import type { AdminOrGovtJurisdiction } from "@/lib/infra/auth-guards";

import {
  deriveWidestJurisdiction,
  isProvinceInGovtScope,
  resolveSeedLocalitySlug,
} from "../derive-widest-jurisdiction";

function j(province: string, locality: string): AdminOrGovtJurisdiction {
  return { province, locality };
}

describe("deriveWidestJurisdiction", () => {
  it("returns national (no province/locality seed) for 0 jurisdictions (admin/universal)", () => {
    expect(deriveWidestJurisdiction([])).toEqual({ provinceCode: null, localityName: null });
  });

  it("returns national when the scope spans MORE THAN ONE distinct province", () => {
    const result = deriveWidestJurisdiction([
      j("Córdoba", "Córdoba Capital"),
      j("Santa Fe", "Rosario"),
    ]);
    expect(result).toEqual({ provinceCode: null, localityName: null });
  });

  it("seeds the province ONLY (no locality) for exactly 1 province with MULTIPLE localities", () => {
    const result = deriveWidestJurisdiction([
      j("Córdoba", "Córdoba Capital"),
      j("Córdoba", "Villa Carlos Paz"),
    ]);
    expect(result).toEqual({ provinceCode: "AR-X", localityName: null });
  });

  it("seeds the province ONLY (no locality) for a whole-province marker (CABA)", () => {
    const result = deriveWidestJurisdiction([j("CABA", "Ciudad Autónoma de Buenos Aires")]);
    expect(result).toEqual({ provinceCode: "AR-C", localityName: null });
  });

  it("mixes a whole-province marker with a specific locality in the SAME province → still province-only (subsumption)", () => {
    // A whole-province assignment governs the entire province, so it subsumes
    // any co-assigned specific locality within it — never a spurious locality.
    const result = deriveWidestJurisdiction([
      j("CABA", "Ciudad Autónoma de Buenos Aires"),
      j("CABA", "Palermo"),
    ]);
    expect(result).toEqual({ provinceCode: "AR-C", localityName: null });
  });

  it("seeds province + locality for exactly 1 province and exactly 1 specific locality", () => {
    const result = deriveWidestJurisdiction([j("Córdoba", "Villa Carlos Paz")]);
    expect(result).toEqual({ provinceCode: "AR-X", localityName: "Villa Carlos Paz" });
  });

  it("ALIAS: a jurisdiction stored under the CABA long form resolves to AR-C via provinceByName", () => {
    // Regression anchor — the old PROVINCE_ISO_MAP had no key for the CABA
    // long-form name, which silently emptied the province set and dropped a
    // single-province operator to national. provinceByName is alias-tolerant.
    const result = deriveWidestJurisdiction([j("Ciudad Autónoma de Buenos Aires", "Palermo")]);
    expect(result).toEqual({ provinceCode: "AR-C", localityName: "Palermo" });
  });

  it("ALIAS never empties a genuinely single-province set even with mixed alias spellings for the SAME province", () => {
    const result = deriveWidestJurisdiction([
      j("CABA", "Palermo"),
      j("Ciudad Autónoma de Buenos Aires", "Palermo"),
    ]);
    expect(result).toEqual({ provinceCode: "AR-C", localityName: "Palermo" });
  });

  it("an unresolvable province name contributes no code (falls through the alias-tolerant resolver)", () => {
    // provinceByName returns null for junk input — the jurisdiction is simply
    // excluded from the province-code set, not treated as a crash.
    const result = deriveWidestJurisdiction([j("Patagonia", "Algún Lugar")]);
    expect(result).toEqual({ provinceCode: null, localityName: null });
  });
});

describe("isProvinceInGovtScope (G1 out-of-scope bounce)", () => {
  // Seed reality: govt@dim.test holds Ushuaia (Tierra del Fuego), El Calafate
  // (Santa Cruz) and Palermo (CABA) — a genuinely multi-province operator.
  const multiProvinceScope: AdminOrGovtJurisdiction[] = [
    j("Tierra del Fuego", "Ushuaia"),
    j("Santa Cruz", "El Calafate"),
    j("CABA", "Palermo"),
  ];

  it("returns true for a province the operator holds", () => {
    expect(isProvinceInGovtScope(multiProvinceScope, "AR-C")).toBe(true); // CABA
    expect(isProvinceInGovtScope(multiProvinceScope, "AR-V")).toBe(true); // Tierra del Fuego
    expect(isProvinceInGovtScope(multiProvinceScope, "AR-Z")).toBe(true); // Santa Cruz
  });

  it("returns false for a province OUTSIDE the operator's jurisdiction (must bounce)", () => {
    expect(isProvinceInGovtScope(multiProvinceScope, "AR-X")).toBe(false); // Córdoba
  });

  it("ALIAS-tolerant: a scope stored under the CABA long form still matches AR-C", () => {
    const aliasScope = [j("Ciudad Autónoma de Buenos Aires", "Palermo")];
    expect(isProvinceInGovtScope(aliasScope, "AR-C")).toBe(true);
    expect(isProvinceInGovtScope(aliasScope, "AR-X")).toBe(false);
  });

  it("empty scope is in nobody's scope (every province bounces)", () => {
    expect(isProvinceInGovtScope([], "AR-C")).toBe(false);
  });
});

describe("resolveSeedLocalitySlug", () => {
  it("returns the resolved slug when the locality row is found", () => {
    expect(resolveSeedLocalitySlug({ localitySlug: "villa-carlos-paz" })).toBe("villa-carlos-paz");
  });

  it("GRACEFUL: falls back to undefined (province-level seed) when the locality row is null", () => {
    // localityByName returns null when widest.localityName doesn't resolve to
    // a known slug (a stale/mistyped govt_assignments row). This must never
    // crash and must never surface an "undefined"-flavored slug string.
    expect(resolveSeedLocalitySlug(null)).toBeUndefined();
  });
});
