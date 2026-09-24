/**
 * The ONE place this app loads maplibre-gl, so the worker URL is set once.
 *
 * WHY A LOADER AND NOT FOUR IMPORTS. maplibre-gl 6 resolves its worker at
 * runtime through `import.meta.url`, a form no bundler detects statically, so
 * webpack emits no asset for it — verified on this tree with a clean build.
 * The fetch that follows does not 404: Next answers the app's own HTML with a
 * 200, the worker starts, tries to run HTML as JavaScript, and dies silently.
 * The map then draws nothing while reporting every layer and source registered
 * and zero features in all of them. `setWorkerUrl` has to run BEFORE the first
 * `new Map()`, and "before" is only enforceable from a single door.
 *
 * WHY MEMOISED, and this repo has paid for it once already: a per-call
 * `await import()` of a module under test drops one of two concurrent callers
 * (see the vitest dynamic-import race). `LocationPicker` alone calls this twice
 * — once for the map, once for the marker — so concurrent callers are the
 * normal case here, not the edge one. One promise, shared.
 *
 * WHY THE URL IS A CONSTANT rather than computed: it is served from `public/`
 * by `scripts/copy-maplibre-worker.ts`, which `prebuild`/`predev` regenerate.
 * `scripts/check-maplibre-worker.ts` guards the WIRING rather than the bytes -
 * it compares the served copies only when they happen to be on disk, and in
 * CI's build-less `check` job that is zero files, which its own success line
 * says out loud. Same origin, so the app's `worker-src 'self'` covers it
 * without the blob: laundering v5 needed.
 */
import type * as MapLibre from "maplibre-gl";

/**
 * Same-origin, and the path is shared with the copy script and its fence — if
 * these three ever disagree the map goes quiet again, so they are checked
 * against each other rather than kept in step by hand.
 */
export const MAPLIBRE_WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";

let loading: Promise<typeof MapLibre> | null = null;

/**
 * maplibre-gl, with its worker pointed somewhere that exists.
 *
 * v6 is ESM-only and has no default export: the module namespace itself carries
 * `Map`, `Marker` and the rest, which is why this returns the namespace.
 */
export function loadMapLibre(): Promise<typeof MapLibre> {
  loading ??= import("maplibre-gl")
    .then((maplibregl) => {
      maplibregl.setWorkerUrl(MAPLIBRE_WORKER_URL);
      return maplibregl;
    })
    // THE FAILURE IS FORGOTTEN, THE SUCCESS IS NOT, and the asymmetry is the
    // whole point. Memoising the promise is what makes `setWorkerUrl` run once;
    // memoising a REJECTED one turns a single failed chunk request into a dead
    // map for the rest of the session. A deploy that rotates chunk hashes while
    // somebody has a map page open, or one flaky request, and every later map —
    // including after a client-side navigation to another route — awaits the
    // same rejection. None of the call sites has a `.catch`, so what the person
    // sees is a blank map and an empty console: the exact failure this module
    // exists to end, on a narrower trigger.
    //
    // The code this replaced retried by accident, because each mount issued its
    // own `import()`. Losing that on the way to fixing the worker would have
    // been a regression bought with the fix.
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}

/** Test seam: forget the memoised module so a suite can re-exercise the load. */
export function resetMapLibreLoaderForTests(): void {
  loading = null;
}
