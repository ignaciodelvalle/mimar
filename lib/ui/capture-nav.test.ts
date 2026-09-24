// Tests for lib/ui/capture-nav.ts — the shared same-route/cross-route
// classification CaptureBox consumes. Node env (window stubbed manually),
// mirroring lib/ui/sheet-nav.test.ts's pattern.
//
// Regression coverage: CaptureBox used to call router.push/router.replace
// unconditionally, regardless of whether the resolved capture destination
// (a matchToCaptureUrl routeOverride, e.g. `?sheet=marcar-perdida`) was the
// SAME route as the page CaptureBox is mounted on (SheetMounter renders it
// at `/mis-mascotas/{token}?sheet=anotar`) — that's exactly the
// router-hot-path defect lib/ui/sheet-nav.ts exists to avoid.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { goToCaptureUrl } from "./capture-nav";
import { __resetSheetNavStateForTests } from "./sheet-nav";

describe("goToCaptureUrl — shared capture-flow navigation classification", () => {
  const pushState = vi.fn();
  const push = vi.fn();
  const replace = vi.fn();
  const pathname = "/mis-mascotas/DIM-ABCD";

  beforeEach(() => {
    __resetSheetNavStateForTests();
    pushState.mockClear();
    push.mockClear();
    replace.mockClear();
    vi.stubGlobal("window", { history: { pushState } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a same-route ?sheet= destination never triggers router.push (uses pushSheetUrl instead)", () => {
    goToCaptureUrl(pathname, `${pathname}?sheet=marcar-perdida`, { push, replace });
    expect(pushState).toHaveBeenCalledWith(null, "", `${pathname}?sheet=marcar-perdida`);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("a same-route destination never triggers router.replace either, when method='replace' is requested", () => {
    goToCaptureUrl(pathname, `${pathname}?sheet=marcar-perdida`, { push, replace }, "replace");
    expect(pushState).toHaveBeenCalledWith(null, "", `${pathname}?sheet=marcar-perdida`);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("a cross-route destination (a full form page) goes through router.push by default", () => {
    goToCaptureUrl(pathname, `${pathname}/eventos/nuevo/vacuna`, { push, replace });
    expect(push).toHaveBeenCalledWith(`${pathname}/eventos/nuevo/vacuna`);
    expect(pushState).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("a cross-route destination goes through router.replace when method='replace' is requested", () => {
    goToCaptureUrl(pathname, `${pathname}/eventos/nuevo/vacuna`, { push, replace }, "replace");
    expect(replace).toHaveBeenCalledWith(`${pathname}/eventos/nuevo/vacuna`);
    expect(pushState).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("the /anotar fallback page reaching a ?sheet= destination on the PROFILE route is cross-route (real navigation)", () => {
    const anotarPathname = `${pathname}/anotar`;
    goToCaptureUrl(anotarPathname, `${pathname}?sheet=marcar-perdida`, { push, replace });
    expect(push).toHaveBeenCalledWith(`${pathname}?sheet=marcar-perdida`);
    expect(pushState).not.toHaveBeenCalled();
  });
});
