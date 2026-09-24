// @vitest-environment jsdom
//
// Tests for components/panorama/use-asof-frame.ts — the temporal FRAME pipeline.
//
// The failure path is what matters here and is the reason this file exists: the
// stale-frame notice is error UI that a healthy local environment never shows,
// so without a forced 429 it would ship unexercised. (The traffic fix in the
// same change dropped playback from ~274 to ~58 req/min, which removed the very
// condition that used to trigger it by accident.)
//
// Same idiom as lib/ui/use-layer-features.test.ts: renderHook against a stubbed
// global fetch.

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAsOfFrame } from "@/components/panorama/use-asof-frame";
import type { FeatureCollection, LayerId } from "@/src/modules/panorama/domain/types";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const ISO = "2026-07-01T00:00:00.000Z";

function setup(fetchImpl: typeof fetch, onFrameSettled = () => {}) {
  vi.stubGlobal("fetch", fetchImpl);
  const asOfData = new Map<LayerId, FeatureCollection>();
  // The hook's own completion signal, always observable. Every test awaits it
  // before finishing — see the drain rationale on afterEach below.
  const settled = vi.fn(onFrameSettled);
  const result = renderHook(() =>
    useAsOfFrame({
      asOfIso: ISO,
      baseQs: "period=90d",
      timeBasis: "valid",
      level: "province",
      // zoonosis is a temporal layer; cobertura is a current-state rollup and
      // must be filtered out by the hook, not requested.
      activeLayerIds: () => ["zoonosis", "cobertura"] as LayerId[],
      asOfData,
      signalFor: () => new AbortController().signal,
      dropCubeStamp: () => {},
      onFrameSettled: settled,
    }),
  );
  return { result, asOfData, settled };
}

// Wait for the hook's fan-out to finish. Without this, a test can assert on an
// intermediate observable (a fetch call recorded, or `current` still null) and
// return while `Promise.all(...).then(setStaleFrame)` is still in flight.
const drain = (settled: ReturnType<typeof vi.fn>) =>
  waitFor(() => expect(settled).toHaveBeenCalled());

// UNMOUNT, don't just unstub.
//
// This project runs Vitest with `globals: false`, so @testing-library/react's
// auto-cleanup (which it installs only when a global `afterEach` exists) never
// registers. A hook left mounted keeps its React root alive; a state update
// landing after the test commits, and React schedules the PASSIVE-EFFECT flush
// through the scheduler's `setImmediate`. In the "db" project (fileParallelism
// false, one worker for every file) that Immediate can fire after this file's
// jsdom environment was torn down, and the flush callback's first statement is
// `schedulerEvent = window.event` — so it throws
// `ReferenceError: window is not defined` from react-dom-client, attributed to
// this file, with zero failing tests. That is the CI "1 error / exit 1".
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useAsOfFrame", () => {
  it("requests only the TEMPORAL layers, once each, at the given instant", async () => {
    const calls: string[] = [];
    const { asOfData, settled } = setup(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ features: EMPTY }), { status: 200 });
    });

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/panorama/zoonosis");
    expect(calls[0]).toContain(`asOf=${encodeURIComponent(ISO)}`);
    // cobertura is a current-state rollup — asking for it as-of would be a lie.
    expect(calls.join(" ")).not.toContain("/api/panorama/cobertura");
    await waitFor(() => expect(asOfData.has("zoonosis" as LayerId)).toBe(true));
    await drain(settled);
  });

  it("reports a rate-limited frame instead of silently keeping stale features", async () => {
    const { result, asOfData, settled } = setup(async () => new Response("", { status: 429 }));

    await waitFor(() => expect(result.result.current).not.toBeNull());
    expect(result.result.current?.rateLimited).toBe(true);
    expect(result.result.current?.layers.length).toBe(1);
    // The cache is deliberately NOT cleared — a blank map is worse than a stale
    // one. The honesty comes from the report, not from wiping the frame.
    expect(asOfData.has("zoonosis" as LayerId)).toBe(false);
    await drain(settled);
  });

  it("reports a failed frame that is not a rate limit", async () => {
    const { result, settled } = setup(async () => new Response("", { status: 500 }));

    await waitFor(() => expect(result.result.current).not.toBeNull());
    expect(result.result.current?.rateLimited).toBe(false);
    await drain(settled);
  });

  it("settles the frame even when every layer fails, so the map still repaints", async () => {
    const onSettled = vi.fn();
    const { settled } = setup(async () => new Response("", { status: 500 }), onSettled);
    await drain(settled);
    expect(onSettled).toHaveBeenCalled();
  });

  it("reports nothing when the frame lands cleanly", async () => {
    const { result, settled } = setup(
      async () => new Response(JSON.stringify({ features: EMPTY }), { status: 200 }),
    );
    await drain(settled);
    expect(result.result.current).toBeNull();
  });

  // WP4 — drag debounce. Without `dragging` the tests above prove the fan-out
  // fires immediately (default false); these two prove the drag path waits out
  // the window and coalesces rapid instants into one request for the LAST one.
  it("while dragging, the fan-out waits out the debounce window", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ features: EMPTY }), { status: 200 });
    }) as typeof fetch);
    renderHook(() =>
      useAsOfFrame({
        asOfIso: ISO,
        baseQs: "period=90d",
        timeBasis: "valid",
        level: "province",
        activeLayerIds: () => ["zoonosis"] as LayerId[],
        asOfData: new Map<LayerId, FeatureCollection>(),
        signalFor: () => new AbortController().signal,
        dropCubeStamp: () => {},
        onFrameSettled: () => {},
        dragging: true,
      }),
    );

    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    vi.useRealTimers();
  });

  it("release after a settled debounced frame does not refetch it (review F1)", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ features: EMPTY }), { status: 200 });
    }) as typeof fetch);
    const settled = vi.fn();
    const { rerender } = renderHook(
      ({ dragging }: { dragging: boolean }) =>
        useAsOfFrame({
          asOfIso: ISO,
          baseQs: "period=90d",
          timeBasis: "valid",
          level: "province",
          activeLayerIds: () => ["zoonosis"] as LayerId[],
          asOfData: new Map<LayerId, FeatureCollection>(),
          signalFor: () => new AbortController().signal,
          dropCubeStamp: () => {},
          onFrameSettled: settled,
          dragging,
        }),
      { initialProps: { dragging: true } },
    );

    // The debounced fetch fires and settles cleanly while still dragging.
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalled();

    // Release (dragging → false, SAME instant): the most common gesture must
    // not pay the whole fan-out a second time for an already-painted frame.
    rerender({ dragging: false });
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(1);
    vi.useRealTimers();
  });

  it("rapid drag instants coalesce into one fan-out for the LAST instant", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ features: EMPTY }), { status: 200 });
    }) as typeof fetch);
    const LAST = "2026-07-03T00:00:00.000Z";
    const { rerender } = renderHook(
      ({ iso }: { iso: string }) =>
        useAsOfFrame({
          asOfIso: iso,
          baseQs: "period=90d",
          timeBasis: "valid",
          level: "province",
          activeLayerIds: () => ["zoonosis"] as LayerId[],
          asOfData: new Map<LayerId, FeatureCollection>(),
          signalFor: () => new AbortController().signal,
          dropCubeStamp: () => {},
          onFrameSettled: () => {},
          dragging: true,
        }),
      { initialProps: { iso: ISO } },
    );

    await vi.advanceTimersByTimeAsync(50);
    rerender({ iso: "2026-07-02T00:00:00.000Z" });
    await vi.advanceTimersByTimeAsync(50);
    rerender({ iso: LAST });
    await vi.advanceTimersByTimeAsync(100);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`asOf=${encodeURIComponent(LAST)}`);
    vi.useRealTimers();
  });
});
