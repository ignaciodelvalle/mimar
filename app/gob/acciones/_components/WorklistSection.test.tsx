// @vitest-environment jsdom
//
// WorklistSection.test — the /gob/acciones screen body rendered with mocked
// domain results (G5 DoD: "screen render with mocked domain fetches").
//
// Pins the four honest surfaces of the composition:
//   1. rows render in the deadline ranking buildWorklist produced,
//   2. each domain carries ITS OWN resolution affordance (inline Tomar only
//      for welfare — link-outs elsewhere, nothing invented),
//   3. the empty state is the measured-zero copy the state-coverage fence
//      expects, and
//   4. a degraded domain announces itself instead of silently shrinking
//      the list.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// TomarButton's client deps — same mock set as WelfareDenunciaRow.test.tsx.
vi.mock("@/src/modules/welfare/actions", () => ({
  assignWelfareToMeAction: vi.fn(),
}));
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: vi.fn(),
}));

import {
  type WorklistLoadResult,
  buildWorklist,
  mapCaseRows,
  mapObservationRows,
  mapWelfareRows,
} from "../_lib/worklist-core";
import { WorklistSection } from "./WorklistSection";

afterEach(cleanup);

const NOW = new Date("2026-08-02T15:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * DAY_MS);

function loaded(over: Partial<WorklistLoadResult> = {}): WorklistLoadResult {
  return {
    items: [],
    totalCount: 0,
    counts: { observaciones: 0, denuncias: 0, casos: 0 },
    degraded: { observaciones: false, denuncias: false, casos: false },
    ...over,
  };
}

/** A mixed 3-domain result, exactly as loadWorklist would compose it. */
function mixedResult(): WorklistLoadResult {
  const observaciones = mapObservationRows(
    [
      {
        petId: "p-1",
        petPublicToken: "DIM-TEST-0001",
        petName: "Pampa",
        species: "dog",
        province: "Buenos Aires",
        locality: "La Plata",
        dueAt: daysFromNow(-6),
      },
    ],
    NOW,
  );
  const denuncias = mapWelfareRows(
    [
      {
        id: "wr-1",
        referenceCode: "DEN-AAAA-0001",
        kind: "physical_abuse",
        severity: "medium",
        createdAt: daysFromNow(-9), // 7d tier → overdue 2d
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "Palermo",
        assignedToUserId: null,
      },
    ],
    NOW,
  );
  const casos = mapCaseRows(
    [
      {
        id: "c-1",
        publicCode: "CAS-0001-0001",
        caseKind: "bite_incident",
        primaryPetName: "Firulais",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
        openedAt: daysFromNow(-2), // due in 12d → on time
      },
    ],
    NOW,
  );
  const { items, totalCount } = buildWorklist([observaciones, denuncias, casos]);
  return loaded({
    items,
    totalCount,
    counts: { observaciones: 1, denuncias: 1, casos: 1 },
  });
}

describe("WorklistSection — ranked rows with honest affordances", () => {
  it("renders the rows in deadline order: most overdue first, on-time last", () => {
    render(<WorklistSection result={mixedResult()} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Venció hace 6 días");
    expect(rows[0]).toHaveTextContent("Observación antirrábica");
    expect(rows[1]).toHaveTextContent("Venció hace 2 días");
    expect(rows[1]).toHaveTextContent("Denuncia de maltrato");
    expect(rows[2]).toHaveTextContent("Vence en 12 días");
    expect(rows[2]).toHaveTextContent("Caso regulatorio");
  });

  it("observación: link-out 'Cerrar →' to the professional-closure flow — no fake inline button", () => {
    render(<WorklistSection result={mixedResult()} />);
    const row = screen.getAllByRole("listitem")[0];
    const link = within(row).getByRole("link", { name: /Cerrar/ });
    expect(link).toHaveAttribute("href", "/gob/observaciones/DIM-TEST-0001");
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
  });

  it("denuncia sin asignar: the ONE true inline action (Tomar) plus the Resolver link", () => {
    render(<WorklistSection result={mixedResult()} />);
    const row = screen.getAllByRole("listitem")[1];
    expect(within(row).getByRole("button", { name: /Tomar/ })).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /Resolver/ })).toHaveAttribute(
      "href",
      "/gob/maltrato/DEN-AAAA-0001",
    );
  });

  it("caso: honest 'Ver →' link into the case — no row mutation exists, none is rendered", () => {
    render(<WorklistSection result={mixedResult()} />);
    const row = screen.getAllByRole("listitem")[2];
    expect(within(row).getByRole("link", { name: /Ver/ })).toHaveAttribute(
      "href",
      "/gob/casos/CAS-0001-0001",
    );
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
  });

  it("summarizes the composition per domain", () => {
    render(<WorklistSection result={mixedResult()} />);
    expect(
      screen.getByText(/3 obligaciones con plazo · 1 observación · 1 denuncia · 1 caso/),
    ).toBeInTheDocument();
  });

  it("says when the render cap truncated the list, with the true total", () => {
    const base = mixedResult();
    render(
      <WorklistSection result={{ ...base, items: base.items.slice(0, 2), totalCount: 342 }} />,
    );
    expect(
      screen.getByText(/Se muestran las 2 obligaciones más urgentes de 342 en vista/),
    ).toBeInTheDocument();
  });
});

describe("WorklistSection — empty and degraded states", () => {
  it("all domains consulted + zero rows → the measured-zero empty state", () => {
    render(<WorklistSection result={loaded()} />);
    expect(screen.getByText("No hay acciones que venzan en tu jurisdicción")).toBeInTheDocument();
    expect(screen.queryByText("Lista incompleta")).not.toBeInTheDocument();
  });

  it("a degraded domain announces itself by name — a partial list never poses as complete", () => {
    render(
      <WorklistSection
        result={loaded({ degraded: { observaciones: true, denuncias: false, casos: false } })}
      />,
    );
    expect(screen.getByText("Lista incompleta")).toBeInTheDocument();
    expect(screen.getByText(/Observación antirrábica/)).toBeInTheDocument();
    // With a source down, the empty state must NOT claim a measured zero.
    expect(
      screen.queryByText("No hay acciones que venzan en tu jurisdicción"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Sin acciones para mostrar")).toBeInTheDocument();
  });
});
