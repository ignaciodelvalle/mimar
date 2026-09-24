// The compliance card must not give "cerradas en el período" two meanings
// (demo review 2026-08-01, finding #6).

import { describe, expect, it } from "vitest";

import {
  type RabiesComplianceFacts,
  rabiesComplianceRows,
} from "@/app/gob/vigilancia/_components/rabies-compliance-rows";
import { rabiesComplianceHeadline } from "@/lib/metrics";

const pct = (v: number | null) => (v === null ? "—" : `${v}%`);

/** The two live scopes from the review. */
const NACIONAL: RabiesComplianceFacts = {
  closed: 16,
  closedWithinWindow: 3,
  compliancePct: 18.8,
  openBreaches: 0,
};
const CABA: RabiesComplianceFacts = {
  closed: 4,
  closedWithinWindow: 3,
  compliancePct: 75,
  openBreaches: 0,
};

describe("rabiesComplianceRows", () => {
  it("'Cerradas en el período' carries the SAME number the KPI tile publishes", () => {
    // THE FINDING: the tile said "18,8% · 16 cerradas en el período" and the
    // card said "Cerradas en el período 3/16" — three words, two meanings, one
    // card apart, on a legal-compliance metric. The tile was right (18.8% is
    // 3/16); the card's term was labelling the in-window subset as the total.
    for (const facts of [NACIONAL, CABA]) {
      const rows = rabiesComplianceRows(facts, pct);
      const closedRow = rows.find((r) => r.term === "Cerradas en el período");
      expect(closedRow?.value).toBe(String(facts.closed));

      const tile = rabiesComplianceHeadline(facts, pct);
      // The tile's sub line is "N cerradas en el período" — the card's row of
      // the same name must be readable as the very same statement.
      expect(tile.sub).toContain(`${facts.closed} cerrada`);
      expect(tile.sub).not.toContain(`${facts.closedWithinWindow} cerrada`);
    }
  });

  it("the in-window subset is a row of its OWN, and says it is a subset", () => {
    const rows = rabiesComplianceRows(NACIONAL, pct);
    const withinRow = rows.find((r) => r.term.includes("dentro del plazo"));
    expect(withinRow?.value).toBe("3");
    expect(withinRow?.term).toMatch(/^De esas/);
    expect(withinRow?.term).toContain("10 días");
  });

  it("no two rows share a term — every number on the card is named once", () => {
    const rows = rabiesComplianceRows(NACIONAL, pct);
    expect(new Set(rows.map((r) => r.term)).size).toBe(rows.length);
    // And no row smuggles the old "numerator/denominator" pair back into one
    // cell, which is what made the ambiguity possible in the first place.
    for (const row of rows) expect(row.value).not.toContain("/");
  });

  it("the compliance percentage is the ratio the two count rows describe", () => {
    // If a reader divides the two counts they must land on the headline figure;
    // otherwise the card is three numbers that do not reconcile.
    for (const facts of [NACIONAL, CABA]) {
      const rows = rabiesComplianceRows(facts, pct);
      const closed = Number(rows.find((r) => r.term === "Cerradas en el período")?.value);
      const within = Number(rows.find((r) => r.term.includes("dentro del plazo"))?.value);
      const shown = rows.find((r) => r.term === "Cumplimiento 10 días")?.value;
      expect(shown).toBe(`${Math.round((within / closed) * 1000) / 10}%`);
    }
  });

  it("a period with no closures shows the em-dash, not a fabricated 0%", () => {
    const rows = rabiesComplianceRows(
      { closed: 0, closedWithinWindow: 0, compliancePct: null, openBreaches: 2 },
      pct,
    );
    expect(rows.find((r) => r.term === "Cumplimiento 10 días")?.value).toBe("—");
    expect(rows.find((r) => r.term === "Cerradas en el período")?.value).toBe("0");
  });

  it("a live breach count is flagged for the danger colour", () => {
    const clean = rabiesComplianceRows(NACIONAL, pct).find((r) => r.term === "Abiertas > 10 días");
    expect(clean?.danger).toBe(false);
    const breached = rabiesComplianceRows({ ...NACIONAL, openBreaches: 2 }, pct).find(
      (r) => r.term === "Abiertas > 10 días",
    );
    expect(breached).toMatchObject({ value: "2", danger: true });
  });
});
