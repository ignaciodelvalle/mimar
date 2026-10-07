// The build refuses to run without patches/postgres.patch in node_modules
// (scripts/build.mjs -> scripts/lib/postgres-patch-check.mjs). The pools run
// with max_pipeline 0, and upstream postgres.js cannot run a transaction that
// way, so an unpatched deploy would fail every write transaction. This pins the
// check itself, against fixture trees and against this checkout.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PATCHED_FILES,
  POSTGRES_PATCH_MARKER,
  TRACED_CONNECTION,
  UPSTREAM_EXECUTE_SHAPE,
  builtPostgresMessage,
  builtPostgresProblems,
  unpatchedPostgresFiles,
  unpatchedPostgresMessage,
} from "@/scripts/lib/postgres-patch-check.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pg-patch-check-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, "node_modules", "postgres", rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

const PATCHED = `function execute(q) {\n  ${POSTGRES_PATCH_MARKER}@3.4.9): run onexecute\n}`;
const UPSTREAM = "function execute(q) {\n  return write(toBuffer(q))\n}";

describe("postgres patch check", () => {
  it("checks both the ESM and the CJS build", () => {
    expect(PATCHED_FILES).toEqual(["src/connection.js", "cjs/src/connection.js"]);
  });

  it("passes when both builds carry the marker", () => {
    const root = fixture({ "src/connection.js": PATCHED, "cjs/src/connection.js": PATCHED });
    expect(unpatchedPostgresFiles(root)).toEqual([]);
  });

  it("names every build that lacks the marker", () => {
    const root = fixture({ "src/connection.js": PATCHED, "cjs/src/connection.js": UPSTREAM });
    expect(unpatchedPostgresFiles(root)).toEqual(["cjs/src/connection.js"]);
  });

  it("treats a missing file as unpatched", () => {
    const root = fixture({});
    expect(unpatchedPostgresFiles(root)).toEqual(PATCHED_FILES);
  });

  it("says what to do, including the Vercel build cache", () => {
    const message = unpatchedPostgresMessage(["src/connection.js"]);
    expect(message).toContain("node_modules/postgres/src/connection.js");
    expect(message).toContain("UNSAFE_TRANSACTION");
    expect(message).toContain("WITHOUT the build cache");
  });

  it("finds the patch applied in this checkout", () => {
    expect(unpatchedPostgresFiles(process.cwd())).toEqual([]);
  });
});

// AFTER the build (A5e). A stale .next once shipped a bundled, UNPATCHED copy
// while the node_modules check above passed. postgres is now external
// (next.config.ts serverExternalPackages), and scripts/build.mjs judges the
// output itself: no upstream execute() in any server chunk, the marker in
// every traced connection.js, and at least one copy found.
describe("post-build postgres check", () => {
  function nextDir(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "pg-built-check-"));
    roots.push(root);
    for (const [rel, body] of Object.entries(files)) {
      const path = join(root, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body);
    }
    return join(root, ".next");
  }

  const STORE = "node_modules/.pnpm/postgres@3.4.9_patch_hash=abc/node_modules/postgres";
  // What webpack's minifier made of each version (the upstream line is
  // verbatim from a real .next/server chunk, 2026-10-07).
  const MIN_UPSTREAM =
    "(a))&&!a.describeFirst&&!a.cursorFn&&B.length<x&&(!a.options.onexecute||a.options.onexecute(aF))}catch(a){}";
  const MIN_PATCHED =
    "let r=aI(a)&&!a.describeFirst&&!a.cursorFn&&B.length<x;return a.options.onexecute&&a.options.onexecute(aF),r&&!a.options.onexecute}catch(a){}";

  function trace(entries: string[]): string {
    return JSON.stringify({ version: 1, files: entries });
  }

  it("reads the upstream shape off the real patch: the removed line has it, no added line does", () => {
    const patch = readFileSync(join(process.cwd(), "patches", "postgres.patch"), "utf8");
    const lines = patch.split(/\r?\n/);
    const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(removed.some((l) => UPSTREAM_EXECUTE_SHAPE.test(l))).toBe(true);
    expect(added.filter((l) => UPSTREAM_EXECUTE_SHAPE.test(l))).toEqual([]);
    expect(UPSTREAM_EXECUTE_SHAPE.test(MIN_UPSTREAM)).toBe(true);
    expect(UPSTREAM_EXECUTE_SHAPE.test(MIN_PATCHED)).toBe(false);
  });

  it("fails on a bundled upstream copy, even with a patched node_modules beside it", () => {
    const dir = nextDir({
      ".next/server/chunks/27968.js": MIN_UPSTREAM,
      [`${STORE}/src/connection.js`]: `${POSTGRES_PATCH_MARKER}@3.4.9)`,
      ".next/server/app/page.js.nft.json": trace([`../../../${STORE}/src/connection.js`]),
    });
    const { problems, bundled } = builtPostgresProblems(dir);
    expect(bundled).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("bundled UNPATCHED");
    expect(problems[0]).toContain("27968.js");
  });

  it("passes a bundled copy that carries the patched code", () => {
    const dir = nextDir({ ".next/server/chunks/1.js": MIN_PATCHED });
    expect(builtPostgresProblems(dir)).toEqual({ problems: [], bundled: 1, traced: 0 });
  });

  it("passes an external postgres whose traced files carry the marker", () => {
    const dir = nextDir({
      [`${STORE}/src/connection.js`]: `${POSTGRES_PATCH_MARKER}@3.4.9)`,
      [`${STORE}/cjs/src/connection.js`]: `${POSTGRES_PATCH_MARKER}@3.4.9)`,
      ".next/server/app/a/page.js.nft.json": trace([
        `../../../../${STORE}/src/connection.js`,
        "../../../../node_modules/next/dist/server/next.js",
      ]),
      ".next/next-server.js.nft.json": trace([`../${STORE}/cjs/src/connection.js`]),
    });
    expect(builtPostgresProblems(dir)).toEqual({ problems: [], bundled: 0, traced: 2 });
  });

  it("fails on a traced connection.js without the marker, or one that is missing", () => {
    const dir = nextDir({
      "node_modules/postgres/src/connection.js": "function execute(q) {}",
      ".next/server/app/page.js.nft.json": trace([
        "../../../node_modules/postgres/src/connection.js",
        "../../../node_modules/postgres/cjs/src/connection.js",
      ]),
    });
    const { problems } = builtPostgresProblems(dir);
    expect(problems.some((p) => p.startsWith("traced UNPATCHED"))).toBe(true);
    expect(problems.some((p) => p.startsWith("traced postgres.js file is missing"))).toBe(true);
  });

  it("refuses to pass vacuously when no copy is found anywhere", () => {
    const dir = nextDir({ ".next/server/app/page.js": "export default 1" });
    const { problems } = builtPostgresProblems(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("proved nothing");
  });

  it("does not read the webpack cache as output", () => {
    const dir = nextDir({
      ".next/server/chunks/1.js": MIN_PATCHED,
      ".next/cache/webpack/server-production/0.js": MIN_UPSTREAM,
    });
    expect(builtPostgresProblems(dir).problems).toEqual([]);
  });

  it("recognises flat and pnpm-store trace paths, and nothing else", () => {
    expect(TRACED_CONNECTION.test("../node_modules/postgres/src/connection.js")).toBe(true);
    expect(TRACED_CONNECTION.test(`../${STORE}/cjs/src/connection.js`)).toBe(true);
    expect(TRACED_CONNECTION.test("../node_modules/postgres/cf/src/connection.js")).toBe(false);
    expect(TRACED_CONNECTION.test("../node_modules/not-postgres/src/connection.js")).toBe(false);
  });

  it("says to rebuild without the cache", () => {
    const message = builtPostgresMessage(["bundled UNPATCHED postgres.js in x.js"]);
    expect(message).toContain("x.js");
    expect(message).toContain("WITHOUT the build cache");
  });
});
