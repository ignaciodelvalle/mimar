// A10-3: a govt business rule's (province, locality) is resolved against the
// ar_localities catalog before it is stored.
//
// `resolveBusinessRule` matches a rule to a pet by EXACT string equality on
// `pets.jurisdiction_locality`, which the pet write paths store canonically.
// A rule stored as "palermo" therefore governed zero pets while /gob/reglas
// showed it as configured. normalizeJurisdiction used to be trim-only; these
// cases pin that it now canonicalizes, and refuses what it cannot resolve.
// Read-only against the catalog: nothing is written.

import { describe, expect, it } from "vitest";

import { normalizeJurisdiction } from "@/src/modules/organizations/application/business-rules/normalize-jurisdiction";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("normalizeJurisdiction (business rules, A10-3)", () => {
  it("stores the catalog spelling of a lower-case locality", async () => {
    const result = await normalizeJurisdiction(
      form({ jurisdictionProvince: "CABA", jurisdictionLocality: "palermo" }),
    );
    expect(result).toEqual({
      ok: true,
      value: { country: "AR", province: "CABA", locality: "Palermo" },
    });
  });

  it("canonicalizes a province-only rule and keeps its locality null", async () => {
    const result = await normalizeJurisdiction(form({ jurisdictionProvince: "Cordoba" }));
    expect(result).toEqual({
      ok: true,
      value: { country: "AR", province: "Córdoba", locality: null },
    });
  });

  it("refuses a locality that is not in the catalog for that province", async () => {
    const result = await normalizeJurisdiction(
      form({ jurisdictionProvince: "CABA", jurisdictionLocality: "Paraje Sin Catalogo" }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a province that is not a province", async () => {
    const result = await normalizeJurisdiction(form({ jurisdictionProvince: "Narnia" }));
    expect(result.ok).toBe(false);
  });

  it("refuses a locality without a province (the cascade is province first)", async () => {
    const result = await normalizeJurisdiction(form({ jurisdictionLocality: "Palermo" }));
    expect(result.ok).toBe(false);
  });

  it("leaves a national rule national", async () => {
    const result = await normalizeJurisdiction(form({}));
    expect(result).toEqual({
      ok: true,
      value: { country: "AR", province: null, locality: null },
    });
  });
});
