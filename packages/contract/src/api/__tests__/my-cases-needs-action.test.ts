// The owner's casos, grouped by whose turn it is (PO decision 2026-10-06).
//
// THE TABLE IS PINNED WHOLE, ON PURPOSE. `MY_CASE_ROW_NEEDS_ACTION` is a
// `Record` over the kind union, so a new kind already fails to compile until it
// is classified. What the compiler cannot say is that the classification is the
// one the PO decided: this file does, kind by kind, so moving a kind between
// "Te toca a vos" and "En curso" is a reviewed change to this list and never a
// quiet edit to the table.

import { describe, expect, it } from "vitest";

import {
  MY_CASE_ROW_KINDS_V1,
  MY_CASE_ROW_NEEDS_ACTION,
  caseKindNeedsAction,
  clusterCaseRowsByPet,
  splitOpenCaseRows,
} from "../my-cases.ts";

const DECIDED: Record<(typeof MY_CASE_ROW_KINDS_V1)[number], boolean> = {
  foster_proposal_pending: true,
  pet_lost: true,
  custody_transfer_pending: true,
  dangerous_breed_pending_attestation: true,
  welfare_report_open: false,
  adoption_application_pending: false,
  approval_request_pending: false,
  custody_dispute_open: false,
  bite_observation_open: false,
  case_generic_open: false,
  foster_proposal_resolved: false,
  welfare_report_closed: false,
  adoption_application_resolved: false,
  approval_request_decided: false,
};

describe("MY_CASE_ROW_NEEDS_ACTION — every kind is classified", () => {
  it("classifies exactly the kinds the list can carry, no more and no fewer", () => {
    expect(Object.keys(MY_CASE_ROW_NEEDS_ACTION).sort()).toEqual([...MY_CASE_ROW_KINDS_V1].sort());
  });

  it.each(MY_CASE_ROW_KINDS_V1.map((kind) => [kind, DECIDED[kind]] as const))(
    "%s → needsAction %s",
    (kind, expected) => {
      expect(MY_CASE_ROW_NEEDS_ACTION[kind]).toBe(expected);
      expect(caseKindNeedsAction(kind)).toBe(expected);
    },
  );

  it("puts the owner on the hook for four kinds only", () => {
    expect(MY_CASE_ROW_KINDS_V1.filter((k) => MY_CASE_ROW_NEEDS_ACTION[k]).sort()).toEqual(
      [
        "custody_transfer_pending",
        "dangerous_breed_pending_attestation",
        "foster_proposal_pending",
        "pet_lost",
      ].sort(),
    );
  });

  it("answers false for a kind this build has never heard of", () => {
    expect(caseKindNeedsAction("some_future_kind")).toBe(false);
  });
});

type Row = {
  label: string;
  needsAction: boolean;
  dueAt: string | null;
  since: string;
  petId: string | null;
  petName: string | null;
  petPhotoUrl: string | null;
};

function row(label: string, overrides: Partial<Row> = {}): Row {
  return {
    label,
    needsAction: false,
    dueAt: null,
    since: "2026-10-01T12:00:00.000Z",
    petId: null,
    petName: null,
    petPhotoUrl: null,
    ...overrides,
  };
}

describe("splitOpenCaseRows", () => {
  it("puts the owner's turn first: earliest deadline, then newest; the rest newest first", () => {
    const rows = [
      row("waiting-old", { since: "2026-09-01T12:00:00.000Z" }),
      row("turn-no-due-new", { needsAction: true, since: "2026-10-05T12:00:00.000Z" }),
      row("turn-due-late", { needsAction: true, dueAt: "2026-10-20T12:00:00.000Z" }),
      row("waiting-new", { since: "2026-10-04T12:00:00.000Z" }),
      row("turn-due-soon", { needsAction: true, dueAt: "2026-10-08T12:00:00.000Z" }),
      row("turn-no-due-old", { needsAction: true, since: "2026-09-15T12:00:00.000Z" }),
    ];
    const { yourTurn, inProgress } = splitOpenCaseRows(rows);
    expect(yourTurn.map((r) => r.label)).toEqual([
      "turn-due-soon",
      "turn-due-late",
      "turn-no-due-new",
      "turn-no-due-old",
    ]);
    expect(inProgress.map((r) => r.label)).toEqual(["waiting-new", "waiting-old"]);
  });

  it("reads the web's Dates and the wire's ISO strings alike", () => {
    const { yourTurn } = splitOpenCaseRows([
      { needsAction: true, dueAt: null, since: new Date("2026-09-01T00:00:00Z") },
      { needsAction: true, dueAt: new Date("2026-12-01T00:00:00Z"), since: new Date(0) },
    ]);
    expect(yourTurn[0]?.dueAt).toEqual(new Date("2026-12-01T00:00:00Z"));
  });
});

describe("clusterCaseRowsByPet", () => {
  it("gathers one pet's rows where it first appears and keeps account-level rows apart", () => {
    const pampa = { petId: "DIM-PAMP-0001", petName: "Pampa", petPhotoUrl: "https://x/p.jpg" };
    const toto = { petId: "DIM-TOTO-0002", petName: "Toto", petPhotoUrl: null };
    const clusters = clusterCaseRowsByPet([
      row("pampa-1", pampa),
      row("denuncia"),
      row("toto-1", toto),
      row("pampa-2", pampa),
      row("aprobacion"),
    ]);
    expect(clusters.map((c) => [c.petName, c.rows.map((r) => r.label)])).toEqual([
      ["Pampa", ["pampa-1", "pampa-2"]],
      [null, ["denuncia"]],
      ["Toto", ["toto-1"]],
      [null, ["aprobacion"]],
    ]);
    expect(clusters[0]?.petPhotoUrl).toBe("https://x/p.jpg");
  });
});
