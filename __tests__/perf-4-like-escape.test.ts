// Unit tests for lib/like-helpers.ts — LIKE input escaping.
//
// PERF-4: SQL filters pushed from JS into WHERE clauses require user-supplied
// strings to be safely escaped before use in ILIKE/LIKE patterns. These tests
// assert that likeContains correctly neutralises SQL wildcard characters.

import { describe, expect, it } from "vitest";

import { escapeLike, likeContains } from "@/lib/utils/like-helpers";

describe("escapeLike", () => {
  it("returns the string unchanged when no special characters are present", () => {
    expect(escapeLike("test")).toBe("test");
    expect(escapeLike("revocation")).toBe("revocation");
  });

  it("escapes percent signs", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a%b%c")).toBe("a\\%b\\%c");
  });

  it("escapes underscores", () => {
    expect(escapeLike("foo_bar")).toBe("foo\\_bar");
    expect(escapeLike("_leading")).toBe("\\_leading");
    expect(escapeLike("trailing_")).toBe("trailing\\_");
  });

  it("escapes backslashes before other special characters", () => {
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("a\\_b")).toBe("a\\\\\\_b");
    expect(escapeLike("a\\%b")).toBe("a\\\\\\%b");
  });

  it("handles empty string", () => {
    expect(escapeLike("")).toBe("");
  });

  it("handles strings with only special characters", () => {
    expect(escapeLike("%_%")).toBe("\\%\\_\\%");
  });
});

describe("likeContains", () => {
  it("wraps the escaped value in percent signs", () => {
    expect(likeContains("revocation")).toBe("%revocation%");
  });

  it("escapes special characters before wrapping", () => {
    expect(likeContains("100%")).toBe("%100\\%%");
    expect(likeContains("foo_bar")).toBe("%foo\\_bar%");
  });

  it("a plain substring is safe to use directly in ILIKE", () => {
    const pattern = likeContains("admin");
    // Should be a contains-style LIKE pattern with no raw wildcards from the input.
    expect(pattern).toBe("%admin%");
    // Does not contain any unescaped wildcard that came from user input.
    expect(pattern.replace(/^%/, "").replace(/%$/, "")).not.toContain("%");
  });
});
