// Tests for the saved-views storage transforms (task #66b).

import { describe, expect, it } from "vitest";

import {
  MAX_SAVED_VIEWS,
  type SavedView,
  parseSavedViews,
  removeView,
  upsertView,
} from "@/components/panorama/saved-views";

const view = (name: string, url = `/gob/panorama?name=${name}`, savedAt = 1): SavedView => ({
  name,
  url,
  savedAt,
});

describe("upsertView", () => {
  it("prepends a new view (newest first)", () => {
    const a = upsertView([], "Salta brotes", "/gob/panorama?preset=brotes-activos", 100);
    expect(a).toEqual([
      { name: "Salta brotes", url: "/gob/panorama?preset=brotes-activos", savedAt: 100 },
    ]);
    const b = upsertView(a, "Cobertura BA", "/gob/panorama?province=AR-B", 200);
    expect(b.map((v) => v.name)).toEqual(["Cobertura BA", "Salta brotes"]);
  });

  it("replaces a view saved under the same name (dedupe + move to front)", () => {
    const start = [view("A", "/old", 1), view("B", "/b", 2)];
    const next = upsertView(start, "A", "/new", 3);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ name: "A", url: "/new", savedAt: 3 });
  });

  it("trims the name and ignores an empty one", () => {
    expect(upsertView([], "   ", "/x", 1)).toEqual([]);
    expect(upsertView([], "  Padrón  ", "/x", 1)[0].name).toBe("Padrón");
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

describe("save → apply → delete round-trip", () => {
  it("saves, finds by name (apply target), then deletes", () => {
    let views = upsertView([], "Mi vista", "/gob/panorama?preset=brotes-activos&z=6.5", 100);
    const applied = views.find((v) => v.name === "Mi vista");
    expect(applied?.url).toBe("/gob/panorama?preset=brotes-activos&z=6.5");
    views = removeView(views, "Mi vista");
    expect(views).toEqual([]);
  });
});
