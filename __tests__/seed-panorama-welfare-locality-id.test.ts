// Seed-side fence: every denuncia scripts/seed-panorama.ts builds carries the
// structural locality FK (L4·1 of the locality plan, 2026-09-08).
//
// THE DEFECT. `welfare_reports.locality_id` (migration 0147) is the id a read
// can join on instead of the display name — the whole point of "a display name
// is never a join key". The panorama seed wrote the name and left the FK NULL on
// every report it built: 2.789 of 2.790 denuncias in the local panorama had a
// name and no id. A read switched to the FK would have sent the denuncias detail
// to zero, and the residual bucket would not catch it, because those rows DO
// have a name. Backfilling alone was no fix either: the next `seed:panorama`
// would write the NULLs again. The cure is the seed; this pins it.
//
// Mechanical on purpose: each welfare row literal in the script — recognised
// by `referenceCode`, which no other row this script builds carries — that
// writes `jurisdictionLocality` must also write `localityId`. The floor keeps
// the check from passing over a script that stopped building rows at all.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SEED = resolve(__dirname, "..", "scripts", "seed-panorama.ts");

/** The object literal around `index`: from its opening `{` to the matching `}`. */
function enclosingObject(source: string, index: number): string {
  let depth = 0;
  let start = index;
  for (; start >= 0; start--) {
    const c = source[start];
    if (c === "}") depth++;
    if (c === "{") {
      if (depth === 0) break;
      depth--;
    }
  }
  depth = 0;
  let end = start;
  for (; end < source.length; end++) {
    const c = source[end];
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, end + 1);
}

function welfareRowLiterals(source: string): string[] {
  const literals: string[] = [];
  for (const m of source.matchAll(/^\s*referenceCode(?::|,)/gm)) {
    literals.push(enclosingObject(source, m.index ?? 0));
  }
  return literals;
}

describe("seed-panorama — denuncias carry locality_id (L4·1)", () => {
  const rows = welfareRowLiterals(readFileSync(SEED, "utf8"));

  it("finds the welfare row builders (non-vacuity floor)", () => {
    // The live-window rows and the history rows.
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("every welfare row that writes a locality NAME also writes its FK", () => {
    const offenders = rows.filter(
      (r) => /\bjurisdictionLocality:/.test(r) && !/\blocalityId:/.test(r),
    );
    expect(offenders).toEqual([]);
  });

  it("resolves the FK through the catalog, never from the synthetic CABA barrio ids", () => {
    for (const r of rows) {
      expect(r).toMatch(/localityId:\s*await resolveLocalityId\(/);
    }
  });
});
