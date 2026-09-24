import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { computeTestPartition } from "./__tests__/db-reachability";

// TWO-PROJECT SPLIT (audit refactor).
// ---------------------------------------------------------------------------
// The suite used to run with fileParallelism:false GLOBALLY and the URL-forcing
// setup on EVERY file — so 100% of tests paid the serial + DB tax even though
// only the DB-integration subset needs it. We now split into two projects:
//
//   • "unit" — files that provably never reach the database client. Run in
//     PARALLEL (default workers), env-only setup (no URL forcing), no
//     postgres.js pool-drain globalSetup. Nothing here can touch a DB.
//   • "db"   — files whose transitive import graph reaches db/index.ts. Run
//     SERIALLY (fileParallelism:false) with the URL-forcing setup.ts + the
//     pool-drain global-setup.ts — byte-for-byte the old behavior, for the
//     files that actually need it.
//
// Membership is MECHANICAL: computeTestPartition() walks the import graph from
// every test file and classifies by reachability of db/index.ts. It is
// recomputed on every run (no manifest to drift) and guarded by
// __tests__/project-partition.guard.test.ts. See __tests__/db-reachability.ts
// for the full safety rationale (why dropping URL forcing on "unit" is safe).
const { db: dbFiles, unit: unitFiles } = computeTestPartition();

// Test paths contain glob-special characters from Next.js route dirs —
// "(app)", "(public)", "[publicToken]". As raw glob patterns those match
// NOTHING (parens/brackets are extglob/char-class syntax), so each path is
// escaped to a literal-matching pattern. Verified against tinyglobby (the
// engine Vitest globs with): an escaped path matches exactly its one file.
const escapeGlob = (p: string): string => p.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
const dbInclude = dbFiles.map(escapeGlob);
const unitInclude = unitFiles.map(escapeGlob);

// A `--shard=i/N` run executes a SLICE of the suite, so its coverage is a slice
// too: every file under coverage.include that another shard exercises reads as
// uncovered here. Grading the ratchet floors against that would fail every
// shard for a reason that is not a regression. CI's vitest job shards (see the
// `test-shard` and `test` jobs in .github/workflows/ci.yml): each shard writes
// a blob carrying its coverage map, and the merge run — which carries no
// `--shard` — merges the maps and grades the floors against the WHOLE suite.
//
// Keyed on the literal flag, not an env var, on purpose: there is no knob that
// turns the floors off. The only run that skips them is one that could not
// measure them honestly anyway.
const isShardRun = process.argv.some((a) => a === "--shard" || a.startsWith("--shard="));

// Shared Vite layer — repeated per project because inline Vitest projects do
// NOT inherit the root config's `plugins`/`resolve`.
const sharedViteConfig = () => ({
  // @vitejs/plugin-react transforms .tsx with the automatic JSX runtime even
  // though the repo's tsconfig sets `jsx: "preserve"` (which Next.js needs).
  // Required by component-level tests introduced in Poncho PR-A.
  plugins: [react()],
  resolve: {
    alias: {
      "@": new URL("./", import.meta.url).pathname,
      // server-only throws at import time in non-Next.js environments.
      // In Vitest (Node.js) we stub it as a no-op so server-only modules
      // can be imported and tested without the Next.js runtime.
      "server-only": new URL("./__tests__/__mocks__/server-only.ts", import.meta.url).pathname,
    },
  },
});

export default defineConfig({
  test: {
    projects: [
      {
        ...sharedViteConfig(),
        test: {
          name: "unit",
          include: unitInclude,
          // groupOrder 0 — runs FIRST, alone. See the db project below for why.
          sequence: { groupOrder: 0 },
          // PARALLEL: no shared DB state to pollute, so files run concurrently
          // across workers. This is the whole point of the split.
          // Env-only setup — loads .env but does NOT force DATABASE_URL /
          // SUPABASE_URL. Safe because no unit file reaches the DB client.
          setupFiles: ["./__tests__/setup-env.ts"],
          // No globalSetup: the postgres.js pool-drain mitigation is a DB-only
          // concern; unit files never open a pool.
        },
      },
      {
        ...sharedViteConfig(),
        test: {
          name: "db",
          include: dbInclude,
          // groupOrder 1 — runs AFTER unit, never alongside it (PO decision,
          // 2026-08-10).
          //
          // Without this, vitest runs every project CONCURRENTLY: the unit
          // project saturates the machine with parallel workers while this
          // project holds the serial lane. `fileParallelism: false` below then
          // buys nothing — the isolation it asks for is contended away from the
          // outside.
          //
          // It was not theoretical. components/panorama/PanoramaConsole.test.tsx
          // — the heaviest file in the suite, 103 tests, ~24s — starved and went
          // red in the FULL run while passing alone. The bisect that settled it:
          //
          //   vitest run --project db  → 686 files, 6985 tests, PASS (1 of 1)
          //   pnpm test (full suite)   → that assertion FAILS (2 of 2)
          //
          // Two earlier commits (dc255915, 5a3f9963) treated it as a slow flush
          // and raised its waitFor timeouts; a third raise would have been the
          // wrong lever again. Nothing about the component is slow — it was not
          // getting scheduled.
          //
          // Cost: total wall-clock is the sum of the two projects instead of the
          // max. That is the price of the isolation this project already
          // declared it needed.
          sequence: { groupOrder: 1 },
          // Tests touch the local Postgres via Drizzle; run serially to avoid
          // cross-test pollution over the shared local stack.
          fileParallelism: false,
          setupFiles: ["./__tests__/setup.ts"],
          // globalSetup runs once in the main process (not per-file). Used to
          // gracefully close the postgres.js pool after the full suite
          // completes, preventing "Worker exited unexpectedly" errors that
          // occur when open sockets are forcibly torn down by the process exit
          // handler instead.
          globalSetup: ["./__tests__/global-setup.ts"],
        },
      },
    ],
    // Coverage is a ROOT-level (cross-project) concern in Vitest 4 — it
    // aggregates over whatever projects run. `pnpm test:coverage` (CI's gate)
    // therefore instruments both projects in one pass.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json"],
      // `packages/**` joined on 2026-08-20 with the first workspace package.
      // Without it, moving a file from lib/ into packages/contract would have
      // silently dropped it from the instrumented corpus — the coverage number
      // would have IMPROVED by deleting measured code, which is the wrong
      // incentive to leave lying around.
      include: ["lib/**", "app/**", "packages/**", "src/**"],
      exclude: [
        "components/**",
        "__tests__/**",
        "node_modules/**",
        ".next/**",
        "db/migrations/**",
        "**/*.d.ts",
        "e2e/**",
      ],
      // Branch-coverage thresholds are RATCHET FLOORS, not aspirational targets
      // (V1-9). The original targets (business-rules 90 / lib 70 / app/actions 75
      // / app/api 60 / src/modules 70 / domain 90) were never enforced and the
      // codebase is well below several of them. These floors are set a couple of
      // points UNDER the current measured coverage so CI prevents REGRESSION
      // without failing today. Raise them incrementally post-launch as coverage
      // improves — never lower a floor below what's achieved.
      thresholds: isShardRun
        ? undefined
        : {
            "lib/business-rules-**": { branches: 80 },
            "lib/**-rules/**": { branches: 80 },
            "lib/**": { branches: 55 },
            // RECALIBRATED 2026-07-28 to the first measurement anyone could
            // reproduce. The 30 came from a local run; CI — clean checkout,
            // bootstrapped DB, seeded population — measures 23,89%, and the local
            // number cannot be re-checked because the coverage run OOMs a worker on
            // this machine. A floor nobody can verify is not a ratchet.
            //
            // This is NOT accepting a regression: nothing dropped, the previous
            // figure was calibrated against an environment that does not enforce
            // anything. Raise it from CI's number as coverage improves — and never
            // from a local one again.
            "app/actions/**": { branches: 22 },
            "app/api/**": { branches: 8 },
            "src/modules/**/domain/**": { branches: 88 },
            "src/modules/**": { branches: 55 },
          },
    },
  },
});
