// MapLibre locale fence — every MapLibre map must speak es-AR.
//
// MapLibre stamps English strings from its built-in `defaultLocale` onto every
// control (canvas aria-label "Map", marker "Map marker", "Toggle attribution",
// zoom/fullscreen tooltips, popup close, cooperative-gestures overlay). In a
// Spanish (es-AR) product a screen-reader user otherwise hears a mix of Spanish
// page copy and English map controls (recorrido QA: "Map marker" / "Toggle
// attribution" on the lost-credential map and Panorama). lib/ui/maplibre-locale
// exports the single shared vocabulary MAPLIBRE_LOCALE_ES.
//
// RULE: any source file that constructs a MapLibre map (`new maplibregl.Map(…)`
// / `new maplibre.Map(…)`) MUST reference MAPLIBRE_LOCALE_ES (import + pass it as
// the `locale` option) so the map's controls are localized. Marker/Popup
// constructors are NOT gated (they carry no control vocabulary of their own —
// the map's locale covers them).
//
// Enforcement: hard ban with a small, documented BASELINE allowlist. Three maps
// predate the shared locale (CabaInset, MapChoropleth, LocationPicker) and are
// grandfathered by relative path — a follow-up owned by those components' authors
// (out of the fence's territory) migrates them; until then the fence prevents any
// NEW un-localized map. Remove a path from the allowlist once its map adopts the
// locale. A brand-new map with no locale fails immediately.
//
// Run: pnpm tsx scripts/check-maplibre-locale.ts
// Or:  pnpm lint:maplibre
//
// Exits 1 with file:line on each un-localized map. Exits 0 if clean.

import { globSync, readFileSync } from "node:fs";

// Matches a MapLibre MAP constructor: `new maplibregl.Map(` or `new maplibre.Map(`.
// Marker/Popup/other constructors are intentionally NOT matched.
export const MAP_CONSTRUCTOR = /new\s+maplibregl?\.Map\s*\(/;

// The shared locale symbol every localized map references.
const LOCALE_SYMBOL = "MAPLIBRE_LOCALE_ES";

// Grandfathered maps that construct a MapLibre map WITHOUT the shared locale yet.
// Documented known gaps — migrating them (add `locale: { ...MAPLIBRE_LOCALE_ES }`)
// belongs to each component's owner. Keyed by repo-relative path (forward slashes).
export const MAPLIBRE_LOCALE_ALLOWLIST = new Set<string>([
  // components/panorama/CabaInset.tsx — CABA barrios inset map; no locale yet.
  "components/panorama/CabaInset.tsx",
  // components/charts/MapChoropleth.tsx — dashboard/panorama choropleth; no locale yet.
  "components/charts/MapChoropleth.tsx",
  // components/LocationPicker.tsx — draggable-marker location picker; no locale yet.
  "components/LocationPicker.tsx",
]);

const FILES = globSync("{app,components,lib,packages,src}/**/*.{ts,tsx}")
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => !f.startsWith("node_modules/") && !f.includes("/node_modules/"));

function runScan(): void {
  let hits = 0;
  let localized = 0;
  let grandfathered = 0;

  for (const relPath of FILES) {
    const content = readFileSync(relPath, "utf8");
    if (!MAP_CONSTRUCTOR.test(content)) continue;

    const hasLocale = content.includes(LOCALE_SYMBOL);
    if (hasLocale) {
      localized += 1;
      continue;
    }
    if (MAPLIBRE_LOCALE_ALLOWLIST.has(relPath)) {
      grandfathered += 1;
      continue;
    }

    // Report the constructor line for a precise pointer.
    const lineNo = content.split(/\r?\n/).findIndex((l) => MAP_CONSTRUCTOR.test(l)) + 1;
    console.error(
      `${relPath}:${lineNo}: constructs a MapLibre map but never references ${LOCALE_SYMBOL} — import it from @/lib/ui/maplibre-locale and pass \`locale: { ...${LOCALE_SYMBOL} }\` so the map controls are es-AR.`,
    );
    hits += 1;
  }

  if (hits > 0) {
    console.error(`\n✗ ${hits} un-localized MapLibre map(s).`);
    process.exit(1);
  }
  console.log(
    `✓ MapLibre locale clean — ${localized} map(s) use ${LOCALE_SYMBOL}; ${grandfathered} grandfathered gap(s) awaiting migration. New maps must localize.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-maplibre-locale.ts") ||
    process.argv[1].endsWith("check-maplibre-locale.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
