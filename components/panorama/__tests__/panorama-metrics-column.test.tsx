// @vitest-environment jsdom
//
// PanoramaMetricsColumn — panorama-vista-redesign Phase 3.
//
// Verifies the per-vista metrics column renders exactly the preset's curated
// `metrics` (in order), reading the SAME getPanoramaKpis() result (no forked
// query), and falls back to showing every KPI when no preset is active
// (manual/advanced mode).

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PanoramaMetricsColumn } from "@/components/panorama/PanoramaMetricsColumn";
import type {
  PanoramaKpi,
  PanoramaKpis,
} from "@/src/modules/panorama/application/get-panorama-kpis";
import { getPreset } from "@/src/modules/panorama/domain/presets";

afterEach(cleanup);

function kpi(id: PanoramaKpi["id"], label: string): PanoramaKpi {
  return {
    id,
    label,
    value: "10%",
    tone: "neutral",
    info: { definition: "def" },
    href: "/gob/x",
    source: "test",
  };
}

const ALL_KPIS: PanoramaKpis = {
  kpis: [
    kpi("cobertura", "Cobertura antirrábica"),
    kpi("esterilizacion", "Cobertura de esterilización"),
    kpi("perdidas", "Pérdidas activas"),
    kpi("mordeduras", "Mordeduras / 10k hab."),
    kpi("zoonosis", "Zoonosis activas"),
    kpi("denuncias", "Denuncias activas"),
  ],
  recalculatedFor: "Recalculado para el alcance nacional.",
  dataAsOf: null,
};

describe("PanoramaMetricsColumn — switching vista updates the column", () => {
  it("shows bienestar's metrics (denuncias, mordeduras) in order", () => {
    const bienestar = getPreset("bienestar")!;
    render(<PanoramaMetricsColumn kpis={ALL_KPIS} metricIds={bienestar.metrics} />);

    const labels = screen.getAllByText(/Denuncias activas|Mordeduras/).map((el) => el.textContent);
    expect(labels).toEqual(["Denuncias activas", "Mordeduras / 10k hab."]);
    expect(screen.queryByText("Cobertura antirrábica")).not.toBeInTheDocument();
    // metric-honesty 2026-07-09: the coverage denominator is a footer caption,
    // never a per-vista tile — the column must not render it.
    expect(screen.queryByText("Mascotas en cobertura")).not.toBeInTheDocument();
  });

  it("switching to cumplimiento's esterilizacion metric option shows esterilizacion/perdidas instead", () => {
    // D1: control-poblacional is now the `esterilizacion` METRIC OPTION of the
    // merged cumplimiento vista — same curated column, one selector deeper.
    const esterilizacionOption = getPreset("cumplimiento")!.metricOptions!.find(
      (o) => o.metric === "esterilizacion",
    )!;
    const { rerender } = render(
      <PanoramaMetricsColumn kpis={ALL_KPIS} metricIds={getPreset("bienestar")!.metrics} />,
    );
    expect(screen.getByText("Denuncias activas")).toBeInTheDocument();

    rerender(<PanoramaMetricsColumn kpis={ALL_KPIS} metricIds={esterilizacionOption.metrics} />);

    expect(screen.getByText("Cobertura de esterilización")).toBeInTheDocument();
    expect(screen.getByText("Pérdidas activas")).toBeInTheDocument();
    expect(screen.queryByText("Denuncias activas")).not.toBeInTheDocument();
    expect(screen.queryByText("Mascotas en cobertura")).not.toBeInTheDocument();
  });

  it("manual/advanced mode (metricIds null) shows every KPI — nothing hidden", () => {
    render(<PanoramaMetricsColumn kpis={ALL_KPIS} metricIds={null} />);

    for (const k of ALL_KPIS.kpis) {
      expect(screen.getByText(k.label)).toBeInTheDocument();
    }
  });

  it("QA fix (finding 6): a partial payload that filters out every curated metric shows an honest empty state, not nothing", () => {
    const partialPayload: PanoramaKpis = {
      kpis: [kpi("cobertura", "Cobertura antirrábica")], // none of bienestar's metrics
      recalculatedFor: ALL_KPIS.recalculatedFor,
      dataAsOf: null,
    };
    const bienestar = getPreset("bienestar")!;
    const { container } = render(
      <PanoramaMetricsColumn kpis={partialPayload} metricIds={bienestar.metrics} />,
    );

    expect(screen.getByText("Métricas no disponibles para esta vista.")).toBeInTheDocument();
    expect(container).not.toBeEmptyDOMElement();
  });

  it("degraded: shows an explicit failure state DISTINCT from loaded-empty copy (trust/safety)", () => {
    // The KPI fan-out failed → the strip is empty AND degraded. It must NOT
    // reuse the loaded-empty "Métricas no disponibles para esta vista." copy
    // (which reads as "these metrics aren't in this vista"); it must say the
    // load failed.
    const degradedPayload: PanoramaKpis = {
      kpis: [],
      recalculatedFor:
        "No pudimos cargar los indicadores en este momento. Reintentá en unos segundos.",
      dataAsOf: null,
      degraded: true,
    };
    const bienestar = getPreset("bienestar")!;
    render(<PanoramaMetricsColumn kpis={degradedPayload} metricIds={bienestar.metrics} degraded />);

    expect(
      screen.getByText("No pudimos cargar los indicadores en este momento."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Métricas no disponibles para esta vista.")).not.toBeInTheDocument();
  });
});
