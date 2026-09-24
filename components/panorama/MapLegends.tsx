"use client";

// MapLegends — the "Referencias" rail section (ARCHETYPE A situation room).
//
// The situational map's scales used to stack as translucent overlays in the
// canvas's bottom-left corner, covering geography. They now live OFF-canvas as a
// named "Referencias" section in the monitoring rail: one block per active layer
// scale, each titled by the layer it decodes. The map keeps ONLY the
// zoom/home/Volver controls + the aggregation badge on the canvas.
//
// Data flow — every scale on this panel is the map's, never this panel's:
//   - the province ramp reads the LIFTED `provinceSeqLegend` (the exact scale
//     syncLayers resolved for the fill, scrub-lock included); when the lift has
//     not arrived yet it falls back to `resolveChoroplethEncoding` — the SAME
//     resolver provinceColorExprForLayer calls, not a look-alike recompute. It
//     used to be a bare `computeClassScale`, which knew nothing about polarity or
//     delta encoding and could publish colours the canvas never painted;
//   - the division-fill legend + graduated-symbol scale are computed imperatively
//     inside SituationalMap's syncLayers (from the rendered data) and LIFTED here
//     via props (onDivisionLegendChange / onGraduatedScaleChange), so a legend
//     bubble/ramp always matches its on-map mark;
//   - the bivariate matrix reads the shared palette constant (bivariate-fill.ts),
//     the one the fill expression is built from.
//
// The invariant behind all three: this file may DISPLAY a scale, never DERIVE one.
//
// The k-anon trichotomy copy (color = value · hatch = protected · outline/neutral
// = no-data) is preserved verbatim — only the container skin changes (from an
// on-canvas translucent panel to a dark rail sub-card).

import { BivariateMatrix } from "@/components/panorama/BivariateMatrix";
import type {
  ActiveLayer,
  DivisionLegendDescriptor,
  ProvinceSeqLegend,
} from "@/components/panorama/SituationalMap";
import { bivariateGreyStates } from "@/components/panorama/bivariate-fill";
import {
  type ClassScale,
  type ClassSwatch,
  classSwatches,
} from "@/components/panorama/class-scale";
import { type ChoroplethEncoding, resolveChoroplethEncoding } from "@/components/panorama/encoding";
import type { GraduatedScale } from "@/components/panorama/graduated-scale";
import {
  HATCH_SWATCH_CSS,
  layerPaintsHatch,
  layerPaintsZero,
} from "@/components/panorama/hatch-pattern";
import { NO_DATA_SWATCH_CSS, NO_DATA_SWATCH_SIZE } from "@/components/panorama/no-data-pattern";
import {
  type ScaleBounds,
  provincePaintsNoData,
  provinceValueBounds,
} from "@/components/panorama/province-choropleth-style";
import { COLOR_NO_DATA, COLOR_SUPPRESSED } from "@dim/contract/viz";

type Props = {
  /** The currently-active layers — the render-derived legends read from these. */
  layers: ActiveLayer[];
  /** Lifted division-fill legend descriptor (null when no division fill is active). */
  divisionLegend: DivisionLegendDescriptor | null;
  /** Lifted graduated-symbol scale (null until it resolves with real data). */
  graduatedScale: GraduatedScale | null;
  /**
   * Lifted sequential province choropleth classed scale(s), keyed by layer id and
   * computed WITH the scrub-locked domain — so the swatch ranges describe the
   * PAINTED colors even mid-scrub. Absent key → fall back to a live-edge recompute.
   */
  provinceSeqLegend: ProvinceSeqLegend;
};

// Shared skin for one legend sub-card in the rail (was `bg-black/55` on canvas).
const CARD = "rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe px-3 py-2";

/** Round a class break to a readable precision for the legend label. */
function formatBound(n: number): string {
  const rounded = Math.abs(n) >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return rounded.toLocaleString("es-AR");
}

/** The value-range label for one class swatch (open-below / range / open-above).
 *  `unit` is appended to the numbers (e.g. "%" for rate layers); `meta` tags the
 *  open-above class as the compliance-target class ("≥ 80% (meta)").
 *
 *  Half-open disambiguation (QA fix): classing is [lo, hi) — a value exactly
 *  AT a break belongs to the UPPER class (pinned by class-scale.test.ts). A
 *  plain "lo – hi" label for two adjacent classes (e.g. "40 – 60" / "60 – 80")
 *  never said which side 60 falls on. The interior range now reads
 *  "lo – <hi" so the exclusive upper bound is explicit; the open-below/
 *  open-above labels already used "<"/"≥" and were never ambiguous. */
function swatchLabel(s: ClassSwatch, opts?: { unit?: string; meta?: boolean }): string {
  const u = opts?.unit ?? "";
  if (s.lo === null && s.hi === null) return "Todos";
  if (s.lo === null) return `< ${formatBound(s.hi as number)}${u}`;
  if (s.hi === null) return `≥ ${formatBound(s.lo)}${u}${opts?.meta ? " (meta)" : ""}`;
  return `${formatBound(s.lo)} – <${formatBound(s.hi)}${u}`;
}

/**
 * Discrete CLASS-swatch legend for a threshold-classed choropleth (Theme 3):
 * one colored chip per class with its value range, replacing the old continuous
 * gradient bar that hid where the data actually fell. The swatches are built from
 * the SAME ClassScale the map fill renders, so legend and map never disagree.
 *
 * `unit` suffixes the numeric labels (e.g. "%" for META'd rate layers) and `meta`
 * tags the top (open-above) class as the compliance-target class — the PO-ratified
 * discrete legend for cobertura / esterilización / microchip / ppp (was the
 * continuous divergent gradient bar).
 */
function ClassSwatchLegend({
  scale,
  unit,
  meta,
}: {
  scale: ClassScale;
  unit?: string;
  meta?: boolean;
}) {
  const swatches = classSwatches(scale);
  return (
    <div className="flex flex-col gap-0.5">
      {swatches.map((s, i) => (
        <div key={`${s.color}-${i}`} className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-4 flex-none rounded-[var(--radius-xs)] border border-ln-op-line"
            style={{ background: s.color }}
            aria-hidden="true"
          />
          <span className="tabular-nums text-ln-op-ink-2">
            {swatchLabel(s, { unit, meta: meta && i === swatches.length - 1 })}
          </span>
        </div>
      ))}
    </div>
  );
}

export function MapLegends({ layers, divisionLegend, graduatedScale, provinceSeqLegend }: Props) {
  // task #63: the active bivariate layer (if any) drives the 3×3 matrix legend;
  // it is excluded from the ordinary province ramp legends.
  const bivariateLayer =
    layers.find((l) => l.geomType === "choropleth" && l.level === "province" && l.bivariateCells) ??
    null;

  const provinceLegends = layers
    .filter((l) => l.geomType === "choropleth" && l.level === "province" && !l.bivariateCells)
    .map((l) => ({
      layer: l,
      bounds: provinceValueBounds(l.features),
      // The ENCODING the map's fill resolves for this layer (encoding.ts — the
      // same `resolveChoroplethEncoding` provinceColorExprForLayer calls). It
      // decides three things this block used to decide for itself: whether the
      // scale is META'd ("%" + a "(meta)" top class), whether it is a zero-
      // anchored DELTA, and — on the sequential path — the layer's POLARITY.
      //
      // PO 2026-08-01: `isMetaLayer(l)` alone was a SECOND, coarser derivation.
      // It ignores `deltaEncoded` (which the resolver branches on FIRST, so a
      // delta layer that also carried a target would have been labelled "%
      // (meta)" over diverging paint) and it ignores `higherIsBetter`, so the
      // fallback scale below painted a higher-is-better ramp the right way up
      // while the map painted it inverted. One resolver, one answer.
      encoding: resolveChoroplethEncoding(l),
    }))
    .filter(
      (x): x is { layer: ActiveLayer; bounds: ScaleBounds; encoding: ChoroplethEncoding | null } =>
        x.bounds !== null,
    );

  // #6/#7: the graduated legend is data-driven — sample bubbles come from
  // `graduatedScale` (built in syncLayers from the observed max) at the exact
  // area-proportional sizes rendered on the map. Only shown once it resolves.
  const hasGraduatedLayer =
    layers.some((l) => l.renderMode === "graduated") &&
    graduatedScale !== null &&
    graduatedScale.bins.length > 0;
  // Name the graduated legend by its layer(s): "Eventos por unidad — Zoonosis".
  const graduatedLayers = layers.filter((l) => l.renderMode === "graduated");
  const graduatedLayerLabel = graduatedLayers.map((l) => l.label).join(" · ");
  // PO 2026-08-01 ("los círculos no son consistentes con lo mostrado en el
  // mapa"). The sample bubbles below are the RIGHT SIZE — `b.r` is the radius
  // the map paints — but they were drawn as hollow grey rings while the canvas
  // paints them filled in the layer's own colour (addGraduatedPointLayer:
  // `circle-color: layer.color`). An operator matching the orange dots on the
  // map to a grey ring in the key has to take it on faith that they are the
  // same mark. Cite the colour when exactly ONE graduated layer is painting —
  // then it is unambiguous. With two co-active graduated layers there is no
  // single colour to cite (the block's title lists both), so it stays neutral
  // rather than picking one and implying the other is something else.
  const graduatedColor = graduatedLayers.length === 1 ? graduatedLayers[0].color : null;
  // RA-7 F3 — the FOURTH k-anon key in this file, and the last one with no gate
  // at all: the graduated block announced "Datos insuficientes (privacidad)" on
  // every graduated frame, painted or not. Exact residue of the defect closed
  // one block above it on 2026-07-30. Reads the same shared `layerPaintsHatch`
  // the other three do — over the GRADUATED layers only, because that is the
  // block's own surface (a suppressed province cell on a co-active choropleth is
  // announced by that layer's own key, not by the bubble key).
  const graduatedPaintsSuppressed = layers.some(
    (l) => l.renderMode === "graduated" && layerPaintsHatch(l),
  );

  // T4.1 — the graduated block's own floor-state caveat: `bubbleRadius`
  // collapses a genuine zero to BUBBLE_R_MIN, the same radius a suppressed
  // dot collapses to (only opacity/color differ). Checked across the
  // GRADUATED layers only, same scoping as `graduatedPaintsSuppressed` above.
  const graduatedPaintsZero = layers.some(
    (l) => l.renderMode === "graduated" && layerPaintsZero(l.features, "count"),
  );

  // RA-7 F10 — which unclassifiable states the bivariate frame actually paints
  // grey with. Read once here so the key below describes THIS frame.
  const bivariateGrey = bivariateGreyStates(bivariateLayer?.bivariateCells ?? []);

  // UX audit 2026-07-26 (finding 5): this used to `return null`, and since the
  // dock renders the pane slot verbatim, "Referencias" became a NAMED TAB THAT
  // OPENS ONTO NOTHING — measured live on the Síntomas vista, where every active
  // layer is a graduated point layer whose values all sit under k=5, so no ramp,
  // no division fill and no resolved graduated scale exist. A blank panel reads
  // as broken software; the honest answer is that there is nothing to decode
  // because the map is not encoding anything by color or size right now.
  const anyLegend =
    provinceLegends.length > 0 ||
    hasGraduatedLayer ||
    divisionLegend !== null ||
    bivariateLayer !== null;

  return (
    <section
      aria-label="Referencias del mapa"
      className="space-y-2 rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-card px-3 py-2.5"
    >
      <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">Referencias</h3>
      {/* PO ask (dock redesign): a one-line top-level framing — the per-legend
          titles below already name WHICH capa each block decodes; this states
          WHAT the section is for, so a first-time operator does not have to
          infer it from the blocks alone. */}
      <p className="text-xs leading-snug text-ln-op-mute">
        Cómo leer los colores y símbolos del mapa.
      </p>
      {/* T4.1 (2026-08-01) — always rendered, independent of `anyLegend`. Three
          gaps closed at once: (a) the AREA-proportional circle sizing
          (`bubbleRadius`, r ∝ √value) was never explained anywhere visible;
          (b) the hatch/stipple rule lived only as a code comment and per-block
          conditional rows, never as a general statement in the tab itself;
          (c) a genuinely reported ZERO had no legend representation, and sits
          visually close to the suppressed dot (0.92 vs 0.6 opacity). An
          operator on the "no hay escalas" empty state still benefits from
          knowing what the marks WOULD mean once a layer starts painting.

          PO ratification (2026-08-05, PO-2): this block stays UNGATED — the P2
          rule ("do not name what this frame does not contain") governs the
          per-frame keys below, not this one. A primer that only lists what is
          already on screen stops teaching the instrument. The tension the
          audit found was real but it was a COPY problem: the block read as a
          key to the current frame. It now says what it is in its own first
          line, so nothing here claims the frame paints a mark it does not. */}
      <div className={CARD}>
        <div className="mb-1.5 font-medium text-ln-op-ink-2">Cómo leer las marcas</div>
        {/* The self-declaration the PO asked for: this is a general reading
            guide, not a key to what is on screen right now. */}
        <p className="mb-1.5 text-ln-op-mute">
          Guía general del mapa: qué significa cada marca cuando aparece. El cuadro actual puede no
          contenerlas a todas.
        </p>
        <div className="flex flex-col gap-1 text-ln-op-ink-2">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 flex-none rounded-full border border-ln-op-line bg-ln-op-ink-2"
              aria-hidden="true"
            />
            <span>El tamaño de los círculos es proporcional a la cantidad de casos.</span>
          </div>
          {/* Same swatch/color as the hatch rows below (hatch-pattern.ts) —
              legend key and on-map mark cannot drift. ⊘ prefix matches
              LegendPill's "⊘ k<5 protegido" so the glyph reads as ONE symbol
              across both surfaces. */}
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 flex-none rounded-[var(--radius-xs)] border border-ln-op-line"
              style={{ backgroundImage: HATCH_SWATCH_CSS }}
              aria-hidden="true"
            />
            <span>
              ⊘ Trama diagonal: protegido por privacidad (k&lt;5, Ley 25.326). El valor real no se
              muestra.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 flex-none rounded-[var(--radius-xs)]"
              style={{
                background: COLOR_NO_DATA,
                backgroundImage: NO_DATA_SWATCH_CSS,
                backgroundSize: NO_DATA_SWATCH_SIZE,
              }}
              aria-hidden="true"
            />
            <span>Punteado: sin datos. Ninguna unidad reportó.</span>
          </div>
        </div>
        <p className="mt-1.5 text-ln-op-mute">
          El valor 0 es un reporte confirmado, no ausencia de datos.
        </p>
      </div>
      {!anyLegend && (
        <p className="text-xs leading-snug text-ln-op-ink-2">
          Por ahora no hay escalas que decodificar: las capas activas no están pintando ningún valor
          por color ni por tamaño en este alcance (por ejemplo, cuando todos los valores quedan
          protegidos por k&lt;5). Activá otra capa o ampliá el alcance para ver las referencias.
        </p>
      )}
      <div className="space-y-2 text-ln-op-ink-2">
        {/* task #63: the bivariate legend IS the 3×3 matrix — coverage terciles
            (x, "Cobertura →") × signal terciles (y, "Señales ↑"). The risk corner
            (low coverage · high signal) is marked. A hatch swatch names the
            k-anon-protected state (color withheld, never inferred). */}
        {bivariateLayer !== null && (
          <div className={CARD}>
            <div className="mb-1.5 font-medium text-ln-op-ink-2">
              {bivariateLayer.bivariatePair?.legendTitle ?? "Intensidad de reporte"}
              <span className="font-normal text-ln-op-mute"> — {bivariateLayer.label}</span>
            </div>
            <BivariateMatrix pair={bivariateLayer.bivariatePair} />
            {/* Live pixel verification 2026-07-30: this row was the ONE k-anon
                key in this file still rendered unconditionally — the bivariate
                block named the hatch whether or not any cell was suppressed,
                the same defect the LegendPill fix closes. Gated on the layer's
                own cells (bivariate suppression lives on `bivariateCells`, not
                on `features`), via the shared `layerPaintsHatch`. */}
            {layerPaintsHatch(bivariateLayer) && (
              <div className="mt-1.5 flex items-center gap-1.5 text-ln-op-mute">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-[var(--radius-xs)] border border-ln-op-line"
                  // Shared hatch color (hatch-pattern.ts) so the legend key matches
                  // the on-map mark exactly — no light-skin drift.
                  style={{ backgroundImage: HATCH_SWATCH_CSS }}
                  aria-hidden="true"
                />
                ⊘ Protegido por privacidad (k&lt;5)
              </div>
            )}
            {/* RA-7 F10 — NAME THE GREY. The 3×3 matrix decodes nine colours and
                the hatch, and said nothing about COLOR_NO_DATA, which
                bivariateFillColorExpr paints on every province the cross could
                not classify. Two different situations land there ("falta un eje"
                and "sin datos en ninguna de las dos"), they are opposite
                conclusions for a municipality, and one grey cannot separate them
                — so the key states which of them THIS frame contains and sends
                the reader to the popup, which does resolve it per jurisdiction.
                Gated: a fully-classified frame paints no grey and says nothing. */}
            {(bivariateGrey.missingAxis || bivariateGrey.noData) && (
              <div className="mt-1.5 flex items-start gap-1.5 text-ln-op-mute">
                <span
                  className="mt-0.5 inline-block h-2.5 w-2.5 flex-none rounded-[var(--radius-xs)] border border-ln-op-line"
                  style={{ background: COLOR_NO_DATA }}
                  aria-hidden="true"
                />
                <span className="leading-snug">
                  {bivariateGrey.missingAxis && bivariateGrey.noData
                    ? "Gris: no se pudo cruzar. En algunas jurisdicciones falta una de las dos capas; en otras faltan las dos. Tocá una para ver cuál."
                    : bivariateGrey.missingAxis
                      ? "Gris: falta una de las dos capas en esa jurisdicción, así que el cruce no se puede clasificar. No significa que no haya casos. Tocá una para ver cuál falta."
                      : "Gris: ninguna de las dos capas reportó en esa jurisdicción."}
                </span>
              </div>
            )}
          </div>
        )}
        {/* Division-fill legend: sequential ramp for the active locality choropleth
            over the barrio/departamento polygons. Names the unit and states that an
            unfilled division is genuine no-data (or k-anon protected).

            MAP-3 honesty fix (QA 2026-07-11): the drilled division fill encodes raw
            COUNTS (the v1 count-density locality rollup — repository.ts locality
            choropleth loaders return per-unit counts), even when the SAME layer's
            province-level fill encodes a RATE against a meta (e.g. cobertura:
            province = "<40%…≥80% (meta)", drilled = counts 48/89/131/172) and the
            KPI headline stays a rate. That v1 difference is deliberate; the legend
            must therefore SAY the unit — "conteos por departamento" — so the
            drilled map is never misread as % coverage. If a rate-encoded division
            fill ever ships, thread an encoding field through
            DivisionLegendDescriptor instead of editing this string. */}
        {divisionLegend !== null && (
          <div className={CARD}>
            <div className="mb-1 font-medium text-ln-op-ink-2">
              {divisionLegend.label}{" "}
              <span className="font-normal text-ln-op-mute">
                · conteos por {divisionLegend.unitNoun}
              </span>
            </div>
            {divisionLegend.hasRamp && (
              <ClassSwatchLegend
                scale={{
                  breaks: divisionLegend.breaks,
                  colors: divisionLegend.colors,
                  method: "quantile",
                }}
              />
            )}
            {/* cursor #2: trichotomous — colored fill = value, DIAGONAL HATCH =
                k-anon-protected, outline-only = genuine no-data. */}
            {divisionLegend.suppressed && (
              <div className="mt-1 flex items-center gap-1.5 text-ln-op-mute">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-[var(--radius-xs)] border border-ln-op-line"
                  // Shared hatch color (hatch-pattern.ts): legend key == on-map mark.
                  style={{ backgroundImage: HATCH_SWATCH_CSS }}
                  aria-hidden="true"
                />
                ⊘ Protegido por privacidad (k&lt;5)
              </div>
            )}
            {/* RA-7 F9 — gated, like the hatch row above it. This key used to
                render on every drilled frame, promising an outline-only mark on
                scopes where every division carries a value. `noData` is lifted
                from syncLayers (divisionPaintsNoData), the same complement the
                stipple overlay is filtered by. `!== false` on purpose: a
                descriptor from before this field existed says "unknown", and for
                a key that has always over-rendered, unknown must not start
                hiding a mark that IS on the canvas. */}
            {divisionLegend.noData !== false && (
              <div className="mt-1 flex items-center gap-1.5 text-ln-op-mute">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-[var(--radius-xs)] border border-ln-op-line"
                  aria-hidden="true"
                />
                Sin datos (solo contorno)
              </div>
            )}
          </div>
        )}
        {provinceLegends.map(({ layer, encoding }) => {
          const isMeta = encoding?.meta === true;
          // Prefer the scale LIFTED from the map (built from the same values +
          // locked domain / meta target the fill renders, so the swatch ranges
          // describe the PAINTED colors even mid-scrub); fall back to the
          // ENCODING the fill would resolve for this frame when the lift is not
          // yet present (first paint, or a frame where SituationalMap has not
          // committed yet). The fallback used to be a bare
          // `computeClassScale(values, { target })` — a third derivation that
          // knew nothing about polarity or delta encoding and could therefore
          // publish swatch colours the map never paints. Now both branches
          // ultimately come from the same resolver.
          const lifted = provinceSeqLegend[layer.id];
          const scale: ClassScale | null = lifted
            ? {
                breaks: lifted.breaks,
                colors: lifted.colors,
                method: isMeta ? "meta" : "interval",
              }
            : (encoding?.scale ?? null);
          return (
            <div key={layer.id} className={CARD}>
              <div className="mb-1 font-medium text-ln-op-ink-2">{layer.label}</div>
              {/* Theme 3 + PO decision: discrete CLASS swatches for every province
                  choropleth. META'd rate layers (cobertura / esterilización /
                  microchip / ppp) show a "%" unit and mark the top class as the
                  compliance target ("≥ 80% (meta)"), replacing the old continuous
                  divergent gradient bar. */}
              {scale !== null && (
                <ClassSwatchLegend scale={scale} unit={encoding?.unit} meta={isMeta} />
              )}
              {/* T4.1 — a confirmed 0 falls in the lowest color class, same as any
                  small positive value; the swatch alone cannot tell them apart.
                  Gated on THIS layer's own features, same discipline as the
                  hatch/stipple rows beside it. */}
              {layerPaintsZero(layer.features, "value") && (
                <div className="mt-1 text-ln-op-mute">
                  El valor 0 es un reporte confirmado, no ausencia de datos.
                </div>
              )}
              {/* RA-7 F9 — gated on the frame, exactly like the k-anon row below
                  it. Unconditional until now: a national frame where all 24
                  jurisdictions report paints no stipple anywhere, and the key
                  still named the mark. Same complement provinceNoDataFilter
                  paints with, so key and overlay cannot disagree. */}
              {provincePaintsNoData(layer.features) && (
                <div className="mt-1 flex items-center gap-1.5 text-ln-op-mute">
                  {/* The swatch carries the SAME stipple the map paints (D.5(b)).
                      A key that shows a flat colour for a textured fill teaches
                      the reader the wrong mark, and the texture is the whole
                      reason "sin datos" is now separable from bare land — they
                      are only ΔE00 1.48 apart as colours. Pattern values come
                      from no-data-pattern.ts so key and map cannot drift. */}
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-[var(--radius-xs)]"
                    style={{
                      background: COLOR_NO_DATA,
                      backgroundImage: NO_DATA_SWATCH_CSS,
                      backgroundSize: NO_DATA_SWATCH_SIZE,
                    }}
                    aria-hidden="true"
                  />
                  Sin datos
                </div>
              )}
              {/* k-anon disclosure at PROVINCE grain (#40). This block used to be
                  a comment explaining its own ABSENCE: "provinces are never
                  suppressed". That premise died with #40 — a province cell is now
                  suppressed when its DENOMINATOR is sub-k (Santa Cruz publishing
                  100% over 11 dogs), and the map hatches it. The key must name the
                  mark: an unexplained texture on a province is worse than none,
                  because the reader's only available guess is "sin datos".
                  Rendered ONLY when this layer actually has a suppressed province,
                  so the row never announces a state the current frame lacks — the
                  same conditional discipline as divisionLegend.suppressed above.
                  Reads the shared `layerPaintsHatch` (hatch-pattern.ts), the SAME
                  atom LegendPill's k-anon pill is gated on, so the collapsed strip
                  and this panel can never disagree about the mark. */}
              {layerPaintsHatch(layer) && (
                <div className="mt-1 flex items-center gap-1.5 text-ln-op-mute">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-[var(--radius-xs)] border border-ln-op-line"
                    // Shared hatch color (hatch-pattern.ts): legend key == on-map mark.
                    style={{ backgroundImage: HATCH_SWATCH_CSS }}
                    aria-hidden="true"
                  />
                  ⊘ Protegido por privacidad (k&lt;5)
                </div>
              )}
            </div>
          );
        })}
        {/* F1 graduated-circle legend: fixed size → count-bucket mapping. */}
        {hasGraduatedLayer && graduatedScale && (
          <div className={CARD}>
            <div className="mb-1.5 font-medium text-ln-op-ink-2">
              Eventos por unidad
              {graduatedLayerLabel && (
                <span className="font-normal text-ln-op-mute"> — {graduatedLayerLabel}</span>
              )}
            </div>
            <div className="flex flex-col gap-1">
              {/* Light-flip fix (dataviz review 2026-07-23): the retired dark
                  "situation-room" skin left these bubbles white-on-white
                  (rgba(255,255,255,…) inside the light bg-ln-op-stripe card —
                  invisible, defeating the size→count key). The encoding is
                  SIZE, so a neutral ink outline reads on the light card and
                  stays honest about not being a color key. */}
              {graduatedScale.bins.map((b) => (
                <div key={b.value} className="flex items-center gap-2">
                  <span
                    className="flex-none rounded-full border-[1.5px] border-ln-op-ink-2/70"
                    style={{
                      width: b.r * 2,
                      height: b.r * 2,
                      // The map's own fill for this mark when it is unambiguous
                      // (see graduatedColor). `circle-opacity` is 0.92 on the
                      // canvas; matched here so the key is the same mark, not a
                      // saturated approximation of it.
                      background: graduatedColor ?? "transparent",
                      opacity: graduatedColor ? 0.92 : 1,
                    }}
                    aria-hidden="true"
                  />
                  <span className="tabular-nums text-ln-op-ink-2">{b.label}</span>
                </div>
              ))}
              {/* T4.1 — `bubbleRadius` collapses a genuine zero to the same floor
                  radius (BUBBLE_R_MIN) a suppressed dot also collapses to; only
                  opacity/color differ (0.92 layer color vs 0.6 COLOR_SUPPRESSED),
                  which reads as noise, not signal, at a glance. */}
              {graduatedPaintsZero && (
                <div className="mt-0.5 text-ln-op-mute">
                  El valor 0 es un reporte confirmado, no ausencia de datos.
                </div>
              )}
              {/* RA-7 F3: the protected DOT is a real mark (COLOR_SUPPRESSED at
                  0.6 opacity, own stroke, collapsed to BUBBLE_R_MIN) — so this
                  key is named when it is painted, and only then. */}
              {graduatedPaintsSuppressed && (
                <div className="mt-0.5 flex items-center gap-2">
                  <span
                    className="flex-none rounded-full border border-ln-op-ink-2/40"
                    style={{ width: 10, height: 10, background: COLOR_SUPPRESSED }}
                    aria-hidden="true"
                  />
                  <span className="text-ln-op-mute">Datos insuficientes (privacidad)</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
