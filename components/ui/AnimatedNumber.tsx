"use client";

// AnimatedNumber — renders a number that eases to its new value when it changes
// (via useCountUp), so a KPI shows its delta viscerally instead of snapping.
// The tween is client-only; SSR (and reduced motion) render the exact value.
//
// `format` OWNS rounding + es-AR formatting + any suffix, because the in-flight
// animated value is fractional — e.g. `(n) => `${Math.round(n).toLocaleString(
// "es-AR")}%``. Default: rounded es-AR integer. Always tabular-nums so the width
// doesn't jitter frame to frame.

import { useCountUp } from "@/lib/hooks/useCountUp";

export function AnimatedNumber({
  value,
  format,
  durationMs,
  startAt,
  className,
}: {
  /** The target number. */
  value: number;
  /** Formats the (fractional, mid-tween) animated value to its display string. */
  format?: (n: number) => string;
  durationMs?: number;
  /**
   * Optional mount reveal — the value counts FROM here to `value` on first paint
   * (e.g. `0`). NOTE: SSR renders `startAt`, so a no-JS/reduced-motion viewer
   * sees it, not the target — use only where a client-side reveal is acceptable.
   * Omit for the SSR-safe default (renders the exact target; only changes animate).
   */
  startAt?: number;
  className?: string;
}) {
  const animated = useCountUp(value, durationMs, startAt);
  const rendered = format ? format(animated) : Math.round(animated).toLocaleString("es-AR");
  return <span className={["tabular-nums", className].filter(Boolean).join(" ")}>{rendered}</span>;
}
