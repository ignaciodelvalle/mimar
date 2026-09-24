"use client";

// LegendPill — the v2C single-line legend overlay (bottom-left, above the
// dock bar): one pill with the base-metric label, the 5-cell classed ramp,
// one dot per active point layer, and — WHEN THE FRAME ACTUALLY PAINTS ONE —
// the k-anon pill («⊘ k<5 protegido»). Clicking
// expands the FULL reading (the real MapLegends blocks + captions + honesty
// notices) in a panel that opens upward — plan note: the compact strip is the
// overlay; the full legend is one click away.

import type { ReactNode } from "react";

import { OverlayDisclosure } from "@/components/panorama/OverlayDisclosure";

type Props = {
  /** Label of the metric painting the map ("Eventos por unidad", layer label…). */
  baseLabel: string;
  /** The classed ramp actually painted (class colors, low→high), or null. */
  rampColors: readonly string[] | null;
  /**
   * H10 (cowork QA): the map is in BIVARIATE mode (a 3×3 matrix, not a sequential
   * ramp). When true the collapsed strip shows an honest 3×3 matrix hint instead
   * of a ramp — the caller must ALSO pass `rampColors={null}` so no ramp competes
   * with the hint. The full 3×3 reading lives in the expanded `children`.
   */
  bivariate?: boolean;
  /**
   * The ACTIVE bivariate pair's axis caption ("Registro PPP × Mordeduras"),
   * built by `bivariateAxesLabel` from the pair the matrix actually crosses.
   *
   * PO 2026-08-01. This slot used to be the hardcoded literal "cobertura ×
   * señal", rendered for EVERY bivariate frame. That vocabulary belongs to ONE
   * declared pair (cobertura × zoonosis); on `riesgo-ppp` the canvas crosses
   * registro PPP × mordeduras and the strip named neither axis correctly — with
   * the map's own popup two centimetres above it saying the right thing.
   * `bivariateCaptionText` had already learned this lesson for the expanded
   * caption (bivariate.ts, PO validacion-A 2026-07-23); the collapsed strip
   * kept its copy of the old bug.
   *
   * Absent → the 3×3 hint renders with no axis caption. A legend that does not
   * know what the matrix crosses says nothing, never a guess.
   */
  bivariateAxes?: string | null;
  /**
   * One dot per point layer THE MAP IS PAINTING (its registry color + label).
   *
   * "Painting", not "active": under the bivariate encoding the signal layer is
   * folded INTO the 3×3 matrix and its circles are removed from the canvas
   * (PanoramaConsole's `mapLayers` drops it). The caller must therefore derive
   * these from the painted layer set — see the call site.
   */
  layerDots: ReadonlyArray<{ color: string; label: string }>;
  /**
   * Round-3 QA fix 6: low/high endpoint labels flanking the ramp (e.g. "0%" /
   * "70% meta") — so "what does dark mean" is answerable WITHOUT expanding.
   * Null when there is no ramp to anchor (bivariate mode, or no classed fill).
   */
  rampEndpoints?: { min: string; max: string } | null;
  /**
   * Round-3 QA fix 6: the graduated/points size hint — small vs large bubble
   * radii (px, as rendered on the map) + their value labels. These encodings
   * paint no ramp at all, so without this the collapsed pill offered no scale
   * cue beyond a bare color dot.
   *
   * `color` is the layer's own bubble fill when exactly one graduated layer is
   * painting (null when several — no single colour to cite).
   */
  graduatedHint?: {
    small: { r: number; label: string };
    large: { r: number; label: string };
    color?: string | null;
  } | null;
  /**
   * Whether the CURRENT FRAME paints at least one k-anon hatch — the gate for
   * the «⊘ k<5 protegido» pill.
   *
   * LIVE PIXEL VERIFICATION 2026-07-30. The pill used to be unconditional
   * ("privacy visible, spec no-negociable #1"), so it announced a 113×25 px
   * mark with a Ley 25.326 tooltip over frames with ZERO hatched units, while
   * MapLegends — same frame, same data — correctly omitted its k-anon row and
   * said "Por ahora no hay escalas que decodificar". The spec asks that
   * suppression never be HIDDEN; it does not ask that it be CLAIMED. A legend
   * that names a mark the canvas does not paint is what teaches an operator to
   * stop reading the legend, and the notice they stop reading is the privacy
   * one.
   *
   * REQUIRED, not defaulted: a default would let a future call site silently
   * pick a branch, and the wrong branch here is the false claim this removes.
   * Callers pass `frameHasSuppressedMark(...)` (hatch-pattern.ts) — the SAME
   * atoms that gate MapLegends' «Protegido por privacidad (k<5)» rows, so the
   * collapsed strip and the expanded panel cannot disagree.
   *
   * Deliberately NOT `suppressedCount > 0`: that number describes the response
   * (possibly at a grain the frame is not painting), and a legend must describe
   * the canvas.
   */
  suppressedInFrame: boolean;
  /** The expanded full reading (MapLegends + captions + notices). */
  children: ReactNode;
};

/**
 * Collapsed bivariate cue: a 3×3 grid whose fill deepens toward the high×high
 * (risk) corner — a recognizable matrix glyph, so the strip never implies a
 * sequential ramp in bivariate mode. Purely decorative (the expanded panel
 * carries the real legend + method), hence aria-hidden.
 */
function BivariateHint() {
  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0 grid-cols-3 gap-px overflow-hidden rounded-[var(--radius-xs)] border border-ln-op-line-2"
      title="Mapa bivariado (matriz 3×3): tocá para leer la escala."
    >
      {[0.15, 0.3, 0.5, 0.3, 0.5, 0.7, 0.5, 0.7, 0.95].map((alpha, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed 9-cell positional matrix — index IS the stable identity.
          key={`biv-${i}`}
          className="block h-2 w-2"
          style={{
            backgroundColor: `color-mix(in srgb, var(--color-ln-op-azul) ${alpha * 100}%, transparent)`,
          }}
        />
      ))}
    </span>
  );
}

/**
 * Largest diameter (px) a collapsed-strip hint bubble may take. The map's own
 * bubbles run BUBBLE_R_MIN 5 → BUBBLE_R_MAX 30 (10–60 px across), which cannot
 * fit inside a one-line pill — so the pair is scaled DOWN by a single common
 * factor. Both dots shrink together, which is the only thing that has to be
 * true: the RATIO between them is the scale cue, and a shared factor preserves
 * it exactly (the map's √-area relation survives the rescale).
 */
const HINT_MAX_D = 14;

/** The two hint diameters (px) for a graduated small/large pair, scaled to fit
 *  the strip while preserving their on-map size ratio. */
function hintDiameters(smallR: number, largeR: number): { small: number; large: number } {
  const large = Math.max(largeR, smallR, 0.5);
  const factor = HINT_MAX_D / (large * 2);
  return { small: Math.max(3, Math.round(smallR * 2 * factor)), large: HINT_MAX_D };
}

export function LegendPill({
  baseLabel,
  rampColors,
  bivariate,
  bivariateAxes = null,
  layerDots,
  rampEndpoints = null,
  graduatedHint = null,
  suppressedInFrame,
  children,
}: Props) {
  // Visual review 2026-07-23 (#2): when the pill title already names a point
  // layer (legendRampTitle falls back to the caption label when no ramp paints
  // — e.g. a graduated denuncias-only view), that layer's own dot chip repeated
  // the identical label right beside it ("Denuncias de bienestar • Denuncias de
  // bienestar"). The bold title IS the naming — suppress the redundant chip.
  // Filtered ONCE here so the collapsed strip and the expanded full-label
  // repeat below (same source array) stay in lockstep.
  const visibleDots = layerDots.filter((dot) => dot.label !== baseLabel);
  return (
    <OverlayDisclosure
      side="up"
      // PO fix ("el panel de referencias queda cortado"): the old max-h-[55vh]
      // clamp cut the legend body well before the viewport actually ran out,
      // forcing a scroll even on tall screens. The panel opens UPWARD from a
      // trigger pinned near the bottom of the map (bottom-16, or bottom-3.5 in
      // presentation mode) under a masthead — calc(100vh-10rem) reserves that
      // worst-case chrome (masthead + trigger + gap + a top margin) so the FULL
      // reading fits unclamped on ordinary viewports, while overflow-y-auto stays
      // as a safety net on very short ones (never lets the panel run off-screen).
      //
      // PO round-2 fix ("sigo viendo compresión, el punto de zoonosis/señal
      // queda cortado"): w-[19rem] was too narrow for a full point-layer label
      // ("Zoonosis / señales" and longer) once it was given a place to render
      // unclamped below — 22rem gives that label real room to sit on one or two
      // relaxed lines instead of squeezing every word. Capped at
      // calc(100vw-1.75rem) (same viewport-edge margin the collapsed strip's
      // outer container already reserves) so it never overflows a narrow phone.
      panelClassName="left-0 max-h-[calc(100vh-10rem)] w-[22rem] max-w-[calc(100vw-1.75rem)] overflow-y-auto"
      summaryClassName="flex max-w-full items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-full border border-ln-op-line bg-ln-op-card px-3.5 py-1.5 text-sm text-ln-op-ink-2 shadow-md hover:border-ln-op-celeste"
      summary={
        <>
          {/* min-w-0 + 2-line clamp: at the dock's mobile width the shrink-0
              ramp / k-anon pill / caret used to squeeze a truncated label down
              to "De…" (dataviz review, baseLabel truncation). Wrapping to a
              second tight line keeps the metric name readable without moving
              the pinned trailing elements; whitespace-normal re-enables
              wrapping under the strip's whitespace-nowrap; line-clamp-2 still
              ellipsizes a pathological third line. */}
          <span className="line-clamp-2 min-w-0 flex-shrink whitespace-normal font-semibold leading-tight">
            {baseLabel}
          </span>
          {bivariate && (
            // Round-3 QA fix 6: the 3×3 hint already existed; add the two axis
            // labels micro-captioned so the collapsed strip names WHAT the
            // matrix crosses, not just that it is a matrix. The caption comes
            // from the ACTIVE pair (see `bivariateAxes`) — never a literal.
            <span className="inline-flex shrink-0 items-center gap-1">
              <BivariateHint />
              {bivariateAxes && (
                <span className="text-xs leading-none text-ln-op-faint">{bivariateAxes}</span>
              )}
            </span>
          )}
          {rampColors !== null && rampColors.length > 0 && (
            // Round-3 QA fix 6: min/max endpoint labels flank the ramp so the
            // collapsed pill answers "what does dark mean" without expanding.
            <span className="inline-flex shrink-0 items-center gap-1">
              {rampEndpoints && (
                <span className="text-xs tabular-nums leading-none text-ln-op-faint">
                  {rampEndpoints.min}
                </span>
              )}
              <span
                aria-hidden="true"
                className="inline-flex shrink-0 overflow-hidden rounded-[var(--radius-xs)] border border-ln-op-line-2"
              >
                {rampColors.map((color) => (
                  <span
                    // Classed ramp colors are distinct stops (class-scale.ts
                    // samples without repeats), so the color IS the identity.
                    key={color}
                    className="block h-2 w-3.5"
                    style={{ background: color }}
                  />
                ))}
              </span>
              {rampEndpoints && (
                <span className="text-xs tabular-nums leading-none text-ln-op-faint">
                  {rampEndpoints.max}
                </span>
              )}
            </span>
          )}
          {graduatedHint &&
            (() => {
              // Round-3 QA fix 6: graduated/points had NO collapsed scale at all
              // (only a color dot) — the biggest gap the QA doc named. A compact
              // small●–large● step hint with the real bin labels.
              //
              // PO 2026-08-01. The two dots were HARDCODED at 4 px and 10 px
              // while this prop's own doc promised "bubble radii (px, as
              // rendered on the map)". They were a fixed 2,5× pair no matter
              // what the data did: a frame whose bins ran 1 → 2 (map radii 5 and
              // ~26 px, a 5,3× area step) and a frame whose bins ran 1 → 900 got
              // the identical picture, and the "large" 10 px dot was the exact
              // size of the map's SMALLEST bubble. Derived from the real radii
              // now, scaled by one shared factor so the ratio survives.
              const d = hintDiameters(graduatedHint.small.r, graduatedHint.large.r);
              // The map fills these in the layer's colour; cite it when there is
              // one (MapLegends does the same in the expanded block).
              const dot = graduatedHint.color
                ? { background: graduatedHint.color, opacity: 0.92 }
                : {};
              return (
                <span
                  className="inline-flex shrink-0 items-center gap-1"
                  title="Tamaño del punto ∝ cantidad de eventos por unidad"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block shrink-0 rounded-full border border-ln-op-line-2 bg-ln-op-azul/20"
                    style={{ width: d.small, height: d.small, ...dot }}
                  />
                  <span className="text-xs tabular-nums leading-none text-ln-op-faint">
                    {graduatedHint.small.label}
                  </span>
                  <span aria-hidden="true" className="text-xs leading-none text-ln-op-faint">
                    –
                  </span>
                  <span
                    aria-hidden="true"
                    className="inline-block shrink-0 rounded-full border border-ln-op-line-2 bg-ln-op-azul/20"
                    style={{ width: d.large, height: d.large, ...dot }}
                  />
                  <span className="text-xs tabular-nums leading-none text-ln-op-faint">
                    {graduatedHint.large.label}
                  </span>
                </span>
              );
            })()}
          {visibleDots.map((dot) => (
            <span key={dot.label} className="inline-flex shrink-0 items-center gap-1">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full border border-ln-op-line"
                style={{ background: dot.color }}
              />
              <span className="text-xs">{dot.label}</span>
            </span>
          ))}
          {/* k-anon pill — shown whenever the frame paints a hatch, and ONLY
              then. Suppression is never hidden (the expanded panel carries the
              full per-layer notice); it is also never claimed over a canvas
              with nothing hatched on it. See `suppressedInFrame` above. */}
          {suppressedInFrame && (
            <span
              className="shrink-0 rounded-full border border-ln-op-line px-2 py-0.5 text-xs text-ln-op-mute"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(45deg, var(--color-ln-op-stripe) 0 3px, var(--color-ln-op-line-2) 3px 6px)",
              }}
              title="Unidades con menos de 5 casos: valor suprimido por k-anonimato (Ley 25.326)"
            >
              ⊘ k&lt;5 protegido
            </span>
          )}
          <span aria-hidden="true" className="shrink-0 text-xs text-ln-op-faint">
            ▴
          </span>
        </>
      }
    >
      {/* PO fix ("el punto de zoonosis/señal queda cortado"): the collapsed
          strip's dots above (`max-w-24 truncate`) are deliberately clipped —
          that's the compact glance strip. But the <summary> stays visible even
          while OPEN (native <details> markup), so its clipped label was the
          ONLY place a point layer's name ever appeared — the full MapLegends
          reading lives one tab away in the dock's Referencias tab (dock
          redesign) and no longer restates it. Repeat the same layerDots here,
          full label, wrapping instead of clipping, so expanding the pill
          actually answers "which point layer is that dot" in full. */}
      {visibleDots.length > 0 && (
        <div className="mb-2 flex flex-col gap-1 border-b border-ln-op-line-2 pb-2">
          {visibleDots.map((dot) => (
            <span key={dot.label} className="flex items-start gap-1.5 text-xs">
              <span
                aria-hidden="true"
                className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full border border-ln-op-line"
                style={{ background: dot.color }}
              />
              <span className="leading-snug text-ln-op-ink-2">{dot.label}</span>
            </span>
          ))}
        </div>
      )}
      {children}
    </OverlayDisclosure>
  );
}
