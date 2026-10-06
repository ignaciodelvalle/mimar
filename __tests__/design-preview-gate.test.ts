import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DESIGN_DIR = "app/(public)/design";
const GATE = readFileSync(join(DESIGN_DIR, "preview-gate.ts"), "utf8");

// Every page under /design, discovered rather than listed: a hand-kept list is
// how a new preview ships ungated — nobody adds the line, and the test stays
// green over a page that renders fixtures in production.
const DESIGN_PAGES = readdirSync(DESIGN_DIR, { recursive: true, encoding: "utf8" })
  .map((entry) => entry.split("\\").join("/"))
  .filter((entry) => entry === "page.tsx" || entry.endsWith("/page.tsx"))
  .map((entry) => `${DESIGN_DIR}/${entry}`)
  .sort();

describe("design previews — production redirect", () => {
  it("sends production home from one helper", () => {
    expect(GATE).toContain('if (process.env.NODE_ENV === "production") redirect("/");');
  });

  // Non-vacuity floor: the index plus the three previews existed when this
  // became a glob (2026-10-06). Fewer means the discovery broke, not that the
  // pages left — a glob that finds nothing passes every per-page assertion.
  it("discovers every /design page (floor: 4)", () => {
    expect(DESIGN_PAGES.length).toBeGreaterThanOrEqual(4);
    expect(DESIGN_PAGES).toContain(`${DESIGN_DIR}/page.tsx`);
    expect(DESIGN_PAGES).toContain(`${DESIGN_DIR}/p-niveles/page.tsx`);
  });

  it.each(DESIGN_PAGES)("%s calls the gate", (file) => {
    const source = readFileSync(file, "utf8");
    // The real helper (a relative import of preview-gate), not a local stub
    // that happens to share its name.
    expect(source).toMatch(/import \{ gateDesignPreview \} from "(?:\.{1,2}\/)+preview-gate";/);
    expect(source).toContain("gateDesignPreview()");
  });
});
