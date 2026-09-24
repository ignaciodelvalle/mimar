// Unit tests for lib/revocation-scope.ts — pure canRevoke() function.
// Strict TDD: all test cases written before implementation exists.

import { describe, expect, it } from "vitest";

import { canRevoke } from "@/lib/domain/revocation-scope";
import type { RevocationTarget } from "@/lib/domain/revocation-scope";

const adminProfile = { id: "admin-1", role: "admin" as const };
const govtProfile = { id: "govt-1", role: "govt" as const };

const bsasJurisdictions = [{ province: "Buenos Aires", locality: "La Plata" }];
const cbaJurisdictions = [{ province: "Córdoba", locality: "Córdoba" }];
const multiJurisdictions = [
  { province: "Buenos Aires", locality: "La Plata" },
  { province: "CABA", locality: "Palermo" },
];

// ---------------------------------------------------------------------------
// Admin — unconditional YES for all three types
// ---------------------------------------------------------------------------

describe("canRevoke — admin", () => {
  it("returns true for vet_role regardless of jurisdiction", () => {
    const target: RevocationTarget = {
      type: "vet_role",
      matriculaJurisdiccion: "Santa Fe",
    };
    expect(canRevoke(adminProfile, target, [])).toBe(true);
  });

  it("returns true for org_verification regardless of jurisdiction", () => {
    const target: RevocationTarget = {
      type: "org_verification",
      province: "Santa Fe",
      locality: "Rosario",
    };
    expect(canRevoke(adminProfile, target, [])).toBe(true);
  });

  it("returns true for govt_locality regardless of jurisdiction", () => {
    const target: RevocationTarget = {
      type: "govt_locality",
      province: "Santa Fe",
      locality: "Rosario",
    };
    expect(canRevoke(adminProfile, target, [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Govt — org_verification: province + locality must match
// ---------------------------------------------------------------------------

describe("canRevoke — govt, org_verification", () => {
  it("returns true when jurisdiction matches exactly", () => {
    const target: RevocationTarget = {
      type: "org_verification",
      province: "Buenos Aires",
      locality: "La Plata",
    };
    expect(canRevoke(govtProfile, target, bsasJurisdictions)).toBe(true);
  });

  it("returns false when province matches but locality differs", () => {
    const target: RevocationTarget = {
      type: "org_verification",
      province: "Buenos Aires",
      locality: "Mar del Plata",
    };
    expect(canRevoke(govtProfile, target, bsasJurisdictions)).toBe(false);
  });

  it("returns false when no jurisdictions match", () => {
    const target: RevocationTarget = {
      type: "org_verification",
      province: "Buenos Aires",
      locality: "La Plata",
    };
    expect(canRevoke(govtProfile, target, cbaJurisdictions)).toBe(false);
  });

  it("returns true when one of multiple jurisdictions matches", () => {
    const target: RevocationTarget = {
      type: "org_verification",
      province: "CABA",
      locality: "Palermo",
    };
    expect(canRevoke(govtProfile, target, multiJurisdictions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Govt — govt_locality: STRICTLY WIDER coverage, not mere containment
//
// D3 (PO decision, 2026-08-23). Until now this branch used plain containment,
// so two officials assigned to the SAME locality could strip each other: an
// official in Buenos Aires / La Plata contained the scope of another official
// in Buenos Aires / La Plata, and `canRevoke` said yes. The assertion below
// USED TO PIN THAT AS EXPECTED — it asserted `true` for exactly the peer pair.
// It is turned around ON PURPOSE. A green test that fixes a defect is how the
// next reader concludes THEY are the ones who are wrong, so the reversal is
// stated here rather than left for them to reconstruct.
//
// The rule the PO chose is RANK, not admin-only: an actor may revoke a govt
// assignment only when their own coverage is STRICTLY WIDER than the target's
// — province over locality, nation over province. Admin-only was rejected
// precisely so a province does NOT have to escalate every legitimate
// revocation inside its own territory. "Nation" has no assignment row in this
// model: universal scope is the admin branch above, which still returns true.
// ---------------------------------------------------------------------------

describe("canRevoke — govt, govt_locality", () => {
  it("REFUSES a peer: same locality is equal rank, not wider (D3)", () => {
    const target: RevocationTarget = {
      type: "govt_locality",
      province: "Buenos Aires",
      locality: "La Plata",
    };
    expect(canRevoke(govtProfile, target, bsasJurisdictions)).toBe(false);
  });

  it("REFUSES a provincial peer: whole-province over whole-province is equal rank (D3)", () => {
    const target: RevocationTarget = {
      type: "govt_locality",
      province: "Buenos Aires",
      locality: "",
    };
    expect(canRevoke(govtProfile, target, [{ province: "Buenos Aires", locality: "" }])).toBe(
      false,
    );
  });

  it("ALLOWS strictly wider: a provincial operator over a locality inside it (D3)", () => {
    const target: RevocationTarget = {
      type: "govt_locality",
      province: "Buenos Aires",
      locality: "La Plata",
    };
    expect(canRevoke(govtProfile, target, [{ province: "Buenos Aires", locality: "" }])).toBe(true);
  });

  it("ALLOWS a whole-CABA operator over a barrio assignment (D3)", () => {
    const target: RevocationTarget = {
      type: "govt_locality",
      province: "CABA",
      locality: "Palermo",
    };
    expect(
      canRevoke(govtProfile, target, [
        { province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" },
      ]),
    ).toBe(true);
  });

  it("REFUSES a locality operator reaching UP at the province that contains them (D3)", () => {
    const target: RevocationTarget = {
      type: "govt_locality",
      province: "Buenos Aires",
      locality: "",
    };
    expect(canRevoke(govtProfile, target, bsasJurisdictions)).toBe(false);
  });

  it("still refuses SELF at the scope layer: an actor never outranks their own row (D3)", () => {
    // The writer's own SELF_REVOCATION_DENIED guard (revoke-govt-locality.ts,
    // before canRevoke) is unchanged and remains the primary check. This
    // asserts the rank rule does not quietly open a second door behind it:
    // the actor's coverage can never be strictly wider than the very row they
    // hold, so the pure predicate refuses it too.
    const target: RevocationTarget = {
      type: "govt_locality",
      province: "Buenos Aires",
      locality: "La Plata",
    };
    expect(canRevoke(govtProfile, target, bsasJurisdictions)).toBe(false);
  });

  it("ADMIN keeps universal reach over a whole-province assignment (D3)", () => {
    const target: RevocationTarget = {
      type: "govt_locality",
      province: "Buenos Aires",
      locality: "",
    };
    expect(canRevoke(adminProfile, target, [])).toBe(true);
  });

  it("returns false when jurisdiction does not match", () => {
    const target: RevocationTarget = {
      type: "govt_locality",
      province: "Buenos Aires",
      locality: "La Plata",
    };
    expect(canRevoke(govtProfile, target, cbaJurisdictions)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Whole-province subsumption (2026-08-17)
//
// Both comparisons in canRevoke used to be plain exact-pair equality, so a
// WHOLE-PROVINCE operator could not revoke anything inside their own province:
// their assignment's locality is the `""` sentinel (or the CABA whole-city
// entry), never a barrio name. The hardened check-jurisdiction-subsumption
// fence found it; these tests keep it found.
// ---------------------------------------------------------------------------

describe("canRevoke — whole-province operators cover their own province", () => {
  const WHOLE_BA = [{ province: "Buenos Aires", locality: "" }];
  const WHOLE_CABA = [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }];

  it('lets a `""`-sentinel provincial operator revoke a locality assignment inside it', () => {
    const target: RevocationTarget = {
      type: "govt_locality",
      province: "Buenos Aires",
      locality: "La Plata",
    };
    expect(canRevoke(govtProfile, target, WHOLE_BA)).toBe(true);
  });

  it("lets a whole-CABA operator revoke an org verification in a barrio", () => {
    const target: RevocationTarget = {
      type: "org_verification",
      province: "CABA",
      locality: "Palermo",
    };
    expect(canRevoke(govtProfile, target, WHOLE_CABA)).toBe(true);
  });

  it("covers a vet whose OPERATIONAL address is a barrio of the held province", () => {
    // The matrícula province deliberately does NOT match, so this can only pass
    // through the operational-address branch — the one that was exact-pair.
    const target: RevocationTarget = {
      type: "vet_role",
      matriculaJurisdiccion: "Córdoba",
      operationalProvince: "Buenos Aires",
      operationalLocality: "Mar del Plata",
    };
    expect(canRevoke(govtProfile, target, WHOLE_BA)).toBe(true);
  });

  it("does NOT let a whole-province operator reach another province", () => {
    // The assertion that keeps the fix from being a widening. Subsumption
    // applies WITHIN a held province and nowhere else.
    const target: RevocationTarget = {
      type: "govt_locality",
      province: "Córdoba",
      locality: "Córdoba",
    };
    expect(canRevoke(govtProfile, target, WHOLE_BA)).toBe(false);
  });

  it("does NOT let a barrio-scoped operator reach a sibling barrio", () => {
    // A locality mandate must stay exact — otherwise the fix would hand every
    // local official their whole province.
    const target: RevocationTarget = {
      type: "org_verification",
      province: "Buenos Aires",
      locality: "Mar del Plata",
    };
    expect(
      canRevoke(govtProfile, target, [{ province: "Buenos Aires", locality: "La Plata" }]),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Govt — vet_role: matches matricula_jurisdiccion (province-only string)
//         OR operational (province, locality) — OR semantics
// ---------------------------------------------------------------------------

describe("canRevoke — govt, vet_role", () => {
  it("returns true when matricula_jurisdiccion matches govt province", () => {
    // govt has Buenos Aires / La Plata; vet's matricula_jurisdiccion = "Buenos Aires"
    const target: RevocationTarget = {
      type: "vet_role",
      matriculaJurisdiccion: "Buenos Aires",
    };
    expect(canRevoke(govtProfile, target, bsasJurisdictions)).toBe(true);
  });

  it("returns true when operational province+locality matches exactly", () => {
    // vet has no matching matricula_jurisdiccion but operational locality matches
    const target: RevocationTarget = {
      type: "vet_role",
      matriculaJurisdiccion: "Santa Fe",
      operationalProvince: "Buenos Aires",
      operationalLocality: "La Plata",
    };
    expect(canRevoke(govtProfile, target, bsasJurisdictions)).toBe(true);
  });

  it("returns false when neither matricula nor operational locality matches", () => {
    const target: RevocationTarget = {
      type: "vet_role",
      matriculaJurisdiccion: "Santa Fe",
      operationalProvince: "Mendoza",
      operationalLocality: "Mendoza",
    };
    expect(canRevoke(govtProfile, target, bsasJurisdictions)).toBe(false);
  });

  it("returns true via OR semantics: matricula matches even if operational does not", () => {
    const target: RevocationTarget = {
      type: "vet_role",
      matriculaJurisdiccion: "Buenos Aires",
      operationalProvince: "Santa Fe",
      operationalLocality: "Rosario",
    };
    expect(canRevoke(govtProfile, target, bsasJurisdictions)).toBe(true);
  });

  it("returns true via OR semantics: operational matches even if matricula does not", () => {
    const target: RevocationTarget = {
      type: "vet_role",
      matriculaJurisdiccion: "Santa Fe",
      operationalProvince: "Buenos Aires",
      operationalLocality: "La Plata",
    };
    expect(canRevoke(govtProfile, target, bsasJurisdictions)).toBe(true);
  });

  it("returns false when govt has no jurisdictions", () => {
    const target: RevocationTarget = {
      type: "vet_role",
      matriculaJurisdiccion: "Buenos Aires",
    };
    expect(canRevoke(govtProfile, target, [])).toBe(false);
  });
});
