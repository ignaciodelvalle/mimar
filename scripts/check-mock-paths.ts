// vi.mock specifier resolution guard — CI lint (post-bucketize hardening).
//
// INCIDENT THIS PREVENTS: the `refactor(lib): bucketize` migration moved
// lib/*.ts into lib/{infra,domain,events,analytics,ui,reference,utils}/*.ts
// and updated source imports, but vi.mock()/vi.doMock() string specifiers in
// tests kept pointing at the OLD deleted paths. Vitest does NOT error when a
// mocked specifier matches no real module — the mock is a silent no-op, the
// real module runs unmocked, and the visible failure is whatever that real
// module does first (missing @/db exports, cookies() outside request scope,
// "executor.select is not a function", vi.mocked(realFn) TypeErrors, …).
// That single silent failure mode cost ~90 test files across three fix
// sessions (commits ede859af, d2a35488, and branch fix/test-debt-mock-paths).
//
// Rule:
//   Every string specifier passed to vi.mock / vi.doMock / vi.unmock /
//   vi.doUnmock in a test file MUST resolve to an existing module:
//     - "@/…"      → resolved against the repo root (tsconfig "@/*": ["./*"])
//     - "./…"/"../…" → resolved against the test file's directory
//     - bare names ("next/navigation", "drizzle-orm", "server-only") → skipped
//       (package resolution is vitest's job; keeps false positives at zero)
//
// Run: pnpm tsx scripts/check-mock-paths.ts   (or: pnpm lint:mocks)
// Exits 0 when clean; exits 1 listing each file:line → dead specifier.
//
// Regex-based, not a full AST analyzer — mirrors the sibling linters
// (check-dependency-direction.ts, check-lib-root-files.ts, etc.).

import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Test-file globs — mirrors vitest's default include for this repo. */
const TEST_GLOBS = ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"];

/** Path fragments excluded from the scan — mirrors vitest.config exclude.
 *
 * `apps/` is here because this fence checks `vi.mock` paths and `apps/mobile`
 * does not run on Vitest at all (it is Jest + `jest-expo`). Reading its test
 * files can only produce a verdict about a mocking API they never call. */
const EXCLUDED_SEGMENTS = ["node_modules/", ".claude/", ".next/", "apps/", "e2e/"];

/** Module file extensions + index variants tried when resolving a specifier. */
const RESOLUTION_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

/**
 * Matches vi.mock("…"), vi.doMock('…'), vi.unmock("…"), vi.doUnmock("…").
 * \s* after the paren tolerates line breaks between call and specifier.
 */
const MOCK_CALL_RE = /\bvi\.(?:mock|doMock|unmock|doUnmock)\(\s*["']([^"']+)["']/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeadSpecifier = {
  file: string;
  line: number;
  specifier: string;
};

// ---------------------------------------------------------------------------
// Core logic (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Classify a specifier: only "@/…" (tsconfig alias) and relative paths are
 * checkable against the filesystem. Bare package names are vitest's problem.
 */
export function isCheckableSpecifier(specifier: string): boolean {
  return specifier.startsWith("@/") || specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Resolve a checkable specifier to an absolute base path (extension-less).
 * "@/lib/x" → <repoRoot>/lib/x; "../application/y" → <testDir>/../application/y.
 */
export function resolveBasePath(specifier: string, repoRoot: string, testDir: string): string {
  if (specifier.startsWith("@/")) {
    return resolve(repoRoot, specifier.slice(2));
  }
  return resolve(testDir, specifier);
}

/** True when the base path resolves to a real module via any known suffix. */
export function moduleExists(basePath: string): boolean {
  return RESOLUTION_SUFFIXES.some((suffix) => existsSync(basePath + suffix));
}

/**
 * Scan one test file's source for dead mock specifiers.
 * Line numbers come from counting newlines before each match index.
 */
export function findDeadSpecifiers(
  filePath: string,
  source: string,
  repoRoot: string,
): DeadSpecifier[] {
  const dead: DeadSpecifier[] = [];
  const testDir = dirname(resolve(repoRoot, filePath));

  for (const match of source.matchAll(MOCK_CALL_RE)) {
    const specifier = match[1] as string;
    if (!isCheckableSpecifier(specifier)) continue;

    const basePath = resolveBasePath(specifier, repoRoot, testDir);
    if (!moduleExists(basePath)) {
      const line = source.slice(0, match.index).split("\n").length;
      dead.push({ file: filePath.replaceAll("\\", "/"), line, specifier });
    }
  }

  return dead;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runScan(): void {
  const repoRoot = process.cwd();

  const testFiles = TEST_GLOBS.flatMap((pattern) => globSync(pattern))
    .map((p) => p.replaceAll("\\", "/"))
    .filter((p) => !EXCLUDED_SEGMENTS.some((seg) => p.includes(seg)))
    .sort();

  if (testFiles.length === 0) {
    console.error("✗ check-mock-paths: no test files found — is the cwd the repo root?");
    process.exit(1);
  }

  const violations: DeadSpecifier[] = [];
  let checkedSpecifiers = 0;

  for (const file of testFiles) {
    const source = readFileSync(file, "utf8");
    checkedSpecifiers += [...source.matchAll(MOCK_CALL_RE)].filter((m) =>
      isCheckableSpecifier(m[1] as string),
    ).length;
    violations.push(...findDeadSpecifiers(file, source, repoRoot));
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(
        `${v.file}:${v.line}: vi.mock specifier "${v.specifier}" resolves to no module — the mock is a silent no-op and the REAL module will run unmocked. Repoint it to the module's current location (check the code-under-test's actual import path).`,
      );
    }
    console.error(
      `\n✗ ${violations.length} dead mock specifier(s) in ${new Set(violations.map((v) => v.file)).size} file(s). This is the exact failure mode of the bucketize fallout (~90 test files) — fix the path, do not add exports to unrelated mocks.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ mock specifiers clean — ${testFiles.length} test file(s) scanned; ${checkedSpecifiers} aliased/relative specifier(s) all resolve to real modules.`,
  );
}

// Guard: only scan when run directly; importing from tests exposes helpers
// without triggering the filesystem scan.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-mock-paths.ts") ||
    process.argv[1].endsWith("check-mock-paths.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
