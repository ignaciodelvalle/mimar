// @vitest-environment jsdom
//
// ProvenanceCard — "¿De dónde sale este número?".
//
// Pins the card's honesty contract:
//   - full-data render: every threaded datum shows.
//   - honest gaps: an unthreaded datum renders its explicit "No disponible…"
//     line — never silently omitted, never faked.
//   - PRIVACY: below the anonymity floor the LITERAL NUMBER never renders —
//     asserted bidirectionally (the withheld sentence present AND the digit
//     absent from the whole dialog).
//   - a11y basics: dialog labeled by the KPI, native cancel (Escape) closes.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ProvenanceCard, sampleLineEs } from "./ProvenanceCard";

// jsdom doesn't implement native <dialog>.showModal/close — stub, toggling the
// `open` attribute so role queries see the content (ConfirmDialog.test idiom).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

afterEach(cleanup);

describe("ProvenanceCard — full-data render", () => {
  it("shows indicator, formula, scope, period, sample and freshness from threaded data", () => {
    render(
      <ProvenanceCard
        descriptorId="rabies_coverage_dogs_12m"
        open
        onClose={() => {}}
        context={{
          scopeLabel: "Buenos Aires — La Plata",
          periodLabel: "Últimos 12 meses (fijos)",
          dataAsOf: "2026-07-30T12:00:00.000Z",
        }}
        n={1240}
      />,
    );

    // Indicador: catalog label + question.
    expect(screen.getByText("Cobertura antirrábica — perros (12 meses)")).toBeInTheDocument();
    expect(screen.getByText(/¿Están los perros del padrón/)).toBeInTheDocument();
    // Fórmula: KPI_PROVENANCE, not the catalog's SQL-ish ui.formula.
    expect(
      screen.getByText(/Perros del padrón con al menos una vacuna antirrábica/),
    ).toBeInTheDocument();
    // Alcance / Período threaded verbatim.
    expect(screen.getByText("Buenos Aires — La Plata")).toBeInTheDocument();
    expect(screen.getByText(/Últimos 12 meses \(fijos\)/)).toBeInTheDocument();
    // Muestra: n at/above the floor renders as an es-AR count.
    expect(screen.getByText("1.240 registros.")).toBeInTheDocument();
    // Frescura: formatted es-AR datetime, not the raw ISO string.
    expect(screen.getByText(/30 de julio de 2026/)).toBeInTheDocument();
    // Vista reproducible.
    expect(screen.getByRole("button", { name: /Copiar enlace de esta vista/ })).toBeInTheDocument();
  });
});

describe("ProvenanceCard — honest gaps", () => {
  it("states every unthreaded datum instead of omitting it", () => {
    render(<ProvenanceCard descriptorId="rabies_coverage_dogs_12m" open onClose={() => {}} />);

    expect(screen.getByText("Según los filtros de la vista actual.")).toBeInTheDocument();
    // Period falls back to the catalog's own window/basis declaration.
    expect(screen.getByText(/Últimos 12 meses · razón/)).toBeInTheDocument();
    expect(screen.getByText("No disponible en esta vista.")).toBeInTheDocument();
    expect(screen.getByText("No disponible.")).toBeInTheDocument();
  });

  it("freshness defers to the page footer when the page renders one", () => {
    render(
      <ProvenanceCard
        descriptorId="rabies_coverage_dogs_12m"
        open
        onClose={() => {}}
        context={{ pageHasFreshnessFooter: true }}
      />,
    );
    expect(screen.getByText("Ver pie de página.")).toBeInTheDocument();
  });

  it("threads the period-invariant verdict as its own line", () => {
    render(
      <ProvenanceCard descriptorId="queue_pending_total" open onClose={() => {}} periodInvariant />,
    );
    expect(screen.getByText("No varía con el período.")).toBeInTheDocument();
  });
});

describe("ProvenanceCard — privacy (n below the anonymity floor)", () => {
  it("renders the withheld sentence and NEVER the literal number", () => {
    const { container } = render(
      <ProvenanceCard descriptorId="rabies_coverage_dogs_12m" open onClose={() => {}} n={3} />,
    );

    expect(
      screen.getByText("Menos de 5 registros — se oculta por privacidad."),
    ).toBeInTheDocument();
    // Bidirectional: the digit 3 appears nowhere in the dialog.
    expect(container.textContent ?? "").not.toContain("3");
  });

  it("withholds n=0 too — a zero count is still below the floor", () => {
    expect(sampleLineEs("rabies_coverage_dogs_12m", 0)).toBe(
      "Menos de 5 registros — se oculta por privacidad.",
    );
  });

  it("sampleLineEs boundary: the floor itself renders, one below does not", () => {
    expect(sampleLineEs("rabies_coverage_dogs_12m", 5)).toBe("5 registros.");
    expect(sampleLineEs("rabies_coverage_dogs_12m", 4)).toBe(
      "Menos de 5 registros — se oculta por privacidad.",
    );
    expect(sampleLineEs("rabies_coverage_dogs_12m", undefined)).toBe(
      "No disponible en esta vista.",
    );
  });
});

describe("ProvenanceCard — dialog a11y basics", () => {
  it("is labeled by the KPI heading", () => {
    render(<ProvenanceCard descriptorId="rabies_coverage_dogs_12m" open onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId ?? "")?.textContent).toBe(
      "Cobertura antirrábica — perros (12 meses)",
    );
  });

  it("closes via the native cancel event (Escape) and via the Cerrar button", () => {
    const onClose = vi.fn();
    render(<ProvenanceCard descriptorId="rabies_coverage_dogs_12m" open onClose={onClose} />);

    fireEvent(screen.getByRole("dialog"), new Event("cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
