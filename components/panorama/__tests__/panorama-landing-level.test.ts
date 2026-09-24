// The LANDING-STATE grain contract (A1, 2026-07-31).
//
// THE DEFECT THIS PINS. On `/gob/panorama?layers=ppp` — no `level` param, which
// is where a scoped govt operator actually lands — the console fired
// `/api/panorama/ppp?layers=ppp&level=province`, ABORTED it, and the winning
// refetch was `/api/panorama/ppp` with no params at all, so the server resolved
// `level=locality`. The map stayed in PROVINCE render mode (`pano-prov-fill-ppp`
// mounted, chip "Provincias") holding LOCALITY features, so every unit read
// EMPTY: the entire country painted "sin datos" — including CABA at 40% and the
// k-anon-suppressed Tierra del Fuego, whose hatch became unreachable without
// hand-editing the URL.
//
// TWO independent causes, one per describe block below.
//
// 1. LEVEL DRIFT ON MOUNT. The page's seed predicate ("has ANY jurisdiction
//    assignment") and the console's `resolveDataLevel` ("has a SINGLE committed
//    province") disagreed for a multi-province operator, so the axis flipped on
//    the very first commit. Both govt seed accounts are multi-province, so this
//    fired on every QA login.
//
// 2. THE STALE `levelRef`. `onLevelChange` set the `level` STATE but not
//    `levelRef.current` (which is only assigned during render). The mount effect
//    is declared AFTER the level-flip effect, runs in the SAME commit, and reads
//    that ref — so it fetched at the OLD axis and, sharing the per-layer abort
//    key, aborted the correct in-flight request.
//
// Both are pinned structurally/purely: PanoramaConsole cannot be rendered in
// Vitest (maplibre-gl is unavailable), which is why the derivations were
// extracted into situational-map-utils in the first place.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AggregationLevel } from "@/src/modules/panorama/domain/types";

import { mountPlaceholderZoom, resolveDataLevel, resolveSeedLevel } from "../situational-map-utils";

// ---------------------------------------------------------------------------
// 1. The seed axis must be a FIXED POINT of the console's own derivation.
// ---------------------------------------------------------------------------

/** Every scope shape a panorama page can hand the console on mount. */
const SCOPE_SHAPES: Array<{
  name: string;
  hasProvinceScope: boolean;
  hasLocalityScope: boolean;
}> = [
  // Unscoped admin viewing /gob, AND — the regression — a govt operator whose
  // jurisdictions span several provinces (deriveWidestJurisdiction empties
  // initialDivisionProvince for them, so the console reads NO province scope).
  { name: "national / multi-province govt", hasProvinceScope: false, hasLocalityScope: false },
  { name: "single-province govt or ?province=", hasProvinceScope: true, hasLocalityScope: false },
  { name: "province + locality drill", hasProvinceScope: true, hasLocalityScope: true },
];

describe("landing-state grain: the seed axis is a fixed point of resolveDataLevel", () => {
  for (const shape of SCOPE_SHAPES) {
    it(`does not drift on mount — ${shape.name}`, () => {
      const seeded = resolveSeedLevel(shape);
      // The console derives its axis on the FIRST commit, before the map has
      // loaded, at the placeholder camera the seeded level itself implies.
      // `hasActiveChoropleth: true` is the reported landing state (?layers=ppp).
      const derived = resolveDataLevel({
        hasProvinceScope: shape.hasProvinceScope,
        hasLocalityScope: shape.hasLocalityScope,
        zoom: mountPlaceholderZoom(seeded),
        hasActiveChoropleth: true,
      });
      expect(derived).toBe(seeded);
    });
  }

  it("pins the national/multi-province landing state to PROVINCE specifically", () => {
    // Not just self-consistent — the right grain. A seed of "locality" here is
    // the exact defect: the placeholder camera (below Z_DIVISIONS) makes the
    // console derive "province", and the mount fetch that wins asks for the
    // grain the map is NOT rendering.
    const seeded: AggregationLevel = resolveSeedLevel({
      hasProvinceScope: false,
      hasLocalityScope: false,
    });
    expect(seeded).toBe("province");
  });

  it("keeps a single-province operator on the LOCALITY grain (unchanged)", () => {
    expect(resolveSeedLevel({ hasProvinceScope: true, hasLocalityScope: false })).toBe("locality");
  });
});

// ---------------------------------------------------------------------------
// 2. Every axis mutation syncs levelRef EAGERLY.
// ---------------------------------------------------------------------------

// The axis mutation sites live in TWO files since the board-init extraction
// (2026-08-01): onLevelChange stays in PanoramaConsole.tsx; the saved-board
// restore (io.setLevel + io.levelRef.current) moved to
// panorama-console-helpers.ts. The fence follows the code.
const FENCED_SOURCES = [
  { name: "PanoramaConsole.tsx", file: join(__dirname, "..", "PanoramaConsole.tsx") },
  {
    name: "panorama-console-helpers.ts",
    file: join(__dirname, "..", "panorama-console-helpers.ts"),
  },
].map((s) => ({ ...s, lines: readFileSync(s.file, "utf8").split(/\r?\n/) }));

/**
 * The CODE on a line, with comments stripped.
 *
 * Mutation-verified the hard way: the first version of this fence matched raw
 * lines, and deleting the real `levelRef.current = next` still passed — the
 * explanatory COMMENT above it (which quotes `levelRef.current = level`)
 * satisfied the regex. A fence that a comment can satisfy is not a fence.
 */
function codeOnly(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  return line.split("//")[0];
}

/** `setLevel(...)` CALLS — not the useState declaration that creates the setter. */
const SET_LEVEL_CALL = /(?<!\[level,\s)\bsetLevel\(/;
const LEVEL_REF_WRITE = /levelRef\.current\s*=[^=]/;

// Lines of forward look after the setLevel call. Both compliant sites assign the
// ref within 2 lines of prose/blank; a small window cannot borrow a distant
// unrelated assignment.
const WINDOW = 24;

describe("PanoramaConsole: setLevel always syncs levelRef in the same tick", () => {
  const sites = FENCED_SOURCES.flatMap(({ name, lines }) =>
    lines
      .map((line, i) => ({ name, lines, line: codeOnly(line), i }))
      .filter(({ line }) => SET_LEVEL_CALL.test(line)),
  );

  it("finds the axis mutation sites (the fence has something to guard)", () => {
    // onLevelChange (console) + the board restore (helpers). If this drops to 0
    // the regex rotted and every assertion below would pass vacuously.
    expect(sites.length).toBeGreaterThanOrEqual(2);
  });

  for (const { name, lines, line, i } of sites) {
    it(`assigns levelRef.current near setLevel at ${name}:${i + 1}`, () => {
      const window = lines.slice(i + 1, i + 1 + WINDOW);
      const found = window.some((l) => LEVEL_REF_WRITE.test(codeOnly(l)));
      expect(
        found,
        `setLevel at ${name}:${i + 1} (${line.trim()}) does not assign levelRef.current within ${WINDOW} lines. Effects declared LATER in the file run in the SAME commit and read that ref — a stale read fetches the wrong grain and aborts the right request.`,
      ).toBe(true);
    });
  }
});
