// Sparkline — inline SVG trend line for the Panorama unit-history panel (F4).
//
// Renders a <polyline> over a number series with no external dependencies.
// The pure path-math helper (sparklinePath) is exported separately so it can
// be unit-tested without React or a DOM.
//
// Accessibility: role="img" + aria-label provided by the caller
// (e.g. "Tendencia de {metric}: {n} puntos").

/**
 * Convert a series to one `<polyline>` points string per CONTIGUOUS RUN of
 * plotted values. A `null` is a HOLE — a bucket with no value to draw — and the
 * line breaks across it instead of dipping through it.
 *
 * WHY A HOLE EXISTS AT ALL (metric-honesty audit, PO 2026-09-16): a bucket
 * masked by k-anonimato carries `y: 0` plus a `suppressed` flag. Plotted as a
 * number, that 0 becomes the series MINIMUM and pins to the bottom of the box —
 * a trough indistinguishable from a week where genuinely nothing happened.
 * Suprimido ≠ cero, so the caller passes `null` and gets a gap. Same treatment
 * TimeSeriesChart gives its masked points, expressed in this file's SVG idiom.
 *
 * Contract:
 *   - Empty series, or every value null → [] (caller hides the element).
 *   - Single plotted point → horizontal mid-line (one point at its own x).
 *   - Flat series (all plotted values equal) → horizontal line at height/2.
 *   - Normal series → min maps to bottom (y=height), max maps to top (y=0).
 *   - x positions are computed over the FULL series length, holes included, so
 *     a gap keeps its width and the time base is not compressed.
 *
 * @pure — no side effects, no DOM, no React. Safe to call in Node/Vitest.
 */
export function sparklineSegments(
  values: ReadonlyArray<number | null>,
  width: number,
  height: number,
): string[] {
  const plotted = values.filter((v): v is number => v !== null);
  if (plotted.length === 0) return [];

  const min = Math.min(...plotted);
  const max = Math.max(...plotted);
  const range = max - min;

  // Anchored on the FULL length, not on the plotted count: dropping the holes
  // from the x math would slide every later bucket leftwards and silently
  // redraw the time base, which is a second falsehood on top of the first.
  const xStep = values.length === 1 ? 0 : width / (values.length - 1);

  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length > 0) segments.push(current.join(" "));
      current = [];
      return;
    }
    const x = values.length === 1 ? width / 2 : i * xStep;
    // When all plotted values are equal (range === 0) render at vertical center.
    const y = range === 0 ? height / 2 : height - ((v - min) / range) * height;
    // Round to 2 decimal places to keep SVG output tidy.
    current.push(`${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`);
  });
  if (current.length > 0) segments.push(current.join(" "));

  return segments;
}

/**
 * Convert a HOLE-FREE numeric series to a single SVG `<polyline>` points string.
 *
 * Kept as the narrow, long-standing entry point (its callers and its unit tests
 * predate the suppression work). It delegates to `sparklineSegments`, which
 * yields exactly one segment when no value is null — byte-identical output for
 * every input this function ever accepted.
 *
 * @pure — no side effects, no DOM, no React. Safe to call in Node/Vitest.
 */
export function sparklinePath(values: number[], width: number, height: number): string {
  return sparklineSegments(values, width, height).join(" ");
}

type SparklineProps = {
  /** The series to plot — one entry per time bucket. `null` is a HOLE (e.g. a
   *  bucket masked by k-anonimato): the line breaks instead of dipping to the
   *  floor through a zero nobody measured. See `sparklineSegments`. */
  points: ReadonlyArray<number | null>;
  /** SVG canvas width in px (default 120). */
  width?: number;
  /** SVG canvas height in px (default 32). */
  height?: number;
  /** Accessible label, e.g. "Tendencia de mordeduras: 12 puntos". */
  ariaLabel: string;
};

/**
 * Inline SVG sparkline. Renders a single <polyline> with no external deps.
 * Empty or single-point series are handled gracefully (no render / mid-point).
 */
export function Sparkline({ points, width = 120, height = 32, ariaLabel }: SparklineProps) {
  const segments = sparklineSegments(points, width, height);

  if (segments.length === 0) {
    // Empty series — render a muted placeholder line at mid height.
    return (
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        className="overflow-visible"
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="3 3"
          className="text-ln-op-line"
        />
      </svg>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={ariaLabel}
      className="overflow-visible"
    >
      {segments.map((pts) => (
        <polyline
          // The points string is unique per run by construction (each run starts
          // at a distinct x), so it is a stable identity without an index key.
          key={pts}
          points={pts}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-ln-op-azul"
        />
      ))}
    </svg>
  );
}
