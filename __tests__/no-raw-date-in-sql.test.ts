// WP2 / P1 — repo guard: no raw JS Date interpolated into a sql`` fragment.
//
// Interpolating a JS Date directly into a Drizzle sql`` template crashes
// postgres-js (prepare:false) with ERR_INVALID_ARG_TYPE ("Received an instance
// of Date") — the exact bug that took down /admin/programa, /censo and /poblacion
// (A2). The fix everywhere is to bind `.toISOString()`; the >=/<= comparison
// casts the ISO string to timestamptz.
//
// SCANNED PATTERN
// ---------------
// The recurring offenders are period/window `.since`/`.until` (AnalyticsPeriod,
// ExportPeriod, the {since, until} window arg) and `new Date(...)`. Drizzle
// COLUMN references interpolated into sql`` are SAFE (the driver serialises them
// as identifiers, not values) and never end in `.since`/`.until` — they are
// createdAt/occurredAt/endedAt/startedAt — so this guard does not flag them.
//
// Typed Drizzle helpers (gte/lte/eq) bind a Date correctly and are NOT affected;
// only RAW sql`` interpolation is dangerous, and raw interpolation is the only
// place `${...}` syntax appears for these expressions.
//
// If this test fails: a `.since`/`.until`/`new Date` value is being interpolated
// raw into SQL. Append `.toISOString()` to it.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["lib", "src"];

// A ${...} interpolation that pulls in a JS Date value (period/window date field
// or `new Date`). Single-line — every real occurrence in this repo is one line.
const DANGEROUS = /\$\{[^}]*(?:\.(?:since|until)\b|\bnew Date\b)[^}]*\}/g;

function tsFiles(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return [];
  }
  return entries
    .filter(
      (p) =>
        p.endsWith(".ts") &&
        !p.endsWith(".d.ts") &&
        !p.includes("__tests__") &&
        !p.endsWith(".test.ts"),
    )
    .map((p) => join(root, p));
}

describe("no raw JS Date interpolated into sql`` (WP2/P1 guard)", () => {
  it("every .since/.until/new Date interpolation in lib/ and src/ is .toISOString()'d", () => {
    const violations: string[] = [];

    for (const root of ROOTS) {
      for (const file of tsFiles(root)) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          const matches = line.match(DANGEROUS);
          if (!matches) return;
          for (const m of matches) {
            // Skip interpolations that resolve to a primitive, not a Date:
            //   .toISOString() (string) or any .getXxx() getter (number),
            //   e.g. new Date(now).getUTCFullYear() / period.since.getTime().
            if (m.includes("toISOString") || /\.get[A-Z]/.test(m)) continue;
            violations.push(`${file.replace(/\\/g, "/")}:${i + 1}  ${m.trim()}`);
          }
        });
      }
    }

    expect(
      violations,
      `Raw JS Date interpolated into a sql\`\` fragment (bind .toISOString() instead):\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
