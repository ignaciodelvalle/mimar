// Guard: projections must never cast JSONB-extracted payload text straight
// to uuid.
//
// The event log is append-only and heterogeneous by design — historic rows
// may carry payloads that predate (or violate) the current Zod schema, and
// they stay forever. A bare `(payload->>'key')::uuid` in a read query turns
// one malformed row into a page-level crash (Postgres 22P02 aborts the whole
// query — this took down /org/[orgToken]/adopciones, error digest 372514334).
// Use `safePayloadUuid` from lib/infra/sql-fragments.ts instead: it guards
// the cast behind a CASE so non-uuid values become NULL (= no join match).

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const SCANNED_DIRS = ["app", "lib", "src"];
const SOURCE_EXT = /\.(ts|tsx)$/;
// `->> 'key' )::uuid` with flexible whitespace, e.g. (s.payload->>'x')::uuid
const UNGUARDED_CAST = /->>\s*'[^']*'\s*\)\s*::uuid/;

function walk(dir: string, hits: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(path, hits);
    } else if (SOURCE_EXT.test(entry.name) && UNGUARDED_CAST.test(readFileSync(path, "utf8"))) {
      hits.push(relative(ROOT, path));
    }
  }
}

describe("projection payload uuid casts", () => {
  it("no source file casts payload->> text to uuid without safePayloadUuid", () => {
    const hits: string[] = [];
    for (const dir of SCANNED_DIRS) {
      walk(join(ROOT, dir), hits);
    }
    expect(hits).toEqual([]);
  });
});
