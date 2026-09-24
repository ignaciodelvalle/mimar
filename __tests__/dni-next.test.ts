// Unit test for sanitizeNext — open-redirect guard (review 2026-05-19 §2.4).
//
// The function must accept legitimate same-origin paths and reject anything
// that could redirect to a different origin (protocol-relative, absolute,
// encoded-slash bypasses). On any rejection, falls back to /cuenta.

import { describe, expect, it } from "vitest";

import { sanitizeNext } from "@/lib/domain/dni-next";

describe("sanitizeNext — open-redirect guard (§2.4)", () => {
  describe("falls back to /cuenta", () => {
    it.each([
      ["null", null],
      ["empty string", ""],
      ["whitespace only", "   "],
      ["protocol-relative URL", "//attacker.com"],
      ["protocol-relative URL with path", "//attacker.com/path"],
      ["http URL", "http://attacker.com"],
      ["https URL", "https://attacker.com/path?q=1"],
      ["javascript: URL", "javascript:alert(1)"],
      ["data: URL", "data:text/html,<script>"],
      ["backslash bypass", "/\\attacker.com"],
      ["encoded slashes", "/%2F%2Fattacker.com"],
      ["mixed encoded slashes", "/%2f%2fattacker.com"],
    ])("rejects %s", (_label, input) => {
      expect(sanitizeNext(input)).toBe("/cuenta");
    });
  });

  describe("safe-but-surprising cases (documented behavior, not vulnerabilities)", () => {
    // A relative path with no leading slash resolves against the base, so
    // `cuenta` → `/cuenta` and `attacker.com` → `/attacker.com`. Both stay
    // on our origin — they cannot redirect to a third party. We accept them
    // rather than rejecting because they're harmless and a stricter reject
    // would surprise callers passing `next` from form state with shapes
    // we don't control. Pin the behavior so future changes notice.
    it("resolves a bare relative path against base", () => {
      expect(sanitizeNext("cuenta")).toBe("/cuenta");
    });

    it("resolves an unprefixed hostname as a same-origin path", () => {
      // Not a redirect to attacker.com — this is `https://OUR_ORIGIN/attacker.com`.
      expect(sanitizeNext("attacker.com")).toBe("/attacker.com");
    });
  });

  describe("accepts same-origin paths", () => {
    it("returns a bare path unchanged", () => {
      expect(sanitizeNext("/foo")).toBe("/foo");
    });

    it("preserves the query string", () => {
      expect(sanitizeNext("/foo?x=1")).toBe("/foo?x=1");
    });

    it("preserves the hash", () => {
      expect(sanitizeNext("/foo#section")).toBe("/foo#section");
    });

    it("preserves query AND hash", () => {
      expect(sanitizeNext("/foo?x=1&y=2#section")).toBe("/foo?x=1&y=2#section");
    });

    it("accepts the bare root", () => {
      expect(sanitizeNext("/")).toBe("/");
    });

    it("trims surrounding whitespace before parsing", () => {
      expect(sanitizeNext("  /foo  ")).toBe("/foo");
    });

    it("accepts deep paths", () => {
      expect(sanitizeNext("/mis-mascotas/abc-123/eventos/nuevo")).toBe(
        "/mis-mascotas/abc-123/eventos/nuevo",
      );
    });
  });
});
