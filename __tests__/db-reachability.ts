// Test-suite partition by DB reachability.
//
// WHY THIS EXISTS
// ---------------
// The Vitest suite is split into TWO projects (see vitest.config.ts):
//   - "unit": pure tests, run in PARALLEL, no DB, no URL forcing.
//   - "db":   tests that (transitively) reach the database client, run
//             SERIALLY against the local Supabase stack, with the URL-forcing
//             setup + the postgres.js pool-drain globalSetup.
//
// Membership is MECHANICAL, not hand-annotated: a test file belongs to the
// "db" project iff its transitive import graph reaches `db/index.ts` — the
// module that constructs the postgres.js client. Everything else is "unit".
//
// SAFETY RATIONALE
// ----------------
// `__tests__/setup.ts` force-rewrites DATABASE_URL / SUPABASE_URL to the local
// stack precisely so a test never issues real auth.admin / Drizzle calls
// against a REMOTE project (a production-incident guard). The "unit" project
// deliberately drops that forcing — which is only safe if a unit file can
// NEVER reach the DB client. By partitioning on transitive reachability of
// `db/index.ts`, a unit file provably cannot import the `db` handle, so it
// cannot query anything, so dropping the URL forcing is safe by construction.
//
// IMPORTANT DISTINCTION: `db/index.ts` (the `@/db` barrel) re-exports
// `db/schema.ts`, so a large number of pure-logic tests import `@/db` ONLY for
// schema constants / enums / types and never query. Those still reach the sink
// (`db/index.ts` runs and lazily constructs a never-queried pool) and are
// therefore classified "db" — the CONSERVATIVE, safe side. `@/db/schema`
// imported directly (bypassing the barrel) does NOT reach the sink.
//
// SECOND SIGNAL — non-import DB access. Import reachability is blind to a test
// that touches the DB WITHOUT importing `@/db`: e.g. migrate-runner.test.ts
// drives `scripts/migrate.ts` in a subprocess and opens its own raw postgres.js
// client, reading process.env.DATABASE_URL directly. Such a test still needs
// the local-URL guarantee. So a file is ALSO "db" if its transitive in-repo
// closure contains a direct-DB textual signal (raw `postgres` driver import,
// `process.env.DATABASE_URL`, or spawning a DB script). Over-including a
// genuinely-pure file this way only costs it parallelism, never safety.
//
// The classification is recomputed from the filesystem on every run (config
// load + the partition guard test), so there is NO manifest to drift: adding
// an `@/db` import to a previously-pure test moves it to the "db" project
// automatically on the next run.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root — this file lives at `<root>/__tests__/db-reachability.ts`. */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url))).replace(/\\/g, "/");

/** The reachability sink: the module that constructs the postgres.js client. */
export const DB_SINK = resolve(ROOT, "db/index.ts").replace(/\\/g, "/");

const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// Directories never walked when discovering test files or resolving imports.
//
// `apps` joined on 2026-08-25 with `apps/mobile`, and it is not the same kind
// of entry as the rest. The others are noise — build output, other checkouts.
// This one is a DIFFERENT TEST RUNNER: the Expo app is tested by Jest
// (`jest-expo`, `apps/mobile/jest.config.js`) because that is the runner its
// toolchain ships, and its files are `*.test.ts` like everything else here.
// Without this line the walk hands them to Vitest, which collects them in jsdom
// under the web app's aliases, fails on the first Jest global, and reports them
// as broken files — a mobile test taking the WEB gate down. `packages/*` is
// deliberately absent from this list for the opposite reason: those tests are
// Vitest's and must run.
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".claude",
  "apps",
  "e2e",
  "worktrees",
  "playwright-report",
  "coverage",
]);

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Resolve a base path (no/with extension) to a concrete source file, honoring
 * `<base>.<ext>` and `<base>/index.<ext>` — mirrors TS/Vite module resolution
 * for the specifiers this repo actually uses. Returns null when nothing exists. */
function resolveToFile(base: string): string | null {
  const p = toPosix(base);
  if (existsSync(p) && statSync(p).isFile()) return p;
  for (const ext of RESOLVE_EXTS) {
    if (existsSync(p + ext)) return toPosix(p + ext);
  }
  for (const ext of RESOLVE_EXTS) {
    const idx = join(p, `index${ext}`);
    if (existsSync(idx)) return toPosix(idx);
  }
  return null;
}

/** Resolve an import specifier to an absolute source file, or null for bare
 * package specifiers / unresolved paths (which cannot reach in-repo modules).
 * `@/x` maps to `<root>/x` (tsconfig `@/* -> ./*`); `server-only` is the Vitest
 * stub and is treated as a non-reaching leaf. */
export function resolveSpecifier(spec: string, importer: string): string | null {
  if (spec === "server-only") return null;
  if (spec.startsWith("@/")) return resolveToFile(resolve(ROOT, spec.slice(2)));
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return resolveToFile(resolve(dirname(importer), spec));
  }
  return null; // bare package — cannot reach an in-repo module
}

// import ... from "x" | export ... from "x" | import "x" | import("x") | require("x")
const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

const depsCache = new Map<string, string[]>();

/** Resolved in-repo dependencies of a single file (direct imports only). */
export function directDeps(file: string): string[] {
  const cached = depsCache.get(file);
  if (cached) return cached;
  let src = "";
  try {
    src = readFileSync(file, "utf8");
  } catch {
    depsCache.set(file, []);
    return [];
  }
  const out = new Set<string>();
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = IMPORT_RE.exec(src))) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) continue;
    const resolved = resolveSpecifier(spec, file);
    if (resolved) out.add(resolved);
  }
  const arr = [...out];
  depsCache.set(file, arr);
  return arr;
}

// DB-reachable set, computed by REVERSE reachability from the sink.
//
// A naive memoized forward DFS with cycle pruning is WRONG on this graph: when a
// node sits on an import cycle, the cache can be poisoned with a spurious
// `false`, under-reporting reachability (measured: 7 real DB tests misclassified
// as unit — a safety hole). Reverse BFS over the whole import graph is O(V+E)
// and provably correct with cycles: build forward edges from every test root,
// invert them, then flood outward from `db/index.ts`. Every module the flood
// reaches is one that transitively imports the DB client.
let dbReachableSet: Set<string> | null = null;

function computeDbReachableSet(): Set<string> {
  if (dbReachableSet) return dbReachableSet;

  // 1. Forward-discover every module reachable from the test roots.
  const forward = new Map<string, string[]>();
  const roots = discoverTestFiles().map((rel) => `${ROOT}/${rel}`);
  const stack = [...roots];
  const seen = new Set<string>();
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const ds = directDeps(file);
    forward.set(file, ds);
    for (const d of ds) if (!seen.has(d)) stack.push(d);
  }

  // 2. Invert the edges.
  const reverse = new Map<string, string[]>();
  for (const [file, ds] of forward) {
    for (const d of ds) {
      const list = reverse.get(d);
      if (list) list.push(file);
      else reverse.set(d, [file]);
    }
  }

  // 3. Flood outward from the sink over reverse edges.
  const reached = new Set<string>([DB_SINK]);
  const queue = [DB_SINK];
  while (queue.length) {
    const node = queue.shift() as string;
    for (const importer of reverse.get(node) ?? []) {
      if (!reached.has(importer)) {
        reached.add(importer);
        queue.push(importer);
      }
    }
  }

  dbReachableSet = reached;
  return reached;
}

/** True iff `file` transitively imports `db/index.ts` (the DB client). */
export function reachesDb(file: string): boolean {
  return computeDbReachableSet().has(file);
}

// Direct DB-access textual signals — a test touching the DB WITHOUT importing
// `@/db` (invisible to import reachability). Deliberately narrow, and applied
// ONLY to a test file's OWN source (not its transitive closure) to avoid
// false positives from domain/lib files that merely mention these tokens in a
// string or comment. The real case: migrate-runner.test.ts opens a raw
// postgres.js client and drives scripts/migrate.ts in a subprocess.
// (Bare `child_process`/`execSync` is intentionally NOT a signal — plenty of
// pure tests spawn non-DB subprocesses.)
//
// SUPABASE SIGNALS (Wave M hardening, Tren 1 review finding): a test can also
// reach the backend through its OWN supabase-js client — createClient() fed by
// the SUPABASE_URL env vars, or auth.admin.* calls — none of which touches
// `db/index.ts`. Any of those in a test's own source classifies it "db" so it
// runs under the URL-forcing setup. Over-including a genuinely-pure file this
// way only costs it parallelism, never safety.
const DIRECT_DB_SIGNAL_RE =
  /(?:from|import|require\()\s*['"]postgres['"]|process\.env\.DATABASE_URL|scripts\/(?:migrate|db-bootstrap)\b|process\.env\.(?:NEXT_PUBLIC_)?SUPABASE_URL|process\.env\.SUPABASE_SERVICE_ROLE_KEY|auth\.admin\./;

const signalCache = new Map<string, boolean>();

/** True iff `file`'s own source contains a direct DB-access textual signal. */
export function fileHasDbSignal(file: string): boolean {
  const cached = signalCache.get(file);
  if (cached !== undefined) return cached;
  let src = "";
  try {
    src = readFileSync(file, "utf8");
  } catch {
    signalCache.set(file, false);
    return false;
  }
  const result = DIRECT_DB_SIGNAL_RE.test(src);
  signalCache.set(file, result);
  return result;
}

/** Authoritative classifier: a test file belongs to the "db" project iff it
 * transitively imports `db/index.ts` OR its own source carries a direct-DB
 * textual signal. The safe side of the split. */
export function isDbTest(file: string): boolean {
  return reachesDb(file) || fileHasDbSignal(file);
}

/** Depth-1 DB reachability: does `file` import `db/index.ts` directly, or does
 * any of its DIRECT imports? A shallow, honestly-bounded cross-check used by
 * the partition guard — independent of the reverse-reachability flood. */
export function reachesDbDepth1(file: string): boolean {
  const direct = directDeps(file);
  if (file === DB_SINK || direct.includes(DB_SINK)) return true;
  for (const dep of direct) {
    if (directDeps(dep).includes(DB_SINK)) return true;
  }
  return false;
}

/** Discover every runnable Vitest test file under the repo root, as posix paths
 * relative to root (the form Vitest `include` expects). Mirrors the config's
 * exclude of node_modules / e2e / worktrees. */
export function discoverTestFiles(): string[] {
  const acc: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = toPosix(join(dir, ent.name));
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full);
      } else if (/\.test\.tsx?$/.test(ent.name)) {
        acc.push(full);
      }
    }
  };
  walk(ROOT);
  return acc.map((f) => f.slice(ROOT.length + 1)).sort();
}

export interface TestPartition {
  /** root-relative posix paths that transitively reach the DB client. */
  db: string[];
  /** root-relative posix paths that provably never reach the DB client. */
  unit: string[];
  /** every discovered test file (db ∪ unit). */
  all: string[];
}

/** Partition all discovered test files into the "db" and "unit" projects. */
export function computeTestPartition(): TestPartition {
  const all = discoverTestFiles();
  const db: string[] = [];
  const unit: string[] = [];
  for (const rel of all) {
    const abs = `${ROOT}/${rel}`;
    if (isDbTest(abs)) db.push(rel);
    else unit.push(rel);
  }
  return { db, unit, all };
}
