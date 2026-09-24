// @vitest-environment jsdom
//
// KpiChips — READ-ONLY contract (#53 Option A, PO 2026-07-14). The chips are
// INDICATORS, never controls: reading a number and changing the map are
// different acts, and the old click-to-rebase (a chip that looked like a stat
// but silently swapped the choropleth base) was the panorama's most confusing
// interaction. These tests pin the new contract: NO radiogroup, NO buttons, NO
// rebase — plus the honesty states (pending/degraded/empty, "estado actual")
// that survive unchanged from the interactive era.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type {
  PanoramaKpi,
  PanoramaKpis,
} from "@/src/modules/panorama/application/get-panorama-kpis";
import { KpiChips } from "./KpiChips";

/** Minimal PanoramaKpi fixture — only the fields KpiChips reads matter. */
function kpi(
  id: string,
  label: string,
  value: string,
  extra: Partial<PanoramaKpi> = {},
): PanoramaKpi {
  return {
    id: id as PanoramaKpi["id"],
    label,
    value,
    tone: "neutral",
    info: { definition: `Definición de ${label}. Segunda oración.` },
    href: "/gob/mock",
    source: "mock",
    ...extra,
  };
}

// The same interleaved mix the old radio contract used (base-role and
// signal-role KPIs) — under #53 Option A they are ALL equal read-only cards.
const KPIS: PanoramaKpis = {
  kpis: [
    kpi("cobertura", "Cobertura antirrábica", "64%"),
    kpi("zoonosis", "Señales de zoonosis", "3"),
    kpi("esterilizacion", "Cobertura de esterilización", "38%"),
    kpi("reunificacion", "Reunificación", "71%"),
  ],
  recalculatedFor: "Argentina · 90 días",
  dataAsOf: null,
};

afterEach(cleanup);

describe("KpiChips — read-only contract (#53 Option A)", () => {
  it("renders every KPI value with NO radio semantics and NO buttons", () => {
    render(<KpiChips kpis={KPIS} metricIds={null} presetId={null} />);
    expect(screen.getByText("64%")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("38%")).toBeInTheDocument();
    expect(screen.getByText("71%")).toBeInTheDocument();
    // Reading is not steering: nothing here is interactive.
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("is an accessible LIST of indicators (es-AR label)", () => {
    render(<KpiChips kpis={KPIS} metricIds={null} presetId={null} />);
    const list = screen.getByRole("list", { name: "Indicadores de esta vista" });
    expect(list).toBeInTheDocument();
    expect(list.querySelectorAll("li")).toHaveLength(4);
  });

  it("the hover title carries the method note and promises NO map action", () => {
    render(<KpiChips kpis={KPIS} metricIds={null} presetId={null} />);
    const card = screen.getByText("64%").closest("li");
    expect(card).toHaveAttribute(
      "title",
      "Cobertura antirrábica — Definición de Cobertura antirrábica.",
    );
    // The old affordance copy ("Click para pintar el mapa…") must be gone.
    expect(card?.getAttribute("title")).not.toMatch(/[Cc]lick/);
  });

  it("caps the cluster at 4 cards (the map dominates)", () => {
    const many: PanoramaKpis = {
      ...KPIS,
      kpis: [
        ...KPIS.kpis,
        kpi("mordeduras", "Mordeduras", "12"),
        kpi("denuncias", "Denuncias", "7"),
      ],
    };
    render(<KpiChips kpis={many} metricIds={null} presetId={null} />);
    expect(screen.getByRole("list").querySelectorAll("li")).toHaveLength(4);
  });
});

describe("KpiChips — honesty states (unchanged from the interactive era)", () => {
  it("degraded state renders the honest failure copy", () => {
    render(<KpiChips kpis={KPIS} metricIds={null} presetId={null} degraded />);
    expect(
      screen.getByText("No pudimos cargar los indicadores en este momento."),
    ).toBeInTheDocument();
  });

  it("COLD START (pending, no prior values) renders the loading copy with aria-busy", () => {
    render(<KpiChips kpis={{ ...KPIS, kpis: [] }} metricIds={null} presetId={null} pending />);
    expect(screen.getByText("Cargando indicadores…")).toHaveAttribute("aria-busy", "true");
  });

  it("REFETCH (pending WITH prior values) keeps the values on screen — never blinks out", () => {
    // Fix (PO: "los KPI aparecen y desaparecen"): a scrub refetch must not replace
    // the strip with a loading placeholder. The previous values stay, marked busy.
    render(<KpiChips kpis={KPIS} metricIds={null} presetId={null} pending />);
    expect(screen.queryByText("Cargando indicadores…")).not.toBeInTheDocument();
    expect(screen.getByText("64%")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Indicadores de esta vista" });
    expect(list).toHaveAttribute("aria-busy", "true");
  });

  it("REFETCH in manual mode also holds the values and marks the group busy", () => {
    render(
      <KpiChips
        kpis={KPIS}
        metricIds={null}
        presetId={null}
        activeLayerIds={["cobertura", "zoonosis"]}
        pending
      />,
    );
    expect(screen.queryByText("Cargando indicadores…")).not.toBeInTheDocument();
    expect(screen.getByText("64%")).toBeInTheDocument();
    // The manual-mode wrapper carries aria-busy while the refetch is pending.
    const list = screen.getByRole("list", { name: "Indicadores de esta vista" });
    expect(list.parentElement).toHaveAttribute("aria-busy", "true");
  });

  it("Q13: scopeChanging BLANKS the strip (aria-busy) — never the previous scope's values", () => {
    // A CABA drill must not flash the old national numbers while the refetch is
    // in flight. Unlike `pending` (scrubber hold), scopeChanging blanks even with
    // prior values on screen.
    render(<KpiChips kpis={KPIS} metricIds={null} presetId={null} scopeChanging />);
    expect(screen.getByText("Actualizando indicadores…")).toHaveAttribute("aria-busy", "true");
    // The previous scope's headline values are GONE during the transition.
    expect(screen.queryByText("64%")).not.toBeInTheDocument();
    expect(screen.queryByText("38%")).not.toBeInTheDocument();
  });

  it("Q13: pending (scrubber hold) still keeps values — scopeChanging is the ONLY blank path", () => {
    // Guard against a regression that conflates the two: pending must HOLD.
    render(<KpiChips kpis={KPIS} metricIds={null} presetId={null} pending />);
    expect(screen.getByText("64%")).toBeInTheDocument();
    expect(screen.queryByText("Actualizando indicadores…")).not.toBeInTheDocument();
  });

  // T2.1 (browser-verified): during a time scrub the strip trails the slider by
  // one fetch and the ONLY cue was opacity-60 — the previous frame's numbers
  // read as current. The strip now stamps the target day while the refetch is
  // in flight, in the same long UTC day shape every as-of surface shares.
  it("T2.1: a scrub refetch stamps the strip with the target day — held numbers never read as current", () => {
    render(
      <KpiChips
        kpis={KPIS}
        metricIds={null}
        presetId={null}
        pending
        pendingAsOfLabel="8 de mayo de 2026"
        temporalFrameActive
      />,
    );
    // The values HOLD (no blink)…
    expect(screen.getByText("64%")).toBeInTheDocument();
    // …and the strip says which frame it is computing.
    expect(screen.getByText("Actualizando al 8 de mayo de 2026…")).toBeInTheDocument();
  });

  it("T2.1: the stamp clears once the refetch settles (pending false)", () => {
    render(
      <KpiChips
        kpis={KPIS}
        metricIds={null}
        presetId={null}
        pendingAsOfLabel="8 de mayo de 2026"
        temporalFrameActive
      />,
    );
    expect(screen.queryByText(/Actualizando al/)).not.toBeInTheDocument();
  });

  it("T2.1: manual mode carries the same stamp", () => {
    render(
      <KpiChips
        kpis={KPIS}
        metricIds={null}
        presetId={null}
        activeLayerIds={["cobertura", "zoonosis"]}
        pending
        pendingAsOfLabel="8 de mayo de 2026"
      />,
    );
    expect(screen.getByText("Actualizando al 8 de mayo de 2026…")).toBeInTheDocument();
  });

  it("empty selection renders the no-metrics copy", () => {
    render(<KpiChips kpis={{ ...KPIS, kpis: [] }} metricIds={null} presetId={null} />);
    expect(screen.getByText("Métricas no disponibles para esta vista.")).toBeInTheDocument();
  });

  it("Q8: a FLOW KPI (no currentState) carries the 'período' temporal-basis tag", () => {
    // Every chip must state its basis in the primary body. Stock chips show
    // "estado actual"; flow chips must show "período" so a stock number and a
    // period flow never read on the same footing.
    const flow: PanoramaKpis = {
      ...KPIS,
      kpis: [kpi("mordeduras", "Mordeduras", "12")],
    };
    render(<KpiChips kpis={flow} metricIds={null} presetId={null} />);
    expect(screen.getByText("período")).toBeInTheDocument();
    expect(screen.queryByText("estado actual")).not.toBeInTheDocument();
  });

  it("Q8: a STOCK KPI (currentState) does NOT carry the 'período' tag", () => {
    const stock: PanoramaKpis = {
      ...KPIS,
      kpis: [kpi("perdidas", "Pérdidas activas", "8", { currentState: true })],
    };
    render(<KpiChips kpis={stock} metricIds={null} presetId={null} />);
    expect(screen.getByText("estado actual")).toBeInTheDocument();
    expect(screen.queryByText("período")).not.toBeInTheDocument();
  });

  it("a STOCK KPI shows the emphasized 'estado actual' tag while a temporal frame is active", () => {
    const stock: PanoramaKpis = {
      ...KPIS,
      kpis: [kpi("cobertura", "Cobertura antirrábica", "64%", { currentState: true })],
    };
    const { rerender } = render(
      <KpiChips kpis={stock} metricIds={null} presetId={null} temporalFrameActive={false} />,
    );
    expect(screen.getByText("estado actual")).toBeInTheDocument();
    rerender(<KpiChips kpis={stock} metricIds={null} presetId={null} temporalFrameActive />);
    expect(screen.getByText("estado actual · no varía con la fecha")).toBeInTheDocument();
  });
});

describe("KpiChips — C2a manual-mode relevance (KPI ↔ active layers)", () => {
  it("shows only KPIs whose subject layer is active; hides the rest behind a toggle", () => {
    // Active layers: cobertura + zoonosis. Relevant KPIs: cobertura, zoonosis.
    // Irrelevant: esterilizacion, reunificacion.
    render(
      <KpiChips
        kpis={KPIS}
        metricIds={null}
        presetId={null}
        activeLayerIds={["cobertura", "zoonosis"]}
      />,
    );
    expect(screen.getByText("64%")).toBeInTheDocument(); // cobertura (relevant)
    expect(screen.getByText("3")).toBeInTheDocument(); // zoonosis (relevant)
    // Irrelevant KPIs are not rendered until the toggle is opened.
    expect(screen.queryByText("38%")).not.toBeInTheDocument();
    expect(screen.queryByText("71%")).not.toBeInTheDocument();
    // The toggle names how many are hidden.
    const toggle = screen.getByRole("button", { name: /Ver todos los indicadores \(2\)/ });
    fireEvent.click(toggle);
    expect(screen.getByText("38%")).toBeInTheDocument();
    expect(screen.getByText("71%")).toBeInTheDocument();
    // Each revealed irrelevant card carries the honest caption (one per card).
    expect(screen.getAllByText("no corresponde a las capas activas")).toHaveLength(2);
  });

  it("when no active layer maps to a KPI, says so and offers the toggle", () => {
    render(<KpiChips kpis={KPIS} metricIds={null} presetId={null} activeLayerIds={["refugios"]} />);
    expect(
      screen.getByText("Ningún indicador corresponde directamente a las capas activas."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Ver todos los indicadores \(4\)/ }),
    ).toBeInTheDocument();
  });

  it("preset mode (metricIds set) ignores relevance — no toggle, curated set shown", () => {
    render(
      <KpiChips
        kpis={KPIS}
        metricIds={["cobertura", "zoonosis"]}
        presetId={"brotes-activos"}
        activeLayerIds={["denuncias"]}
      />,
    );
    // Curated metrics shown regardless of active layers; no relevance toggle.
    expect(screen.getByText("64%")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ver todos/ })).not.toBeInTheDocument();
  });
});
