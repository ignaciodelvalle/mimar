// @vitest-environment jsdom
// X1-F1: the pending state must outlive the action, not the click.
//
// `window.location.assign()` returns immediately — the browser starts fetching
// and the JS thread carries on. So a control gated only on the action's own
// pending flag re-enables, with its idle label, while the OLD page is still on
// screen and the new document is in flight. On a real connection the sequence
// reads: "Guardando…" → "Crear mascota" enabled again, nothing changed →
// (seconds) → the new page. The impatient user taps again, and most of the 89
// call sites have no UI idempotency guard.
//
// useActionRedirect therefore reports a `navigating` flag that goes true when it
// fires and never goes back down — the document is leaving; there is nothing to
// come back to.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigateSpy = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (url: string) => navigateSpy(url),
}));

import { useActionRedirect } from "@/lib/ui/use-action-redirect";

describe("useActionRedirect — navigating outlives the action", () => {
  beforeEach(() => navigateSpy.mockClear());

  it("reports false while there is nothing to navigate to", () => {
    const { result } = renderHook(() => useActionRedirect(null, { error: null }));
    expect(result.current).toBe(false);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("reports true from the moment it navigates", () => {
    const state = { error: null, redirectTo: "/inicio" };
    const { result } = renderHook(() => useActionRedirect(state.redirectTo, state));
    expect(navigateSpy).toHaveBeenCalledWith("/inicio");
    expect(result.current).toBe(true);
  });

  it("STAYS true after the action state settles — the document is still coming", () => {
    const settled = { error: null, redirectTo: "/inicio" };
    const { result, rerender } = renderHook(
      ({ to, key }: { to: string | null; key: unknown }) => useActionRedirect(to, key),
      { initialProps: { to: settled.redirectTo as string | null, key: settled as unknown } },
    );
    expect(result.current).toBe(true);

    // A re-render with no redirect (the shape a settled/reset form takes) must
    // NOT re-enable the control: window.location.assign has already been called
    // and the page is on its way out.
    act(() => rerender({ to: null, key: { error: null } }));
    expect(result.current).toBe(true);
  });

  it("re-fires for a second submission that resolves to the same destination", () => {
    const first = { error: null, redirectTo: "/inicio" };
    const { rerender } = renderHook(
      ({ to, key }: { to: string | null; key: unknown }) => useActionRedirect(to, key),
      { initialProps: { to: first.redirectTo as string | null, key: first as unknown } },
    );
    expect(navigateSpy).toHaveBeenCalledTimes(1);

    // New state object, identical destination — the bfcache-restore case the
    // hook's fireKey exists for.
    act(() => rerender({ to: "/inicio", key: { error: null, redirectTo: "/inicio" } }));
    expect(navigateSpy).toHaveBeenCalledTimes(2);
  });
});
