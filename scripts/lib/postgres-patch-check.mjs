// Build-time proof that patches/postgres.patch reached node_modules.
//
// db/index.ts runs every pool with max_pipeline: 0, and upstream postgres.js
// cannot run a transaction with that setting: without the patch every
// db.transaction() in production fails with UNSAFE_TRANSACTION. A build that
// ships without the patch must not deploy. Two ways it could happen, both of
// them silent at install time:
//   - a restored build cache whose node_modules predates the patch (pnpm 11
//     was seen skipping a newly added patch on its "Already up to date" path);
//   - a postgres version the name-keyed patch was never written for.
//
// The marker is the comment the patch adds to execute(). The ESM build (what
// Next bundles for the server) and the CJS build (what tsx scripts and any
// require() resolve to) are both checked; the Cloudflare build is never loaded.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const POSTGRES_PATCH_MARKER = "// DIM patch (postgres";

export const PATCHED_FILES = ["src/connection.js", "cjs/src/connection.js"];

/**
 * Relative paths (under node_modules/postgres) that are missing or lack the
 * patch marker. Empty when the patch is applied.
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function unpatchedPostgresFiles(repoRoot) {
  const pkg = join(repoRoot, "node_modules", "postgres");
  return PATCHED_FILES.filter((rel) => {
    try {
      return !readFileSync(join(pkg, rel), "utf8").includes(POSTGRES_PATCH_MARKER);
    } catch {
      return true;
    }
  });
}

/**
 * The message the build prints before refusing to continue.
 * @param {string[]} missing
 * @returns {string}
 */
export function unpatchedPostgresMessage(missing) {
  return [
    `[build] postgres.js is NOT patched: ${missing.map((m) => `node_modules/postgres/${m}`).join(", ")} lacks "${POSTGRES_PATCH_MARKER}".`,
    "[build] db/index.ts runs with max_pipeline 0, and without patches/postgres.patch every transaction fails (UNSAFE_TRANSACTION).",
    "[build] Reinstall (pnpm install --frozen-lockfile). On Vercel, redeploy WITHOUT the build cache.",
  ].join("\n");
}
