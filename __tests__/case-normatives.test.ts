// Coverage + sanity tests for case normatives.
//
// Enforces:
//  - Every CASE_KIND has at least one entry (the static load-time check
//    in lib/case-normatives.ts would already throw; we duplicate it here
//    for a clean test failure if someone wraps that throw away).
//  - getNormativesForCase returns country-wide laws for unmatched
//    province/locality.
//  - CABA bite_incident surfaces Ord. 41.831.
//  - welfare_denuncia surfaces Ley 14.346 nationwide.

import { describe, expect, it } from "vitest";

import { CASE_NORMATIVES, getNormativesForCase } from "@/lib/domain/case-normatives";
import { CASE_KINDS } from "@/src/modules/cases/domain/case-kinds";

describe("CASE_NORMATIVES — coverage", () => {
  for (const kind of CASE_KINDS) {
    it(`has at least one entry for ${kind}`, () => {
      const entries = CASE_NORMATIVES.filter((n) => n.kind === kind);
      expect(entries.length).toBeGreaterThan(0);
    });
  }
});

describe("getNormativesForCase — hierarchy", () => {
  it("returns country-wide laws when province/locality don't have specific entries", () => {
    const result = getNormativesForCase("bite_incident", {
      country: "AR",
      province: "Mendoza",
      locality: "Godoy Cruz",
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((law) => law.id === "ley_15465_60_decreto_3640_64")).toBe(true);
  });

  it("CABA bite_incident surfaces Ordenanza 41.831", () => {
    const result = getNormativesForCase("bite_incident", {
      country: "AR",
      province: "CABA",
      locality: "CABA",
    });
    const hasOrd = result.some(
      (law) => /41[.\s-]?831/.test(law.label) || /41[.\s-]?831/.test(law.id),
    );
    expect(hasOrd).toBe(true);
  });

  it("Buenos Aires bite_incident surfaces Decreto 4669/1973 PBA", () => {
    const result = getNormativesForCase("bite_incident", {
      country: "AR",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    expect(result.some((law) => law.id === "decreto_4669_1973_pba")).toBe(true);
  });

  it("welfare_denuncia surfaces Ley 14.346 nationwide", () => {
    const result = getNormativesForCase("welfare_denuncia", {
      country: "AR",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    expect(result.some((law) => law.id === "ley_nacional_14346_1954")).toBe(true);
  });

  it("dedupes laws when same id appears at multiple jurisdiction levels", () => {
    const result = getNormativesForCase("welfare_denuncia", {
      country: "AR",
    });
    const ids = result.map((l) => l.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });
});

describe("CASE_NORMATIVES — copy is user-facing, never spec-speak", () => {
  // Every label/scope renders VERBATIM on the public case page. One entry
  // shipped with a raw column name in backticks ("Detalle en
  // `external_proceeding_reference` del dispute") and an English legalism
  // ("Proceeding") — read by a pet owner on their own dispute (9-role
  // external run, 2026-08-18). This bans the SUBJECT — schema identifiers
  // and code formatting in any entry — not that one spelling.
  it("no label or scope contains backticks or snake_case identifiers", () => {
    expect(CASE_NORMATIVES.length).toBeGreaterThan(0); // non-vacuity
    for (const entry of CASE_NORMATIVES) {
      for (const law of entry.laws) {
        for (const text of [law.label, law.scope ?? ""]) {
          expect(text, `${entry.kind}/${law.id} has a backtick`).not.toContain("`");
          expect(
            /\b[a-z]+_[a-z_]+\b/.test(text),
            `${entry.kind}/${law.id} leaks a snake_case identifier: "${text}"`,
          ).toBe(false);
        }
      }
    }
  });
});
