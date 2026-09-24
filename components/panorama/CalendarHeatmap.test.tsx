// @vitest-environment jsdom
//
// CalendarHeatmap — pins the presentational contract (viz-suite Wave 1, item 1):
// es-AR labels, the a11y fallback table mirroring the input, the empty/
// non-temporal honesty state, and single-day click-to-filter (cell + table).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CalendarHeatmap } from "./CalendarHeatmap";

afterEach(cleanup);

const WEEK = { since: "2026-01-05", until: "2026-01-11" }; // one Mon–Sun week
const DATA = [
  { date: "2026-01-05", count: 3 },
  { date: "2026-01-07", count: 1 },
];

describe("<CalendarHeatmap>", () => {
  it("renders the title, method note, and the sequential legend", () => {
    render(<CalendarHeatmap data={DATA} {...WEEK} methodNote="Total del alcance por día" />);
    expect(screen.getByText("Eventos por día")).toBeInTheDocument();
    expect(screen.getByText("Total del alcance por día")).toBeInTheDocument();
    expect(screen.getByText("Menos")).toBeInTheDocument();
    expect(screen.getByText("Más")).toBeInTheDocument();
  });

  it("labels each day cell in es-AR (D de MMMM: N eventos)", () => {
    render(<CalendarHeatmap data={DATA} {...WEEK} />);
    // In-window day with events.
    expect(screen.getByRole("img", { name: "5 de enero: 3 eventos" })).toBeInTheDocument();
    // In-window day with no events renders as ZERO, not absent.
    expect(screen.getByRole("img", { name: "6 de enero: 0 eventos" })).toBeInTheDocument();
  });

  it("exposes a fallback table whose rows mirror the input series", () => {
    render(<CalendarHeatmap data={DATA} {...WEEK} />);
    expect(screen.getByText("Ver datos")).toBeInTheDocument();
    // One row per input day (formatDate renders the AR-pinned full date).
    expect(screen.getByText("5 de enero de 2026")).toBeInTheDocument();
    expect(screen.getByText("7 de enero de 2026")).toBeInTheDocument();
    // Both counts appear in the table body.
    expect(screen.getByRole("cell", { name: "3" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1" })).toBeInTheDocument();
  });

  it("fires onDayClick with the clicked day (cell + table both filter)", () => {
    const onDayClick = vi.fn();
    render(<CalendarHeatmap data={DATA} {...WEEK} onDayClick={onDayClick} />);

    // Cell click (mouse affordance).
    fireEvent.click(screen.getByRole("img", { name: "5 de enero: 3 eventos" }));
    expect(onDayClick).toHaveBeenLastCalledWith("2026-01-05");

    // Table date button (keyboard/SR path).
    fireEvent.click(screen.getByRole("button", { name: "7 de enero de 2026" }));
    expect(onDayClick).toHaveBeenLastCalledWith("2026-01-07");
  });

  it("caps a multi-year window to the recent 12 months and notes the truncation", () => {
    render(
      <CalendarHeatmap
        data={[
          { date: "2026-07-07", count: 2 }, // within the recent 12 months
          { date: "2021-03-05", count: 5 }, // older than the cap → dropped
        ]}
        since="2020-01-01"
        until="2026-07-14"
      />,
    );
    // The truncation note appears (es-AR).
    expect(screen.getByText("Últimos 12 meses del período activo.")).toBeInTheDocument();
    // The recent day survives in the a11y table; the old one is dropped.
    expect(screen.getByText("7 de julio de 2026")).toBeInTheDocument();
    expect(screen.queryByText("5 de marzo de 2021")).not.toBeInTheDocument();
  });

  it("shows no cap note for a window within 12 months", () => {
    render(<CalendarHeatmap data={DATA} {...WEEK} />);
    expect(screen.queryByText("Últimos 12 meses del período activo.")).not.toBeInTheDocument();
  });

  it("narrates the empty/non-temporal state instead of a blank box", () => {
    render(
      <CalendarHeatmap
        data={[]}
        {...WEEK}
        emptyMessage="Activá una capa con dimensión temporal."
      />,
    );
    expect(screen.getByText("Activá una capa con dimensión temporal.")).toBeInTheDocument();
    // No data → no fallback table.
    expect(screen.queryByText("Ver datos")).not.toBeInTheDocument();
  });
});
