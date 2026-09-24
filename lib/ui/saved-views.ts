// Named saved views / bookmarks — shared primitive (Fase C, saved-views).
//
// Every OpFilterBar-driven dashboard (and Panorama, its own client-side
// console) already drives its ENTIRE view through the URL: period,
// jurisdiction, and every domain axis are searchParams. `CopyViewButton`
// already turns that into a one-click shareable link. This adds NAMED
// bookmarks of that URL — save the current view under a name, then list /
// apply / delete it later. localStorage only (a client/browser preference,
// scoped per SCREEN via a caller-supplied storage key) — no backend, no
// migration.
//
// Originally lived only in components/panorama/saved-views.ts (task #66b,
// Panorama's SavedViewsPopover). Extracted here so the operator dashboards
// (OpFilterBar consumers) can reuse the exact same round-trip logic instead
// of re-inventing it — Panorama's module now delegates to this one, keyed to
// its own fixed storage key, so its existing behavior/tests are unchanged.
//
// The pure array transforms (upsert / remove / parse) are separated from the
// localStorage IO so the round-trip is unit-testable without a DOM, and the
// IO functions take the storage key as a parameter so every screen gets its
// own isolated bucket (a saved view on /gob/perdidas never leaks into
// /admin/casos's list).

/** Cap the list so a runaway save loop can't blow the localStorage quota. The
 * newest views are kept (upsert prepends); older ones fall off the end. */
export const MAX_SAVED_VIEWS = 24;

/** One saved view: a user-given name, the full URL it reproduces, and when saved. */
export type SavedView = { name: string; url: string; savedAt: number };

function isSavedView(v: unknown): v is SavedView {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as SavedView).name === "string" &&
    typeof (v as SavedView).url === "string" &&
    typeof (v as SavedView).savedAt === "number"
  );
}

/** Parse the persisted JSON into a validated list. Tolerates absent/corrupt data
 * (returns []) and drops any malformed entry. */
export function parseSavedViews(raw: string | null): SavedView[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(isSavedView);
  } catch {
    return [];
  }
}

/**
 * Upsert a view by NAME: a save under an existing name REPLACES it (and moves it
 * to the front as the newest), keeping the list de-duplicated. An empty/whitespace
 * name is ignored (returns the list unchanged) — the UI also guards this. The list
 * is capped at {@link MAX_SAVED_VIEWS}, newest first.
 */
export function upsertView(
  views: readonly SavedView[],
  name: string,
  url: string,
  now: number,
): SavedView[] {
  const trimmed = name.trim();
  if (trimmed.length === 0) return [...views];
  const without = views.filter((v) => v.name !== trimmed);
  return [{ name: trimmed, url, savedAt: now }, ...without].slice(0, MAX_SAVED_VIEWS);
}

/** Remove the view with the given (exact) name. */
export function removeView(views: readonly SavedView[], name: string): SavedView[] {
  return views.filter((v) => v.name !== name);
}

// --- localStorage IO (thin, SSR- and quota-tolerant) ------------------------
//
// Keyed by a caller-supplied `storageKey` — each screen/console passes its own
// (e.g. "panorama:views:v1", "op-saved-views:perdidas:v1") so lists never mix.

/** Read + parse the saved views for `storageKey` ([] when unavailable/corrupt). */
export function loadSavedViews(storageKey: string): SavedView[] {
  if (typeof window === "undefined") return [];
  try {
    return parseSavedViews(window.localStorage.getItem(storageKey));
  } catch {
    return [];
  }
}

/** Persist the saved views for `storageKey` (no-op when unavailable/quota-full). */
export function persistSavedViews(storageKey: string, views: readonly SavedView[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(views));
  } catch {
    // Storage unavailable (private mode, quota) — the bookmark just isn't saved.
  }
}
