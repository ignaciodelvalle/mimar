"use client";

// coalesced-get — in-flight GET request coalescing (panorama Q10).
//
// The panorama's per-key AbortController guard (useKeyedAbort) dedupes races
// WITHIN one console instance, but React StrictMode dev-remounts the whole tree:
// the second instance owns a FRESH abort registry and cannot supersede the first
// instance's in-flight layer fetches — so cobertura/zoonosis fired TWICE on the
// first load. This module-level map is keyed by the full request URL and SURVIVES
// the remount: an identical in-flight GET is shared instead of re-issued.
//
// A DIFFERENT URL (a scope/period/basis change writes new params, or a
// `level`/`asOf`/`mode` difference) never matches, so every legitimate refetch is
// untouched. This is COALESCING, not caching: the entry is cleared on settle, so
// a later request for the same URL fetches for real.

const inFlightGets = new Map<string, Promise<Response>>();

/**
 * Fetch `url` (GET), coalescing onto any identical in-flight request. Each caller
 * races its OWN `signal`, so a superseded caller still rejects with AbortError
 * (preserving the last-wins guard), while the shared network request keeps
 * running for the other coalesced callers.
 */
export function coalescedGet(url: string, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  let shared = inFlightGets.get(url);
  if (shared === undefined) {
    // The shared network request carries NO caller signal: one caller aborting
    // (or its instance unmounting) must not cancel the request the OTHER
    // coalesced callers are awaiting.
    shared = fetch(url, { headers: { accept: "application/json" } });
    const created = shared;
    // Clean the map entry when the shared fetch settles. The trailing .catch
    // swallows the finally-chain's re-raise (the shared fetch has no signal, but
    // a network error still rejects) so this cleanup branch never surfaces an
    // unhandledrejection — each CALLER handles the rejection on its own `base`.
    void created
      .finally(() => {
        if (inFlightGets.get(url) === created) inFlightGets.delete(url);
      })
      .catch(() => {});
    inFlightGets.set(url, created);
  }
  const base = shared;
  // Each caller receives a fresh Response clone (a body may be consumed only
  // once, but N coalesced callers each parse it independently). `clone` is guarded
  // for non-standard Response stubs (test doubles whose json() is re-readable): a
  // real fetch Response always clones; a stub without clone is shared as-is.
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    base.then(
      (res) => {
        signal.removeEventListener("abort", onAbort);
        resolve(typeof res.clone === "function" ? res.clone() : res);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
