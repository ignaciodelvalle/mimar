"use client";

import { useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";

import { CHART_COLORS, type ChartColorKey } from "@dim/contract/viz";

import { ChartSizingBox } from "./ChartSizingBox";

/**
 * Stacked time-series chart — multi-series stacked area over a shared x-axis.
 *
 * This is the multi-series sibling of TimeSeriesChart. It exists to convert the
 * "Causas por semana" flat ISO-week×cause table into a real trend: one stacked
 * band per series (death cause, disease code, …), so the operator sees the
 * direction of each component over time, not a static snapshot.
 *
 * Reuses the same accessibility + reduced-motion contract as TimeSeriesChart:
 *  - `prefers-reduced-motion` disables recharts animations on the client.
 *  - A `<details>` data-table fallback (períodos × series matrix) is always
 *    rendered so screen readers and no-JS contexts get the full data.
 *
 * Colors come from the tokenized CHART_COLORS palette (@dim/contract/viz) — no
 * inline hex literals. Series cycle through the palette in stack order.
 */

/** One row of the chart: an x label + a numeric value per series key. */
export type StackedSeriesPoint = {
  x: string;
  values: Record<string, number>;
  /**
   * Cells masked by k-anonimato (`suppressSmallStackedCells`): el valor real es
   * 1..k-1 y viaja como 0 en `values`. Keyed por serie; sólo las celdas
   * enmascaradas están presentes.
   *
   * La tabla "Ver datos" y el tooltip escriben "oculto (privacidad)" en vez del
   * cero — suprimido ≠ cero. El ÁREA no dibuja un hueco como hace
   * TimeSeriesChart con su serie única, y la razón es geométrica, no un olvido:
   * una banda enmascarada ya vale 0 y por lo tanto ya tiene altura cero en el
   * apilado, así que un corte de trazo no agregaría información y se leería
   * como una falla de render. Los canales honestos acá son el tooltip, la tabla
   * y el resumen accesible.
   */
  suppressed?: Record<string, true>;
};

/** Lo que se muestra en lugar de un número que nadie midió. Mismo texto que la
 *  tabla de TimeSeriesChart usa para su serie única — un solo vocabulario. */
const SUPPRESSED_CELL_LABEL = "oculto (privacidad)";

/** Campo interno de cada fila de recharts que transporta el mapa de celdas
 *  enmascaradas hasta el tooltip. Prefijado para no colisionar con una clave de
 *  serie (las claves son causas crudas del payload, p. ej. "disease"). */
const MASKED_FIELD = "__dimSuppressed";

export type StackedTimeSeriesChartProps = {
  /** Ordered series keys (raw) — define stack order (bottom → top). */
  seriesKeys: string[];
  /** Chronologically ordered points; each carries a value per series key. */
  points: StackedSeriesPoint[];
  /**
   * Resolved raw-key → es-AR label map. MUST be plain serializable data, never a
   * function: this is a Client Component, and passing a function across the
   * server → client boundary crashes the route (Next RSC). Resolve labels
   * server-side at the call-site (e.g. `Object.fromEntries(keys.map(k => [k,
   * deathCauseLabel(k)]))`). Missing keys fall back to the raw key.
   */
  seriesLabels: Record<string, string>;
  /** Optional y-axis label. */
  yLabel?: string;
  /** Chart height in px. Default 320. */
  height?: number;
  className?: string;
  /** Caption for the accessibility data table. */
  fallbackTableLabel?: string;
  /**
   * Visual review 2026-07-23 (#4): k-anon suppressed cell count, when the
   * caller knows it (e.g. mortalidad's causes-by-period fold). With it, an
   * EMPTY chart — no points, or every remaining value zeroed by suppression —
   * states "Datos ocultos por privacidad (k<5)." instead of the generic
   * no-data copy, so a privacy-blanked plot never reads as a render failure.
   */
  suppressedCount?: number;
};

/** Palette cycle order — single-hue tokens. Ordered so no deutan-confusable
 *  pair (green–red, the axis viz-scales.ts forbids; green–teal, close under
 *  deuteranopia) is ever ADJACENT in the stack: purple/red always separate
 *  them (dataviz review 2026-07-23). Co-occurrence at 6 series is unavoidable
 *  with this token set — callers with 6+ categories should roll up the tail
 *  into "otras" instead of trusting the cycle. */
const PALETTE: ChartColorKey[] = ["blue", "orange", "green", "purple", "red", "teal"];

export function StackedTimeSeriesChart({
  seriesKeys,
  points,
  seriesLabels,
  yLabel,
  height = 320,
  className = "",
  fallbackTableLabel = "Datos del gráfico",
  suppressedCount = 0,
}: StackedTimeSeriesChartProps) {
  const labelFor = (key: string) => seriesLabels[key] ?? key;
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // recharts wants a flat row per x with one numeric prop per series. We use the
  // raw series key as the dataKey and the display label as the series `name`.
  //
  // Una celda enmascarada se plotea igual como 0 (no como null) A PROPÓSITO: ya
  // valía 0 en el apilado, así que null no cambiaría la geometría y sólo
  // cortaría el trazo de una banda de altura cero. Lo que sí cambia es el
  // tooltip, que lee `MASKED_FIELD` de la fila y escribe "oculto (privacidad)".
  const chartData = points.map((p) => {
    const row: Record<string, unknown> = { periodo: p.x };
    for (const key of seriesKeys) row[key] = p.values[key] ?? 0;
    if (p.suppressed) row[MASKED_FIELD] = p.suppressed;
    return row;
  });

  /** Total de celdas enmascaradas que ESTOS puntos traen — derivado de los
   *  propios datos, nunca de un segundo contador que pueda desincronizarse. */
  const maskedCells = points.reduce(
    (n, p) => n + (p.suppressed ? Object.keys(p.suppressed).length : 0),
    0,
  );

  const colorFor = (i: number) => CHART_COLORS[PALETTE[i % PALETTE.length]];

  // Visual review 2026-07-23 (#4): in-chart empty state. Axes + a full legend
  // over zero bands read as a render failure — draw a centered message inside
  // the plot area and omit the series legend (there is nothing to decode).
  // "Empty" covers: no points, no series, or (suppression only) every value
  // zeroed by the k-anon fold — a chart of suppressed zeros is a blank plot
  // with a misleadingly populated legend.
  const isEmpty =
    points.length === 0 ||
    seriesKeys.length === 0 ||
    (suppressedCount > 0 && points.every((p) => seriesKeys.every((k) => (p.values[k] ?? 0) === 0)));
  const emptyMessage =
    suppressedCount > 0
      ? "Datos ocultos por privacidad (k<5)."
      : "Sin datos para el período seleccionado.";

  // RA-9 BR-5: the recharts SVG used to sit in a bare <div> — no accessible
  // name, not aria-hidden, so a screen reader met an unnamed graphic. Mirrors
  // the ForecastChart / MapChoropleth / CalendarHeatmap contract.
  // El lector de pantalla oye la geometría del apilado, no el vacío de una
  // banda de altura cero — así que la única forma de que se entere de que una
  // celda está enmascarada es que el resumen lo diga. La tabla "Ver datos" ya
  // escribe "oculto (privacidad)" por celda; esto avisa que hay que ir a mirarla.
  const maskedNote =
    maskedCells > 0
      ? ` ${maskedCells} ${maskedCells === 1 ? "celda oculta" : "celdas ocultas"} por privacidad (k<5): en la tabla figuran como "${SUPPRESSED_CELL_LABEL}", no como cero.`
      : "";
  const summaryLabel = isEmpty
    ? `${fallbackTableLabel}: ${emptyMessage}`
    : `${fallbackTableLabel}: gráfico de áreas apiladas, ${seriesKeys.length} ${
        seriesKeys.length === 1 ? "serie" : "series"
      } (${seriesKeys.map(labelFor).join(", ")}) sobre ${points.length} ${
        points.length === 1 ? "período" : "períodos"
      }. Los valores exactos están en la tabla "Ver datos".${maskedNote}`;

  return (
    <div className={className}>
      {/* role="img" wraps the PLOT ONLY — the "Ver datos" table below stays a
          sibling, because everything inside a role="img" node is presentational
          to assistive tech (mirrors MapChoropleth). */}
      <figure role="img" aria-label={summaryLabel} className="relative m-0">
        <ChartSizingBox height={height}>
          <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="periodo" tick={{ fontSize: 11 }} />
            <YAxis
              tick={{ fontSize: 11 }}
              label={
                yLabel
                  ? { value: yLabel, angle: -90, position: "insideLeft", style: { fontSize: 11 } }
                  : undefined
              }
            />
            {/* Suprimido ≠ cero también acá: sin este formatter el tooltip de una
                celda enmascarada decía "Enfermedad: 0", que es la misma
                afirmación falsa que la tabla hacía más abajo. */}
            <Tooltip
              formatter={(value: unknown, _name: unknown, item: unknown) => {
                const entry = item as
                  | { dataKey?: unknown; payload?: Record<string, unknown> }
                  | undefined;
                const key = typeof entry?.dataKey === "string" ? entry.dataKey : null;
                const masked = entry?.payload?.[MASKED_FIELD] as Record<string, true> | undefined;
                return key && masked?.[key] ? SUPPRESSED_CELL_LABEL : String(value);
              }}
            />
            {!isEmpty && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {seriesKeys.map((key, i) => {
              const color = colorFor(i);
              return (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  name={labelFor(key)}
                  stackId="1"
                  stroke={color}
                  fill={`${color}66`}
                  strokeWidth={2}
                  isAnimationActive={!reducedMotion}
                />
              );
            })}
          </AreaChart>
        </ChartSizingBox>
        {isEmpty && (
          <p
            role="note"
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ln-mute"
          >
            {emptyMessage}
          </p>
        )}
      </figure>

      {/* Accessibility data table — períodos (rows) × series (cols) matrix.
          RA-9 BR-7: the sr-only suffix disambiguates N "Ver datos" toggles on a
          multi-chart dashboard (WCAG 2.4.6). */}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-ln-azul hover:underline text-xs font-medium">
          Ver datos<span className="sr-only"> — {fallbackTableLabel}</span>
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">{fallbackTableLabel}</caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="border border-ln-line px-3 py-1.5 text-left font-semibold text-ln-ink-2 bg-ln-stripe"
                >
                  Período
                </th>
                {seriesKeys.map((key) => (
                  <th
                    key={key}
                    scope="col"
                    className="border border-ln-line px-3 py-1.5 text-left font-semibold text-ln-ink-2 bg-ln-stripe"
                  >
                    {labelFor(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: los buckets de una serie temporal son únicos por posición
                <tr key={i}>
                  <th
                    scope="row"
                    className="border border-ln-line px-3 py-1.5 text-left text-ln-ink"
                  >
                    {p.x}
                  </th>
                  {seriesKeys.map((key) => (
                    <td
                      key={key}
                      className="border border-ln-line px-3 py-1.5 text-ln-ink tabular-nums"
                    >
                      {/* EL cero falso vivía exactamente acá: una celda de 1..4
                          fallecimientos se imprimía como "0" bajo un encabezado
                          que ya declaraba "N celdas ocultas (privacidad)". */}
                      {p.suppressed?.[key] ? SUPPRESSED_CELL_LABEL : (p.values[key] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
