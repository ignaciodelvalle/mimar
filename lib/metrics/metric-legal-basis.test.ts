// Mandate-scoped legal-citation resolution (red-team CRITICAL): a province's
// law must NEVER be shown to an operator whose mandate does not include that
// province. The reference scenario is a CABA + Tierra del Fuego + Santa Cruz
// operator, who used to see "PBA: Ley 14.107" cited as their obligation.
// Separately (2026-08-17), microchip_penetration lost its citation entirely:
// see the "carries no legal citation" block below for why that is a different
// failure from the scoping one, and why it must NOT degrade to the neutral
// provincial fallback.

import { describe, expect, it } from "vitest";

import { CANONICAL_PROVINCE_NAMES } from "@/lib/domain/jurisdiction-canonical";
import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";
import {
  METRIC_LEGAL_BASIS,
  NATIONAL_VIEW_PROVINCIAL_ONLY_ES,
  PROVINCIAL_GAP_FALLBACK_ES,
  formatLegalBasis,
  formatMetricLegalBasis,
  resolveMetricLegalBasis,
} from "./metric-legal-basis";

// Canonical province display names as stored in govt_assignments (verified
// against lib/reference/ar-provincias.ts PROVINCES).
const CABA_TDF_SC = ["CABA", "Tierra del Fuego", "Santa Cruz"];
const TDF_ONLY = ["Tierra del Fuego"];
const PBA_ONLY = ["Buenos Aires"];

describe("METRIC_LEGAL_BASIS registry", () => {
  it("every byProvince key is a canonical province display name", () => {
    for (const [kpiId, basis] of Object.entries(METRIC_LEGAL_BASIS)) {
      for (const province of Object.keys(basis.byProvince ?? {})) {
        expect(
          CANONICAL_PROVINCE_NAMES.has(province),
          `${kpiId}.byProvince key "${province}" is not a canonical province name`,
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The microchip claim (legal research 2026-08-17, engram
// legal/claims-refutadas-2026-08-17). The registry used to map
// microchip_penetration to PBA's Ley 14.107 as a chip mandate. That statute
// admits "un chip O DE UN TATUAJE" and only for PPP; Ley CABA 4.078 never
// mentions a chip; SENASA confirms no national electronic-ID rule. There is
// no jurisdiction to substitute, so the metric must carry NO citation at all.
//
// This block fences BOTH halves of the fix, because either alone is
// insufficient: deleting the registry entry makes formatMetricLegalBasis
// return null, and briefing-alerts' `?? undefined` then falls straight back
// to the CATALOG's target.source — which is where the false claim also lived.
// ---------------------------------------------------------------------------
describe("microchip_penetration carries no legal citation (refuted 2026-08-17)", () => {
  it("has no entry in the registry, so the resolver reports neither laws nor a gap", () => {
    expect(METRIC_LEGAL_BASIS.microchip_penetration).toBeUndefined();
    const r = resolveMetricLegalBasis("microchip_penetration", "all");
    expect(r.laws).toEqual([]);
    // NOT a provincial gap: a gap means "your province isn't covered yet" and
    // would render the neutral "según la normativa provincial" fallback,
    // which is itself a claim that some provincial norm exists. None does.
    expect(r.hasProvincialGap).toBe(false);
  });

  it("formats to null at every scope — no citation, no neutral fallback", () => {
    expect(formatMetricLegalBasis("microchip_penetration", "all")).toBeNull();
    expect(formatMetricLegalBasis("microchip_penetration", PBA_ONLY)).toBeNull();
    expect(formatMetricLegalBasis("microchip_penetration", CABA_TDF_SC)).toBeNull();
  });

  it("the catalog fallback the alert drops back to cites no law either", () => {
    const target = KPI_CATALOG.microchip_penetration.target;
    expect(target?.source).not.toContain("14.107");
    expect(target?.source).not.toContain("4078");
    expect(target?.source).not.toMatch(/Ley/i);
    // "programmatic-target" would render the literal word "Obligación:" in
    // front of the source (see formatKpiTarget) — there is no obligation.
    expect(target?.sourceKind).toBe("benchmark");
  });

  it("no descriptor prose claims the chip is legally required", () => {
    const kpi = KPI_CATALOG.microchip_penetration;
    for (const prose of [kpi.caveat, kpi.question, kpi.ui?.definition]) {
      expect(prose ?? "").not.toContain("14.107");
      expect(prose ?? "").not.toMatch(/seg[úu]n lo exige la ley|Exigido por/i);
    }
  });
});

describe("resolveMetricLegalBasis", () => {
  it("CABA+TdF+SC mandate: mortality resolves to CABA's Ley 5470, no gap", () => {
    const r = resolveMetricLegalBasis("mortality_disposal_traceability", CABA_TDF_SC);
    expect(r.laws).toEqual(["Ley 5470"]);
    expect(r.hasProvincialGap).toBe(false);
  });

  it("CABA+TdF+SC mandate: ppp resolves ONLY the CABA law, never PBA's", () => {
    const r = resolveMetricLegalBasis("ppp_registry_compliance", CABA_TDF_SC);
    expect(r.laws).toEqual(["Ley 4078"]);
    expect(r.laws.join(" ")).not.toContain("14.107");
    expect(r.hasProvincialGap).toBe(false);
  });

  it("TdF-only mandate: mortality has a provincial gap — CABA's law never leaks", () => {
    const r = resolveMetricLegalBasis("mortality_disposal_traceability", TDF_ONLY);
    expect(r.laws).toEqual([]);
    expect(r.hasProvincialGap).toBe(true);
  });

  it("PBA-only mandate: ppp resolves ONLY the PBA law", () => {
    const r = resolveMetricLegalBasis("ppp_registry_compliance", PBA_ONLY);
    expect(r.laws).toEqual(["Ley Prov. 14.107"]);
  });

  it('admin ("all") gets every registered citation', () => {
    expect(resolveMetricLegalBasis("ppp_registry_compliance", "all").laws).toEqual([
      "Ley 4078",
      "Ley Prov. 14.107",
    ]);
    expect(resolveMetricLegalBasis("mortality_disposal_traceability", "all")).toEqual({
      laws: ["Ley 5470"],
      hasProvincialGap: false,
    });
  });

  it("a metric with no registered legal basis resolves empty without a gap", () => {
    const r = resolveMetricLegalBasis("open_bite_cases", CABA_TDF_SC);
    expect(r.laws).toEqual([]);
    expect(r.hasProvincialGap).toBe(false);
  });
});

describe("formatMetricLegalBasis", () => {
  it("CABA operator: mortality reads 'CABA: Ley 5470'", () => {
    expect(formatMetricLegalBasis("mortality_disposal_traceability", CABA_TDF_SC)).toBe(
      "CABA: Ley 5470",
    );
  });

  it("TdF-only mandate: ppp shows the neutral fallback, never CABA's or PBA's law", () => {
    const out = formatMetricLegalBasis("ppp_registry_compliance", TDF_ONLY);
    expect(out).toBe(PROVINCIAL_GAP_FALLBACK_ES);
    expect(out).not.toContain("14.107");
    expect(out).not.toContain("4078");
    expect(out).not.toContain("PBA");
  });

  it("TdF-only mandate: mortality shows the neutral fallback, never 'Ley 5470'", () => {
    const out = formatMetricLegalBasis("mortality_disposal_traceability", TDF_ONLY);
    expect(out).toBe(PROVINCIAL_GAP_FALLBACK_ES);
    expect(out).not.toContain("5470");
  });

  // Demo review 2026-08-01: this test used to assert a bare province prefix
  // for a NATIONAL view — i.e. it pinned the exact defect a funcionario
  // nacional would read as "a provincial statute is the obligation behind
  // this country-wide number". The citation list is still full and still
  // names the province; what changed is that the national reader is now told
  // the norm's reach BEFORE the province prefixes.
  it('national view ("all") gets the full citation list, qualified as provincial-only', () => {
    expect(formatMetricLegalBasis("mortality_disposal_traceability", "all")).toBe(
      `${NATIONAL_VIEW_PROVINCIAL_ONLY_ES} · CABA: Ley 5470`,
    );
    expect(formatMetricLegalBasis("ppp_registry_compliance", "all")).toBe(
      `${NATIONAL_VIEW_PROVINCIAL_ONLY_ES} · CABA: Ley 4078 · PBA: Ley Prov. 14.107`,
    );
  });

  // NOTE the boundary this test guards, tightened 2026-08-17: it says a REAL
  // obligation is never dropped or swapped to dodge a scope problem. It does
  // NOT say a citation survives its own refutation — microchip_penetration's
  // was deleted outright, and the block at the top of this file fences that.
  // The PPP registry duty these two statutes DO impose is the real thing.
  it("never drops or swaps the law it cites — the obligation is real, only its reach is narrower", () => {
    const out = formatMetricLegalBasis("ppp_registry_compliance", "all");
    expect(out).toContain("Ley Prov. 14.107");
    expect(out).toContain("Ley 4078");
    expect(out).toContain("PBA");
  });

  it("does NOT qualify a province's own view — there the provincial law simply applies", () => {
    expect(formatMetricLegalBasis("ppp_registry_compliance", PBA_ONLY)).not.toContain(
      NATIONAL_VIEW_PROVINCIAL_ONLY_ES,
    );
  });

  // MUTATION SURVIVOR (2026-08-01): deleting the `national` half of the
  // national-view guard changed nothing across the whole suite, because not
  // one entry in METRIC_LEGAL_BASIS declares a national anchor today — the
  // branch was future-proofing nobody could break. These two go through the
  // pure formatter so both sides are exercised against a basis VALUE, without
  // mutating the shared registry. The day a KPI cites a national law, the
  // "no nacional" label must not appear over it.
  it("a metric WITH a national anchor is never labelled provincial-only at national scope", () => {
    const withNationalAnchor = {
      national: ["Ley 22.953"],
      byProvince: { CABA: ["Ley 5470"] },
    };
    const out = formatLegalBasis(withNationalAnchor, "all");
    expect(out).toBe("Ley 22.953 (nacional) · CABA: Ley 5470");
    expect(out).not.toContain(NATIONAL_VIEW_PROVINCIAL_ONLY_ES);
  });

  it("the SAME basis without its national anchor IS labelled provincial-only", () => {
    const provincialOnly = { byProvince: { CABA: ["Ley 5470"] } };
    expect(formatLegalBasis(provincialOnly, "all")).toBe(
      `${NATIONAL_VIEW_PROVINCIAL_ONLY_ES} · CABA: Ley 5470`,
    );
  });

  it("PBA-only mandate: ppp shows PBA's law alone (province IS in mandate)", () => {
    expect(formatMetricLegalBasis("ppp_registry_compliance", PBA_ONLY)).toBe(
      "PBA: Ley Prov. 14.107",
    );
  });

  it("returns null for a metric with no registered legal basis", () => {
    expect(formatMetricLegalBasis("open_bite_cases", CABA_TDF_SC)).toBeNull();
    expect(formatMetricLegalBasis("open_bite_cases", "all")).toBeNull();
  });
});
