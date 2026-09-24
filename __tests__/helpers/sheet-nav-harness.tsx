// Shared harness for the sheet "close via clean nav" test cluster.
//
// Nine sheet/mounter suites (app/(public)/refugios/[orgToken]/sheets/*,
// CuentaSheetMounter, OrgPetSheetMounter) assert the same router-drop cure:
// clicking "Cerrar" must call closeSheetNav with a URL that strips ONLY the
// `sheet` param (preserving unrelated params) and must never touch
// router.push/replace/refresh. Each file used to duplicate ~35 lines of
// mock/jsdom/teardown boilerplate; it now imports this harness.
//
// USAGE (per test file — vi.mock factories are hoisted, so they pull the
// harness via dynamic import to share the SAME spy instances):
//
//   vi.mock("next/navigation", async () => {
//     const h = await import("@/__tests__/helpers/sheet-nav-harness");
//     return h.sheetNavigationMock("/refugios/refugio-abc", "sheet=donar&foo=bar");
//   });
//   vi.mock("@/lib/ui/sheet-nav", async () => {
//     const h = await import("@/__tests__/helpers/sheet-nav-harness");
//     return h.sheetNavModuleMock();
//   });
//
//   describe("<DonarSheet> — close", () => {
//     testSheetClosesViaCleanNav({
//       render: () => <DonarSheet ... />,
//       expectedCloseUrl: "/refugios/refugio-abc?foo=bar",
//     });
//   });
//
// Files with a second (submit/auto-close) test add their own `it` in the same
// describe — the hooks registered by testSheetClosesViaCleanNav cover it; pass
// `extraAfterEach` for per-file teardown (fake timers, submit-mock clears).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared spies — one instance per test-file module registry, shared between
// the vi.mock factories (dynamic import) and the test body (static import).
// ---------------------------------------------------------------------------

export const routerPush = vi.fn();
export const routerReplace = vi.fn();
export const routerRefresh = vi.fn();
export const closeSheetNav = vi.fn();

/** Module shape for `vi.mock("next/navigation", …)` in a sheet test. */
export function sheetNavigationMock(pathname: string, search: string) {
  return {
    usePathname: () => pathname,
    useSearchParams: () => new URLSearchParams(search),
    useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: routerRefresh }),
  };
}

/** Module shape for `vi.mock("@/lib/ui/sheet-nav", …)`. */
export function sheetNavModuleMock() {
  return { closeSheetNav };
}

/** jsdom lacks matchMedia and ResizeObserver; Vaul needs both to open. */
export function installSheetJsdomPolyfills(): void {
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ??
    (class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver);
}

/** Registers the cluster's standard beforeEach/afterEach inside the caller's describe. */
export function registerSheetHooks(extraAfterEach?: () => void): void {
  beforeEach(() => {
    installSheetJsdomPolyfills();
  });
  afterEach(() => {
    cleanup();
    closeSheetNav.mockClear();
    routerPush.mockClear();
    routerReplace.mockClear();
    routerRefresh.mockClear();
    extraAfterEach?.();
  });
}

export type SheetCloseTestOptions = {
  /** Renders the sheet under test (already-open state). */
  render: () => React.ReactElement;
  /** The URL closeSheetNav must receive: `sheet` stripped, other params kept. */
  expectedCloseUrl: string;
  /** Per-file teardown appended to the standard afterEach (timers, submit mocks). */
  extraAfterEach?: () => void;
};

/**
 * Registers the cluster hooks + the standard "Cerrar" test. Call INSIDE a
 * describe. Every assertion of the pre-harness copies is preserved verbatim:
 * closeSheetNav called with the clean URL; push/replace/refresh never called.
 */
export function testSheetClosesViaCleanNav(opts: SheetCloseTestOptions): void {
  registerSheetHooks(opts.extraAfterEach);

  it("clicking Cerrar calls closeSheetNav with `sheet` stripped, preserving other params, and never touches the router", () => {
    render(opts.render());

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));

    expect(closeSheetNav).toHaveBeenCalledWith(opts.expectedCloseUrl);
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });
}
