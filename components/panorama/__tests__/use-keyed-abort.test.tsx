// @vitest-environment jsdom
//
// Unit tests for useKeyedAbort (panorama-redesign Fase 1).
//
// The hook backs the Panorama fetch cancellation: one AbortController per
// logical key (layer id, or "kpis"). Requesting a signal for a key ABORTS and
// replaces the prior in-flight controller for that key — last click wins per
// key. Distinct keys never interfere. Unmount aborts everything.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useKeyedAbort } from "@/components/panorama/use-keyed-abort";

describe("useKeyedAbort", () => {
  it("aborts the prior signal when the same key is requested again (last wins)", () => {
    const { result } = renderHook(() => useKeyedAbort());

    const first = result.current.signalFor("cobertura");
    expect(first.aborted).toBe(false);

    const second = result.current.signalFor("cobertura");
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
  });

  it("keeps distinct keys independent — aborting one never touches another", () => {
    const { result } = renderHook(() => useKeyedAbort());

    const cobertura = result.current.signalFor("cobertura");
    const zoonosis = result.current.signalFor("zoonosis");
    const kpis = result.current.signalFor("kpis");

    // Supersede only cobertura.
    result.current.signalFor("cobertura");

    expect(cobertura.aborted).toBe(true);
    expect(zoonosis.aborted).toBe(false);
    expect(kpis.aborted).toBe(false);
  });

  it("abortAll() aborts every outstanding signal", () => {
    const { result } = renderHook(() => useKeyedAbort());

    const a = result.current.signalFor("a");
    const b = result.current.signalFor("b");

    result.current.abortAll();

    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(true);
  });

  it("aborts all outstanding signals on unmount", () => {
    const { result, unmount } = renderHook(() => useKeyedAbort());

    const a = result.current.signalFor("a");
    const b = result.current.signalFor("b");

    unmount();

    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(true);
  });

  it("a signal requested after abortAll() starts fresh (not pre-aborted)", () => {
    const { result } = renderHook(() => useKeyedAbort());

    result.current.signalFor("a");
    result.current.abortAll();

    const next = result.current.signalFor("a");
    expect(next.aborted).toBe(false);
  });
});
