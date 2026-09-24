// @vitest-environment jsdom
//
// PanoramaDataTable — UX audit 2026-07-26 (finding 4), the "PEORES N over a
// count ranking" lie.
//
// Live repro (vista Cumplimiento · Córdoba · nivel departamento): a `rate`
// layer only resolves a PERCENTAGE at province grain (repository "V1
// LIMITATION"), so below province the console coerces the ranking to counts
// (`rankLocalityRateCount`) and labels the measure "(conteo)". The heading kept
// saying "PEORES 10", and the count order is descending — so the console
// printed:
//
//   PEORES 10 · COBERTURA ANTIRRÁBICA (CONTEO)
//   Capital  147
//   Punilla  136
//   ...
//
// The department that vaccinated the MOST animals was named the worst. A
// vaccination count is a VOLUME, not a compliance level: descending volume is a
// perfectly good ordering, it is just not a ranking of badness. So the framing
// has to change with the coercion, not stay behind it.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RankedUnit } from "@/src/modules/panorama/domain/ranking";

import { PanoramaDataTable } from "./PanoramaDataTable";

afterEach(cleanup);

const COUNTS: RankedUnit[] = [
  { key: "capital", label: "Capital", value: 147, gap: null },
  { key: "punilla", label: "Punilla", value: 136, gap: null },
];

describe("PanoramaDataTable — a volume order is not a worst-N ranking", () => {
  it("drops the 'Peores' framing when the rows are ordered by raw volume", () => {
    render(
      <PanoramaDataTable
        rows={COUNTS}
        kind="density"
        measureLabel="cobertura antirrábica (conteo)"
        orderedByVolume
      />,
    );

    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading.textContent).not.toMatch(/Peores/i);
    expect(heading.textContent).toMatch(/cobertura antirrábica \(conteo\)/);
  });

  it("says a count is not a level, so more records never reads as worse", () => {
    render(
      <PanoramaDataTable
        rows={COUNTS}
        kind="density"
        measureLabel="cobertura antirrábica (conteo)"
        orderedByVolume
      />,
    );

    expect(screen.getByText(/no significa peor/i)).toBeInTheDocument();
  });

  it("keeps 'Peores N' for an ordinary worst-N ranking", () => {
    render(<PanoramaDataTable rows={COUNTS} kind="density" measureLabel="mortalidad registrada" />);

    expect(screen.getByRole("heading", { level: 3 }).textContent).toMatch(/Peores 2/);
    expect(screen.queryByText(/no significa peor/i)).not.toBeInTheDocument();
  });
});
