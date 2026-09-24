import { describe, expect, it } from "@jest/globals";

import type { MyCaseRowV1, MyCasesV1 } from "@dim/contract/api";

import {
  caseCountLabel,
  caseDateLabel,
  caseRowAccessibilityLabel,
  hasOpenCases,
  historyTruncationNote,
} from "./cases-view-model";

function aRow(over: Partial<MyCaseRowV1> = {}): MyCaseRowV1 {
  return {
    kind: "case_generic_open",
    title: "Caso CAS-TEST-0001 · Pampa",
    subtitle: "Episodio de custodia",
    severity: "info",
    since: "2026-09-01T12:00:00.000Z",
    route: "/casos/CAS-TEST-0001",
    ...over,
  };
}

function payload(over: Partial<MyCasesV1> = {}): MyCasesV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-09-24T00:00:00.000Z",
    staleAfter: "2026-09-24T00:01:00.000Z",
    open: [],
    history: { rows: [], hasMore: false },
    ...over,
  };
}

describe("cases view model", () => {
  it("counts like the web's widget", () => {
    expect(caseCountLabel(1)).toBe("1 caso");
    expect(caseCountLabel(3)).toBe("3 casos");
  });

  it("does not invent a date for an unreadable instant", () => {
    expect(caseDateLabel("not a date")).toBe("fecha desconocida");
  });

  it("reads a row as one sentence, and says when it opens nothing", () => {
    const opens = caseRowAccessibilityLabel(aRow());
    expect(opens.startsWith("Caso CAS-TEST-0001 · Pampa. Episodio de custodia.")).toBe(true);
    expect(opens).not.toContain("web");

    const inert = caseRowAccessibilityLabel(aRow({ route: null, subtitle: "" }));
    expect(inert).toContain("Se ve en la web");
    // An empty second line is not read as an empty sentence.
    expect(inert).not.toContain(". .");
  });

  it("draws the Mis mascotas block only when something is open", () => {
    expect(hasOpenCases(null)).toBe(false);
    expect(hasOpenCases(payload())).toBe(false);
    expect(hasOpenCases(payload({ open: [aRow()] }))).toBe(true);
  });

  it("says when older history exists instead of presenting the page as the set", () => {
    expect(historyTruncationNote(payload())).toBe(null);
    const note = historyTruncationNote(
      payload({ history: { rows: [aRow(), aRow()], hasMore: true } }),
    );
    expect(note).toContain("últimos 2");
  });
});
