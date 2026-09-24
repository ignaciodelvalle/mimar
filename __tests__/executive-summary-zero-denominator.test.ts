// The executive summary must not paint "we don't know" as "you are failing".
//
// THE DEFECT, AND WHY IT IS THE DAY-ONE SHAPE
// ---------------------------------------------------------------------------
// `/gob/programa` and `/admin/programa` are the first executive screens a
// funcionario opens. Their Esterilización and Microchip tiles keyed the dash
// off the RATE:
//
//     value={sterilRatePct > 0 ? formatPercent(sterilRatePct) : "—"}
//     tone={toneForTarget(sterilRatePct, META)}
//
// which collapses two different facts into one glyph — "nothing is registered
// here, so we cannot know" and "there IS a padrón and measured coverage is 0%"
// — and then runs the tone function on the raw 0 in BOTH cases, painting the
// tile RED. A jurisdiction that has not loaded anything yet looked exactly like
// one failing its legal target. That is not an edge case: it is the shape of
// every new jurisdiction on its first day, which is precisely the state this
// system is about to be opened in.
//
// The denominator is the honest discriminator, and four sibling screens already
// branch on it. This fence keeps the two executive screens branching too.
//
// IT SCANS SOURCE ON PURPOSE. The tiles are deep inside async server components
// that fan out to a dozen fetchers; rendering them in a unit test would mean
// mocking the world, and the assertion would then be about the mocks. What
// actually went wrong is a one-line predicate, and a predicate is exactly what
// source can be checked for.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

const PANTALLAS = [
  { file: "app/gob/programa/ProgramaResumenScreen.tsx", label: "gobierno" },
  { file: "app/admin/programa/page.tsx", label: "admin" },
] as const;

function source(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

/** Strips comments so the historical notes describing the OLD code don't match. */
function rendered(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("executive summary — a rate of 0 is not the same as no padrón", () => {
  it("reads both screens", () => {
    // NON-VACUITY: a moved or renamed file would otherwise make every
    // assertion below pass over an empty string.
    for (const { file } of PANTALLAS) {
      expect(rendered(file).length, file).toBeGreaterThan(2000);
    }
  });

  it("never decides the dash from the rate itself", () => {
    // The exact shape that was wrong. `rate > 0 ? … : "—"` cannot distinguish
    // the two states, whatever it is renamed to.
    const culpables: string[] = [];
    for (const { file, label } of PANTALLAS) {
      const src = rendered(file);
      for (const m of src.matchAll(/(\w*[Rr]ate\w*)\s*>\s*0\s*\?/g)) {
        culpables.push(`${label} · ${file} → ${m[0]}`);
      }
    }
    expect(culpables).toEqual([]);
  });

  it("branches the tone on the denominator, so no-data is never a red verdict", () => {
    // The half that actually misleads. A dash with a red tone still reads as a
    // failing grade; only the tone branch removes the false verdict.
    const sinGuarda: string[] = [];
    for (const { file, label } of PANTALLAS) {
      const src = rendered(file);
      for (const m of src.matchAll(/tone=\{([^}]*toneForTarget[^}]*)\}/g)) {
        const expr = m[1] ?? "";
        if (!/hasPadron|hasChipPadron|hasData/.test(expr)) {
          sinGuarda.push(`${label} · ${file} → tone={${expr.trim().slice(0, 70)}}`);
        }
      }
    }
    expect(sinGuarda).toEqual([]);
  });

  it("derives those guards from a COUNT, not from the rate", () => {
    // The guard has to come from the denominator. `hasPadron = rate > 0` would
    // satisfy every assertion above while changing nothing.
    for (const { file, label } of PANTALLAS) {
      const src = rendered(file);
      const guards = [...src.matchAll(/const (hasPadron|hasChipPadron)\s*=\s*([^;]+);/g)];
      expect(guards.length, `${label}: no declara los guardas`).toBe(2);
      for (const g of guards) {
        const expr = (g[2] ?? "").trim();
        expect(expr, `${label} · ${g[1]}`).toMatch(/\.(total|active)\s*>\s*0/);
      }
    }
  });
});
