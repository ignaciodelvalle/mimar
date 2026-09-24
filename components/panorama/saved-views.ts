// Named saved views / bookmarks for the panorama console (task #66b).
//
// "Copiar vista" already copies the full URL (which now encodes the COMPLETE view:
// layers / preset / period / level / province / camera / asOf). This adds NAMED
// bookmarks of that URL — save the current view under a name, then list / apply /
// delete it later. localStorage only (a client preference, exactly like the
// `panorama:board:v1` last-board memory) — no backend.
//
// Thin wrapper over the shared primitive (lib/ui/saved-views, extracted Fase C
// 2026-07-21 so the OpFilterBar dashboards can reuse the same round-trip logic)
// pinned to Panorama's own storage key — every export below keeps its original
// (pre-extraction) signature so nothing else in this module needs to change.

import {
  MAX_SAVED_VIEWS,
  type SavedView,
  loadSavedViews as loadFromKey,
  parseSavedViews,
  persistSavedViews as persistToKey,
  removeView,
  upsertView,
} from "@/lib/ui/saved-views";

/** localStorage key for the saved-views list. Distinct from `panorama:board:v1`
 * (the single last-board memory) — this is a user-managed named collection. */
export const SAVED_VIEWS_KEY = "panorama:views:v1";

export type { SavedView };
export { MAX_SAVED_VIEWS, parseSavedViews, upsertView, removeView };

/** Read + parse the saved views from localStorage ([] when unavailable/corrupt). */
export function loadSavedViews(): SavedView[] {
  return loadFromKey(SAVED_VIEWS_KEY);
}

/** Persist the saved views to localStorage (no-op when unavailable/quota-full). */
export function persistSavedViews(views: readonly SavedView[]): void {
  persistToKey(SAVED_VIEWS_KEY, views);
}
