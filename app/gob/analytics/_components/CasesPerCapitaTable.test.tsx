// @vitest-environment jsdom
//
// CasesPerCapitaTable — E1 (2026-07-21 facades harvest). fetchCasesPerCapita
// was fully built + unit-tested with zero callers before this pass; this pins
// that the /gob/analytics screen actually renders the metric once wired, and
// that the null-population fallback (no census row → raw count, never a
// silent drop) still shows up.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ProvinceCasesPerCapita } from "@/lib/analytics/govt-dashboards";
import { CasesPerCapitaTable } from "./CasesPerCapitaTable";

afterEach(cleanup);

describe("CasesPerCapitaTable", () => {
  it("renders provinces ranked by cases per 10,000 inhabitants, highest first", () => {
    const rows: ProvinceCasesPerCapita[] = [
      { province: "CABA", code: "AR-C", count: 30, ratePer10k: 1.0, suppressed: false },
      { province: "Santa Cruz", code: "AR-Z", count: 5, ratePer10k: 1.5, suppressed: false },
      { province: "Buenos Aires", code: "AR-B", count: 100, ratePer10k: 0.1, suppressed: false },
    ];
    render(<CasesPerCapitaTable rows={rows} />);

    // Highest rate (Santa Cruz, 1.5) ranks #1, not the highest raw count
    // (Buenos Aires) — proves this is genuinely per-capita, not a raw-count
    // table wearing a per-capita label.
    const cells = screen.getAllByRole("row").map((r) => r.textContent ?? "");
    const santaCruzRowIndex = cells.findIndex((c) => c.includes("Santa Cruz"));
    const cabaRowIndex = cells.findIndex((c) => c.includes("CABA"));
    const buenosAiresRowIndex = cells.findIndex((c) => c.includes("Buenos Aires"));
    expect(santaCruzRowIndex).toBeGreaterThan(0);
    expect(santaCruzRowIndex).toBeLessThan(cabaRowIndex);
    expect(cabaRowIndex).toBeLessThan(buenosAiresRowIndex);
  });

  it("falls back to the raw count, in a footnote, for provinces with no census row", () => {
    const rows: ProvinceCasesPerCapita[] = [
      { province: "Tierra del Fuego", code: "AR-V", count: 7, ratePer10k: null, suppressed: false },
    ];
    render(<CasesPerCapitaTable rows={rows} />);

    expect(screen.getByText(/Sin dato de población censal/)).toBeInTheDocument();
    expect(screen.getByText(/Tierra del Fuego \(7\)/)).toBeInTheDocument();
  });

  it("shows an honest empty state when there are no open cases in scope", () => {
    render(<CasesPerCapitaTable rows={[]} />);
    expect(screen.getByText(/Sin casos abiertos/)).toBeInTheDocument();
  });

  // RA-3 C4 — the render half. The data side already withholds the numbers;
  // these pin that the SCREEN never republishes them and that it says how many
  // it is hiding.
  it("k-anon: a suppressed province publishes no number anywhere and is disclosed as a count", () => {
    const rows: ProvinceCasesPerCapita[] = [
      { province: "Buenos Aires", code: "AR-B", count: 100, ratePer10k: 0.1, suppressed: false },
      // count/rate are null, NOT 0 — the fetcher never hands a false zero down.
      {
        province: "Tierra del Fuego",
        code: "AR-V",
        count: null,
        ratePer10k: null,
        suppressed: true,
      },
    ];
    render(<CasesPerCapitaTable rows={rows} />);

    // Not in the ranking, and NOT smuggled into the no-census footnote either —
    // that footnote prints raw counts by name, so it is the obvious bypass.
    expect(screen.queryByText(/Tierra del Fuego/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sin dato de población censal/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 provincia oculta/)).toBeInTheDocument();
  });

  it("k-anon: all provinces suppressed does NOT read as 'sin casos abiertos'", () => {
    const rows: ProvinceCasesPerCapita[] = [
      { province: "Santa Cruz", code: "AR-Z", count: null, ratePer10k: null, suppressed: true },
      { province: "La Rioja", code: "AR-F", count: null, ratePer10k: null, suppressed: true },
    ];
    render(<CasesPerCapitaTable rows={rows} />);

    // "Sin casos abiertos" would be a measured-zero claim over data that was
    // measured as non-zero and then withheld.
    expect(screen.queryByText(/Sin casos abiertos/)).not.toBeInTheDocument();
    expect(screen.getByText(/por debajo del umbral de privacidad/)).toBeInTheDocument();
    expect(screen.getByText(/2 provincias ocultas/)).toBeInTheDocument();
  });
});
