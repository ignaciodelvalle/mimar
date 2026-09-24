// check-function-parity — the pure scanning/normalization logic, tested with
// fixture strings (no DB). The live comparison rides db:doctor section D.

import { describe, expect, it } from "vitest";

import {
  collectRepoFunctions,
  extractFunctionBodies,
  normalizeBody,
} from "@/scripts/check-function-parity";

const FN = (name: string, body: string, tag = "$$") => `
CREATE OR REPLACE FUNCTION public.${name}()
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
    expect(map.get("f")?.source).toBe("0009_b.sql");
    expect(normalizeBody(map.get("f")?.body ?? "")).toBe("new");
  });

  it("db/triggers.sql OVERRIDES migrations for the functions it defines", () => {
    // Measured reality (2026-08-16): enforce_pet_events_append_only's live
    // body matches triggers.sql, not its older migration snapshot — the
    // hand-applied file is the source of truth for its functions.
    const map = collectRepoFunctions(
      [{ name: "0127_snapshot.sql", contents: FN("f_trig", "\nmigration snapshot\n") }],
      FN("f_trig", "\nhand-applied truth\n"),
    );
    expect(map.get("f_trig")?.source).toBe("db/triggers.sql");
  });

  it("migration-only functions keep their migration source when triggers.sql exists", () => {
    const map = collectRepoFunctions(
      [{ name: "0182_x.sql", contents: FN("f_mig", "\nbody\n") }],
      FN("f_other", "\nother\n"),
    );
    expect(map.get("f_mig")?.source).toBe("0182_x.sql");
    expect(map.get("f_other")?.source).toBe("db/triggers.sql");
  });
});

describe("normalizeBody", () => {
  it("neutralizes line endings and edge whitespace, nothing else", () => {
    expect(normalizeBody("\r\nBEGIN\r\n  x;\r\nEND;\r\n")).toBe("BEGIN\n  x;\nEND;");
    // Interior changes are REAL differences — never normalized away.
    expect(normalizeBody("BEGIN x; END;")).not.toBe(normalizeBody("BEGIN  x; END;"));
  });
});
