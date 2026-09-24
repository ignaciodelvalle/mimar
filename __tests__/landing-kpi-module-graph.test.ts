/**
 * Regression guard for W5c (design canon C9, LCP fix R-2, 2026-09-23).
 *
 * commit 751ecbb75 measured components/landing/story-screens.tsx pulling in
 * the WHOLE components/ui/dashboard/OpKpi.tsx module (metric-contract engine,
 * ProvenanceCard, KPI_CATALOG, a dynamic-imported recharts chart) for a
 * decorative console mock that only ever needed the compact OpKpiSm tile —
 * measured as an extra 35KB shipped to every anonymous landing visitor. The
 * fix moved OpKpiSm into its own light module (components/ui/dashboard/
 * OpKpiSm.tsx, no heavy imports) and pointed story-screens.tsx at it directly.
 *
 * This test walks the STATIC import graph reachable from story-screens.tsx
 * (following only `import ... from "..."` / `export ... from "..."` — NOT
 * `import(...)` dynamic calls, which are the deliberate code-split boundary,
 * e.g. OpKpi.tsx's own lazy Sparkline) and asserts OpKpi.tsx is never in it.
 * A regression that re-imports OpKpiSm from OpKpi.tsx (or from the
 * components/ui/dashboard barrel, which re-exports it from OpKpi.tsx) would
 * reintroduce the whole module into the landing bundle and must fail here.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ENTRY = path.resolve(ROOT, "components/landing/story-screens.tsx");
const OP_KPI = path.resolve(ROOT, "components/ui/dashboard/OpKpi.tsx");
const OP_KPI_SM = path.resolve(ROOT, "components/ui/dashboard/OpKpiSm.tsx");

// Matches `import ... from "spec"`, `import "spec"`, and `export ... from
// "spec"` — static edges only. Deliberately does NOT match `import(...)`
// (dynamic import), which is a code-split boundary, not a bundle edge.
const STATIC_IMPORT =
  /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveModule(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null; // external package
  const base = specifier.startsWith("@/")
    ? path.resolve(ROOT, specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier);
  // Extensioned files checked before index.ts(x) — `base` itself (no
  // extension) is skipped on purpose: when `base` is a directory, statSync
  // would resolve it, but it is never a valid module file on its own.
  const candidates = [
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    path.join(base, "index.tsx"),
    path.join(base, "index.ts"),
  ];
  return candidates.find(isFile) ?? null;
}

function walk(entry: string): Set<string> {
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    let src: string;
    try {
      src = readFileSync(current, "utf8");
    } catch {
      continue;
    }
    STATIC_IMPORT.lastIndex = 0;
    for (const m of src.matchAll(STATIC_IMPORT)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const resolved = resolveModule(spec, current);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

describe("landing module graph — story-screens.tsx must not reach OpKpi.tsx", () => {
  const graph = walk(ENTRY);

  it("non-vacuity: the scan actually traversed a non-trivial graph", () => {
    expect(graph.size).toBeGreaterThan(5);
  });

  it("reaches OpKpiSm.tsx (the module it is supposed to use)", () => {
    expect(graph.has(OP_KPI_SM)).toBe(true);
  });

  it("never reaches OpKpi.tsx — that would re-inflate the landing bundle", () => {
    expect(graph.has(OP_KPI)).toBe(false);
  });
});
