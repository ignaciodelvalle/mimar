// Fence: one province name ↔ ISO code map, in TypeScript and in SQL.
//
// localidades-por-id B2 (audit R12). `PROVINCES` (packages/contract) is THE
// list. SQL reads it through `public.ar_province_code` / `public.ar_province_name`
// (migration 0249); this file calls both for every row and compares. The lint
// half (scripts/check-province-map-single-source.ts) refuses a hand-written
// copy anywhere else; its detector is pinned here on fixtures, and its verdict
// over the repository must be clean.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { PROVINCES } from "@/lib/reference/ar-provincias";

import {
  MAP_THRESHOLD,
  countPairLines,
  evaluate,
  readSources,
} from "../scripts/check-province-map-single-source";

describe("the SQL functions are the list", () => {
  it("ar_province_code answers every canonical name with its code", async () => {
    const rows = (await db.execute(sql`
      select v.name, public.ar_province_code(v.name) as code
        from (values ${sql.join(
          PROVINCES.map((p) => sql`(${p.name})`),
          sql`, `,
        )}) as v(name)
    `)) as unknown as Array<{ name: string; code: string | null }>;
    expect(rows).toHaveLength(24);
    expect(Object.fromEntries(rows.map((r) => [r.name, r.code]))).toEqual(
      Object.fromEntries(PROVINCES.map((p) => [p.name, p.code])),
    );
  });

  it("ar_province_name answers every code with its canonical name", async () => {
    const rows = (await db.execute(sql`
      select v.code, public.ar_province_name(v.code) as name
        from (values ${sql.join(
          PROVINCES.map((p) => sql`(${p.code})`),
          sql`, `,
        )}) as v(code)
    `)) as unknown as Array<{ code: string; name: string | null }>;
    expect(Object.fromEntries(rows.map((r) => [r.code, r.name]))).toEqual(
      Object.fromEntries(PROVINCES.map((p) => [p.code, p.name])),
    );
  });

  it("an alias or a long form is not a stored name: NULL, never a guess", async () => {
    const rows = (await db.execute(sql`
      select public.ar_province_code('Ciudad Autónoma de Buenos Aires') as long_form,
             public.ar_province_code('cordoba') as folded,
             public.ar_province_code(null) as nothing,
             public.ar_province_name('AR-Ñ') as bad_code
    `)) as unknown as Array<Record<string, string | null>>;
    expect(rows[0]).toEqual({ long_form: null, folded: null, nothing: null, bad_code: null });
  });
});

describe("the detector", () => {
  it("counts a name→code map, one pair line each", () => {
    const map = `export const M = {\n  "Buenos Aires": "AR-B",\n  CABA: "AR-C",\n  Córdoba: "AR-X",\n};`;
    expect(countPairLines(map)).toBe(3);
  });

  it("counts SQL pairs and ignores them inside comments", () => {
    const body = "VALUES ('Chaco', 'AR-H'),\n-- ('Salta', 'AR-A')\n('Jujuy', 'AR-Y')";
    expect(countPairLines(body, true)).toBe(2);
  });

  it("does not count a code or a name alone, nor a pair in a // comment", () => {
    const src = `const code = "AR-X";\nconst name = "Córdoba";\nfoo("AR-B"); // Buenos Aires`;
    expect(countPairLines(src)).toBe(0);
  });

  it("flags a new map and names the file", () => {
    const pairs = Array.from(
      { length: MAP_THRESHOLD },
      (_, i) => `  "${PROVINCES[i]?.name}": "${PROVINCES[i]?.code}",`,
    );
    const { violations } = evaluate([
      { file: "lib/new-copy.ts", source: `const M = {\n${pairs.join("\n")}\n};` },
    ]);
    expect(violations).toContainEqual({ file: "lib/new-copy.ts", lines: MAP_THRESHOLD, frozen: 0 });
  });
});

describe("the repository", () => {
  it("has no province map outside the frozen list", () => {
    const { violations } = evaluate(readSources());
    expect(violations).toEqual([]);
  });
});
