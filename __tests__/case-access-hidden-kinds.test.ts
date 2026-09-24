// isHiddenFromSubjectKind — the shared predicate that closes the
// welfare_denuncia leak (pet-document-redesign privacy fix, REQ-1.1/1.3).
//
// Positive case: welfare_denuncia -> true.
// Negative case: every other case kind (including lost_pet_episode and
// bite_incident, which are handled by separate exclusion mechanisms) -> false.

import { describe, expect, it } from "vitest";

import { HIDDEN_FROM_SUBJECT_CASE_KINDS, isHiddenFromSubjectKind } from "@/lib/infra/case-access";
import { CASE_KINDS, type CaseKind } from "@/src/modules/cases/domain/case-kinds";

describe("isHiddenFromSubjectKind", () => {
  it("returns true for welfare_denuncia", () => {
    expect(isHiddenFromSubjectKind("welfare_denuncia")).toBe(true);
  });

  it("returns false for every other case kind", () => {
    const otherKinds = CASE_KINDS.filter((k): k is CaseKind => k !== "welfare_denuncia");
    for (const kind of otherKinds) {
      expect(isHiddenFromSubjectKind(kind), `${kind} must not be hidden from subject`).toBe(false);
    }
  });

  it("returns false for an unknown/malformed kind string", () => {
    expect(isHiddenFromSubjectKind("not-a-real-kind")).toBe(false);
  });

  it("HIDDEN_FROM_SUBJECT_CASE_KINDS contains exactly welfare_denuncia", () => {
    expect(Array.from(HIDDEN_FROM_SUBJECT_CASE_KINDS)).toEqual(["welfare_denuncia"]);
  });
});
