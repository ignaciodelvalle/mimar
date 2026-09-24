// "use server" export-shape fence.
//
// THE DEFECT THIS EXISTS FOR
// ---------------------------------------------------------------------------
// Next validates EVERY export of a module carrying the "use server" directive
// and rejects anything that is not an async function:
//
//     Error: A "use server" file can only export async functions, found object.
//
// It is not a build error. `tsc --noEmit` is happy, biome is happy, the bundle
// is produced — and then the module throws AT LOAD, in production, taking down
// every page whose import graph reaches it. Measured in Vercel runtime
// telemetry for deployment dpl_HhM1q7Vx2bogqPPhpxntYgyfCnuL (commit bb8dece4c):
// a hard 500 on /org/[orgToken]/mascotas/[publicToken], from one
//
//     export const ADOPTER_DNI_CHECK_LIMITS = { maxPerMinute: 8, … } as const;
//
// sitting in src/modules/adoption/actions.ts. A rate-limit ceiling with an
// excellent reason to be shared (the test asserts against the same constant the
// action enforces) and no reason at all to be in that file. It moved to
// src/modules/adoption/domain/dni-check-policy.ts; nothing else changed.
//
// WHY A FENCE AND NOT A NOTE
// ---------------------------------------------------------------------------
// The repo had already written the rule down, in commit 16d46c744:
//
//   LOS HELPERS COMPARTIDOS VAN A UN ARCHIVO SIN DIRECTIVA, A PROPOSITO. Next
//   convierte CADA export de un modulo "use server" en un endpoint alcanzable
//   desde el cliente, asi que un tipo y dos helpers internos no pueden vivir en
//   uno.
//
// and built src/modules/events/action-support.ts to honour it — and the very
// same week a sibling module shipped the exact violation the note forbids, to
// production, on a real route. A doctrine with no enforcement is a preference.
// This class is invisible to every instrument the repo already runs: the type
// checker (the code is well typed), the linter (the code is well formed), and
// the unit suite (the test imported the constant DIRECTLY, so it never loaded
// the module the way Next does). Only a fence that reads the directive and then
// reads the exports can see it.
//
// WHAT IS ALLOWED
// ---------------------------------------------------------------------------
//   · `export async function f(…)`                        — the only shape Next wants
//   · `export const f = async (…) => …` / `async function` — same thing, expression form
//   · `export type` / `export interface` / `export type { … }` — ERASED at build,
//     so they never reach the runtime validator. Type-only exports are fine and
//     action-support.ts's EventFormState depends on that being true.
//
// Everything else is a violation, INCLUDING shapes that are merely unprovable
// here: `export { helper }`, `export const f = someFn`, `export * from …`. This
// fence refuses to guess. A re-export list hides whether the binding is async
// behind a module resolution step, and "probably fine" is the reasoning that
// produced the 500 — the fix in every case is the same one the repo already
// chose, which is to move the export to a sibling WITHOUT the directive.
//
// A SECOND RULE, about NAMES rather than shapes (A01-4): a runtime export named
// like a test helper (`__…` or `…ForTests`) is refused even when it is a legal
// async function, because in this file it is a production endpoint. See
// withTestOnlyRule().
//
// KNOWN GAP, stated rather than hidden: a FUNCTION-scoped `"use server"` inside
// a component or page is also a server action, but it is a closure rather than a
// module export, so there is nothing here to classify. Same gap
// check-authz-guards.ts states for the same reason.
//
// Run:  pnpm tsx scripts/check-server-action-exports.ts   (or: pnpm lint:server-exports)
// Exits 0 when every export of every "use server" module is an async function
//   or a type.
// Exits 1 naming each offending export with file:line and its shape.

import { globSync, readFileSync } from "node:fs";

import { stripComments } from "./lib/strip-comments.mjs";

// ---------------------------------------------------------------------------
// Discovery — by CONTENT, not by filename
// ---------------------------------------------------------------------------
//
// Same definition check-authz-guards.ts settled on after its own globs turned
// out to be "a naming convention masquerading as a security boundary": a module
// counts when its FIRST statement, after comments, is the directive — exactly
// what the bundler looks at. Deliberately NOT imported from there:
// listActionFiles() unions in two LEGACY filename globs whose members need not
// carry the directive at all, and this fence must judge only files Next will
// actually validate. A false positive here is a fence telling someone to move a
// constant out of a file that never had the problem.
const SOURCE_GLOBS = ["app/**/*.ts", "app/**/*.tsx", "src/**/*.ts", "src/**/*.tsx"];

// ---------------------------------------------------------------------------
// Anti-vacuity floors — IN THE SCRIPT, not only in the test
// ---------------------------------------------------------------------------
//
// The failure mode this fence must never have is the one it exists to catch:
// passing silently. A glob that stops matching yields an empty module list, an
// empty list yields no offenders, and no offenders prints a ✓. `pnpm
// lint:server-exports` runs in `verify`, a lane with no test runner, so the
// floors have to live here — the lesson check-action-redirect.ts wrote into its
// own header after its globs missed `action.ts` and it reported "0 baselined
// call(s) across 0 file(s)" over three live redirects.
//
// Measured 2026-08-23: 91 "use server" modules carrying 496 top-level exports,
// 298 of them runtime (the rest erased types), of which exactly ONE was a
// violation — the constant above. Every floor sits well below its measurement,
// so modules can be split or retired without a false alarm, and far above zero.
//
// The triage that opened this ticket counted 111 modules with a quick `rg`. The
// difference is not a gap in the scan: 133 files in the repo MENTION "use
// server", most of them in comments saying a file deliberately has no directive
// (src/modules/events/action-support.ts, app/actions/bulk-vaccinate-types.ts,
// src/modules/organizations/actions.internal.ts, and a dozen more). Only 91 have
// it as their first statement, which is the only thing Next validates. Recorded
// here because the next person to sanity-check this floor with a grep will get
// 133 and think the fence lost twenty files.

/** Modules whose first statement is the "use server" directive. */
export const MIN_SERVER_ACTION_MODULES = 70;
/** Top-level exports classified across them — a module list that resolves but
 *  whose exports stop parsing is the same silent pass one level down. */
export const MIN_CLASSIFIED_EXPORTS = 380;
/** Of those, the RUNTIME ones — the only exports that can offend. Separate from
 *  the total because a classifier that started reading every export as an erased
 *  type would keep the total healthy while judging nothing. */
export const MIN_RUNTIME_EXPORTS = 220;

/** True when the module's first statement is the "use server" directive. */
export function isServerActionModule(src: string): boolean {
  return /^(["'])use server\1/.test(stripComments(src).trimStart());
}

function isScannable(relPath: string): boolean {
  if (relPath.includes("__tests__")) return false;
  if (/\.test\.[jt]sx?$/.test(relPath)) return false;
  return !relPath.endsWith(".d.ts");
}

/**
 * Every `"use server"` module in the repo, as forward-slash paths. Exported so a
 * test can pin the SCAN SET and not only the classifier: the fence's plausible
 * failure is not misjudging an export, it is never opening the file.
 */
export function listServerActionModules(): string[] {
  const files = new Set<string>();
  for (const pattern of SOURCE_GLOBS) {
    for (const f of globSync(pattern)) {
      const relPath = f.replaceAll("\\", "/");
      if (files.has(relPath)) continue;
      if (!isScannable(relPath)) continue;
      if (!isServerActionModule(readFileSync(f, "utf8"))) continue;
      files.add(relPath);
    }
  }
  return [...files].sort();
}

export type ExportVerdict = {
  /** The exported binding, or a description of the clause for anonymous forms. */
  name: string;
  line: number;
  /**
   * `erased` exports (type / interface / declare / type-only re-export lists)
   * never reach Next's runtime validator. `runtime` exports do, and are the only
   * ones that can offend — counted separately so the anti-vacuity floor below
   * measures the population that matters, not the total.
   */
  kind: "erased" | "runtime";
  /** null when the export is legal — an async function or an erased type. */
  problem: string | null;
};

function lineOfIndex(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/** `async (…) =>`, `async fn =>`, `async function`, `async <T>(…) =>`. */
const ASYNC_INITIALIZER = /^\s*async(\s+function\b|\s*[(<]|\s+\w+\s*=>)/;

/**
 * Classify every TOP-LEVEL export of a source file.
 *
 * Anchored at column 0 (`^export`) on the comment-stripped source. Top-level is
 * the only level that matters — an `export` nested inside a block is not a
 * module export, and this repo has none — while anchoring is what keeps the word
 * "export" inside a function body from being read as a declaration.
 *
 * Exported for tests: each shape below is a separate way to break a page, and
 * the difference between "flagged" and "silently allowed" is one regex.
 */
export function classifyExports(src: string): ExportVerdict[] {
  const code = stripComments(src);
  const verdicts: ExportVerdict[] = [];

  for (const m of code.matchAll(/^export\b[^\n]*/gm)) {
    // `rest` is the module from this clause on. Declarations wrap across lines
    // constantly (`export const f = async (\n  a: string,\n) => {`), so the
    // initializer test must be able to read past the newline; the SHAPE tests
    // read the single line, which is where the keyword always is.
    const verdict =
      classifyErasedOrReExport(m[0], code.slice(m.index)) ??
      classifyDeclaration(m[0], code.slice(m.index));
    verdicts.push({
      ...withTestOnlyRule(verdict),
      line: lineOfIndex(code, m.index),
    });
  }

  return verdicts;
}

/**
 * A TEST-ONLY HELPER IS A PRODUCTION ENDPOINT HERE (A01-4).
 *
 * Every runtime export of a "use server" module is an independently addressable
 * server action, reachable from any browser with no RLS behind it. Two
 * `__reset*ForTests` helpers lived in such modules and deleted the persistent
 * rate-limit buckets of the anonymous `/perdidas` and `/adoptar` typeahead —
 * a legal async function, so the shape rule above waved them through, and an
 * anonymous caller could disarm a live throttle. The name is the contract: a
 * `__` prefix or a `ForTest(s)` suffix says "not public surface", and in this
 * file there is no such thing. Such helpers belong in the plain use-case module
 * the tests can import directly.
 */
const TEST_ONLY_NAME = /^__|ForTests?$/;

function withTestOnlyRule(verdict: Unplaced): Unplaced {
  if (verdict.kind !== "runtime" || verdict.problem !== null) return verdict;
  if (!TEST_ONLY_NAME.test(verdict.name)) return verdict;
  return runtime(
    verdict.name,
    'a test-only helper — every export of a "use server" module is a production server action any browser can call; move it to the plain module the test can import',
  );
}

type Unplaced = Omit<ExportVerdict, "line">;

const runtime = (name: string, problem: string | null): Unplaced => ({
  name,
  kind: "runtime",
  problem,
});
const erased = (name: string): Unplaced => ({ name, kind: "erased", problem: null });

/**
 * Type-only exports (erased at build, so Next never validates them) and the two
 * re-export forms whose target lives in another module. Returns null when the
 * clause is a plain declaration, which classifyDeclaration then judges.
 */
function classifyErasedOrReExport(clause: string, rest: string): Unplaced | null {
  // `export type { A, B }` is matched by the same clause as `export type X`.
  const typeMatch = /^export\s+(?:type|interface|declare)\b\s*(\{|\w+)?/.exec(clause);
  if (typeMatch) {
    return erased(typeMatch[1] === "{" ? clause.trim() : (typeMatch[1] ?? clause.trim()));
  }

  if (/^export\s*\*/.test(clause)) {
    return runtime(
      clause.trim(),
      'a star re-export — every binding of the target module becomes an export of this "use server" module, and none of them can be checked here',
    );
  }

  if (/^export\s*\{/.test(clause)) {
    // `export { type A, type B }` is erased even without the outer `type`.
    const inner = /^export\s*\{([^}]*)\}/.exec(rest)?.[1] ?? "";
    const specifiers = inner
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (specifiers.length > 0 && specifiers.every((s) => /^type\s/.test(s))) {
      return erased(clause.trim());
    }
    return runtime(
      clause.trim(),
      "a re-export list — whether the re-exported binding is an async function depends on another module, so this cannot be proven safe here",
    );
  }

  return null;
}

/** Declarations: the shapes whose asyncness is decidable from the source here. */
function classifyDeclaration(clause: string, rest: string): Unplaced {
  const enumMatch = /^export\s+(?:const\s+)?enum\s+(\w+)/.exec(clause);
  if (enumMatch) return runtime(enumMatch[1], "an enum (a runtime object)");

  const classMatch = /^export\s+(?:abstract\s+)?class\s+(\w+)/.exec(clause);
  if (classMatch) return runtime(classMatch[1], "a class");

  const fnMatch = /^export\s+(async\s+)?function\s*(\*)?\s*(\w+)/.exec(clause);
  if (fnMatch) {
    const [, isAsync, isGenerator, name] = fnMatch;
    if (isGenerator) return runtime(name, "a generator function");
    if (!isAsync) return runtime(name, "a SYNCHRONOUS function — add `async`");
    return runtime(name, null);
  }

  const varMatch = /^export\s+(const|let|var)\s+(\w+)/.exec(clause);
  if (varMatch) {
    const [, kind, name] = varMatch;
    if (kind !== "const") {
      return runtime(name, `a \`${kind}\` binding (mutable, and not an async function)`);
    }
    const initializer = rest.slice(rest.indexOf("=", rest.indexOf(name)) + 1);
    if (ASYNC_INITIALIZER.test(initializer)) return runtime(name, null);
    return runtime(
      name,
      "a const whose initializer is not an async function — this is the shape that 500s (`found object`)",
    );
  }

  if (/^export\s+default\b/.test(clause)) {
    const after = rest.replace(/^export\s+default\b/, "");
    if (ASYNC_INITIALIZER.test(after)) return runtime("default", null);
    return runtime("default", "a default export that is not an async function");
  }

  // Anything reaching here is a shape this classifier does not know. It is
  // REPORTED rather than skipped: an unrecognised export waved through silently
  // is a new blind spot every time TypeScript grows a declaration form, and a
  // blind spot is exactly what this fence exists to close.
  return runtime(clause.trim(), "an export shape this fence does not recognise");
}

function runCheck(): void {
  const modules = listServerActionModules();

  const offenders: string[] = [];
  let classified = 0;
  let runtimeExports = 0;
  for (const file of modules) {
    for (const verdict of classifyExports(readFileSync(file, "utf8"))) {
      classified++;
      if (verdict.kind === "runtime") runtimeExports++;
      if (verdict.problem === null) continue;
      offenders.push(`✗ ${file}:${verdict.line} exports ${verdict.name} — ${verdict.problem}.`);
    }
  }

  // Anti-vacuity BEFORE the verdict: a fence that judged nothing must never
  // reach one.
  const floors: string[] = [];
  const floor = (label: string, n: number, min: number, hint: string) => {
    if (n < min) floors.push(`✗ ${label}: ${n}, expected at least ${min}. ${hint}`);
  };
  floor(
    'scan set — "use server" module(s)',
    modules.length,
    MIN_SERVER_ACTION_MODULES,
    "SOURCE_GLOBS stopped matching, or isServerActionModule stopped recognising the directive.",
  );
  floor(
    "classifier — export(s) classified",
    classified,
    MIN_CLASSIFIED_EXPORTS,
    "The modules were opened but their exports stopped parsing — the same silent pass, one level down.",
  );
  floor(
    "classifier — RUNTIME export(s)",
    runtimeExports,
    MIN_RUNTIME_EXPORTS,
    "Runtime exports are the only ones that can offend; a classifier reading them all as erased types keeps the total healthy and judges nothing.",
  );
  if (floors.length > 0) {
    for (const f of floors) console.error(f);
    console.error(
      "\n✗ check-server-action-exports judged an implausibly small corpus. This check cannot pass having examined almost nothing.",
    );
    process.exit(1);
  }

  if (offenders.length > 0) {
    for (const o of offenders) console.error(o);
    console.error(
      [
        "",
        `✗ ${offenders.length} illegal export(s) from "use server" module(s).`,
        "",
        '  Next validates EVERY export of a "use server" file and throws at module',
        '  load: `A "use server" file can only export async functions, found object`.',
        "  Nothing catches this before production — not tsc, not biome, not the unit",
        "  suite — and the blast radius is every page whose import graph reaches the",
        "  module, as a hard 500.",
        "",
        "  THE FIX IS ALWAYS THE SAME AND IT IS NEVER AN EXEMPTION HERE: move the",
        "  export to a sibling module WITHOUT the directive. The repo's precedents",
        "  are src/modules/events/action-support.ts for shared action plumbing and",
        "  src/modules/*/domain/** for policy constants. `export type` and",
        "  `export interface` are erased at build and may stay.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `✓ "use server" export shapes — ${classified} export(s) across ${modules.length} module(s), ${runtimeExports} of them runtime; every runtime export is an async function.`,
  );
}

// Only run when invoked as a CLI; importing from tests must not exit.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-server-action-exports.ts") ||
    process.argv[1].endsWith("check-server-action-exports.js"));

if (isMain) {
  runCheck();
}
