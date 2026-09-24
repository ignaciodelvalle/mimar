// A test that needs demo furniture must SAY SO. (Plan H.2 — seed contract.)
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// `pnpm db:bootstrap` seeds exactly three things: INDEC localities, CABA
// barrios, and the eight @dim.test accounts (scripts/db-bootstrap.ts step 4).
// That is what a fresh CI database contains, and it is the only state a test
// may assume without declaring it.
//
// Everything else a seed script writes — DIM-DEMO- pets and their event series,
// the DIM-PAMP- flagship, the storyline pets, panorama aggregates, govt
// assignments, alert subscriptions — is DEMO FURNITURE. It exists on one
// long-lived local stack because somebody ran the seed by hand.
//
// seed-demo-scenario.test.ts silently depended on exactly that. The documented
// CI recipe produced 8 red tests, and `pnpm test` green — the Definition of
// Done — quietly rested on undeclared state: a green that proves nothing. The
// fix (PO decision D2) was a declared precondition, NOT a demo step in
// bootstrap: CI has no business building demo furniture to satisfy a test.
//
// This fence stops the next one from being written. Measured when it was added:
// of the 15 test files that mention a demo token, 13 use it as a render fixture
// (no database at all) and 1 creates its own pets — only seed-demo-scenario.ts
// actually depends on the seed, and it declares it. The suite is clean today.
// The fence is here so it stays clean, because the failure mode is invisible:
// nothing goes red, the tests just stop being run without anybody noticing.
//
// …AND THE PRODUCT, NOT JUST CI (cold-start review RA-6, finding 1)
// ---------------------------------------------------------------------------
// The original collector matched `/\.test\.tsx?$/`. It therefore protected CI
// and left the product completely unprotected — and the product had the worse
// instance of the exact same bug: components/landing/landing-content.ts
// hardcoded DIM-PAMP-0001, app/page.tsx rendered a REAL scannable QR at it,
// and /p/[publicToken] calls notFound() when a token does not resolve. That
// token is seeded ONLY by scripts/seed-flagship-pampa.ts, which runs in
// neither db-bootstrap step 4 nor deploy-provision step 8, and
// dim-interno:docs/ops/cutover-playbook.md mandates production carry "no seed pets". The
// front door 404'd by design of the playbook, and no test could see it.
//
// So the second fence below scans every NON-test file that ships — the same
// detector, the same comment stripping, a stricter rule. Shipped code may not
// name a demo-seed token at ALL: a runtime file has no `.skipIf` with which to
// declare a precondition, so the only honest declaration is one the DEPLOYMENT
// makes (an env var) plus a runtime probe that degrades when the row is absent.
// components/landing/demo-pet.ts is what that looks like.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Public-token prefixes that ONLY a demo/storyline seed ever writes. Bootstrap
// creates no pets at all, so any of these in a database-touching test is a
// dependency on furniture CI does not build. Kept as an EXPLICIT list rather
// than a `DIM-` pattern: tests legitimately mint their own tokens at runtime
// via generatePublicToken(), and those must not trip this.
const DEMO_TOKEN_PREFIXES = [
  "DIM-DEMO-",
  "DIM-PAMP-",
  "DIM-ARGO-",
  "DIM-BRUNO-",
  "DIM-LAIK-",
  "DIM-HACH-",
  "DIM-KABO-",
  "DIM-TRRY-",
  "DIM-CUJO-",
  "DIM-ROCO-",
  "DIM-BOBB-",
  "DIM-FRID-",
  "DIM-SNPY-",
  "DIM-ODIE-",
];

/**
 * Strip comments so a token NAMED in prose is not read as a dependency.
 *
 * subject-rights-rpcs.test.ts explains a fixture by referring to
 * "DIM-BRUNO-DEMO" in a line comment while creating its own pets via
 * generatePublicToken(). Without this it would be a permanent false positive,
 * and a fence that cries wolf gets an allowlist entry and then gets ignored.
 *
 * Deliberately simple: block comments, plus lines whose first non-space
 * characters are `//` or `*`. It does not parse, so a token in a trailing
 * comment after code on the same line still counts — that errs toward flagging,
 * which is the safe direction for a fence.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith("//") && !t.startsWith("*");
    })
    .join("\n");
}

interface TestFileFacts {
  file: string;
  /** Demo-seed token prefixes referenced in real code (not in comments). */
  demoTokens: string[];
  /** Imports the Drizzle client, i.e. actually reads the database. */
  touchesDb: boolean;
  /** Declares a precondition via describe.skipIf / it.skipIf. */
  declaresPrecondition: boolean;
}

function readFacts(file: string): TestFileFacts {
  const raw = readFileSync(file, "utf8");
  const code = stripComments(raw);
  return {
    file: file.replace(/\\/g, "/"),
    demoTokens: DEMO_TOKEN_PREFIXES.filter((p) => code.includes(p)),
    touchesDb: /from ["']@\/db["']/.test(code),
    declaresPrecondition: /\.skipIf\s*\(/.test(code),
  };
}

/** Every `.ts(x)` under `root` matching `keep`, skipping node_modules. */
function collectFiles(root: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !keep(entry.name)) continue;
    const dir = entry.parentPath ?? entry.path ?? root;
    if (dir.includes("node_modules")) continue;
    out.push(join(dir, entry.name));
  }
  return out;
}

const isTest = (name: string) => /\.test\.tsx?$/.test(name);
/**
 * Anything inside a `__tests__/` directory, whatever it is called. Test
 * HELPERS do not end in `.test.ts` — `_fake-repo.ts`, fixtures, builders — and
 * before 2026-08-19 they were classified as shipping code, so a fake
 * repository holding a demo token failed this fence for a file that no
 * deployment ever contains. The concept is "code that reaches users"; matching
 * only on the `.test.ts` suffix was narrower than the concept.
 */
const isTestSupport = (name: string) => /[\/]__tests__[\/]/.test(name);
/** Ships to users: `.ts(x)`, not a test or test helper, not an ambient declaration. */
const isRuntime = (name: string) =>
  /\.tsx?$/.test(name) && !isTest(name) && !isTestSupport(name) && !/\.d\.ts$/.test(name);

const TEST_FILES = ["__tests__", "app", "components", "lib"].flatMap((r) =>
  collectFiles(r, isTest),
);

// `scripts/` is deliberately absent: the seeds are where demo tokens BELONG.
// `e2e/` too — a browser test driving the demo stack is a test, not shipped code.
const RUNTIME_FILES = ["app", "components", "lib", "src"].flatMap((r) =>
  collectFiles(r, isRuntime),
);

const FACTS = TEST_FILES.map(readFacts);
const RUNTIME_FACTS = RUNTIME_FILES.map(readFacts);

describe("seed precondition contract (H.2)", () => {
  it("scans a real suite — the fence must not go inert", () => {
    // A fence whose glob silently matches nothing passes forever. Same guard as
    // the vaccine-name fence: prove it is looking at something first.
    expect(TEST_FILES.length).toBeGreaterThan(100);
  });

  it("detects both halves on the known case (seed-demo-scenario.test.ts)", () => {
    // The one file that genuinely depends on the demo seed. If the detector
    // stops seeing EITHER its dependency or its declaration, the fence below is
    // meaningless — it would pass by seeing nothing at all.
    const known = FACTS.find((f) => f.file.endsWith("__tests__/seed-demo-scenario.test.ts"));
    expect(known, "seed-demo-scenario.test.ts not found — did it move?").toBeDefined();
    expect(known?.touchesDb).toBe(true);
    expect(known?.declaresPrecondition).toBe(true);
  });

  it("does not read a token named in a comment as a dependency", () => {
    // subject-rights-rpcs.test.ts mentions DIM-BRUNO-DEMO in prose and mints its
    // own tokens. Pinning it keeps stripComments from being quietly removed.
    const commentOnly = FACTS.find((f) => f.file.endsWith("__tests__/subject-rights-rpcs.test.ts"));
    expect(commentOnly, "subject-rights-rpcs.test.ts not found — did it move?").toBeDefined();
    expect(commentOnly?.touchesDb).toBe(true);
    expect(commentOnly?.demoTokens).toEqual([]);
  });

  it("every database-touching test that needs demo furniture declares it", () => {
    const violations = FACTS.filter(
      (f) => f.touchesDb && f.demoTokens.length > 0 && !f.declaresPrecondition,
    );
    expect(
      violations.map((v) => `${v.file} (uses ${v.demoTokens.join(", ")})`),
      [
        "These tests read the database AND expect pets that only a demo seed creates,",
        "but assume that state instead of declaring it. On a fresh CI database they go",
        "red for the wrong reason; on a stale local one they pass for the wrong reason.",
        "",
        "Fix by declaring the precondition, the way __tests__/seed-demo-scenario.test.ts",
        "does: probe for the artefact, then describe.skipIf(!HAS_...) with the reason in",
        "the SUITE NAME (a console.warn does not print for a fully-skipped file — vitest",
        "buffers and discards it). Do NOT add a demo seed step to db:bootstrap: demo",
        "furniture is not CI's job (PO decision D2).",
        "",
        "Or create the fixture yourself, which is what most tests here already do.",
      ].join("\n"),
    ).toEqual([]);
  });
});

describe("seed precondition contract — shipped code (RA-6 finding 1)", () => {
  it("scans a real runtime surface — the fence must not go inert", () => {
    // Same anti-inertia guard as above. A glob typo here would silently protect
    // nothing, which is precisely the state this fence was added to end.
    expect(RUNTIME_FILES.length).toBeGreaterThan(500);
  });

  it("collects shipped code and excludes tests", () => {
    // Pins both halves of the collector. If it stopped reaching app/page.tsx —
    // the file that rendered the 404-ing hero QR — the fence would pass by
    // seeing nothing; if it swept tests in, every render fixture would go red
    // and the fence would be neutered by an allowlist within the week.
    const files = RUNTIME_FILES.map((f) => f.replace(/\\/g, "/"));
    expect(files.some((f) => f.endsWith("app/page.tsx"))).toBe(true);
    expect(files.some((f) => isTest(f))).toBe(false);
  });

  it("no shipped file hardcodes a pet only a demo seed creates", () => {
    const violations = RUNTIME_FACTS.filter((f) => f.demoTokens.length > 0);
    expect(
      violations.map((v) => `${v.file} (uses ${v.demoTokens.join(", ")})`),
      [
        "These files SHIP. They name a public token that only a demo/storyline seed",
        "writes — and no seed script runs in db-bootstrap step 4 or deploy-provision",
        "step 8, while dim-interno:docs/ops/cutover-playbook.md mandates production be loaded with",
        "'no seed pets, no demo accounts'. So on every honestly-provisioned deployment",
        "that row does not exist and whatever the code does with it (render a QR, link",
        "to /p, look it up) fails or 404s.",
        "",
        "A runtime file cannot declare a precondition the way a test can — there is no",
        "`.skipIf` at 3am in production. The honest shape has two parts, and",
        "components/landing/demo-pet.ts + app/page.tsx are the worked example:",
        "",
        "  1. The DEPLOYMENT declares its demo furniture (an env var), so a deployment",
        "     that has none simply says nothing and gets the degraded path.",
        "  2. The code PROBES the row before promising anything, so a stale or mistyped",
        "     declaration degrades too instead of shipping a broken promise.",
        "",
        "Then make the no-pet path a first-class render, not an error. Do NOT add a demo",
        "seed step to db:bootstrap or deploy-provision: demo furniture is not the",
        "product's job (PO decision D2).",
      ].join("\n"),
    ).toEqual([]);
  });
});
