// dropCubeStamp adjacency — structural fence over PanoramaConsole (fences wave S #10).
//
// The panorama console SSR-seeds a "datos agregados actualizados" cube stamp that
// describes the SEEDED frame only. Every client /api/panorama/[layer] response
// comes from the LIVE path, so the FIRST such fetch must invalidate the stamp via
// the one-way latch dropCubeStamp() — otherwise a lingering stamp asserts cube
// freshness the live view does not have (review 2026-07-17; regression class
// 77497967). The contract (see the dropCubeStamp comment in PanoramaConsole) is:
// "dropCubeStamp() sits beside every layer-data fetch dispatch."
//
// This test enforces that structurally. It reads every SCANNED file and, for
// every LAYER-DATA fetch site, asserts dropCubeStamp() appears in the enclosing
// dispatch. Review F6 (2026-08-15): the scan set now includes use-asof-frame.ts —
// the temporal fan-out extracted from the console carries a layer fetch of its
// own, and fencing only the console left it invisible to this contract.
//
// WINDOW HEURISTIC (documented): a "layer-data fetch site" is a template literal
// `\`/api/panorama/${...}\`` whose FIRST path segment is a dynamic expression
// (the layer id) — this excludes the KPI/scope fetches (`/api/panorama/kpis...`,
// `/api/panorama/scope...`), which are literal-segment and intentionally do NOT
// drop the stamp. For each site we scan the ADJACENCY WINDOW = the WINDOW lines
// immediately preceding the fetch line (the tail of its enclosing callback, where
// the latch is dispatched right before the await). Every compliant site in the
// file drops the stamp within 2 lines, so a small window is both sufficient and
// tight enough not to borrow a neighbour's latch.
//
// KNOWN_GAP_HELPERS: enclosing helpers (by function name, line-shift robust)
// whose layer fetch is allowlisted despite lacking an adjacent latch. Empty
// today — fetchLayersInto, the original gap, drops the stamp since wave S.
// Keep the mechanism: a future documented gap goes here, not in the window.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Every file that dispatches a layer-data fetch, with the minimum number of
// sites the regex must find there (vacuous-pass guard for each file).
const SCANNED: ReadonlyArray<{ name: string; minSites: number }> = [
  { name: "PanoramaConsole.tsx", minSites: 7 },
  { name: "use-asof-frame.ts", minSites: 1 },
];

const FILES = SCANNED.map(({ name, minSites }) => {
  const src = readFileSync(join(__dirname, "..", "components", "panorama", name), "utf8");
  return { name, minSites, src, lines: src.split(/\r?\n/) };
});

// Layer-data fetch: backtick + `/api/panorama/${` (dynamic FIRST segment). The
// KPI/scope fetches read `/api/panorama/kpis${` / `/api/panorama/scope?${` — a
// LITERAL first segment — so they never match.
const LAYER_FETCH = /`\/api\/panorama\/\$\{/;

// Lines of backward look — the tail of the enclosing callback where the latch
// fires just before the await. Every compliant site drops within 2 lines.
const WINDOW = 6;

// Enclosing helpers whose layer fetch has NO adjacent dropCubeStamp — documented
// known gaps, allowlisted by name so line shifts don't break the fence.
const KNOWN_GAP_HELPERS = new Set<string>([]);

/** The nearest `const <name> = useCallback(` at or above `lineIdx`, or null. */
function enclosingCallbackName(lines: string[], lineIdx: number): string | null {
  for (let i = lineIdx; i >= 0; i--) {
    const m = lines[i].match(/const\s+(\w+)\s*=\s*useCallback\(/);
    if (m) return m[1];
  }
  return null;
}

function layerFetchLineIndices(lines: string[]): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (LAYER_FETCH.test(line)) out.push(i);
  });
  return out;
}

describe("panorama — dropCubeStamp sits beside every layer-data fetch", () => {
  it("defines the dropCubeStamp latch in the console", () => {
    const console_ = FILES[0];
    expect(console_.src).toMatch(/const dropCubeStamp = useCallback\(/);
  });

  for (const file of FILES) {
    it(`${file.name}: finds the expected family of layer-data fetch sites`, () => {
      // Guard against the regex silently matching nothing (vacuous pass).
      expect(layerFetchLineIndices(file.lines).length).toBeGreaterThanOrEqual(file.minSites);
    });

    it(`${file.name}: every layer-data fetch drops the cube stamp in its enclosing dispatch`, () => {
      const violations: string[] = [];
      for (const idx of layerFetchLineIndices(file.lines)) {
        const window = file.lines.slice(Math.max(0, idx - WINDOW), idx + 1).join("\n");
        if (window.includes("dropCubeStamp()")) continue; // adjacent latch — OK.

        const enclosing = enclosingCallbackName(file.lines, idx);
        if (enclosing && KNOWN_GAP_HELPERS.has(enclosing)) continue; // flagged gap.

        violations.push(
          `${file.name}:${idx + 1}: ${file.lines[idx].trim()} — no dropCubeStamp() within ${WINDOW} lines (enclosing: ${enclosing ?? "?"})`,
        );
      }
      expect(violations, `\n${violations.join("\n")}`).toEqual([]);
    });
  }
});
