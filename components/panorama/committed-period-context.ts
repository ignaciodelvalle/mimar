"use client";

import { createContext, useContext } from "react";

/**
 * Committed-period bridge — the Panorama period chrome (PeriodPicker highlight +
 * TimeScrubber axis) must agree with the data the console actually loaded.
 *
 * WHY (W2 seeded first-visit desync): the console commits a preset's period
 * (`period=30d/90d`) via a SHALLOW History `replaceState`/`pushState` (no router
 * navigation, so the map never remounts). But Next's `useSearchParams()` returns a
 * BARE-URL snapshot that a shallow History change can't update, so `PeriodPicker`
 * (which keys its active chip off `useSearchParams`) keeps highlighting the "3 años"
 * default while layers/KPIs already show the committed 30d/90d window — the temporal
 * chrome lies.
 *
 * The console provides the COMMITTED period preset string through this context;
 * consumers prefer it over their `useSearchParams`-derived value. `null` means
 * "nothing committed client-side — fall back to searchParams" (the normal path and
 * every non-Panorama dashboard, which never wrap a provider, so they are unaffected).
 */
export const CommittedPeriodContext = createContext<string | null>(null);

/** Read the console's committed period preset, or `null` to fall back to searchParams. */
export function useCommittedPeriod(): string | null {
  return useContext(CommittedPeriodContext);
}
