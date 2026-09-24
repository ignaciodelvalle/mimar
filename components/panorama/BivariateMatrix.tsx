// The bivariate 3×3 key, as ONE component two surfaces read.
//
// WHY THIS FILE EXISTS (PO report 2026-08-01): LegendPill's docblock says "the
// full 3×3 reading lives in the expanded `children`". It did not. The collapsed
// strip showed a 3×3 HINT, so an operator opened the pill expecting the key and
// got a paragraph of prose about terciles — the matrix only ever existed inside
// MapLegends (the Referencias tab). A comment that declares where something
// lives, pointing at a place it does not live, is worse than no comment: it
// stops the next reader from looking.
//
// Extracting rather than copying is the point. The matrix decodes nine colours
// against a palette whose CVD validation is measured by a fence
// (__tests__/bivariate-cvd.test.ts); a second hand-kept copy is a second thing
// that can drift out of that guarantee, and the drift would be invisible —
// both surfaces would still render *a* legend.
//
// Scope: the KEY only (axes + swatches + risk corner). The hatch row and the
// grey row stay with their callers, because whether to show them is a question
// about the FRAME ("does this frame paint that mark?"), not about the key, and
// each surface already answers it from its own shared predicate.

import { BIVARIATE_LEGEND_GRID } from "@/components/panorama/bivariate-fill";
import type { BivariatePair } from "@/src/modules/panorama/domain/bivariate";

type Props = {
  /**
   * The ACTIVE pair, so the axes are named by what the matrix actually crosses.
   * Absent → the generic axis captions. Never a guess at the pair.
   */
  pair?: BivariatePair | null;
};

export function BivariateMatrix({ pair }: Props) {
  return (
    <div className="flex items-stretch gap-1.5">
      <div className="flex flex-col items-center justify-center">
        <span className="whitespace-nowrap text-xs text-ln-op-mute [writing-mode:vertical-rl] [transform:rotate(180deg)]">
          {pair?.signalAxis ?? "Señales ↑"}
        </span>
      </div>
      <div>
        {/* 3 rows × 3 cols; grid is row-major, top row = high signal. */}
        <div className="grid grid-cols-3 gap-0.5">
          {BIVARIATE_LEGEND_GRID.map((sw) => (
            <span
              key={`biv-${sw.cov}-${sw.sig}`}
              className={`h-4 w-4 rounded-[var(--radius-xs)] ${
                sw.risk ? "ring-1 ring-ln-op-danger" : "border border-ln-op-line-2"
              }`}
              style={{ background: sw.color }}
              title={
                sw.risk
                  ? (pair?.riskCornerNote ?? "Intensidad alta: cobertura baja · señales altas")
                  : undefined
              }
              aria-hidden="true"
            />
          ))}
        </div>
        <div className="mt-0.5 text-center text-xs text-ln-op-mute">
          {pair?.coverageAxis ?? "Cobertura →"}
        </div>
      </div>
    </div>
  );
}
