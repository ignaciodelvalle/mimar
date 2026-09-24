// WP5 / D3 — AlertInboxTable renders the "observado X · meta Y" format.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type AlertInboxRow, AlertInboxTable } from "@/components/admin/AlertInboxTable";

function fakeRow(overrides: Partial<AlertInboxRow> = {}): AlertInboxRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    subscriptionId: "00000000-0000-0000-0000-000000000002",
    metricKey: "sterilization_coverage_pct",
    direction: "below",
    threshold: "70",
    observedValue: "38",
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Comuna 1",
    status: "disparada",
    firedAt: new Date("2026-06-20T00:00:00Z"),
    investigationCode: null,
    ...overrides,
  } as unknown as AlertInboxRow;
}

describe("AlertInboxTable — observado · meta format (D3)", () => {
  it("renders 'observado 38 · meta 70', not a bare '38 ≤ 70' comparison", () => {
    const html = renderToStaticMarkup(<AlertInboxTable rows={[fakeRow()]} />);
    expect(html).toContain("observado");
    expect(html).toContain("meta");
    expect(html).toContain("38");
    expect(html).toContain("70");
    // The old comparison glyphs are gone.
    expect(html).not.toContain("≤");
    expect(html).not.toContain("≥");
  });

  it("keeps the empty state when there are no rows", () => {
    const html = renderToStaticMarkup(<AlertInboxTable rows={[]} />);
    expect(html.toLowerCase()).toContain("sin alertas");
  });
});
