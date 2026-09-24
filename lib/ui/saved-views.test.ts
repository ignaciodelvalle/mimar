// Tests for lib/ui/saved-views.ts — the shared saved-views storage primitive
// (Fase C, extracted from components/panorama/saved-views.ts so OpFilterBar
// dashboards can reuse the same round-trip logic under their own storage key).
// The pure-array-transform cases mirror components/panorama/__tests__/saved-views.test.ts
// (panorama's own suite still passes unchanged — it delegates here); this
// suite additionally covers the keyed localStorage IO and key isolation,
// which panorama's fixed-key module never needed to test.

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_SAVED_VIEWS,
  type SavedView,
  loadSavedViews,
  parseSavedViews,
  persistSavedViews,
  removeView,
  upsertView,
} from "@/lib/ui/saved-views";

const view = (name: string, url = `/gob/perdidas?name=${name}`, savedAt = 1): SavedView => ({
  name,
  url,
  savedAt,
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("upsertView", () => {
  it("prepends a new view (newest first)", () => {
    const a = upsertView([], "Salta urgentes", "/gob/maltrato?severity=critical", 100);
    expect(a).toEqual([
      { name: "Salta urgentes", url: "/gob/maltrato?severity=critical", savedAt: 100 },
    ]);
    const b = upsertView(a, "Cobertura BA", "/gob/perdidas?province=AR-B", 200);
    expect(b.map((v) => v.name)).toEqual(["Cobertura BA", "Salta urgentes"]);
  });

  it("replaces a view saved under the same name (dedupe + move to front)", () => {
    const start = [view("A", "/old", 1), view("B", "/b", 2)];
    const next = upsertView(start, "A", "/new", 3);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ name: "A", url: "/new", savedAt: 3 });
  });

  it("trims the name and ignores an empty one", () => {
    expect(upsertView([], "   ", "/x", 1)).toEqual([]);
    expect(upsertView([], "  Urgentes  ", "/x", 1)[0].name).toBe("Urgentes");
  });

  it("caps the list at MAX_SAVED_VIEWS, keeping the newest", () => {
    let views: SavedView[] = [];
    for (let i = 0; i < MAX_SAVED_VIEWS + 5; i++) {
      views = upsertView(views, `v${i}`, `/v${i}`, i);
    }
    expect(views).toHaveLength(MAX_SAVED_VIEWS);
    expect(views[0].name).toBe(`v${MAX_SAVED_VIEWS + 4}`); // newest
  });
});

describe("removeView", () => {
  it("removes by exact name and leaves the rest", () => {
    const start = [view("A"), view("B"), view("C")];
    expect(removeView(start, "B").map((v) => v.name)).toEqual(["A", "C"]);
    expect(removeView(start, "missing")).toHaveLength(3);
  });
});

describe("parseSavedViews", () => {
  it("round-trips a valid serialized list", () => {
    const views = [view("A", "/a", 1), view("B", "/b", 2)];
    expect(parseSavedViews(JSON.stringify(views))).toEqual(views);
  });

  it("tolerates absent / corrupt / malformed data", () => {
    expect(parseSavedViews(null)).toEqual([]);
    expect(parseSavedViews("not json")).toEqual([]);
    expect(parseSavedViews(JSON.stringify({ not: "an array" }))).toEqual([]);
    expect(parseSavedViews(JSON.stringify([{ name: "x" }, view("ok")]))).toEqual([view("ok")]);
  });
});

describe("loadSavedViews / persistSavedViews — keyed localStorage IO", () => {
  it("round-trips a filter-string view through localStorage under its key", () => {
    const key = "op-saved-views:perdidas:v1";
    expect(loadSavedViews(key)).toEqual([]);

    const saved = upsertView([], "Perros en Salta", "/gob/perdidas?province=AR-A&species=dog", 100);
    persistSavedViews(key, saved);

    expect(loadSavedViews(key)).toEqual(saved);
  });

  it("isolates lists between different storage keys (per-screen scoping)", () => {
    persistSavedViews("op-saved-views:perdidas:v1", upsertView([], "Vista A", "/a", 1));
    persistSavedViews("op-saved-views:maltrato:v1", upsertView([], "Vista B", "/b", 2));

    expect(loadSavedViews("op-saved-views:perdidas:v1").map((v) => v.name)).toEqual(["Vista A"]);
    expect(loadSavedViews("op-saved-views:maltrato:v1").map((v) => v.name)).toEqual(["Vista B"]);
  });

  it("tolerates corrupt data at a given key without throwing", () => {
    const key = "op-saved-views:casos:v1";
    window.localStorage.setItem(key, "not json");
    expect(loadSavedViews(key)).toEqual([]);
  });
});

describe("save → apply → delete round-trip", () => {
  it("saves, finds by name (apply target), then deletes", () => {
    let views = upsertView([], "Mi vista", "/gob/perdidas?province=AR-B&species=dog", 100);
    const applied = views.find((v) => v.name === "Mi vista");
    expect(applied?.url).toBe("/gob/perdidas?province=AR-B&species=dog");
    views = removeView(views, "Mi vista");
    expect(views).toEqual([]);
  });
});
