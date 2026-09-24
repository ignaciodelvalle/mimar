// Screen-manifest fence — CI guard (C6a,
// dim-interno:docs/reviews/results/2026-07-22-plan-maestro-integridad.md §C6).
//
// "Toda pantalla declara su decisión dueña... si no hay decisión, es reporte
// o cola, no dashboard." This fence enforces the FIRST half of that sentence
// mechanically: every gob/admin `page.tsx` route must resolve to an entry in
// lib/ui/screen-manifest.ts (a route + layer + one-sentence decision) OR be
// explicitly grandfathered in the baseline below. A NEW route shipped with
// neither fails CI — the author must add a manifest entry (or, if the screen
// genuinely isn't decision-shaped yet, add it to the baseline and say why).
//
// SECOND check — manifest↔nav consistency: nav-presets.ts (GOB_NAV_SECTIONS /
// ADMIN_NAV_SECTIONS) and screen-manifest.ts are deliberately SEPARATE
// modules rather than one reading the other's shape. Reason: nav-presets.ts
// is a pure, capability-gated, section-labeled tree consumed directly by the
// rail/mobile-drawer/link-integrity tests (frozen-snapshot style); the
// manifest is a flat decision registry with no gating concept. Forcing nav
// items to carry `layer` sourced from the manifest (or vice versa) would
// couple two modules that change for different reasons — capability/route
// changes vs. decision-language changes. Instead, this fence cross-checks
// them: for every nav item with a manifest entry, the manifest's `layer` must
// agree with the SECTION the item actually renders under (via
// SECTION_LABEL_TO_LAYER below) — so the two can never silently diverge.
//
// Baseline: scripts/screen-manifest-baseline.json — regenerate with
//   pnpm tsx scripts/check-screen-manifest.ts --write-baseline
// (baseline entries are a fixed grandfathered list, not a ratchet count —
// removing a route from the baseline by giving it a real manifest entry only
// ever shrinks it; the script warns when a baselined route has quietly
// disappeared, same as the eyebrow/state-coverage fences' stale-entry warning).
//
// Run: pnpm tsx scripts/check-screen-manifest.ts   (or: pnpm lint:screens)
// Exits 0 when clean; exits 1 listing each violation.

import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ADMIN_NAV_SECTIONS, GOB_NAV_SECTIONS } from "../components/layout/nav-presets";
import { SCREEN_MANIFEST, type ScreenLayer } from "../lib/ui/screen-manifest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = resolve(ROOT, "scripts/screen-manifest-baseline.json");

const PAGE_GLOBS = ["app/gob/**/page.tsx", "app/admin/**/page.tsx"];

type BaselineFile = {
  _meta: { generatedAt: string; description: string };
  routes: string[];
};

/** nav-presets.ts section label → the C6a layer it represents. */
const SECTION_LABEL_TO_LAYER: Record<string, ScreenLayer> = {
  "": "briefing",
  Situación: "situacion",
  Programa: "programa",
  Intervención: "intervencion",
  "Bandeja operativa": "bandeja",
  Profundidad: "profundidad",
};

// ---------------------------------------------------------------------------
// Route discovery
// ---------------------------------------------------------------------------

/** "app/gob/casos/[publicCode]/page.tsx" → "/gob/casos/[publicCode]" */
function fileToRoute(rel: string): string {
  return rel.replace(/^app/, "").replace(/\/page\.tsx$/, "");
}

function collectRoutes(): string[] {
  const files = PAGE_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: ROOT }))
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.includes("node_modules/"))
    .sort();
  if (files.length === 0) {
    // FAIL CLOSED: an empty glob means the scan ran from the wrong place or
    // the app/ tree moved — that must never read as "no violations".
    console.error(
      `✗ check-screen-manifest: no files matched ${PAGE_GLOBS.join(", ")} under ${ROOT}.`,
    );
    process.exit(1);
  }
  return files.map(fileToRoute);
}

function loadBaseline(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
    return new Set(parsed.routes);
  } catch {
    console.warn(
      `[warn] ${BASELINE_PATH} not found — every uncovered route will fail. Regenerate with: pnpm tsx scripts/check-screen-manifest.ts --write-baseline`,
    );
    return new Set();
  }
}

function writeBaseline(uncovered: string[]): void {
  const baseline: BaselineFile = {
    _meta: {
      generatedAt: new Date().toISOString().slice(0, 10),
      description:
        "Routes grandfathered with no screen-manifest entry (mostly detail/form/export drill-downs FROM an already-declared decision, not new dashboard surfaces). A NEW uncovered route fails lint:screens — either add a lib/ui/screen-manifest.ts entry or add it here explicitly. Removing a baselined route by giving it a real entry only ever shrinks this list.",
    },
    routes: uncovered.sort(),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`✓ Wrote ${uncovered.length} route(s) to ${BASELINE_PATH}.`);
}

// ---------------------------------------------------------------------------
// Manifest coverage
// ---------------------------------------------------------------------------

function checkManifestCoverage(routes: string[], baseline: Set<string>): string[] {
  const covered = new Set(SCREEN_MANIFEST.map((e) => e.route));
  const violations: string[] = [];
  for (const route of routes) {
    if (covered.has(route)) continue;
    if (baseline.has(route)) continue;
    violations.push(
      `${route} has no lib/ui/screen-manifest.ts entry and is not baselined — add a { route, layer, decision } entry (or, if this route genuinely isn't decision-shaped, add it to scripts/screen-manifest-baseline.json and say why).`,
    );
  }
  return violations;
}

function warnStaleBaseline(routes: string[], baseline: Set<string>): void {
  const liveRoutes = new Set(routes);
  const stale = [...baseline].filter((r) => !liveRoutes.has(r));
  if (stale.length > 0) {
    console.warn(
      `[info] ${stale.length} baselined route(s) no longer exist as a page.tsx — remove them from ${BASELINE_PATH} to tighten the ratchet: ${stale.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Manifest ↔ nav consistency (second check — see header comment)
// ---------------------------------------------------------------------------

function checkNavConsistency(): string[] {
  const violations: string[] = [];
  const navSources: Array<{ portal: string; sections: typeof GOB_NAV_SECTIONS }> = [
    { portal: "gob", sections: GOB_NAV_SECTIONS },
    { portal: "admin", sections: ADMIN_NAV_SECTIONS },
  ];

  for (const { portal, sections } of navSources) {
    for (const section of sections) {
      const expectedLayer = SECTION_LABEL_TO_LAYER[section.label];
      if (expectedLayer === undefined) {
        violations.push(
          `${portal} nav section "${section.label}" has no entry in SECTION_LABEL_TO_LAYER — add one so its items can be checked against the manifest.`,
        );
        continue;
      }
      for (const item of section.items) {
        const entry = SCREEN_MANIFEST.find((e) => e.route === item.href);
        if (!entry) continue; // uncovered nav items are a manifest-coverage concern, not a consistency one
        if (entry.layer !== expectedLayer) {
          violations.push(
            `${item.href}: nav-presets.ts places it under "${section.label}" (layer "${expectedLayer}") but lib/ui/screen-manifest.ts declares layer "${entry.layer}" — the two disagree, fix one.`,
          );
        }
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function runChecks(): void {
  const routes = collectRoutes();
  const baseline = loadBaseline();

  const coverageViolations = checkManifestCoverage(routes, baseline);
  const consistencyViolations = checkNavConsistency();

  warnStaleBaseline(routes, baseline);

  const allViolations = [...coverageViolations, ...consistencyViolations];
  if (allViolations.length > 0) {
    for (const v of allViolations) console.error(`✗ ${v}`);
    console.error(
      `\n✗ ${allViolations.length} screen-manifest violation(s) (${coverageViolations.length} uncovered, ${consistencyViolations.length} nav-inconsistent).`,
    );
    process.exit(1);
  }

  const manifestCount = SCREEN_MANIFEST.length;
  console.log(
    `✓ screen-manifest clean — ${manifestCount} route(s) declared, ${baseline.size} baselined, 0 new violations.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-screen-manifest.ts") ||
    process.argv[1].endsWith("check-screen-manifest.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  if (process.argv.includes("--write-baseline")) {
    const routes = collectRoutes();
    const covered = new Set(SCREEN_MANIFEST.map((e) => e.route));
    writeBaseline(routes.filter((r) => !covered.has(r)));
  } else {
    runChecks();
  }
}
