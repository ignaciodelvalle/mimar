// Offline guard for the scope ↔ authorization coherence fence
// (scripts/check-scope-authz.ts). The gate itself needs a database; these
// tests pin the two parts that decide WHAT gets judged and WHETHER it passes —
// the derivation of the scope-gated table set, and the coherence evaluation.
// Both are the parts that would quietly rot: a derivation that silently
// returns nothing is a fence that waves everything through.

import { describe, expect, it } from "vitest";

import {
  type GatedTable,
  LOCAL_HOSTS,
  type PolicyRow,
  SCOPE_LAYER_FILES,
  type TableRlsRow,
  describeTarget,
  evaluateCoherence,
  extractGatedTables,
  importedDbIdents,
  isUnconditionalRead,
  parseSchemaTableNames,
} from "@/scripts/check-scope-authz";

const schema = new Map([
  ["pets", "pets"],
  ["petEvents", "pet_events"],
  ["welfareReports", "welfare_reports"],
]);

const policy = (over: Partial<PolicyRow> = {}): PolicyRow => ({
  table_name: "pets",
  policy_name: "p",
  permissive: "PERMISSIVE",
  roles: ["anon"],
  cmd: "SELECT",
  qual: "(owner_user_id = auth.uid())",
  ...over,
});

const gatedPets: GatedTable[] = [{ ident: "pets", sqlName: "pets", files: ["a.ts"] }];

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

describe("importedDbIdents", () => {
  it("collects table identifiers imported from @/db, across multiple lines", () => {
    const src = `import {\n  pets,\n  petEvents,\n} from "@/db";`;
    expect([...importedDbIdents(src)].sort()).toEqual(["petEvents", "pets"]);
  });

  it("ignores imports from anything that is not a db module", () => {
    const src = `import { petsScopeClause } from "@/lib/metrics";`;
    expect(importedDbIdents(src).size).toBe(0);
  });

  it("ignores type-only imports — a type reference gates no rows", () => {
    const src = `import type { Pet } from "@/db";\nimport { type Row, pets } from "@/db";`;
    expect([...importedDbIdents(src)]).toEqual(["pets"]);
  });

  it("takes the local name of an aliased import", () => {
    const src = `import { pets as petsTable } from "@/db";`;
    expect([...importedDbIdents(src)]).toEqual(["petsTable"]);
  });
});

describe("extractGatedTables", () => {
  it("gates a table that is imported AND referenced", () => {
    const sources = [
      { file: "s.ts", content: `import { pets } from "@/db";\neq(pets.jurisdictionProvince, x);` },
    ];
    expect(extractGatedTables(sources, schema)).toEqual([
      { ident: "pets", sqlName: "pets", files: ["s.ts"] },
    ]);
  });

  it("does NOT gate an imported-but-unused table — an unused import narrows nothing", () => {
    const sources = [{ file: "s.ts", content: `import { pets } from "@/db";\nconst x = 1;` }];
    expect(extractGatedTables(sources, schema)).toEqual([]);
  });

  it("does NOT gate a table named only inside a comment", () => {
    const sources = [
      {
        file: "s.ts",
        content: `import { pets, petEvents } from "@/db";\n// petEvents.id is discussed here\neq(pets.id, x);`,
      },
    ];
    expect(extractGatedTables(sources, schema).map((g) => g.ident)).toEqual(["pets"]);
  });

  it("merges the files that gate the same table", () => {
    const sources = [
      { file: "b.ts", content: `import { pets } from "@/db";\npets.id;` },
      { file: "a.ts", content: `import { pets } from "@/db";\npets.id;` },
    ];
    expect(extractGatedTables(sources, schema)[0].files).toEqual(["a.ts", "b.ts"]);
  });

  it("reports an identifier with no pgTable declaration as unresolved, not as absent", () => {
    const sources = [{ file: "s.ts", content: `import { ghosts } from "@/db";\nghosts.id;` }];
    const gated = extractGatedTables(sources, schema);
    expect(gated).toEqual([{ ident: "ghosts", sqlName: null, files: ["s.ts"] }]);
    expect(evaluateCoherence({ gated, tables: [], policies: [] })).toEqual([
      { kind: "unresolved_ident", ident: "ghosts", files: ["s.ts"] },
    ]);
  });
});

describe("parseSchemaTableNames", () => {
  it("maps a Drizzle export name to its SQL table name", () => {
    const src = `export const custodyDisputes = pgTable(\n  "custody_disputes",\n  {`;
    expect(parseSchemaTableNames(src).get("custodyDisputes")).toBe("custody_disputes");
  });
});

// ---------------------------------------------------------------------------
// The real scope layer — the fence must derive a non-empty set from the
// files as they exist today. This is the test that catches a refactor
// silently emptying the fence.
// ---------------------------------------------------------------------------

describe("the fence's live derivation", () => {
  it("derives the scope-gated tables from the real scope-layer files", async () => {
    const { readFileSync } = await import("node:fs");
    const sources = SCOPE_LAYER_FILES.map((file) => ({
      file,
      content: readFileSync(file, "utf8"),
    }));
    const tables = parseSchemaTableNames(readFileSync("db/schema.ts", "utf8"));
    const names = extractGatedTables(sources, tables).map((g) => g.sqlName);

    expect(names).not.toHaveLength(0);
    // pets and pet_events are the two the staging leak actually exposed; if a
    // refactor ever drops them from the derivation, that is the regression.
    expect(names).toContain("pets");
    expect(names).toContain("pet_events");
    expect(names).not.toContain(null);
  });
});

// ---------------------------------------------------------------------------
// Coherence evaluation
// ---------------------------------------------------------------------------

describe("evaluateCoherence", () => {
  const rls = (over: Partial<TableRlsRow> = {}): TableRlsRow[] => [
    { table_name: "pets", rls_enabled: true, ...over },
  ];

  it("passes when RLS is on and every policy has a real predicate", () => {
    expect(evaluateCoherence({ gated: gatedPets, tables: rls(), policies: [policy()] })).toEqual(
      [],
    );
  });

  it("fails a scope-gated table with RLS DISABLED — the staging failure class", () => {
    const v = evaluateCoherence({
      gated: gatedPets,
      tables: rls({ rls_enabled: false }),
      policies: [],
    });
    expect(v).toEqual([{ kind: "rls_disabled", ident: "pets", sqlName: "pets", files: ["a.ts"] }]);
  });

  it("fails a scope-gated table that does not exist in the database", () => {
    const v = evaluateCoherence({ gated: gatedPets, tables: [], policies: [] });
    expect(v[0].kind).toBe("missing_table");
  });

  it("passes RLS-on with ZERO policies — deny-all is stricter than the app, not a leak", () => {
    expect(evaluateCoherence({ gated: gatedPets, tables: rls(), policies: [] })).toEqual([]);
  });

  it("fails an unconditional read policy that lint:rls would count as coverage", () => {
    const v = evaluateCoherence({
      gated: gatedPets,
      tables: rls(),
      policies: [policy({ policy_name: "wide_open", qual: "true" })],
    });
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("unconditional_read_policy");
  });

  it("ignores policies belonging to a table that is not scope-gated", () => {
    const v = evaluateCoherence({
      gated: gatedPets,
      tables: [...rls(), { table_name: "other", rls_enabled: true }],
      policies: [policy({ table_name: "other", qual: "true" })],
    });
    expect(v).toEqual([]);
  });
});

describe("isUnconditionalRead", () => {
  it.each([
    ["USING (true)", policy({ qual: "true" })],
    ["USING ((true))", policy({ qual: "(true)" })],
    ["no USING clause at all", policy({ qual: null })],
    ["FOR ALL", policy({ cmd: "ALL", qual: "true" })],
    ["role public", policy({ roles: ["public"], qual: "true" })],
    ["role authenticated", policy({ roles: ["authenticated"], qual: "true" })],
  ])("flags %s", (_label, p) => {
    expect(isUnconditionalRead(p)).toBe(true);
  });

  it.each([
    ["a real predicate", policy()],
    ["a RESTRICTIVE policy", policy({ permissive: "RESTRICTIVE", qual: "true" })],
    ["an INSERT policy (qual is always null there)", policy({ cmd: "INSERT", qual: null })],
    ["service_role, which bypasses RLS by design", policy({ roles: ["service_role"], qual: null })],
  ])("does not flag %s", (_label, p) => {
    expect(isUnconditionalRead(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Which database am I looking at? — the skip decision
// ---------------------------------------------------------------------------

describe("describeTarget", () => {
  it("recognises the local Supabase stack", () => {
    const t = describeTarget("postgresql://postgres:postgres@localhost:54322/postgres");
    expect(t.isLocal).toBe(true);
    expect(t.label).toBe("localhost:54322/postgres");
  });

  it("treats a Supabase-hosted database as NOT local — the half-hour trap", () => {
    const t = describeTarget("postgresql://postgres:hunter2@db.abcdefg.supabase.co:5432/postgres");
    expect(t.isLocal).toBe(false);
    expect(t.host).toBe("db.abcdefg.supabase.co");
  });

  it("never echoes the password in the label", () => {
    const t = describeTarget("postgresql://postgres:hunter2@db.abcdefg.supabase.co:5432/postgres");
    expect(t.label).not.toContain("hunter2");
  });

  it("treats an unparseable URL as non-local — the safe assumption", () => {
    const t = describeTarget("not a url");
    expect(t.isLocal).toBe(false);
    expect(t.parseError).not.toBeNull();
  });

  it("keeps 127.0.0.1 local", () => {
    expect(describeTarget("postgres://u:p@127.0.0.1:54322/db").isLocal).toBe(true);
    expect(LOCAL_HOSTS.has("127.0.0.1")).toBe(true);
  });
});
