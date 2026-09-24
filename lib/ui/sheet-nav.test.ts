// Tests for lib/ui/sheet-nav.ts — the open/close state machine backing the
// pet profile's client-driven sheets (router-hot-path fix). Node env (no
// jsdom needed): `window` is stubbed manually so this stays a fast, focused
// unit test of the pure decision logic (pushState vs. back() vs.
// replaceState), independent of the interaction-level RTL+jsdom coverage in
// SheetHost.interaction.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSheetNavStateForTests,
  closeSheetNav,
  closeSheetNavWithFullReload,
  isSameRouteUrl,
  pushSheetUrl,
  replaceTabUrl,
} from "./sheet-nav";

describe("pushSheetUrl / closeSheetNav — history-API state machine", () => {
  const pushState = vi.fn();
  const replaceState = vi.fn();
  const back = vi.fn();

  beforeEach(() => {
    __resetSheetNavStateForTests();
    pushState.mockClear();
    replaceState.mockClear();
    back.mockClear();
    vi.stubGlobal("window", {
      history: { pushState, replaceState, back },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pushSheetUrl calls history.pushState with the given URL", () => {
    pushSheetUrl("/mis-mascotas/abc?sheet=anotar");
    expect(pushState).toHaveBeenCalledWith(null, "", "/mis-mascotas/abc?sheet=anotar");
    expect(replaceState).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it("closeSheetNav calls history.back() when the sheet was opened via pushSheetUrl", () => {
    pushSheetUrl("/mis-mascotas/abc?sheet=anotar");
    closeSheetNav("/mis-mascotas/abc");
    expect(back).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("closeSheetNav calls history.replaceState (not back) when no pushSheetUrl happened first — direct URL load", () => {
    closeSheetNav("/mis-mascotas/abc");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/mis-mascotas/abc");
    expect(back).not.toHaveBeenCalled();
  });

  it("a second open() after a close() still uses back() (flag is set again by the new push)", () => {
    pushSheetUrl("/mis-mascotas/abc?sheet=anotar");
    closeSheetNav("/mis-mascotas/abc");
    back.mockClear();
    pushSheetUrl("/mis-mascotas/abc?sheet=compartir");
    closeSheetNav("/mis-mascotas/abc");
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("opening a second sheet while one is already open (pushed) keeps back()-based closing", () => {
    pushSheetUrl("/mis-mascotas/abc?sheet=mas");
    pushSheetUrl("/mis-mascotas/abc?sheet=editar-mascota"); // nested open, e.g. from inside MasSheet
    closeSheetNav("/mis-mascotas/abc?sheet=mas");
    expect(back).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("is a no-op when window is undefined (SSR safety)", () => {
    vi.stubGlobal("window", undefined);
    expect(() => pushSheetUrl("/x?sheet=y")).not.toThrow();
    expect(() => closeSheetNav("/x")).not.toThrow();
  });
});

describe("closeSheetNavWithFullReload — post-mutation stale-server-data close", () => {
  const assign = vi.fn();

  beforeEach(() => {
    assign.mockClear();
    vi.stubGlobal("window", { location: { assign } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("navigates via window.location.assign (never history-API shallow close)", () => {
    closeSheetNavWithFullReload("/mis-mascotas/abc");
    expect(assign).toHaveBeenCalledWith("/mis-mascotas/abc");
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when window is undefined (SSR safety)", () => {
    vi.stubGlobal("window", undefined);
    expect(() => closeSheetNavWithFullReload("/x")).not.toThrow();
  });
});

describe("replaceTabUrl — silent one-time tab/face URL normalization (no pushed history entry)", () => {
  const pushState = vi.fn();
  const replaceState = vi.fn();

  beforeEach(() => {
    pushState.mockClear();
    replaceState.mockClear();
    vi.stubGlobal("window", {
      history: { pushState, replaceState },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls history.replaceState with the given URL, never pushState", () => {
    replaceTabUrl("/mis-mascotas/abc?tab=libreta&lente=todo");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/mis-mascotas/abc?tab=libreta&lente=todo");
    expect(pushState).not.toHaveBeenCalled();
  });

  it("is a no-op when window is undefined (SSR safety)", () => {
    vi.stubGlobal("window", undefined);
    expect(() => replaceTabUrl("/x?tab=libreta")).not.toThrow();
  });
});

describe("isSameRouteUrl", () => {
  const pathname = "/mis-mascotas/DIM-ABCD";

  it("true for a bare ?sheet= shorthand on the same route", () => {
    expect(isSameRouteUrl(pathname, `${pathname}?sheet=peso&kg=12`)).toBe(true);
  });

  it("true when the target has no query string at all (exact pathname match)", () => {
    expect(isSameRouteUrl(pathname, pathname)).toBe(true);
  });

  it("false for a different route (full-page form, e.g. /eventos/nuevo/vacuna)", () => {
    expect(isSameRouteUrl(pathname, `${pathname}/eventos/nuevo/vacuna`)).toBe(false);
  });

  it("false for the dedicated /anotar fallback page (different route from ?sheet=anotar)", () => {
    expect(isSameRouteUrl(pathname, `${pathname}/anotar?text=hola`)).toBe(false);
  });

  it("ignores a hash fragment when comparing", () => {
    expect(isSameRouteUrl(pathname, `${pathname}?sheet=mas#top`)).toBe(true);
  });
});
