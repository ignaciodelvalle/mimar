// Guards the `op-hit-24` touch-target utility against the failure mode this
// repo keeps rediscovering: THE ARTIFACT EXISTS, THE CONTENT DOES NOT SAY WHAT
// IT SEEMS.
//
// A hit-area extension is invisible by construction — that is the whole point.
// So if the CSS rule is deleted, renamed, or has its `content` dropped, every
// `className="op-hit-24"` in the app keeps rendering exactly as before and the
// touch target silently collapses back to the size of the glyph. No screenshot
// diff, no failing render test, no reviewer notices. The only thing that can
// catch it is an assertion tying the class NAME to the RULE.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const CSS = readFileSync(join(ROOT, "app/globals.css"), "utf8");

/**
 * Every source file that puts the class on an element. Walks with readdirSync
 * (the enumeration style the other fences in this directory use) rather than
 * adding a glob dependency for one test.
 */
function usageFiles(): string[] {
  const found: string[] = [];
  for (const root of ["app", "components", "src"]) {
    for (const entry of readdirSync(join(ROOT, root), {
      withFileTypes: true,
      recursive: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".tsx")) continue;
      if (entry.name.endsWith(".test.tsx")) continue;
      const abs = join(entry.parentPath, entry.name);
      if (readFileSync(abs, "utf8").includes("op-hit-24")) {
        found.push(abs.slice(ROOT.length + 1).replaceAll("\\", "/"));
      }
    }
  }
  return found;
}

describe("op-hit-24 — the touch-target extension is real, not just a class name", () => {
  it("defines the rule with a positioning context and a rendered ::after box", () => {
    // Three separate declarations, each load-bearing and each independently
    // deletable by a well-meaning cleanup:
    //   - position:relative — without it the absolute ::after resolves against
    //     some ancestor and pads the wrong region entirely.
    //   - content — a ::after with no content value generates NO box at all,
    //     so the inset below applies to nothing.
    //   - the negative inset — this is the extension itself.
    expect(CSS).toMatch(/\.op-hit-24\s*\{[^}]*position:\s*relative/);
    expect(CSS).toMatch(/\.op-hit-24::after\s*\{[^}]*content:/);
    expect(CSS).toMatch(/\.op-hit-24::after\s*\{[^}]*position:\s*absolute/);
    expect(CSS).toMatch(/\.op-hit-24::after\s*\{[^}]*inset:\s*-5px/);
  });

  it("reaches 24px from the 14px glyph it was sized for", () => {
    // Pins the ARITHMETIC, not just the presence of some inset. A future edit
    // that softens -5px to -2px would still match every assertion above while
    // leaving the target at 18px — under the WCAG 2.5.8 minimum this rule
    // exists to clear.
    const inset = CSS.match(/\.op-hit-24::after\s*\{[^}]*inset:\s*(-\d+)px/);
    expect(inset).not.toBeNull();
    const glyphPx = 14;
    const extension = Math.abs(Number(inset?.[1]));
    expect(glyphPx + extension * 2).toBeGreaterThanOrEqual(24);
  });

  it("is actually used — a rule nothing references protects nothing", () => {
    // NON-VACUITY. Without this, deleting every usage would leave the two
    // assertions above passing forever while the app has no extended targets
    // left. The repo has been bitten by fences that scan zero files and pass.
    const files = usageFiles();
    expect(files.length).toBeGreaterThan(0);
    // The KPI disclosure button is the reason the utility was written; if it
    // stops using it, that is a decision someone must make deliberately.
    expect(files).toContain("components/ui/dashboard/OpKpi.tsx");
  });
});
