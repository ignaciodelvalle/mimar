// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RankedUnit } from "@/src/modules/panorama/domain/ranking";
import { PanoramaDataTable } from "../PanoramaDataTable";

afterEach(cleanup);

const RATE_ROWS: RankedUnit[] = [
  { key: "AR-F", label: "Formosa", value: 31, gap: 49 },
  { key: "AR-H", label: "Chaco", value: 38, gap: 42 },
  { key: "AR-Y", label: "Santiago", value: 40, gap: 40 },
];

describe("PanoramaDataTable — accessible view (Ley 26.653)", () => {
  it("renders a real table with role=table and column headers", () => {
    render(<PanoramaDataTable rows={RATE_ROWS} kind="rate" measureLabel="cobertura" />);
    const table = screen.getByRole("table");
    expect(table).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: /Jurisdicción/ })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: /Brecha vs meta/ })).toBeInTheDocument();
  });

  it("defaults to worst-first (gap descending) and exposes aria-sort", () => {
    render(<PanoramaDataTable rows={RATE_ROWS} kind="rate" measureLabel="cobertura" />);
    const gapHeader = screen.getByRole("columnheader", { name: /Brecha vs meta/ });
    expect(gapHeader).toHaveAttribute("aria-sort", "descending");
    // First data row is the worst gap (Formosa, gap 49).
    const rowHeaders = screen.getAllByRole("rowheader");
    expect(rowHeaders[0]).toHaveTextContent("Formosa");
  });

  it("toggles the sort direction when a header is clicked", () => {
    render(<PanoramaDataTable rows={RATE_ROWS} kind="rate" measureLabel="cobertura" />);
    fireEvent.click(screen.getByRole("button", { name: /Brecha vs meta/ }));
    const gapHeader = screen.getByRole("columnheader", { name: /Brecha vs meta/ });
    expect(gapHeader).toHaveAttribute("aria-sort", "ascending");
    // Ascending gap → smallest gap first (Santiago, gap 40).
    const rowHeaders = screen.getAllByRole("rowheader");
    expect(rowHeaders[0]).toHaveTextContent("Santiago");
  });

  it("fires onSelect from a jurisdiction cell", () => {
    const onSelect = vi.fn();
    render(
      <PanoramaDataTable
        rows={RATE_ROWS}
        kind="rate"
        measureLabel="cobertura"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Chaco" }));
    expect(onSelect).toHaveBeenCalledWith("AR-H");
  });

  it("shows the empty state when there are no rows", () => {
    render(<PanoramaDataTable rows={[]} kind="rate" measureLabel="cobertura" />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    // C4 (2026-07-25): with no `measuredUnits` the table cannot know whether
    // everyone is above target or nothing was measured, so it declares
    // blindness instead of the old unconditional "Sin jurisdicciones bajo meta"
    // all-clear. See PanoramaDataTable.empty.test.tsx for the full branch set.
    expect(screen.getByText(/Sin señales en este alcance/)).toBeInTheDocument();
  });

  it("dataUnavailable: no rows + no data shows an explicit failure state, not the all-clear (trust/safety)", () => {
    render(<PanoramaDataTable rows={[]} kind="rate" measureLabel="cobertura" dataUnavailable />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(/No pudimos calcular el ranking/)).toBeInTheDocument();
    // The invariant this test was written for, unchanged: a failure must never
    // be dressed as good news.
    expect(screen.queryByText(/Ninguna jurisdicción quedó bajo meta/)).not.toBeInTheDocument();
  });

  // Ranking one-list consolidation: the table is now the DEFAULT rendering, so it
  // inherits the map linkage the retired headerless list used to own.
  it("names the value column after the metric (Jurisdicción / <métrica> / Brecha vs meta)", () => {
    render(<PanoramaDataTable rows={RATE_ROWS} kind="rate" measureLabel="cobertura antirrábica" />);
    // The <métrica> column header carries the actual measure, capitalized.
    expect(screen.getByRole("columnheader", { name: /Cobertura antirrábica/ })).toBeInTheDocument();
  });

  it("carries the worst-N heading, reframed for a small scope (scopeFallback)", () => {
    const { rerender } = render(
      <PanoramaDataTable rows={RATE_ROWS} kind="rate" measureLabel="cobertura" />,
    );
    expect(screen.getByRole("heading", { name: /Peores 3 · cobertura/ })).toBeInTheDocument();
    rerender(
      <PanoramaDataTable
        rows={RATE_ROWS}
        kind="rate"
        measureLabel="cobertura"
        scopeFallback
        unitNoun="comunas"
      />,
    );
    // T5.2: count + agreeing plural, no possessive.
    expect(screen.getByRole("heading", { name: /^3 comunas · cobertura/ })).toBeInTheDocument();
  });

  it("bubbles the unit key on row hover and clears it on leave (map sync)", () => {
    const onHover = vi.fn();
    render(
      <PanoramaDataTable rows={RATE_ROWS} kind="rate" measureLabel="cobertura" onHover={onHover} />,
    );
    // Row header cell carries the jurisdiction; hover fires on its <tr>.
    const row = screen.getByRole("rowheader", { name: "Formosa" }).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.mouseEnter(row as Element);
    expect(onHover).toHaveBeenCalledWith("AR-F");
    fireEvent.mouseLeave(row as Element);
    expect(onHover).toHaveBeenCalledWith(null);
  });

  it("marks the highlighted row with aria-current (map→row sync)", () => {
    render(
      <PanoramaDataTable
        rows={RATE_ROWS}
        kind="rate"
        measureLabel="cobertura"
        highlightedKey="AR-H"
      />,
    );
    const chacoRow = screen.getByRole("rowheader", { name: "Chaco" }).closest("tr");
    const formosaRow = screen.getByRole("rowheader", { name: "Formosa" }).closest("tr");
    expect(chacoRow).toHaveAttribute("aria-current", "true");
    expect(formosaRow).not.toHaveAttribute("aria-current");
  });
});

// ---------------------------------------------------------------------------
// POLARITY (2026-07-26). This table RE-SORTS the rows it is handed, so the
// domain ranking's polarity died here: `rankWorstUnits` returns a
// higher-is-better layer worst-first (lowest value), and the default `value`
// DESC sort then put the BEST unit at row 1 under a "Peores N" heading. A unit
// test on rankWorstUnits alone stays green through that bug — this is the
// surface where the order becomes visible.
// ---------------------------------------------------------------------------

/** acceso-veterinario shape: actos/1.000, where MORE is better. Handed over in
 *  the domain's worst-first order (ascending), as rankWorstUnits produces. */
const HIGHER_IS_BETTER_ROWS: RankedUnit[] = [
  { key: "AR-A", label: "Salta", value: 690.9, gap: null },
  { key: "AR-Q", label: "Neuquén", value: 1145.4, gap: null },
  { key: "AR-M", label: "Mendoza", value: 1997.9, gap: null },
];

describe("PanoramaDataTable — higher-is-better polarity", () => {
  it("keeps the LEAST-served unit first — the heading says 'Peores', so the order must too", () => {
    render(
      <PanoramaDataTable
        rows={HIGHER_IS_BETTER_ROWS}
        kind="density"
        measureLabel="acceso veterinario (actos/1.000)"
        higherIsBetter
      />,
    );
    const rowHeaders = screen.getAllByRole("rowheader");
    expect(rowHeaders[0]).toHaveTextContent("Salta");
    expect(rowHeaders[rowHeaders.length - 1]).toHaveTextContent("Mendoza");
    // The value column announces the ascending order it actually renders.
    expect(screen.getByRole("columnheader", { name: /acceso veterinario/i })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("still ranks a harm magnitude highest-first (the default is untouched)", () => {
    // Identical rows, identical kind — ONLY the polarity flag differs.
    render(
      <PanoramaDataTable
        rows={HIGHER_IS_BETTER_ROWS}
        kind="density"
        measureLabel="mortalidad registrada"
      />,
    );
    const rowHeaders = screen.getAllByRole("rowheader");
    expect(rowHeaders[0]).toHaveTextContent("Mendoza");
    expect(rowHeaders[rowHeaders.length - 1]).toHaveTextContent("Salta");
  });

  it("lets the operator still flip the order by hand", () => {
    render(
      <PanoramaDataTable
        rows={HIGHER_IS_BETTER_ROWS}
        kind="density"
        measureLabel="acceso veterinario (actos/1.000)"
        higherIsBetter
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /acceso veterinario/i }));
    expect(screen.getAllByRole("rowheader")[0]).toHaveTextContent("Mendoza");
  });
});
