import { describe, expect, it } from "vitest";

import { escapeHtml } from "./escape-html";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("neutralizes an XSS payload", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  it("escapes & first so other entities are not double-encoded", () => {
    expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
  });

  it("leaves safe text untouched", () => {
    expect(escapeHtml("Refugio San Roque")).toBe("Refugio San Roque");
  });

  it("coerces null/undefined to empty and numbers to their string form", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });
});
