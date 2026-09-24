// Pure domain-lock for color/size scales under a time scrub (fixes the flicker
// bug). The choropleth fill, the province sequential fill, and the graduated
// bubble scale all derive their domain (min/max or max) from the CURRENT frame's
// data. When the operator scrubs the TimeScrubber, each as-of frame has a
// different min/max, so the color/size MEANING rebases every frame — a value that
// was "dark blue" at t0 becomes "light blue" at t1 with no real change. That is
// meaningless flicker.
//
// The fix: lock the domain at the LIVE edge (asOf === null). While a scrub is
// active, every frame reuses the locked live-edge domain, so a given value maps
// to the SAME color/size across the whole scrub — the scale is comparable over
// time. When the scrub ends (back to live), the lock refreshes to the current
// frame. Extracted here so the lock is unit-testable in isolation (no maplibre).

/** value min/max domain for a sequential/choropleth scale. */
export type DomainBounds = { min: number; max: number };

/**
 * Resolve the domain a frame should render with, and the domain to carry forward.
 *
 *  - NOT scrubbing (live edge): use the current frame's domain AND refresh the
 *    lock, so the next scrub starts from the freshest live-edge domain.
 *  - scrubbing: reuse the locked live-edge domain so color/size meaning is stable
 *    across frames. If a scrub somehow began with no lock (e.g. the map mounted
 *    mid-scrub), adopt the current frame as the lock so every later frame matches.
 *
 * Generic over the domain shape (a `number` graduated-max, a `DomainBounds`, or a
 * nullable variant) — the caller decides what "domain" means; this only owns the
 * live-edge vs scrub selection. Referentially returns the SAME locked object when
 * reused, so a downstream memo can skip recompute.
 */
export function resolveScrubDomain<T>(opts: {
  live: T;
  scrubbing: boolean;
  locked: T | null;
}): { domain: T; locked: T | null } {
  if (!opts.scrubbing) {
    return { domain: opts.live, locked: opts.live };
  }
  const locked = opts.locked ?? opts.live;
  return { domain: locked, locked };
}
