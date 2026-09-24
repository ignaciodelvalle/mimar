// @vitest-environment jsdom
//
// Tests for lib/hooks/useOnline.ts — touches window/navigator directly, so it
// cannot be smoke-tested via the renderToStaticMarkup SSR convention used for
// components/ui/EmptyState.test.tsx / components/ErrorBoundary.test.tsx.
// @testing-library/react's renderHook/act (an existing devDependency, see
// lib/ui/use-step-focus.test.ts for the same pattern) drives it instead.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useOnline } from "./useOnline";

describe("useOnline", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true on initial render (SSR-safe default, no hydration mismatch)", () => {
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
  });

  it("flips to false when the browser dispatches 'offline'", () => {
    const { result } = renderHook(() => useOnline());

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });

    expect(result.current).toBe(false);
  });

  it("flips back to true when the browser dispatches 'online'", () => {
    const { result } = renderHook(() => useOnline());

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current).toBe(true);
  });

  it("removes its online/offline listeners on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => useOnline());
    unmount();

    expect(removeSpy).toHaveBeenCalledWith("online", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("offline", expect.any(Function));
  });

  it("stops reacting to connectivity events after unmount", () => {
    const { result, unmount } = renderHook(() => useOnline());
    unmount();

    // The cleanup already removed the listeners, so this must be a no-op —
    // no error, and (since there is nothing left mounted to observe) the last
    // captured value stays exactly what it was at unmount time.
    expect(() => {
      act(() => {
        window.dispatchEvent(new Event("offline"));
      });
    }).not.toThrow();
    expect(result.current).toBe(true);
  });
});
