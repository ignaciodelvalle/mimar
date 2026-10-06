// The build refuses to run without patches/postgres.patch in node_modules
// (scripts/build.mjs -> scripts/lib/postgres-patch-check.mjs). The pools run
// with max_pipeline 0, and upstream postgres.js cannot run a transaction that
// way, so an unpatched deploy would fail every write transaction. This pins the
// check itself, against fixture trees and against this checkout.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PATCHED_FILES,
  POSTGRES_PATCH_MARKER,
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
