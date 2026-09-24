// @vitest-environment jsdom
//
// coalesced-get — in-flight GET coalescing (panorama Q10). Pins: identical
// concurrent URLs hit the network ONCE; distinct URLs do not coalesce; a
// per-caller abort rejects that caller without cancelling the shared request;
// and the entry clears on settle so a later same-URL request refetches.

import { afterEach, describe, expect, it, vi } from "vitest";

import { coalescedGet } from "./coalesced-get";

/** A deferred Response so the test controls when the shared fetch settles. */
function deferredResponse() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("coalescedGet", () => {
  it("coalesces identical concurrent GETs into ONE network request", async () => {
    const d = deferredResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(d.promise);

    const a = coalescedGet("/api/panorama/cobertura?level=province", new AbortController().signal);
    const b = coalescedGet("/api/panorama/cobertura?level=province", new AbortController().signal);

    d.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const [ra, rb] = await Promise.all([a, b]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Each caller gets an independently-readable clone.
    expect(await ra.json()).toEqual({ ok: 1 });
    expect(await rb.json()).toEqual({ ok: 1 });
  });

  it("does NOT coalesce distinct URLs (the legitimate refetch)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await Promise.all([
      coalescedGet("/api/panorama/cobertura?period=90", new AbortController().signal),
      coalescedGet("/api/panorama/cobertura?period=30", new AbortController().signal),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a caller whose signal aborts, WITHOUT cancelling the shared request", async () => {
    const d = deferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(d.promise);

    const ctrlA = new AbortController();
    const a = coalescedGet("/api/panorama/zoonosis", ctrlA.signal);
    const b = coalescedGet("/api/panorama/zoonosis", new AbortController().signal);

    ctrlA.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });

    // The shared request still resolves for the surviving caller.
    d.resolve(new Response(JSON.stringify({ ok: 2 }), { status: 200 }));
    expect(await (await b).json()).toEqual({ ok: 2 });
  });

  it("rejects immediately when the caller signal is already aborted", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(coalescedGet("/api/panorama/denuncias", ctrl.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the entry on settle so a later same-URL request refetches", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await coalescedGet("/api/panorama/decomisos", new AbortController().signal);
    await coalescedGet("/api/panorama/decomisos", new AbortController().signal);

    // Sequential (not concurrent) → two real fetches; coalescing is not caching.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
