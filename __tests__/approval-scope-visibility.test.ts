// A2 regression: the /gob home "Aprobaciones" (nee "Cola de aprobaciones")
// panel count and the
// /gob/cola queue MUST share ONE jurisdiction scope. Both derive from
// lib/infra/approval-scope (fetchVisiblePendingRequests → visibleRequestsClause);
// canDecideRequest is the decision-side mirror of that same predicate ("an
// authority can decide a request only if it would appear in their queue").
//
// The reported symptom — panel "Ver todos (20)" while the scoped queue was
// empty — is exactly a scope mismatch. These pure tests lock the invariant that
// governs both surfaces: a govt with an empty or non-matching scope sees NOTHING
// (so the panel count is 0, never a global 20), and only an exact (province,
// locality) tuple match for a govt-decidable type is visible.

import { describe, expect, it } from "vitest";

import { canDecideRequest } from "@/lib/infra/approval-scope";

const LA_PLATA = { province: "Buenos Aires", locality: "La Plata" };
const CABA = { province: "CABA", locality: "Comuna 1" };

const vetRequestInLaPlata = {
  type: "role_upgrade_vet" as const,
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "La Plata",
};

describe("approval scope — shared /gob panel + /gob/cola invariant (A2)", () => {
  it("admin sees/decides everything regardless of jurisdictions", () => {
    expect(canDecideRequest({ role: "admin" }, vetRequestInLaPlata, [])).toBe(true);
  });

  it("govt with a matching (province, locality) tuple is in scope", () => {
    expect(canDecideRequest({ role: "govt" }, vetRequestInLaPlata, [LA_PLATA])).toBe(true);
  });

  it("govt with NO assignments has an empty scope → count 0, never global", () => {
    // This is the exact 'empty scoped queue' case: the panel count must be 0.
    expect(canDecideRequest({ role: "govt" }, vetRequestInLaPlata, [])).toBe(false);
  });

  it("govt whose assignments do not match the request's jurisdiction is out of scope", () => {
    // Assigned elsewhere → the request is NOT theirs → not counted, not decidable.
    expect(canDecideRequest({ role: "govt" }, vetRequestInLaPlata, [CABA])).toBe(false);
  });

  it("govt scope requires BOTH province and locality to match (not province alone)", () => {
    const sameProvinceOtherLocality = { province: "Buenos Aires", locality: "Quilmes" };
    expect(
      canDecideRequest({ role: "govt" }, vetRequestInLaPlata, [sameProvinceOtherLocality]),
    ).toBe(false);
  });
});
