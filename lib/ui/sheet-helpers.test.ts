// Unit tests for Sheet helpers.

import { describe, expect, it } from "vitest";
import {
  buildCloseSheetUrl,
  buildSheetUrl,
  getDrawerWidth,
  getSheetIdFromSearchParams,
} from "./sheet-helpers";

describe("getSheetIdFromSearchParams", () => {
  it("returns the sheet id when param is present (URLSearchParams)", () => {
    const params = new URLSearchParams("sheet=pet-actions");
    expect(getSheetIdFromSearchParams(params)).toBe("pet-actions");
  });

  it("returns the sheet id when param is present (plain object)", () => {
    expect(getSheetIdFromSearchParams({ sheet: "documents" })).toBe("documents");
  });

  it("returns null when no sheet param (URLSearchParams)", () => {
    expect(getSheetIdFromSearchParams(new URLSearchParams())).toBeNull();
  });

  it("returns null when no sheet param (plain object)", () => {
    expect(getSheetIdFromSearchParams({})).toBeNull();
  });

  it("returns null for empty string sheet param", () => {
    expect(getSheetIdFromSearchParams(new URLSearchParams("sheet="))).toBeNull();
  });

  it("ignores unrelated params when returning id", () => {
    const params = new URLSearchParams("tab=history&sheet=notes&page=2");
    expect(getSheetIdFromSearchParams(params)).toBe("notes");
  });
});

describe("buildSheetUrl", () => {
  it("adds sheet param to empty search params", () => {
    expect(buildSheetUrl("/mis-mascotas", new URLSearchParams(), "actions")).toBe(
      "/mis-mascotas?sheet=actions",
    );
  });

  it("preserves existing params when adding sheet", () => {
    const params = new URLSearchParams("tab=health");
    const url = buildSheetUrl("/pet", params, "docs");
    expect(url).toContain("tab=health");
    expect(url).toContain("sheet=docs");
  });

  it("replaces existing sheet param", () => {
    const params = new URLSearchParams("sheet=old-sheet");
    const url = buildSheetUrl("/pet", params, "new-sheet");
    expect(url).not.toContain("old-sheet");
    expect(url).toContain("sheet=new-sheet");
  });

  it("works with plain object params", () => {
    const url = buildSheetUrl("/foo", { existing: "value" }, "bar");
    expect(url).toBe("/foo?existing=value&sheet=bar");
  });

  it("produces correct URL with empty plain object", () => {
    expect(buildSheetUrl("/foo", {}, "bar")).toBe("/foo?sheet=bar");
  });
});

describe("buildCloseSheetUrl", () => {
  it("removes sheet param from URL", () => {
    const params = new URLSearchParams("sheet=actions");
    expect(buildCloseSheetUrl("/pet", params)).toBe("/pet");
  });

  it("preserves other params when removing sheet", () => {
    const params = new URLSearchParams("tab=history&sheet=notes&page=2");
    const url = buildCloseSheetUrl("/pet", params);
    expect(url).not.toContain("sheet");
    expect(url).toContain("tab=history");
    expect(url).toContain("page=2");
  });

  it("returns plain pathname when no params remain", () => {
    expect(buildCloseSheetUrl("/mis-mascotas", new URLSearchParams("sheet=x"))).toBe(
      "/mis-mascotas",
    );
  });

  it("returns plain pathname when search params were already empty", () => {
    expect(buildCloseSheetUrl("/foo", new URLSearchParams())).toBe("/foo");
  });

  it("works with plain object", () => {
    expect(buildCloseSheetUrl("/foo", { other: "keep", sheet: "remove" })).toBe("/foo?other=keep");
  });
});

describe("getDrawerWidth", () => {
  it("sm → 320px", () => {
    expect(getDrawerWidth("sm")).toBe("md:w-[320px]");
  });

  it("md → 480px", () => {
    expect(getDrawerWidth("md")).toBe("md:w-[480px]");
  });

  it("lg → 640px", () => {
    expect(getDrawerWidth("lg")).toBe("md:w-[640px]");
  });
});
