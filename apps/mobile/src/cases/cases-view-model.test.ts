import { describe, expect, it } from "@jest/globals";

import type { MyCaseRowV1, MyCasesV1 } from "@dim/contract/api";

import {
  caseCountLabel,
  caseDateLabel,
  caseDueLabel,
  caseRowAccessibilityLabel,
  hasOpenCases,
  historyTruncationNote,
  normalizeCaseRow,
  normalizeMyCases,
  petClusterAccessibilityLabel,
} from "./cases-view-model";

function aRow(over: Partial<MyCaseRowV1> = {}): MyCaseRowV1 {
  return {
    kind: "case_generic_open",
    title: "Caso CAS-TEST-0001 · Pampa",
    subtitle: "Episodio de custodia",
    severity: "info",
    since: "2026-09-01T12:00:00.000Z",
    route: "/casos/CAS-TEST-0001",
    petId: null,
    petName: null,
    petPhotoUrl: null,
    needsAction: false,
    dueAt: null,
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

  it("names a deadline, and reads it as part of the row", () => {
    expect(caseDueLabel(aRow())).toBe(null);
    const due = aRow({ dueAt: "2026-10-09T15:00:00.000Z" });
    expect(caseDueLabel(due)).toBe(`Vence el ${caseDateLabel("2026-10-09T15:00:00.000Z")}`);
    expect(caseRowAccessibilityLabel(due)).toContain("Vence el");
  });

  it("names the pet in the row's sentence, unless the cluster head already does", () => {
    const luna = aRow({
      title: "Tu postulación",
      subtitle: "",
      petId: "DIM-LUNA-0003",
      petName: "Luna",
    });
    expect(caseRowAccessibilityLabel(luna)).toContain("Tu postulación. Luna.");
    expect(caseRowAccessibilityLabel(luna, { withPet: false })).not.toContain("Luna");
    // An account-level row has no pet to name.
    expect(caseRowAccessibilityLabel(aRow())).not.toContain("null");
  });

  it("reads a pet's cluster head as one sentence", () => {
    expect(petClusterAccessibilityLabel("Pampa", 2)).toBe("Pampa, 2 casos");
  });

  it("tolerates a payload from a server that predates the grouping", () => {
    // What an older deployment answers: payloadVersion 1, none of the new keys.
    const legacy = {
      kind: "pet_lost",
      title: "Pampa está reportada como perdida",
      subtitle: "Avisanos cuando aparezca",
      severity: "urgent",
      since: "2026-09-01T12:00:00.000Z",
      route: "/mascotas/DIM-PAMP-0001",
    } as unknown as MyCaseRowV1;
    expect(normalizeCaseRow(legacy)).toEqual({
      ...legacy,
      petId: null,
      petName: null,
      petPhotoUrl: null,
      // The turn falls back to the contract's own table, not to a guess.
      needsAction: true,
      dueAt: null,
    });
    const waiting = normalizeCaseRow({
      ...legacy,
      kind: "welfare_report_open",
    } as unknown as MyCaseRowV1);
    expect(waiting.needsAction).toBe(false);

    const whole = normalizeMyCases(
      payload({ open: [legacy], history: { rows: [legacy], hasMore: false } }),
    );
    expect(whole.open[0]?.petId).toBe(null);
    expect(whole.history.rows[0]?.needsAction).toBe(true);
  });

  it("keeps what a current server decided, even where the table would say otherwise", () => {
    const row = normalizeCaseRow(aRow({ kind: "pet_lost", needsAction: false }));
    expect(row.needsAction).toBe(false);
  });

  it("says when older history exists instead of presenting the page as the set", () => {
    expect(historyTruncationNote(payload())).toBe(null);
    const note = historyTruncationNote(
      payload({ history: { rows: [aRow(), aRow()], hasMore: true } }),
    );
    expect(note).toContain("últimos 2");
  });
});
