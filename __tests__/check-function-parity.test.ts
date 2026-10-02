// check-function-parity — the pure scanning/normalization logic, tested with
// fixture strings (no DB). The live comparison rides db:doctor section D.

import { describe, expect, it } from "vitest";

import {
  collectRepoFunctions,
  extractFunctionBodies,
  extractFunctionDrops,
  identityArgTypes,
  normalizeBody,
} from "@/scripts/check-function-parity";

const FN = (name: string, body: string, tag = "$$", args = "") => `
CREATE OR REPLACE FUNCTION public.${name}(${args})
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS ${tag}${body}${tag};
`;

describe("extractFunctionBodies", () => {
  it("extracts the dollar-quoted body verbatim", () => {
    const out = extractFunctionBodies("0001_x.sql", FN("f_one", "\nBEGIN RETURN NEW; END;\n"));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("f_one");
    expect(out[0].body).toBe("\nBEGIN RETURN NEW; END;\n");
  });

  it("supports named dollar tags and multiple definitions per file", () => {
    const sql = FN("f_a", "\nBEGIN RETURN NEW; END;\n", "$fn$") + FN("f_b", "\nSELECT 1;\n");
    const out = extractFunctionBodies("0002_x.sql", sql);
    expect(out.map((f) => f.name)).toEqual(["f_a", "f_b"]);
  });

  it("skips a malformed definition (unterminated body) instead of guessing", () => {
    const sql = "CREATE FUNCTION public.broken() RETURNS void AS $$ BEGIN -- no close";
    expect(extractFunctionBodies("0003_x.sql", sql)).toEqual([]);
  });
});

describe("collectRepoFunctions — authority rules", () => {
  it("last defining migration wins across sorted files", () => {
    const map = collectRepoFunctions(
      [
        { name: "0001_a.sql", contents: FN("f", "\nold\n") },
        { name: "0009_b.sql", contents: FN("f", "\nnew\n") },
      ],
      null,
    );
    expect(map.get("f()")?.source).toBe("0009_b.sql");
    expect(normalizeBody(map.get("f()")?.body ?? "")).toBe("new");
  });

  it("db/triggers.sql OVERRIDES migrations for the functions it defines", () => {
    // Measured reality (2026-08-16): enforce_pet_events_append_only's live
    // body matches triggers.sql, not its older migration snapshot — the
    // hand-applied file is the source of truth for its functions.
    const map = collectRepoFunctions(
      [{ name: "0127_snapshot.sql", contents: FN("f_trig", "\nmigration snapshot\n") }],
      FN("f_trig", "\nhand-applied truth\n"),
    );
    expect(map.get("f_trig()")?.source).toBe("db/triggers.sql");
  });

  it("migration-only functions keep their migration source when triggers.sql exists", () => {
    const map = collectRepoFunctions(
      [{ name: "0182_x.sql", contents: FN("f_mig", "\nbody\n") }],
      FN("f_other", "\nother\n"),
    );
    expect(map.get("f_mig()")?.source).toBe("0182_x.sql");
    expect(map.get("f_other()")?.source).toBe("db/triggers.sql");
  });
});

describe("collectRepoFunctions — DROP FUNCTION tombstones", () => {
  // CI run 36560138481: 0271 drops two functions 0269 created, and the scanner
  // — CREATE-only — demanded both exist on a freshly replayed database.
  it("a later migration's DROP leaves a tombstone, not the old body", () => {
    const map = collectRepoFunctions(
      [
        { name: "0269_a.sql", contents: FN("f_gone", "\nbody\n", "$$", "p_row public.audit_log") },
        {
          name: "0271_b.sql",
          contents: "DROP FUNCTION IF EXISTS public.f_gone(public.audit_log);",
        },
      ],
      null,
    );
    // The create spells the arg with a parameter name, the drop without one:
    // both are the overload f_gone(audit_log).
    expect(map.get("f_gone(audit_log)")).toMatchObject({ dropped: true, source: "0271_b.sql" });
    expect(map.size).toBe(1);
  });

  it("drop-then-recreate in one file ends live; recreate-then-drop ends dropped", () => {
    const map = collectRepoFunctions(
      [
        { name: "0001_a.sql", contents: `DROP FUNCTION f_back();\n${FN("f_back", "\nnew\n")}` },
        { name: "0002_b.sql", contents: `${FN("f_out", "\nx\n")}\nDROP FUNCTION f_out();` },
      ],
      null,
    );
    expect(map.get("f_back()")?.dropped).toBeUndefined();
    expect(normalizeBody(map.get("f_back()")?.body ?? "")).toBe("new");
    expect(map.get("f_out()")?.dropped).toBe(true);
  });

  it("names every target of a multi-function DROP, splitting on top-level commas only", () => {
    expect(
      extractFunctionDrops(
        "DROP FUNCTION IF EXISTS public.a(numeric(10,2), text), b(uuid) CASCADE;",
      ).map((d) => d.name),
    ).toEqual(["a", "b"]);
  });
});

describe("overloads — keyed by name + identity argument types", () => {
  // Doctor red on staging since 2026-09-27: jurisdiction_admin_province has a
  // (uuid) overload and a () wrapper, both byte-identical to 0268 live. Keyed
  // by name, the repo side kept the last CREATE (the wrapper) and the live
  // side whichever overload pg_proc returned last — a nondeterministic DIFFERS.
  const OVERLOADS = `
CREATE OR REPLACE FUNCTION public.jurisdiction_admin_province(p_user uuid)
RETURNS text LANGUAGE sql STABLE
AS $$ select 'with-arg' $$;

CREATE OR REPLACE FUNCTION public.jurisdiction_admin_province()
RETURNS text LANGUAGE sql STABLE
AS $$ select public.jurisdiction_admin_province((select auth.uid())) $$;
`;

  it("keeps both overloads of one name, each with its own body", () => {
    const map = collectRepoFunctions([{ name: "0268_x.sql", contents: OVERLOADS }], null);
    expect([...map.keys()].sort()).toEqual([
      "jurisdiction_admin_province()",
      "jurisdiction_admin_province(uuid)",
    ]);
    expect(normalizeBody(map.get("jurisdiction_admin_province(uuid)")?.body ?? "")).toBe(
      "select 'with-arg'",
    );
    expect(normalizeBody(map.get("jurisdiction_admin_province()")?.body ?? "")).toContain(
      "auth.uid()",
    );
  });

  it("a later CREATE replaces only the overload with the same identity", () => {
    const map = collectRepoFunctions(
      [
        { name: "0268_x.sql", contents: OVERLOADS },
        {
          name: "0270_y.sql",
          contents: FN("jurisdiction_admin_province", "\nnew\n", "$$", "x uuid"),
        },
      ],
      null,
    );
    expect(map.get("jurisdiction_admin_province(uuid)")?.source).toBe("0270_y.sql");
    expect(map.get("jurisdiction_admin_province()")?.source).toBe("0268_x.sql");
  });

  it("a DROP with an argument list tombstones that overload only", () => {
    const map = collectRepoFunctions(
      [
        { name: "0268_x.sql", contents: OVERLOADS },
        { name: "0280_z.sql", contents: "DROP FUNCTION public.jurisdiction_admin_province();" },
      ],
      null,
    );
    expect(map.get("jurisdiction_admin_province()")?.dropped).toBe(true);
    expect(map.get("jurisdiction_admin_province(uuid)")?.dropped).toBeUndefined();
  });

  it("a DROP without an argument list tombstones every known overload of the name", () => {
    const map = collectRepoFunctions(
      [
        { name: "0268_x.sql", contents: OVERLOADS },
        { name: "0280_z.sql", contents: "DROP FUNCTION IF EXISTS jurisdiction_admin_province;" },
        { name: "0281_w.sql", contents: "DROP FUNCTION IF EXISTS never_created;" },
      ],
      null,
    );
    expect(map.get("jurisdiction_admin_province()")?.dropped).toBe(true);
    expect(map.get("jurisdiction_admin_province(uuid)")?.dropped).toBe(true);
    // Nothing known to pin it to: the whole name must be absent live.
    expect(map.get("never_created")).toMatchObject({ dropped: true, anyOverload: true });
  });

  it("reads a lowercase `as $$` body (the repo writes both cases)", () => {
    const sql = `create or replace function public.can_read_case(p_case_id uuid, p_user_id uuid)
  returns boolean language plpgsql
as $$ begin return true; end; $$;`;
    const out = extractFunctionBodies("0259_x.sql", sql);
    expect(out.map((f) => f.key)).toEqual(["can_read_case(uuid, uuid)"]);
    expect(normalizeBody(out[0].body)).toBe("begin return true; end;");
  });

  it("names the overload a multi-target DROP points at", () => {
    expect(
      extractFunctionDrops("DROP FUNCTION IF EXISTS public.a(numeric(10,2), text), b CASCADE;").map(
        (d) => d.key,
      ),
    ).toEqual(["a(numeric, text)", null]);
  });
});

describe("identityArgTypes — Postgres's oidvectortypes spelling", () => {
  it.each([
    ["", []],
    ["uuid", ["uuid"]],
    ["p_user uuid", ["uuid"]],
    ["p_user uuid DEFAULT NULL", ["uuid"]],
    ["p_limit integer = 100", ["integer"]],
    [
      "p_before_at timestamptz DEFAULT now(), p_before_id uuid",
      ["timestamp with time zone", "uuid"],
    ],
    ["timestamp with time zone, int", ["timestamp with time zone", "integer"]],
    ["p_at timestamp with time zone", ["timestamp with time zone"]],
    ["p_row public.audit_log", ["audit_log"]],
    ["IN p_a text, OUT p_b text, INOUT p_c bool", ["text", "boolean"]],
    ["VARIADIC p_ids uuid[]", ["uuid[]"]],
    ["p_amount numeric(10,2), p_name varchar(20)", ["numeric", "character varying"]],
    ['"p_quoted" "text"', ["text"]],
  ])("%j → %j", (args, expected) => {
    expect(identityArgTypes(args)).toEqual(expected);
  });
});

describe("normalizeBody", () => {
  it("neutralizes line endings and edge whitespace, nothing else", () => {
    expect(normalizeBody("\r\nBEGIN\r\n  x;\r\nEND;\r\n")).toBe("BEGIN\n  x;\nEND;");
    // Interior changes are REAL differences — never normalized away.
    expect(normalizeBody("BEGIN x; END;")).not.toBe(normalizeBody("BEGIN  x; END;"));
  });
});
