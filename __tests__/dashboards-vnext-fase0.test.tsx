/**
 * Dashboards vNext — Fase 0 contract tests.
 *
 * These pin the rendering contract of `OpKpi` when the full set of Fase 0
 * props is used together: deltaV2, sparkline, bar, tone, info, drillHref.
 *
 * The component already supports these props (they were added in a prior PR).
 * This test file ensures the combination renders without error and that the
 * Fase 0 caller-side contract is stable — i.e. a future refactor cannot
 * silently drop deltaV2 text, the drill link, or the info ⓘ button.
 *
 * Pattern: renderToStaticMarkup (repo convention — no jsdom required).
 * Matches the approach used in __tests__/ux-2.3-dataviz.test.tsx.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OpKpi } from "@/components/ui/dashboard/OpKpi";

// ---------------------------------------------------------------------------
// Shared fixture — a fully-populated Fase 0 KPI tile.
// ---------------------------------------------------------------------------

const FASE0_KPI = (
  <OpKpi
    label="Cobertura antirrábica"
    value="72%"
    tone="warn"
    bar={72}
    deltaV2={{ value: 5.3, period: "vs mes anterior" }}
    sparkline={[60, 65, 68, 70, 72]}
    info={{
      definition: "Porcentaje de perros con vacunación antirrábica vigente en el ámbito.",
      formula: "dogs_vaccinated / dogs_active * 100",
      caveat: "Meta legal: 80 %. Valores por debajo activan alerta.",
    }}
    drillHref="/gob/vacunacion"
  />
);

// ---------------------------------------------------------------------------
// Rendering contract
// ---------------------------------------------------------------------------

describe("OpKpi — Fase 0 full-prop contract", () => {
  it("renders without throwing when all Fase 0 props are combined", () => {
    // If any prop causes a runtime error, renderToStaticMarkup throws.
    expect(() => renderToStaticMarkup(FASE0_KPI)).not.toThrow();
  });

  it("renders the KPI label", () => {
    const html = renderToStaticMarkup(FASE0_KPI);
    expect(html).toContain("Cobertura antirrábica");
  });

  it("renders the KPI value", () => {
    const html = renderToStaticMarkup(FASE0_KPI);
    expect(html).toContain("72%");
  });

  it("renders the deltaV2 value with sign and period label", () => {
    const html = renderToStaticMarkup(FASE0_KPI);
    // Positive delta, es-AR: "+5,3%". This read "+5.3%" — an English decimal
    // point — for as long as the delta row interpolated `{delta.value}` as a
    // raw JS number instead of going through the es-AR formatters every other
    // figure in the tile uses. On /gob that put "-99.8%" beside eleven
    // comma-formatted numbers (QA 2026-08-07).
    expect(html).toContain("+5,3%");
    expect(html).toContain("vs mes anterior");
  });

  it("renders the deltaV2 arrow glyph for a positive change", () => {
    const html = renderToStaticMarkup(FASE0_KPI);
    // Up arrow (↑) for positive deltaV2.value.
    expect(html).toContain("↑");
  });

  it("renders a negative deltaV2 correctly", () => {
    const html = renderToStaticMarkup(
      <OpKpi
        label="Tasa de adopción"
        value="18%"
        tone="danger"
        deltaV2={{ value: -3.0, period: "vs mes anterior" }}
      />,
    );
    // Negative delta, no plus sign, es-AR separator and a FIXED 1 decimal:
    // "-3,0%". The precision is uniform on purpose — `computeDeltaPct` rounds
    // to one decimal (lib/metrics/targets.ts:348) and the delta row is
    // `tabular-nums`, which only buys digit alignment if every value has the
    // same width. Previously this rendered a bare "-3%".
    expect(html).toContain("-3,0%");
    expect(html).toContain("↓");
  });

  it("renders the drill link with the correct href", () => {
    const html = renderToStaticMarkup(FASE0_KPI);
    expect(html).toContain('href="/gob/vacunacion"');
    // The link text should be the "Ver detalle" pattern.
    expect(html).toContain("Ver detalle");
  });

  it("renders the ⓘ info button when info prop is provided", () => {
    const html = renderToStaticMarkup(FASE0_KPI);
    expect(html).toContain('data-icon-name="info"');
    expect(html).toContain("Información sobre este indicador");
  });

  it("renders the info ⓘ button (tooltip body is closed in SSR — aria-expanded='false')", () => {
    // InfoButton uses useState(false): the tooltip panel is NOT emitted in
    // renderToStaticMarkup.  The contract for this test is therefore that:
    //   (a) the ⓘ button itself renders (verified in the test above), and
    //   (b) aria-expanded is 'false' — meaning the closed state is announced
    //       correctly to assistive technology even in the static render.
    const html = renderToStaticMarkup(FASE0_KPI);
    expect(html).toContain('aria-expanded="false"');
  });

  it("does NOT render drill link when drillHref is omitted", () => {
    const html = renderToStaticMarkup(<OpKpi label="Total" value={42} tone="neutral" />);
    expect(html).not.toContain("Ver detalle");
  });

  it("does NOT render ⓘ button when info prop is omitted", () => {
    const html = renderToStaticMarkup(<OpKpi label="Total" value={42} tone="neutral" />);
    expect(html).not.toContain('data-icon-name="info"');
  });

  it("renders warn-tone card class when tone='warn'", () => {
    const html = renderToStaticMarkup(FASE0_KPI);
    // warn tone maps to --color-st-warn-* tokens (st-* semantic layer from PR-1).
    expect(html).toContain("var(--color-st-warn-bg)");
  });

  it("renders ok-tone card class when tone='ok'", () => {
    const html = renderToStaticMarkup(<OpKpi label="Microchip" value="83%" tone="ok" />);
    expect(html).toContain("var(--color-st-ok-bg)");
  });

  it("renders danger-tone card class when tone='danger'", () => {
    const html = renderToStaticMarkup(<OpKpi label="Adopciones" value="10%" tone="danger" />);
    expect(html).toContain("var(--color-st-err-bg)");
  });
});

// SUPPRESSED ≠ ZERO on a KPI tile (metric-honesty audit, PO 2026-09-16).
//
// The "N períodos ocultos (privacidad)" disclosure existed on the big trend
// CARDS and nowhere near the tiles the sparklines live in — and the tile is the
// worse place to omit it: 32px tall, no axes, no tooltip, so a masked bucket
// drawn at the floor looks exactly like a quiet week and there is nothing to
// hover for the truth. Every call site fed OpKpi a bare `number[]` built with
// `.points.map((p) => p.y)`, a projection that structurally cannot carry the
// flag, so the tile could not have disclosed it even if it wanted to.
//
// The sparkline itself is `next/dynamic({ ssr: false })` and renders nothing
// under renderToStaticMarkup — which is precisely why the disclosure is a
// sibling of the chart and not inside it.
describe("OpKpi — a k-anon-masked sparkline bucket is disclosed, not silently drawn", () => {
  it("discloses the masked periods when the series carries the flag", () => {
    const html = renderToStaticMarkup(
      <OpKpi
        label="Mordeduras"
        value={37}
        sparkline={[{ y: 9 }, { y: 0, suppressed: true }, { y: 11 }, { y: 0, suppressed: true }]}
      />,
    );
    expect(html).toContain("2 períodos ocultos (privacidad)");
  });

  it("uses the singular for a single masked period", () => {
    const html = renderToStaticMarkup(
      <OpKpi label="Mordeduras" value={37} sparkline={[{ y: 9 }, { y: 0, suppressed: true }]} />,
    );
    expect(html).toContain("1 período oculto (privacidad)");
    expect(html).not.toContain("períodos ocultos");
  });

  it("says nothing when nothing was masked — a true zero is not a mask", () => {
    // The guard against overreach: a genuine 0 bucket is a real measurement and
    // must never acquire a privacy note it did not earn.
    const html = renderToStaticMarkup(
      <OpKpi label="Mordeduras" value={20} sparkline={[{ y: 9 }, { y: 0 }, { y: 11 }]} />,
    );
    expect(html).not.toContain("(privacidad)");
  });

  it("still accepts a plain number[] for series that never pass through k-anon", () => {
    // e.g. the campañas turnos sparkline — no suppression, no disclosure.
    const html = renderToStaticMarkup(
      <OpKpi label="Turnos" value={120} sparkline={[10, 20, 30]} />,
    );
    expect(html).not.toContain("(privacidad)");
  });
});
