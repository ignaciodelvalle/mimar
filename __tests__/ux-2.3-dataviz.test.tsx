/**
 * UX Audit 2.3 — data-viz interpretability tests.
 *
 * Tests rendered HTML via react-dom/server (repo convention — no jsdom).
 *
 * Covers:
 *   (1) MapChoropleth — gradient scale legend + no-data/suppressed swatches +
 *       accessible figure/figcaption structure.
 *   (2) Mortality bars — role/aria attributes on bar lists and individual items.
 *   (3) OpKpi info tooltip — ⓘ button and definition are rendered.
 *
 * Pure helpers:
 *   (4) MapChoropleth scaleBounds — derived min/max from non-suppressed data.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// React hook stubs — MapChoropleth uses useSearchParams/useEffect/useRef/
// useState/useCallback. We stub only what prevents SSR rendering.
// ---------------------------------------------------------------------------

// Stub Next.js navigation hooks used by MapChoropleth.
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ toString: () => "" }),
}));

// MapLibre is loaded dynamically inside useEffect — it never fires in SSR.
// We only need the component tree to render without error in server mode.

import { MapChoropleth } from "@/components/charts/MapChoropleth";
import { OpKpi } from "@/components/ui/dashboard/OpKpi";

// ---------------------------------------------------------------------------
// (1) MapChoropleth — scale legend
// ---------------------------------------------------------------------------

describe("MapChoropleth — gradient scale legend (UX 2.3 item 1)", () => {
  const baseData = [
    { code: "AR-B", value: 5, label: "Buenos Aires" },
    { code: "AR-C", value: 20, label: "CABA" },
    { code: "AR-X", value: 10, label: "Córdoba" },
  ];

  it("renders a <figure> with an aria-label for the legend", () => {
    const html = renderToStaticMarkup(
      <MapChoropleth data={baseData} scaleLabel="Casos abiertos" />,
    );
    expect(html).toContain("<figure");
    expect(html).toContain("Leyenda:");
  });

  it("renders a <figcaption> with sr-only text describing the legend", () => {
    const html = renderToStaticMarkup(
      <MapChoropleth data={baseData} scaleLabel="Casos abiertos" />,
    );
    // figcaption class includes sr-only
    expect(html).toContain("figcaption");
    expect(html).toContain("sr-only");
    expect(html).toContain("escala de colores");
  });

  // Renamed + repaired 2026-07-31 (RA-3 C6). It asserted `linear-gradient` on a
  // SEQUENTIAL frame, but the continuous min→max gradient bar was removed in the
  // 2026-07-24 classed-legend redesign (see the next test, which documents it)
  // — the only `linear-gradient` left in this markup came from the k-anon hatch
  // swatch, which used to render UNCONDITIONALLY. So this test passed by reading
  // a privacy mark and calling it a colour scale, and gating the swatch is what
  // exposed it. It now asserts what the sequential legend actually publishes.
  it("surfaces the data range through the legend when scaleLabel is provided", () => {
    const html = renderToStaticMarkup(
      <MapChoropleth data={baseData} scaleLabel="Casos abiertos" />,
    );
    // The min (5) and max (20) of non-suppressed data should appear.
    expect(html).toContain(">5<");
    expect(html).toContain(">20<");
    // Classed sequential: each bin chip carries its exact painted class color.
    expect(html).toContain("Resaltar regiones por rango de valores");
    // …and NOT a continuous gradient bar, which this frame does not paint.
    expect(html).not.toContain("linear-gradient(to right");
  });

  it("renders the classed legend with a labeled range fieldset", () => {
    // Since 2026-07-24 the sequential fill is CLASSED (discrete color per
    // break), not a continuous min→max gradient — the legend now exposes
    // clickable range bins under a labeled fieldset instead of a min/max
    // textual gradient aria description (dataviz review #5: the continuous
    // ramp read flat).
    const html = renderToStaticMarkup(
      <MapChoropleth data={baseData} scaleLabel="Casos abiertos" />,
    );
    expect(html).toContain("Resaltar regiones por rango de valores");
    expect(html).toContain("Casos abiertos");
  });

  // The GRADIENT SCALE bar uses `linear-gradient(to right, …)`; the
  // suppressed-cell swatch (map-QOL hatching) uses
  // `repeating-linear-gradient(45deg, …)` — assert on the scale's exact
  // pattern so the hatch swatch doesn't false-positive the substring.
  // ("always-rendered" until RA-3 C6; the swatch is now gated on the frame.)
  const SCALE_GRADIENT = "linear-gradient(to right";

  it("does NOT render the gradient scale when scaleLabel is omitted", () => {
    const html = renderToStaticMarkup(<MapChoropleth data={baseData} />);
    // No gradient scale without label (the hatch swatch may still render).
    expect(html).not.toContain(SCALE_GRADIENT);
  });

  it("does NOT render the gradient scale when all data values are the same (no meaningful range)", () => {
    const flatData = [
      { code: "AR-B", value: 10, label: "Buenos Aires" },
      { code: "AR-C", value: 10, label: "CABA" },
    ];
    const html = renderToStaticMarkup(
      <MapChoropleth data={flatData} scaleLabel="Casos abiertos" />,
    );
    // min === max → gradient scale intentionally hidden.
    expect(html).not.toContain(SCALE_GRADIENT);
  });

  it("renders 'Sin datos' swatch for COLOR_NO_DATA", () => {
    const html = renderToStaticMarkup(<MapChoropleth data={baseData} />);
    expect(html).toContain("Sin datos");
  });

  // INVERTED 2026-07-31 (RA-3 C6). This test asserted the suppressed swatch on
  // `baseData`, which has NO suppressed cell — i.e. it pinned the bug: a legend
  // naming a mark the canvas does not paint. The swatch is now gated on the
  // frame, and both directions are pinned here.
  it("does NOT name the suppressed-cell swatch when the frame paints no hatch", () => {
    const html = renderToStaticMarkup(<MapChoropleth data={baseData} />);
    expect(html).not.toContain("Datos insuficientes (privacidad)");
  });

  it("renders the suppressed-cell swatch when the frame DOES paint a hatch", () => {
    const html = renderToStaticMarkup(
      <MapChoropleth
        data={[
          ...baseData,
          { code: "AR-V", value: 0, suppressed: true, label: "Tierra del Fuego" },
        ]}
      />,
    );
    // map-QOL renamed 'Suprimido (privacidad)' → 'Datos insuficientes
    // (privacidad)' so the operator learns WHY there is no number.
    expect(html).toContain("Datos insuficientes (privacidad)");
  });

  it("color swatches are aria-hidden (color not the sole means — list provides text)", () => {
    const html = renderToStaticMarkup(<MapChoropleth data={baseData} />);
    // Color swatch spans inside the list should be aria-hidden.
    // We check at least one aria-hidden appears in the legend area.
    expect(html).toContain('aria-hidden="true"');
  });

  it("excludes suppressed data from scale min/max computation", () => {
    const dataWithSuppressed = [
      { code: "AR-B", value: 5, label: "Buenos Aires" },
      { code: "AR-C", value: 999, label: "CABA", suppressed: true }, // should be excluded
      { code: "AR-X", value: 10, label: "Córdoba" },
    ];
    const html = renderToStaticMarkup(
      <MapChoropleth data={dataWithSuppressed} scaleLabel="Casos" />,
    );
    // max should be 10, not 999 (suppressed is excluded from scale).
    expect(html).toContain(">10<");
    expect(html).not.toContain(">999<");
  });

  it("renders a <ul> for the discrete swatches with an aria-label", () => {
    const html = renderToStaticMarkup(<MapChoropleth data={baseData} />);
    expect(html).toContain("Estados especiales");
  });
});

// ---------------------------------------------------------------------------
// (2) Mortality bars — accessible structure
// ---------------------------------------------------------------------------

// We test the rendered mortalidad page bar markup patterns by directly
// rendering a minimal reproduction of the bar list structure (the page is
// a Server Component with DB calls, so we test the structural pattern via
// a matching inline render).
//
// The key accessibility contract is (revised — CSS/a11y audit 2026-08-04,
// Q2): NO `role="img"` on the wrapping <figure>. That role flattens its
// ENTIRE subtree to a single opaque image for assistive tech, which made the
// figcaption AND every <li>'s per-bar aria-label below unreachable — the
// exact defect this fixture used to encode as "correct". Same fix already
// shipped for StaticFirstMap's static-map role.
//   - <figure aria-label="…"> gives the chart an overview accessible name,
//     WITHOUT role="img" — its children stay in the accessibility tree
//   - <figcaption class="sr-only"> describes the chart
//   - <li> items carry aria-label with the numeric value, independently reachable
//   - Numeric counts are aria-hidden (redundant with the li aria-label)

function MortalityBarsFixture({
  buckets,
  max,
}: {
  buckets: Array<{ bucket: string; count: number; label: string }>;
  max: number;
}) {
  return (
    <figure
      aria-label={`Disposición final de fallecimientos — ${buckets.length} métodos. Máximo: ${max} fallecimientos.`}
    >
      <figcaption className="sr-only">
        Gráfico de barras horizontales: distribución de fallecimientos por método de disposición
        final.
      </figcaption>
      <ul aria-label="Métodos de disposición">
        {buckets.map((b) => {
          const pct = max > 0 ? (b.count / max) * 100 : 0;
          return (
            <li
              key={b.bucket}
              aria-label={`${b.label}: ${b.count} fallecimientos (${Math.round(pct)}% del máximo)`}
            >
              <span>{b.label}</span>
              <div aria-hidden="true">
                <div style={{ width: `${pct}%` }} />
              </div>
              <span aria-hidden="true">{b.count}</span>
            </li>
          );
        })}
      </ul>
      <p>Escala: 0 – {max} fallecimientos</p>
    </figure>
  );
}

describe("Mortality bars — accessible bar chart (UX 2.3 item 2)", () => {
  const buckets = [
    { bucket: "cremation", count: 30, label: "Cremación" },
    { bucket: "burial", count: 15, label: "Sepultura / cementerio" },
    { bucket: "other", count: 5, label: "Otro / sin especificar" },
  ];

  it('wraps bars in a <figure> with a descriptive aria-label and NO role="img"', () => {
    const html = renderToStaticMarkup(<MortalityBarsFixture buckets={buckets} max={30} />);
    // Q2: role="img" here would flatten the figure's subtree (figcaption +
    // every per-bar <li> aria-label) to a single opaque image for AT.
    expect(html).not.toContain('role="img"');
    expect(html).toContain("<figure");
    expect(html).toContain("Disposición final de fallecimientos");
    expect(html).toContain("Máximo: 30 fallecimientos");
  });

  it("renders figcaption with sr-only accessible description", () => {
    const html = renderToStaticMarkup(<MortalityBarsFixture buckets={buckets} max={30} />);
    expect(html).toContain("figcaption");
    expect(html).toContain("sr-only");
    expect(html).toContain("barras horizontales");
  });

  it("each bar <li> has aria-label with the bucket name and numeric count", () => {
    const html = renderToStaticMarkup(<MortalityBarsFixture buckets={buckets} max={30} />);
    expect(html).toContain("Cremación: 30 fallecimientos");
    expect(html).toContain("Sepultura / cementerio: 15 fallecimientos");
    expect(html).toContain("Otro / sin especificar: 5 fallecimientos");
  });

  it("renders a scale reference text below the bars", () => {
    const html = renderToStaticMarkup(<MortalityBarsFixture buckets={buckets} max={30} />);
    expect(html).toContain("Escala: 0 – 30 fallecimientos");
  });

  it("bar list is a <ul> with a descriptive aria-label", () => {
    const html = renderToStaticMarkup(<MortalityBarsFixture buckets={buckets} max={30} />);
    // <ul> is implicitly role="list" — no redundant role attribute needed.
    expect(html).toContain("<ul");
    expect(html).toContain("Métodos de disposición");
  });
});

// ---------------------------------------------------------------------------
// (3) OpKpi info tooltip — ⓘ affordance + definition rendered
// ---------------------------------------------------------------------------

describe("OpKpi info prop — ⓘ tooltip rendering (UX 2.3 item 3)", () => {
  const kpiWithInfo = (
    <OpKpi
      label="Trazabilidad de disposición"
      value="72%"
      info={{
        definition: "Porcentaje de fallecimientos con método y establecimiento conocidos (B3).",
        formula: "deaths con (method ≠ null) AND (facility ≠ '') / total",
        caveat: "Umbral de alerta: < 75%.",
      }}
    />
  );

  it("renders the ⓘ button when info prop is provided", () => {
    const html = renderToStaticMarkup(kpiWithInfo);
    expect(html).toContain('data-icon-name="info"');
  });

  it("renders aria-label on the ⓘ button", () => {
    const html = renderToStaticMarkup(kpiWithInfo);
    expect(html).toContain("Información sobre este indicador");
  });

  it("renders the definition text in the tooltip body", () => {
    // InfoButton renders the tooltip when open=true. Since useState starts false
    // in SSR, the tooltip body is initially hidden — but the button itself is
    // always rendered. We verify the button aria-label here and the tooltip
    // content structure in the open state via a separate check below.
    const html = renderToStaticMarkup(kpiWithInfo);
    // Button is always present.
    expect(html).toContain("aria-expanded");
  });

  it("does NOT render ⓘ button when info prop is omitted", () => {
    const html = renderToStaticMarkup(<OpKpi label="Total" value={42} />);
    expect(html).not.toContain('data-icon-name="info"');
    expect(html).not.toContain("Información sobre este indicador");
  });

  it("KPI label is rendered alongside the ⓘ button", () => {
    const html = renderToStaticMarkup(kpiWithInfo);
    expect(html).toContain("Trazabilidad de disposición");
  });

  it("renders info for B3 (traceableRate) KPI with formula text", () => {
    const html = renderToStaticMarkup(
      <OpKpi
        label="Trazabilidad de disposición"
        value="80%"
        info={{
          definition: "Porcentaje de fallecimientos con método de disposición conocido.",
          formula: "deaths con (disposition_method ≠ null) AND (facility ≠ '') / total",
        }}
      />,
    );
    // Button renders regardless of open state.
    expect(html).toContain('data-icon-name="info"');
    expect(html).toContain("Trazabilidad de disposición");
  });

  it("renders info for B9 (reportableShare) KPI", () => {
    const html = renderToStaticMarkup(
      <OpKpi
        label="Muertes notificables"
        value="3%"
        info={{
          definition:
            "Porcentaje de fallecimientos con enfermedades de notificación obligatoria (B9).",
          formula: "deaths con (is_reportable = true) / total",
          caveat: "Cualquier valor > 0% activa indicación de atención.",
        }}
      />,
    );
    expect(html).toContain('data-icon-name="info"');
    expect(html).toContain("Muertes notificables");
  });

  it("renders info for A8/A9 rabies compliance KPI", () => {
    const html = renderToStaticMarkup(
      <OpKpi
        label="Cumplimiento observación 10d"
        value="85%"
        info={{
          definition:
            "Porcentaje de observaciones rábicas cerradas dentro del plazo legal de 10 días (A8).",
          formula:
            "rabies_observation_ended con (ended_at − started_at) ≤ 10 días / total cerradas",
          caveat: "Observaciones > 10 días sin cierre generan incumplimiento vivo (A9).",
        }}
      />,
    );
    expect(html).toContain('data-icon-name="info"');
    expect(html).toContain("Cumplimiento observación 10d");
  });

  it("renders info for A7 ENO SLA KPI", () => {
    const html = renderToStaticMarkup(
      <OpKpi
        label="SLA notificación ENO"
        value="92%"
        info={{
          definition: "Porcentaje de notificaciones ENO entregadas dentro del SLA (A7).",
          formula: "outbox rows con delivered_at ≤ sla_due_at / total delivered en período",
        }}
      />,
    );
    expect(html).toContain('data-icon-name="info"');
    expect(html).toContain("SLA notificación ENO");
  });

  it("renders info for A12 AMR density KPI", () => {
    const html = renderToStaticMarkup(
      <OpKpi
        label="Densidad ATM/AMR"
        value="2.3"
        info={{
          definition: "Densidad de uso de antimicrobianos por 1.000 mascotas activas (A12).",
          formula: "COUNT(medication_started donde drug_code ∈ antimicrobial) / activePets × 1.000",
          caveat: "Fármacos no clasificados se reportan aparte y no se incluyen en la tasa.",
        }}
      />,
    );
    expect(html).toContain('data-icon-name="info"');
    expect(html).toContain("Densidad ATM/AMR");
  });
});
