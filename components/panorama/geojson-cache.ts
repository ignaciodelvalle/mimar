// In-memory, session-lived dedupe cache for the static /geo/*.geojson assets.
//
// The Panorama basemap layers (ar-provinces, ar-departments, caba-barrios,
// sudamerica-context) are immutable per deploy and served same-origin from
// public/geo. Without a cache each map instance refetches them independently:
// the main SituationalMap AND the CABA inset both pull caba-barrios, a province
// drill re-pulls ar-departments, and a re-mount repeats every request — the
// instrumented review counted caba-barrios fetched 3× and ar-provinces 2× in a
// single session.
//
// A single shared Promise PER URL collapses concurrent AND repeat fetches to one
// network round-trip for the session. The Promise (not the resolved value) is
// cached so overlapping callers dedupe on the in-flight request too. A rejected
// fetch is evicted so a later attempt can retry (a transient failure must not
// poison the asset for the rest of the session).

const cache = new Map<string, Promise<unknown>>();

/**
 * Fetch a same-origin GeoJSON asset once per session, returning the parsed JSON.
 * Repeat and concurrent calls for the same URL share a single fetch. Callers keep
 * their own try/catch for the "asset unavailable → degrade" branch.
 */
export function fetchGeojsonCached<T = unknown>(url: string): Promise<T> {
  const hit = cache.get(url);
  if (hit) return hit as Promise<T>;
  const p = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`geojson ${url} HTTP ${r.status}`);
      return r.json() as Promise<T>;
    })
    .catch((err) => {
      // Do NOT cache a rejection — evict so a later mount can retry.
      cache.delete(url);
      throw err;
    });
  cache.set(url, p);
  return p as Promise<T>;
}

/** Test-only: clear the cache so dedupe cases start from a clean slate. */
export function __resetGeojsonCache(): void {
  cache.clear();
}
