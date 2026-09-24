"use client";

// ForecastChart — renders a flow series with a forward trend PROJECTION.
//
// Paquete J, Fase J1. Built on the pure ForecastResult from lib/metrics/forecast.
// It does NOT touch TimeSeriesChart — it is an additive, standalone primitive so
// the existing trend charts stay intact next to it.
//
// VISUAL CONTRACT
//   - actual segment   → SOLID line (observed buckets).
//   - forecast segment → DASHED line (projected buckets) — distinct by STYLE,
//     not colour alone (a11y: the legend says "proyección").
//   - confidence band  → low-opacity Area between lo/hi of the forecast tail.
//   - target           → optional ReferenceLine at target.value (ONLY pass a
//     target in the SAME unit as the series — see Paquete J §J-D3: do NOT paint
//     a coverage-% meta on a counts axis).
//   - crossing callout → "alcanza la meta en ~N {período}" when crossing != null,
//     or "a este ritmo no alcanza la meta en el horizonte" when null + a target.
//
// HONESTY (acceptance requirement, not decoration)
//   - footnote: "Proyección de tendencia — no es una garantía. n={puntos},
//     método={linear|holt}."
//   - insufficient → render ONLY the actuals + "Datos insuficientes para
//     proyectar" (never an invented straight line).
//
// A11y: figure[role="img"] + descriptive aria-label, sr-only figcaption, and an
// accessible <details> data table — the recharts SVG itself is decorative.

import { useEffect, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ForecastMethod, ForecastResult } from "@/lib/metrics/forecast";
import { CHART_COLORS } from "@dim/contract/viz";
import { ChartSizingBox } from "./ChartSizingBox";

export type ForecastChartProps = {
  /** The projection produced by projectSeries(). */
  result: ForecastResult;
  /** Series label — shown in the legend, tooltip and aria description. */
  seriesLabel: string;
  /**
   * Optional reference target in the SAME UNIT as the series. Omit for flow
   * series whose legal target is a coverage % (Paquete J §J-D3).
   */
  target?: { value: number; label: string };
  /** Unit suffix for values (e.g. "esterilizaciones"). */
  unit?: string;
  /** Buckets-ahead crossing from targetCrossing(), or null when it won't cross. */
  crossing?: number | null;
  /** Chart height in px. Default 300. */
  height?: number;
  className?: string;
};

const ACTUAL_COLOR = CHART_COLORS.blue;
const FORECAST_COLOR = CHART_COLORS.teal;

/** es-AR bucket-period noun used in the crossing callout. */
function periodNoun(n: number): string {
  return n === 1 ? "período" : "períodos";
}

/** es-AR label for the projection method, shown in the honesty footnote. */
const METHOD_LABEL: Record<ForecastMethod, string> = {
  linear: "lineal",
  holt: "Holt (suavizado exponencial)",
};

export function ForecastChart({
  result,
  seriesLabel,
  target,
  unit,
  crossing,
  height = 300,
  className = "",
}: ForecastChartProps) {
  // Detect prefers-reduced-motion to disable recharts animations.
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const { points, method, insufficient } = result;
  const actuals = points.filter((p) => p.kind === "actual");
  const forecast = points.filter((p) => p.kind === "forecast");
  const n = actuals.length;

  // B1 — render the honest "insufficient" state (not an empty SVG) whenever we
  // can't draw a meaningful line: the upstream result is insufficient, OR there
  // are fewer than 2 actual vertices (recharts draws nothing from <2 points).
  const cannotPlot = insufficient || n < 2;

  // Build the recharts rows. We keep "actual" and "forecast" as separate value
  // keys so the two <Line>s render distinct (solid vs dashed) segments. To make
  // the dashed forecast line visually continuous with the solid actuals, the
  // last actual point also seeds the forecast key (a shared join vertex).
  const lastActual = actuals.at(-1);
  const chartData = [
    ...actuals.map((p) => ({
      x: p.x,
      actual: p.y,
      forecast: undefined as number | undefined,
      lo: undefined as number | undefined,
      hi: undefined as number | undefined,
    })),
    ...forecast.map((p) => ({
      x: p.x,
      actual: undefined as number | undefined,
      forecast: p.y,
      lo: p.lo,
      hi: p.hi,
    })),
  ];
  // Seed the join vertex so the dashed line and band start at the last actual.
  if (lastActual && forecast.length > 0) {
    const firstForecastRow = chartData[actuals.length];
    const joinRow = chartData[actuals.length - 1];
    joinRow.forecast = lastActual.y;
    joinRow.lo = lastActual.y;
    joinRow.hi = lastActual.y;
    void firstForecastRow;
  }

  // Accessible description of the projection direction + crossing.
  const slopeWord =
    result.slopePerBucket > 0
      ? "en aumento"
      : result.slopePerBucket < 0
        ? "en descenso"
        : "estable";
  const crossingText =
    crossing != null
      ? `Alcanza la meta en aproximadamente ${crossing} ${periodNoun(crossing)}.`
      : target
        ? "A este ritmo no alcanza la meta dentro del horizonte proyectado."
        : "";
  const ariaLabel = insufficient
    ? `${seriesLabel}: datos insuficientes para proyectar la tendencia.`
    : `Proyección de ${seriesLabel}, tendencia ${slopeWord}. ${forecast.length} ${periodNoun(forecast.length)} proyectados.${crossingText ? ` ${crossingText}` : ""}`;

  const footnote = `Proyección de tendencia — no es una garantía. n=${n}, método=${METHOD_LABEL[method]}.`;

  return (
    // RA-9 BR-7 fallout: role="img" makes its whole subtree presentational, so
    // the "Ver datos" table, the crossing callout and the honesty footnote were
    // all UNREACHABLE by assistive tech while nested inside the figure. The
    // figure now wraps the PLOT ONLY (mirrors MapChoropleth); everything a
    // screen reader must actually reach is a sibling of it.
    <div className={className}>
      <figure
        role="img"
        aria-label={ariaLabel}
        className="m-0"
        data-forecast-insufficient={cannotPlot ? "true" : "false"}
        data-forecast-has-band={!cannotPlot && forecast.length > 0 ? "true" : "false"}
        data-forecast-has-target={target ? "true" : "false"}
      >
        {cannotPlot ? (
          // Insufficient: actuals only, NO band, explicit message (no invented line).
          <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe px-4 py-6 text-center">
            <p className="text-md font-medium text-ln-op-ink-2">
              Datos insuficientes para proyectar
            </p>
            <p className="mt-1 text-sm text-ln-op-mute">
              Se necesitan al menos 4 períodos con datos para estimar una tendencia confiable.
            </p>
          </div>
        ) : (
          // B1 — the shared ChartSizingBox gives recharts a concrete-height,
          // full-width box so ResponsiveContainer can never measure 0 (empty SVG
          // on first mount under the ssr:false dynamic wrapper). See #14.
          <ChartSizingBox height={height} className="w-full" data-forecast-chart="true">
            <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="x" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />

              {/* Confidence band — low-opacity area between lo and hi of the tail. */}
              <Area
                type="monotone"
                dataKey="hi"
                name="Banda de confianza"
                stroke="none"
                fill={FORECAST_COLOR}
                fillOpacity={0.12}
                isAnimationActive={!reducedMotion}
                activeDot={false}
                legendType="none"
              />
              <Area
                type="monotone"
                dataKey="lo"
                name="Banda de confianza (mín.)"
                stroke="none"
                fill="#ffffff"
                fillOpacity={1}
                isAnimationActive={!reducedMotion}
                activeDot={false}
                legendType="none"
              />

              {/* Actual segment — SOLID. */}
              <Line
                type="monotone"
                dataKey="actual"
                name={seriesLabel}
                stroke={ACTUAL_COLOR}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={!reducedMotion}
              />

              {/* Forecast segment — DASHED (distinct by style, not colour alone). */}
              <Line
                type="monotone"
                dataKey="forecast"
                name="Proyección"
                stroke={FORECAST_COLOR}
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                connectNulls={false}
                isAnimationActive={!reducedMotion}
              />

              {/* Target reference line — ONLY when a same-unit target is provided. */}
              {target ? (
                <ReferenceLine
                  y={target.value}
                  stroke={CHART_COLORS.orange}
                  strokeDasharray="4 4"
                  label={{ value: target.label, position: "insideTopRight", fontSize: 10 }}
                />
              ) : null}
            </ComposedChart>
          </ChartSizingBox>
        )}
      </figure>

      {/* Crossing callout — states in words when the projection crosses the target. */}
      {!cannotPlot && crossingText ? (
        <p
          className={`mt-2 text-sm font-medium ${
            crossing != null ? "text-ln-op-ok" : "text-ln-op-mute"
          }`}
        >
          {crossingText}
        </p>
      ) : null}

      {/* Honesty footnote — band + n + method (acceptance requirement). Was a
          <figcaption> inside the role="img" figure, i.e. never announced. */}
      <p className="mt-2 text-xs italic leading-snug text-ln-op-mute">{footnote}</p>

      {/* Accessible data table — recharts SVG is decorative.
          RA-9 BR-7: the sr-only suffix disambiguates N "Ver datos" toggles on a
          multi-chart dashboard (WCAG 2.4.6). */}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-sm font-medium text-ln-op-azul hover:underline">
          Ver datos<span className="sr-only"> — {seriesLabel}, observado y proyectado</span>
        </summary>
        <table className="mt-2 w-full border-collapse text-sm">
          <caption className="sr-only">
            Datos de {seriesLabel}: períodos observados y proyectados con banda de confianza.
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="border border-ln-op-line bg-ln-op-stripe px-2 py-1 text-left font-semibold text-ln-op-ink-2"
              >
                Período
              </th>
              <th
                scope="col"
                className="border border-ln-op-line bg-ln-op-stripe px-2 py-1 text-left font-semibold text-ln-op-ink-2"
              >
                Valor
              </th>
              <th
                scope="col"
                className="border border-ln-op-line bg-ln-op-stripe px-2 py-1 text-left font-semibold text-ln-op-ink-2"
              >
                Tipo
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: series points are unique by position
              <tr key={i}>
                <td className="border border-ln-op-line px-2 py-1 text-ln-op-ink">{p.x}</td>
                <td className="border border-ln-op-line px-2 py-1 tabular-nums text-ln-op-ink">
                  {p.kind === "forecast" ? `${p.y} (${p.lo}–${p.hi})` : p.y}
                  {unit ? <span className="ml-1 text-ln-op-mute">{unit}</span> : null}
                </td>
                <td className="border border-ln-op-line px-2 py-1 text-ln-op-mute">
                  {p.kind === "forecast" ? "proyección" : "observado"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
