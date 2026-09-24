// @vitest-environment jsdom
//
// Tests for lib/ui/use-saved-views.ts — the React state wrapper around the
// saved-views storage primitive. Covers the save/apply(find)/delete cycle a
// SavedViewsControl consumer drives, plus per-key isolation.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useSavedViews } from "./use-saved-views";

beforeEach(() => {
  window.localStorage.clear();
});

describe("useSavedViews", () => {
  it("starts empty for a fresh storage key", () => {
    const { result } = renderHook(() => useSavedViews("op-saved-views:perdidas:v1"));
    expect(result.current.views).toEqual([]);
  });

  it("save() adds a newest-first entry and updates state synchronously", () => {
    const { result } = renderHook(() => useSavedViews("op-saved-views:perdidas:v1"));

    act(() => {
      result.current.save("Perros en Salta", "/gob/perdidas?province=AR-A&species=dog");
    });

    expect(result.current.views).toHaveLength(1);
    expect(result.current.views[0]).toMatchObject({
      name: "Perros en Salta",
      url: "/gob/perdidas?province=AR-A&species=dog",
    });
  });

  it("remove() deletes the named view", () => {
    const { result } = renderHook(() => useSavedViews("op-saved-views:perdidas:v1"));

    act(() => {
      result.current.save("A", "/gob/perdidas?species=dog");
      result.current.save("B", "/gob/perdidas?species=cat");
    });
    expect(result.current.views.map((v) => v.name)).toEqual(["B", "A"]);

    act(() => {
      result.current.remove("A");
    });
    expect(result.current.views.map((v) => v.name)).toEqual(["B"]);
  });

  it("persists across remounts under the same storage key", () => {
    const first = renderHook(() => useSavedViews("op-saved-views:maltrato:v1"));
    act(() => {
      first.result.current.save("Urgentes", "/gob/maltrato?severity=critical");
    });

    // A fresh mount (e.g. navigating back to the screen) re-reads localStorage
    // via the hook's own mount effect — no manual refresh() needed.
    const second = renderHook(() => useSavedViews("op-saved-views:maltrato:v1"));
    expect(second.result.current.views.map((v) => v.name)).toEqual(["Urgentes"]);
  });

  it("isolates state between different storage keys", () => {
    const perdidas = renderHook(() => useSavedViews("op-saved-views:perdidas:v1"));
    const casos = renderHook(() => useSavedViews("op-saved-views:casos:v1"));

    act(() => {
      perdidas.result.current.save("Vista perdidas", "/gob/perdidas?species=dog");
      casos.result.current.save("Vista casos", "/admin/casos?status=all");
    });

    expect(perdidas.result.current.views.map((v) => v.name)).toEqual(["Vista perdidas"]);
    expect(casos.result.current.views.map((v) => v.name)).toEqual(["Vista casos"]);
  });
});
