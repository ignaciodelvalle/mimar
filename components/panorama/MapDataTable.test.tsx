// @vitest-environment jsdom
//
// MapDataTable — Round-2 review #3a: the "Capa" column repeats the SAME
// value on every row when a single layer is active — zero information, pure
// noise. Pins: the column hides when exactly one layer produced rows, and
// stays (to disambiguate) when 2+ layers are active. The CSV export is
// unaffected (buildMapTableCsv always keeps Capa — a self-contained file has
// no adjacent "1 capa" context to lean on).

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MapDataTable } from "./MapDataTable";
import { type MapTableRow, buildMapTableCsv } from "./map-table-csv";

afterEach(cleanup);

const ONE_LAYER: MapTableRow[] = [
  { layer: "Cobertura antirrábica", unit: "Salta", value: "64,4 %" },
  { layer: "Cobertura antirrábica", unit: "Jujuy", value: "58,1 %" },
];

const TWO_LAYERS: MapTableRow[] = [
  { layer: "Cobertura antirrábica", unit: "Salta", value: "64,4 %" },
  { layer: "Mordeduras", unit: "Salta", value: "12" },
];

describe("MapDataTable — Capa column gated on active-layer count (Round-2 review #3a)", () => {
  it("hides the Capa column and cells when exactly one layer produced rows", () => {
    render(<MapDataTable rows={ONE_LAYER} caption="cap" filename="f" />);

    expect(screen.queryByRole("columnheader", { name: "Capa" })).not.toBeInTheDocument();
    expect(screen.queryByText("Cobertura antirrábica")).not.toBeInTheDocument();
    // The other columns are unaffected.
    expect(screen.getByRole("columnheader", { name: "Unidad" })).toBeInTheDocument();
    expect(screen.getByText("Salta")).toBeInTheDocument();
  });

  it("keeps the Capa column when 2+ layers produced rows (disambiguates)", () => {
    render(<MapDataTable rows={TWO_LAYERS} caption="cap" filename="f" />);

    expect(screen.getByRole("columnheader", { name: "Capa" })).toBeInTheDocument();
    expect(screen.getAllByText("Cobertura antirrábica").length).toBeGreaterThan(0);
    expect(screen.getByText("Mordeduras")).toBeInTheDocument();
  });

  it("CSV export keeps the Capa column regardless of on-screen visibility", () => {
    const csv = buildMapTableCsv(ONE_LAYER);
    expect(csv.split("\r\n")[0]).toBe("Capa,Unidad,Valor,Brecha vs meta");
    expect(csv).toContain("Cobertura antirrábica,Salta,");
  });
});

// The on-screen table is the ACCESSIBLE MIRROR of the map. Exporting the gap to
// CSV while withholding it on screen hands a screen-reader user the value but
// not the comparison — the exact asymmetry this table exists to fix.
//
// Assertions read the rendered ROW CELLS, not getByText: a `title`/aria-only
// string would satisfy a text query while staying invisible on screen.
const GAP_ROWS: MapTableRow[] = [
  { layer: "Cobertura antirrábica", unit: "Salta", value: "64,4 %", gap: "−15,6" },
  // Same layer, no target reachable for this cell → the comparison is ABSENT.
  { layer: "Cobertura antirrábica", unit: "Jujuy", value: "58,1 %" },
];

/**
 * GAP_ROWS with the gap removed and NOTHING else changed — same layer, same
 * units, same values. The single-axis control for the column-omission test.
 */
const NO_GAP_ROWS: MapTableRow[] = [
  { layer: "Cobertura antirrábica", unit: "Salta", value: "64,4 %" },
  { layer: "Cobertura antirrábica", unit: "Jujuy", value: "58,1 %" },
];

/** The visible text of every <td>/<th> in the row that names `unit`. */
function rowCellsFor(unit: string): string[] {
  const cell = screen.getByRole("rowheader", { name: unit });
  const tr = cell.closest("tr");
  if (!tr) throw new Error(`no row for ${unit}`);
  return [...tr.querySelectorAll("td,th")].map((c) => c.textContent ?? "");
}

describe("MapDataTable — Brecha vs meta column (accessible mirror of the map)", () => {
  it("renders the gap column header when a row carries a target comparison", () => {
    render(<MapDataTable rows={GAP_ROWS} caption="cap" filename="f" />);
    expect(screen.getByRole("columnheader", { name: "Brecha vs meta" })).toBeInTheDocument();
  });

  it("shows the signed gap in the row's own cell (same string the CSV exports)", () => {
    render(<MapDataTable rows={GAP_ROWS} caption="cap" filename="f" />);
    expect(rowCellsFor("Salta")).toContain("−15,6");
  });

  it("leaves the cell EMPTY when the row has no target — never a '0' that reads as on-target", () => {
    render(<MapDataTable rows={GAP_ROWS} caption="cap" filename="f" />);
    const cells = rowCellsFor("Jujuy");
    expect(cells).toContain("");
    expect(cells).not.toContain("0");
  });

  it("omits the column entirely when no active layer has a compliance target", () => {
    // H8.3: this used to render TWO_LAYERS, which differs from GAP_ROWS on TWO
    // axes — no gap AND a second layer. If `showGapColumn` ever coupled to the
    // active-layer count instead of the presence of a gap, the test would still
    // pass and nobody would learn. NO_GAP_ROWS is GAP_ROWS with the gap removed
    // and nothing else changed, so the ONE varying axis is the one under test.
    render(<MapDataTable rows={NO_GAP_ROWS} caption="cap" filename="f" />);
    expect(screen.queryByRole("columnheader", { name: "Brecha vs meta" })).not.toBeInTheDocument();
    // Positive anchor: an empty table renders no columnheader at all, so the
    // negative above would also pass on a table that rendered nothing. Proving
    // the table IS there is what makes the absence meaningful.
    expect(screen.getByRole("columnheader", { name: "Unidad" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Salta" })).toBeInTheDocument();
  });

  it("still omits the column with 2+ layers and no target (the count is not the trigger)", () => {
    render(<MapDataTable rows={TWO_LAYERS} caption="cap" filename="f" />);
    expect(screen.queryByRole("columnheader", { name: "Brecha vs meta" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Capa" })).toBeInTheDocument();
  });
});

describe("MapDataTable — Valor column names the metric (cowork QA ronda 3 §3)", () => {
  it("names the Valor column '(conteo)' for a single locality-rate metric", () => {
    render(
      <MapDataTable
        rows={ONE_LAYER}
        caption="cap"
        filename="f"
        metrics={[{ label: "Cobertura antirrábica", dataType: "rate", level: "locality" }]}
      />,
    );
    expect(
      screen.getByRole("columnheader", { name: "Cobertura antirrábica (conteo)" }),
    ).toBeInTheDocument();
    // The bare, mislabeled "Valor" header is gone.
    expect(screen.queryByRole("columnheader", { name: "Valor" })).not.toBeInTheDocument();
  });

  it("keeps a generic 'Valor' header when metrics are not provided", () => {
    render(<MapDataTable rows={ONE_LAYER} caption="cap" filename="f" />);
    expect(screen.getByRole("columnheader", { name: "Valor" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// UX audit 2026-07-26 (finding 2) — the zero-row state told ONE story for
// several opposite causes.
//
// Live repro (CABA · vista Bienestar): the CABA inset drill lands the camera at
// z=11, which flips denuncias into the near-zoom POINTS band. Points are
// individual records, not per-unit cells, so this table gets zero rows and
// printed "Sin datos por unidad para las capas activas en este alcance." —
// while the KPI read 39 denuncias, the map painted ~20 bubbles and the
// Estadísticas ranking said "20 comunas SÍ reportaron". Zooming out one step
// (z=9) restored 21 rows from the SAME scope and period.
//
// "Sin datos" is a claim about the WORLD; this was a fact about the ZOOM. Same
// class of defect as the ranking's suppression-vs-no-signal collapse.
// ---------------------------------------------------------------------------

describe("MapDataTable — the empty state names WHY it is empty (UX audit 2026-07-26)", () => {
  it("says the layers are drawing individual records at this zoom, not that there is no data", () => {
    render(
      <MapDataTable
        rows={[]}
        caption="cap"
        filename="f"
        pointModeLayers={["Denuncias de bienestar"]}
      />,
    );

    expect(screen.getByText(/registros individuales/i)).toBeInTheDocument();
    expect(screen.getByText(/Denuncias de bienestar/)).toBeInTheDocument();
    expect(screen.queryByText(/Sin datos por unidad/i)).not.toBeInTheDocument();
  });

  it("names k-anonymity when every in-scope unit reported but was withheld", () => {
    render(<MapDataTable rows={[]} caption="cap" filename="f" suppressedUnits={20} />);

    expect(screen.getByText(/20 unidades/)).toBeInTheDocument();
    expect(screen.getByText(/identificaría casos/i)).toBeInTheDocument();
    expect(screen.queryByText(/Sin datos por unidad/i)).not.toBeInTheDocument();
  });

  it("keeps the plain no-signal copy when nothing reported and no view mode explains it", () => {
    render(<MapDataTable rows={[]} caption="cap" filename="f" />);

    expect(screen.getByText(/Sin datos por unidad/i)).toBeInTheDocument();
  });
});

// L-19: a table taller than the max-h-80 scroll container was reachable only
// by mouse wheel — axe `scrollable-region-focusable`. The wrapper must be
// focusable and named so a keyboard user can Tab to it and arrow-scroll.
describe("MapDataTable — keyboard-reachable scroll region (L-19)", () => {
  it("the scroll container is a focusable, caption-named region", () => {
    render(<MapDataTable rows={ONE_LAYER} caption="Datos por unidad" filename="f" />);

    const region = screen.getByRole("region", { name: "Datos por unidad" });
    expect(region).toHaveAttribute("tabindex", "0");
  });
});
