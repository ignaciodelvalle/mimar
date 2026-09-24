"use client";

// AnimatedKpiValue — the panorama KPI strip's number, eased instead of snapped.
//
// WHY (motion audit 2026-08-04, Gap 5): the repo owns `AnimatedNumber` +
// `useCountUp` — built, reduced-motion-guarded, unit-tested — and had wired it
// into exactly ONE consumer (`OpKpi`). The panorama's own strip, which is the
// single surface in the product where watching a number CHANGE is the entire
// point (the operator is dragging a time scrubber), dimmed the whole list to
// opacity-60 and then let six figures snap at once. The dim tells you the SET
// is stale; it cannot tell you WHICH member moved.
//
// WHY THIS FILE EXISTS AT ALL — `PanoramaKpi.value` is a PRE-FORMATTED es-AR
// string ("1.234", "83%", "12,5%"), formatted server-side. `AnimatedNumber`
// needs a number, and there is no numeric field to read: adding one would mean
// changing the domain type, every producer, the KPI-cube JSON round-trip and
// their fixtures — a schema change to buy an animation.
//
// So this parses the string back. Which is only defensible with a proof, and
// there is one: it re-formats the parsed number and animates ONLY IF the round
// trip reproduces the server's characters EXACTLY. Any value this module
// cannot reproduce byte-for-byte — a range, an em dash, a locale shape it did
// not anticipate — renders verbatim and unanimated. The failure mode is "no
// animation", never "a differently-formatted number".

import { AnimatedNumber } from "@/components/ui/AnimatedNumber";

/**
 * Tween duration while a temporal frame is active, in ms.
 *
 * The scrubber advances every 1100ms (`TimeScrubber.PLAY_INTERVAL_MS`), so the
 * default 600ms tween would still be mid-flight when the next value lands and
 * the strip would never be still. 300ms is the same reasoning — and the same
 * number — as the map's `DIVISION_FADE_MS`: it leaves ~800ms of settled frame
 * to actually READ, which is what the operator is there for. The audit's own
 * caveat on this gap: do not ship a permanently-mid-tween number.
 */
const SCRUB_TWEEN_MS = 300;

/** Splits "  83,5%" into ["", "83,5", "%"]; null when there is no number. */
const NUMERIC = /^(\D*?)(\d[\d.]*(?:,\d+)?)(.*)$/s;

type Parsed = { prefix: string; n: number; decimals: number; suffix: string };

/**
 * Parse an es-AR formatted figure, and verify the parse by reproducing it.
 *
 * es-AR uses `.` for thousands and `,` for decimals, so "1.234" is one
 * thousand two hundred thirty-four and "12,5" is twelve and a half — the exact
 * inverse of the en-US reading, which is why this refuses to guess. Exported
 * for unit tests.
 */
export function parseEsArFigure(value: string): Parsed | null {
  const m = NUMERIC.exec(value);
  if (!m) return null;
  const [, prefix, digits, suffix] = m;
  const [whole, fraction = ""] = digits.split(",");
  const n = Number(`${whole.replaceAll(".", "")}.${fraction || "0"}`);
  if (!Number.isFinite(n)) return null;
  const decimals = fraction.length;
  // The proof: unless our own formatter reproduces the server's characters, we
  // have misread the locale and must not touch the number.
  if (formatEsAr(n, decimals) !== digits) return null;
  return { prefix, n, decimals, suffix };
}

function formatEsAr(n: number, decimals: number): string {
  return n.toLocaleString("es-AR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function AnimatedKpiValue({
  value,
  temporalFrameActive,
  className,
}: {
  /** The server's pre-formatted es-AR figure. */
  value: string;
  /** True while the time scrubber owns the frame — shortens the tween. */
  temporalFrameActive: boolean;
  className?: string;
}) {
  const parsed = parseEsArFigure(value);
  if (!parsed) return <span className={className}>{value}</span>;

  const { prefix, n, decimals, suffix } = parsed;
  return (
    <AnimatedNumber
      value={n}
      durationMs={temporalFrameActive ? SCRUB_TWEEN_MS : undefined}
      format={(x) => `${prefix}${formatEsAr(x, decimals)}${suffix}`}
      className={className}
    />
  );
}
