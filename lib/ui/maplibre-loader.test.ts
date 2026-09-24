// @vitest-environment jsdom
//
// The loader's whole job is ORDERING and ONCE-NESS, and both fail silently.
//
// `setWorkerUrl` has to run before the first `new Map()`. If it does not, the
// worker is fetched from a path webpack never emitted, Next answers the app's
// own HTML with a 200, the worker executes HTML as JavaScript and dies without
// a word — and the map renders an empty canvas with every layer and source
// registered and zero features in all of them. No console output, no failed
// request. That is what shipped on `deps/maplibre-v6` and what this loader ends.
//
// The memoisation is the other half, and this repo has paid for it once
// already: a per-call `await import()` of a mocked module drops one of two
// concurrent callers. `LocationPicker` alone calls this twice — once for the
// map, once for the marker — so concurrent callers are the normal case here.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { setWorkerUrl } = vi.hoisted(() => ({ setWorkerUrl: vi.fn() }));

vi.mock("maplibre-gl", () => ({
  setWorkerUrl,
  Map: class {},
  Marker: class {},
}));

import { MAPLIBRE_WORKER_URL, loadMapLibre, resetMapLibreLoaderForTests } from "./maplibre-loader";

beforeEach(() => {
  setWorkerUrl.mockClear();
  resetMapLibreLoaderForTests();
});

describe("loadMapLibre — one door, opened once", () => {
  it("points the worker at the served copy before handing the module back", async () => {
    await loadMapLibre();
    expect(setWorkerUrl).toHaveBeenCalledWith(MAPLIBRE_WORKER_URL);
  });

  it("sets the worker URL exactly ONCE however many callers arrive together", async () => {
    // Three concurrent callers, which is the shape LocationPicker produces on
    // its own. A per-call `import()` would resolve three times.
    const [a, b, c] = await Promise.all([loadMapLibre(), loadMapLibre(), loadMapLibre()]);
    expect(setWorkerUrl).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("stays memoised across sequential calls too", async () => {
    await loadMapLibre();
    await loadMapLibre();
    expect(setWorkerUrl).toHaveBeenCalledTimes(1);
  });

  it("FORGETS a failure so the next map can try again", async () => {
    // Memoising the promise is what makes setWorkerUrl run once. Memoising a
    // REJECTED one turns a single failed chunk request — a deploy that rotated
    // hashes while a map page was open, one flaky connection — into a dead map
    // for the rest of the session, on every route, with no call site catching
    // it and nothing in the console. The code this loader replaced retried by
    // accident, because each mount issued its own import().
    setWorkerUrl.mockImplementationOnce(() => {
      throw new Error("chunk 404");
    });
    await expect(loadMapLibre()).rejects.toThrow("chunk 404");

    // The very next caller gets a real attempt, not the corpse of the last one.
    await expect(loadMapLibre()).resolves.toBeDefined();
    expect(setWorkerUrl).toHaveBeenCalledTimes(2);
  });

  it("serves the worker from THIS origin, not a CDN and not a blob", () => {
    // v6 dropped the CSP bundle because a same-origin worker needs no blob:
    // laundering — the app's `worker-src 'self'` covers this URL and nothing
    // wider had to be opened for it. A relative path would resolve against the
    // current route and 404 on any nested page.
    expect(MAPLIBRE_WORKER_URL.startsWith("/")).toBe(true);
    expect(MAPLIBRE_WORKER_URL).not.toMatch(/^https?:/);
    expect(MAPLIBRE_WORKER_URL).not.toMatch(/^blob:/);
  });
});
