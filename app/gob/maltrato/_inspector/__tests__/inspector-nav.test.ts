// @vitest-environment jsdom

// Unit tests for inspector-nav — the shallow-history URL state machine of the
// master-detail inspector (task #12). Locks the push-vs-replace semantics the
// spec requires (§Interaction & state preservation): first selection pushes one
// entry (Back restores the exact list state), browsing replaces in place, the
// pet drill pushes its own entry, and a full close pops every pushed entry.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetInspectorNavForTests,
  closeInspector,
  openMascota,
  popMascota,
  selectCaso,
  syncDepthAfterPop,
} from "../inspector-nav";

let pushSpy: ReturnType<typeof vi.spyOn>;
let replaceSpy: ReturnType<typeof vi.spyOn>;
let backSpy: ReturnType<typeof vi.spyOn>;
let goSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetInspectorNavForTests();
  pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
  replaceSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
  backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
  goSpy = vi.spyOn(window.history, "go").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("selectCaso — first vs subsequent selection", () => {
  it("FIRST selection (no ?caso yet) pushes one history entry", () => {
    selectCaso("/gob/maltrato?queue=all&caso=abc", false);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(null, "", "/gob/maltrato?queue=all&caso=abc");
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("SUBSEQUENT selection (browsing) replaces in place — no history growth", () => {
    selectCaso("/gob/maltrato?queue=all&caso=abc", false); // open
    selectCaso("/gob/maltrato?queue=all&caso=def", true); // browse
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledWith(null, "", "/gob/maltrato?queue=all&caso=def");
  });
});

describe("closeInspector — pops exactly the pushed entries", () => {
  it("after a single case open, Back-closes with go(-1)", () => {
    selectCaso("/gob/maltrato?caso=abc", false); // depth 1
    closeInspector("/gob/maltrato");
    expect(goSpy).toHaveBeenCalledWith(-1);
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("after case open + pet drill, closes the WHOLE inspector with go(-2)", () => {
    selectCaso("/gob/maltrato?caso=abc", false); // depth 1
    openMascota("/gob/maltrato?caso=abc&mascota=DIM-1"); // depth 2
    closeInspector("/gob/maltrato");
    expect(goSpy).toHaveBeenCalledWith(-2);
  });

  it("deep-loaded ?caso (nothing pushed) strips params in place instead of traversing", () => {
    // No selectCaso() this session → nothing was pushed.
    closeInspector("/gob/maltrato?queue=all");
    expect(goSpy).not.toHaveBeenCalled();
    expect(replaceSpy).toHaveBeenCalledWith(null, "", "/gob/maltrato?queue=all");
  });
});

describe("pet drill", () => {
  it("openMascota pushes its own entry; popMascota pops exactly one", () => {
    selectCaso("/gob/maltrato?caso=abc", false); // depth 1
    openMascota("/gob/maltrato?caso=abc&mascota=DIM-1"); // depth 2
    expect(pushSpy).toHaveBeenCalledTimes(2);

    popMascota();
    expect(backSpy).toHaveBeenCalledTimes(1);

    // Closing now only pops the remaining case entry.
    closeInspector("/gob/maltrato");
    expect(goSpy).toHaveBeenCalledWith(-1);
  });
});

describe("syncDepthAfterPop — browser Back reconciliation", () => {
  it("resets pushed depth when the URL no longer carries ?caso", () => {
    selectCaso("/gob/maltrato?caso=abc", false); // depth 1
    syncDepthAfterPop(false); // browser Back stripped ?caso
    // A later close with depth reset falls back to replaceState (nothing to pop).
    closeInspector("/gob/maltrato");
    expect(goSpy).not.toHaveBeenCalled();
    expect(replaceSpy).toHaveBeenCalledWith(null, "", "/gob/maltrato");
  });
});
