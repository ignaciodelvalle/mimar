// Unit tests for the operator bulk-select state machine (Wave 2 Item 10.2).
//
// These are the pure functions behind OpBulkBar + the queue checkbox columns.
// No DB, no DOM — just the selection transitions and the destructive-confirm
// reason gate.

import { describe, expect, it } from "vitest";

import {
  isPageFullySelected,
  isReasonValid,
  selectionSummary,
  toggleSelectPage,
  toggleSelection,
} from "@/lib/domain/bulk-select";

describe("toggleSelection", () => {
  it("adds an id not currently selected", () => {
    const next = toggleSelection(new Set<string>(), "a");
    expect(next.has("a")).toBe(true);
    expect(next.size).toBe(1);
  });

  it("removes an id already selected", () => {
    const next = toggleSelection(new Set(["a", "b"]), "a");
    expect(next.has("a")).toBe(false);
    expect(next.has("b")).toBe(true);
  });

  it("returns a new Set without mutating the input", () => {
    const input = new Set(["a"]);
    const next = toggleSelection(input, "b");
    expect(input.size).toBe(1); // unchanged
    expect(next.size).toBe(2);
  });
});

describe("toggleSelectPage", () => {
  const page = ["a", "b", "c"];

  it("selects all page ids when none are selected", () => {
    const next = toggleSelectPage(new Set<string>(), page);
    expect([...next].sort()).toEqual(["a", "b", "c"]);
  });

  it("selects all page ids when only some are selected", () => {
    const next = toggleSelectPage(new Set(["a"]), page);
    expect([...next].sort()).toEqual(["a", "b", "c"]);
  });

  it("clears the selection when every page id is already selected", () => {
    const next = toggleSelectPage(new Set(["a", "b", "c"]), page);
    expect(next.size).toBe(0);
  });

  it("treats an empty page as never fully selected (selects nothing)", () => {
    const next = toggleSelectPage(new Set<string>(), []);
    expect(next.size).toBe(0);
  });
});

describe("isPageFullySelected", () => {
  it("is false for an empty page", () => {
    expect(isPageFullySelected(new Set(["a"]), [])).toBe(false);
  });

  it("is true only when all page ids are selected", () => {
    expect(isPageFullySelected(new Set(["a", "b"]), ["a", "b"])).toBe(true);
    expect(isPageFullySelected(new Set(["a"]), ["a", "b"])).toBe(false);
  });
});

describe("isReasonValid — destructive-confirm reason gate", () => {
  it("rejects reasons shorter than the default 5 chars", () => {
    expect(isReasonValid("ok")).toBe(false);
    expect(isReasonValid("    ")).toBe(false);
    expect(isReasonValid("four")).toBe(false);
  });

  it("accepts reasons at or above 5 chars by default", () => {
    expect(isReasonValid("valid")).toBe(true);
    expect(isReasonValid("a long enough motivo")).toBe(true);
  });

  it("trims whitespace before measuring", () => {
    expect(isReasonValid("   abc   ")).toBe(false); // 3 chars
    expect(isReasonValid("   abcde   ")).toBe(true); // 5 chars
  });

  it("honors a custom minimum (revoke flow uses 30)", () => {
    expect(isReasonValid("too short for revoke", 30)).toBe(false);
    expect(isReasonValid("this motivo is definitely over thirty chars", 30)).toBe(true);
  });
});

describe("selectionSummary", () => {
  it("uses singular for exactly one", () => {
    expect(selectionSummary(1)).toBe("1 seleccionado");
  });

  it("uses plural for zero and many", () => {
    expect(selectionSummary(0)).toBe("0 seleccionados");
    expect(selectionSummary(3)).toBe("3 seleccionados");
  });
});
