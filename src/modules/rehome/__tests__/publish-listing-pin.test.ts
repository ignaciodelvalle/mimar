// Source pin: the rehome listing is PUBLISHED from exactly one place.
// Layer: Unit (reads source, no DB). Verify report S-4 (REQ-13).
//
// REQ-13 says a citizen never self-serves a listing: the ONLY path that puts a
// sponsored pet on the adoption shelf is the sponsoring org's ACCEPT of a
// rehome_request (respond-to-rehome-request.ts step 7). lint:titular-gate
// fences the columns (`adoptionListedAt` is titular-only); this pins the
// WRITER: every call of the repository's `publishListing(` in app/, lib/ and
// src/ is that one use-case. A second caller — a person-path action, a cron, a
// "republish" helper — would be the regression, and it would not show up in
// a column fence because it would go through the same repository.
//
// Same shape as owner-row-lock.test.ts's caller-discovery arm: the set of
// callers is DISCOVERED over comment-stripped source, never hand-listed, and
// the expected set is asserted to be non-empty first so the pin cannot pass
// over an empty scan. Comment-stripped because a comment quoting the call
// (this file's own header, for one) is not a caller.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const MODULE_ROOT = join(__dirname, "..");
const REPO_ROOT = join(MODULE_ROOT, "..", "..", "..");

const SCAN_DIRS = ["app", "lib", "src"];
const REPOSITORY = "src/modules/rehome/infrastructure/rehome-repository.ts";
const PORT = "src/modules/rehome/application/ports.ts";
const ONLY_CALLER = "src/modules/rehome/application/respond-to-rehome-request.ts";
/** A CALL through a repository/port reference: `.publishListing(`. Word-anchored
 *  on the dot so `unpublishListing(` (the withdraw's) and the definition
 *  `async publishListing(` do not match. */
const CALL_RE = /\.publishListing\(/;

/** Block and line comments out, so a quoted call is not a call. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

function walk(dir: string, acc: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__tests__" || name === ".next") continue;
      walk(full, acc);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      acc.push(full);
    }
  }
}

function sources(): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  for (const base of SCAN_DIRS) {
    const files: string[] = [];
    walk(join(REPO_ROOT, base), files);
    for (const abs of files) {
      out.push({
        rel: relative(REPO_ROOT, abs).split(sep).join("/"),
        src: stripComments(readFileSync(abs, "utf8")),
      });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

describe("rehome — publishListing is reached from respond-to-rehome-request.ts and nowhere else (REQ-13)", () => {
  const all = sources();

  it("the scan is not vacuous — it reads the repository, the port and the accept use-case", () => {
    const rels = all.map((f) => f.rel);
    expect(rels).toContain(REPOSITORY);
    expect(rels).toContain(PORT);
    expect(rels).toContain(ONLY_CALLER);
    expect(rels.length).toBeGreaterThan(100);
  });

  it("the repository defines publishListing as a delegation to adoption's listing writer", () => {
    // Design R5: the listing columns have ONE writer, adoption's
    // setListingStatus; rehome reuses it (`action: "publish"`) rather than
    // re-implementing the catalog predicate a fifth time.
    const repo = all.find((f) => f.rel === REPOSITORY)?.src ?? "";
    const start = repo.indexOf("async publishListing(");
    expect(start, "publishListing is a method of RehomeRepository").toBeGreaterThanOrEqual(0);
    const next = repo.indexOf("\n  async ", start + 1);
    const body = repo.slice(start, next === -1 ? undefined : next);
    expect(body).toMatch(/AdoptionRepository\.setListingStatus\(/);
    expect(body).toMatch(/action: "publish"/);
    expect(all.find((f) => f.rel === PORT)?.src).toMatch(/publishListing\(args/);
  });

  it("the accept use-case is the ONE caller", () => {
    const callers = all.filter((f) => CALL_RE.test(f.src)).map((f) => f.rel);
    expect(callers, "the accept transaction calls repo.publishListing(").toContain(ONLY_CALLER);
    expect(callers).toEqual([ONLY_CALLER]);
  });

  it("the call sits inside the accept transaction, after the custody insert and before the request closes", () => {
    const accept = all.find((f) => f.rel === ONLY_CALLER)?.src ?? "";
    const txStart = accept.indexOf("runAnswerTransaction(deps, async (tx) =>");
    expect(txStart, "the accept transaction").toBeGreaterThanOrEqual(0);
    const custodyAt = accept.indexOf("repo.insertShelterCustody(", txStart);
    const publishAt = accept.indexOf("repo.publishListing(", txStart);
    const closeAt = accept.indexOf("repo.closeRequestCase(", publishAt);
    expect(custodyAt).toBeGreaterThan(txStart);
    expect(publishAt).toBeGreaterThan(custodyAt);
    expect(closeAt).toBeGreaterThan(publishAt);
  });
});
