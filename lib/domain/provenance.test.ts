import { describe, expect, it } from "vitest";

import {
  PROVENANCE_ORDER,
  type ProvenanceTier,
  VACCINE_LENS,
  isAtLeastProvenance,
  provenanceTier,
  provenanceTierChip,
  provenanceTierFromLocationSource,
  provenanceTierLabel,
} from "@/lib/domain/provenance";
import { computeConfidence } from "@/lib/events/event-confidence";

// Author presets — mirror the compliance/confidence test vocabulary.
const VET = { authorRole: "vet", authorVerified: true, authorOrganizationId: null };
const GOVT = { authorRole: "govt", authorVerified: true, authorOrganizationId: null };
const SHELTER_VERIFIED = {
  authorRole: "shelter",
  authorVerified: true,
  authorOrganizationId: "org-1",
};
const ORG_UNVERIFIED = {
  authorRole: "shelter",
  authorVerified: false,
  authorOrganizationId: "org-1",
};
const OWNER = { authorRole: "owner", authorVerified: false, authorOrganizationId: null };
const SCANNER = { authorRole: "scanner", authorVerified: false, authorOrganizationId: null };

describe("provenanceTier — author-based tiers", () => {
  it("vet + verified (matrícula) → firmado_matricula", () => {
    expect(provenanceTier(VET)).toBe("firmado_matricula");
  });

  it("govt verified → verificado", () => {
    expect(provenanceTier(GOVT)).toBe("verificado");
  });

  it("verified shelter with org → verificado (institutional)", () => {
    expect(provenanceTier(SHELTER_VERIFIED)).toBe("verificado");
  });

  it("lab-confirmed payload → verificado regardless of author", () => {
    expect(provenanceTier({ ...OWNER, payload: { confirmed_by_lab: true } })).toBe("verificado");
  });

  it("org-registered (shelter, no matrícula) → declarado (a record, not verified)", () => {
    expect(provenanceTier(ORG_UNVERIFIED)).toBe("declarado");
  });

  it("owner self-reported → declarado", () => {
    expect(provenanceTier(OWNER)).toBe("declarado");
  });

  it("anonymous scanner → declarado", () => {
    expect(provenanceTier(SCANNER)).toBe("declarado");
  });

  it("tolerates missing author fields (defensive default → declarado)", () => {
    expect(provenanceTier({})).toBe("declarado");
  });
});

// The load-bearing invariant: the compliance "al día" gate clears iff the
// provenance tier is NOT declarado. computeConfidence is the shared derivation
// both lenses read, so this checks the coarsening agrees with the gate.
describe("provenanceTier — invariant vs. the compliance gate", () => {
  const clears = (input: Parameters<typeof computeConfidence>[0]) => {
    const t = computeConfidence(input);
    return t === "professional_verified" || t === "institutional_verified";
  };

  for (const [name, preset] of Object.entries({
    VET,
    GOVT,
    SHELTER_VERIFIED,
    ORG_UNVERIFIED,
    OWNER,
    SCANNER,
  })) {
    it(`${name}: provenanceTier !== declarado ⟺ clears the al-día gate`, () => {
      const input = { ...preset, payload: {} };
      const tier = provenanceTier(preset);
      expect(tier !== "declarado").toBe(clears(input));
    });
  }
});

describe("provenanceTierFromLocationSource / location events", () => {
  it("gps → verificado", () => {
    expect(provenanceTierFromLocationSource("gps")).toBe("verificado");
  });
  it("geocodificada → verificado", () => {
    expect(provenanceTierFromLocationSource("geocodificada")).toBe("verificado");
  });
  it("pin_manual → declarado", () => {
    expect(provenanceTierFromLocationSource("pin_manual")).toBe("declarado");
  });
  it("unknown / null → declarado", () => {
    expect(provenanceTierFromLocationSource(null)).toBe("declarado");
    expect(provenanceTierFromLocationSource("wat")).toBe("declarado");
  });

  it("provenanceTier with { location: true } reads location_source, not the author", () => {
    // A vet-authored location pin is still only as good as its pin source.
    expect(
      provenanceTier({ ...VET, payload: { location_source: "pin_manual" } }, { location: true }),
    ).toBe("declarado");
    expect(
      provenanceTier({ ...OWNER, payload: { location_source: "gps" } }, { location: true }),
    ).toBe("verificado");
  });
});

describe("ordering + labels", () => {
  it("PROVENANCE_ORDER ascends declarado < verificado < firmado_matricula", () => {
    expect(PROVENANCE_ORDER).toEqual(["declarado", "verificado", "firmado_matricula"]);
  });

  it("isAtLeastProvenance compares by trust order", () => {
    expect(isAtLeastProvenance("firmado_matricula", "verificado")).toBe(true);
    expect(isAtLeastProvenance("verificado", "verificado")).toBe(true);
    expect(isAtLeastProvenance("declarado", "verificado")).toBe(false);
  });

  it("labels are es-AR and describe the source (never judgmental)", () => {
    const tiers: ProvenanceTier[] = ["declarado", "verificado", "firmado_matricula"];
    for (const t of tiers) {
      expect(provenanceTierLabel(t)).toBeTruthy();
      expect(provenanceTierChip(t)).toBeTruthy();
    }
    expect(provenanceTierLabel("firmado_matricula")).toMatch(/matriculado/i);
    expect(provenanceTierChip("declarado")).toBe("Declarada");
  });

  it("VACCINE_LENS names the three lenses distinctly", () => {
    expect(VACCINE_LENS.compliance.name).toBe("Al día");
    expect(VACCINE_LENS.currency.name).toBe("Vigente");
    expect(VACCINE_LENS.provenance.name).toBe("Origen");
    // The currency lens must explicitly disclaim it is NOT the compliance lens.
    expect(VACCINE_LENS.currency.note).toMatch(/al día/i);
  });
});
