// WP0 / A1 — lib/demo-mode.ts server-safe demo-mode flag helper.
//
// Regression: shouldShowDemoBanner previously lived ONLY in the "use client"
// module components/ui/DemoModeBanner.tsx. The server-side app/admin/layout.tsx
// could not call it without crashing the whole /admin segment. The helper now
// lives in a server-safe module (no "use client") so both the server layout and
// the client banner import it from one place.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";

describe("shouldShowDemoBanner()", () => {
  it('returns true only when the env value is exactly "true"', () => {
    expect(shouldShowDemoBanner("true")).toBe(true);
  });

  it("returns false when the env value is undefined", () => {
    expect(shouldShowDemoBanner(undefined)).toBe(false);
  });

  it('returns false for "false" and any other value', () => {
    expect(shouldShowDemoBanner("false")).toBe(false);
    expect(shouldShowDemoBanner("1")).toBe(false);
    expect(shouldShowDemoBanner("TRUE")).toBe(false);
    expect(shouldShowDemoBanner("")).toBe(false);
  });
});

describe("lib/demo-mode.ts stays server-safe", () => {
  it('carries no "use client" directive (the server admin layout imports it)', () => {
    const src = readFileSync(new URL("../lib/domain/demo-mode.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*["']use client["']/m);
  });
});
