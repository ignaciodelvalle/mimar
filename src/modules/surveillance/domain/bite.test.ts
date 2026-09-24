// Unit tests for domain/bite.ts
// Spec source: task 1.3 — victimKind/severity enums, orgTypeToReporterRole.
// Parity: orgTypeToReporterRole mirrors app/actions/bite.ts; isInScope mirrors
//         professionalCloseRabiesObservationAction and outbreak use-cases.

import { describe, expect, it } from "vitest";

import { BITE_SEVERITIES, VICTIM_KINDS, orgTypeToReporterRole } from "./bite";

// ---------------------------------------------------------------------------
// VICTIM_KINDS constant
// ---------------------------------------------------------------------------

describe("VICTIM_KINDS", () => {
  it("contains human, animal, unknown", () => {
    expect(VICTIM_KINDS).toContain("human");
    expect(VICTIM_KINDS).toContain("animal");
    expect(VICTIM_KINDS).toContain("unknown");
  });

  it("has exactly 3 kinds", () => {
    expect(VICTIM_KINDS).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// BITE_SEVERITIES constant
// ---------------------------------------------------------------------------

describe("BITE_SEVERITIES", () => {
  it("contains minor, moderate, severe", () => {
    expect(BITE_SEVERITIES).toContain("minor");
    expect(BITE_SEVERITIES).toContain("moderate");
    expect(BITE_SEVERITIES).toContain("severe");
  });

  it("has exactly 3 levels", () => {
    expect(BITE_SEVERITIES).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// orgTypeToReporterRole
// ---------------------------------------------------------------------------

describe("orgTypeToReporterRole", () => {
  it("maps 'clinic' → 'vet'", () => {
    expect(orgTypeToReporterRole("clinic")).toBe("vet");
  });

  it("maps 'shelter' → 'shelter'", () => {
    expect(orgTypeToReporterRole("shelter")).toBe("shelter");
  });

  it("maps 'rescue_network' → 'shelter'", () => {
    expect(orgTypeToReporterRole("rescue_network")).toBe("shelter");
  });

  it("maps 'sanitary_authority' → 'govt'", () => {
    expect(orgTypeToReporterRole("sanitary_authority")).toBe("govt");
  });

  it("maps unknown org type → 'witness' (default)", () => {
    expect(orgTypeToReporterRole("other")).toBe("witness");
  });

  it("maps empty string → 'witness'", () => {
    expect(orgTypeToReporterRole("")).toBe("witness");
  });

  it("maps 'vet_practice' (unknown) → 'witness'", () => {
    expect(orgTypeToReporterRole("vet_practice")).toBe("witness");
  });
});

// ---------------------------------------------------------------------------
// isInScope was DELETED from domain/bite.ts on 2026-08-18, and its tests with it.
//
// There were TWO functions named isInScope. The live one — the guard the four
// outbreak actions actually call — is outbreak-investigation.ts::isInScope, and
// it is subsumption-aware: a whole-province assignment covers every barrio in
// that province. The one here was a second copy with the same name, the same
// stated rules, and plain exact-pair equality — so it answered FALSE for a
// whole-CABA operator asked about a case in Palermo.
//
// It had zero production importers, so it was never exploitable. What it was is
// a loaded gun: a domain helper named and shaped like THE scope predicate for
// bites, whose tests claimed "isInScope mirrors professionalCloseRabiesObservation
// and outbreak use-cases" — a parity that stopped being true when those two
// were fixed. The next person to import it would have reintroduced the bug that
// took two separate fixes to remove on 2026-08-17.
//
// The live guard states the principle this deletion follows, in its own export
// comment: a guard worth testing is worth importing. Its tests live in
// outbreak-investigation.test.ts and __tests__/jurisdiction-subsumption-class.ts,
// against the real function.
// ---------------------------------------------------------------------------
