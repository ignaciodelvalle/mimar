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

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

// ---------------------------------------------------------------------------
// AFTER the build: what actually ships.
//
// The check above reads node_modules, and node_modules is not what runs. A
// stale .next once served an UNPATCHED copy of postgres.js that webpack had
// bundled into a server chunk earlier, while this very check passed against a
// patched node_modules: every transaction failed with UNSAFE_TRANSACTION.
//
// Since then next.config.ts lists postgres in serverExternalPackages, so the
// server output should carry NO bundled copy; the function requires the
// package at runtime from the files Next's trace (*.nft.json) ships, and those
// are node_modules files — which keep their comments, so the marker is there to
// read. The post-build pass checks both ends:
//   - a bundled copy, if one ever reappears, must not be the upstream code. The
//     marker is a comment and minification strips it, so a bundle is judged by
//     the upstream CODE shape instead: `(!q.options.onexecute || …)` survives
//     minification as `(!a.options.onexecute||…)`, and the patch removes it;
//   - every traced copy of connection.js must carry the marker;
//   - at least one copy must be found at all, or the pass proves nothing.

/** The upstream execute() tail, in any minified or unminified spelling. */
export const UPSTREAM_EXECUTE_SHAPE = /\(\s*![\w$]+\.options\.onexecute\s*\|\|/;

/** A traced postgres.js connection.js, in a flat or a pnpm-store layout. */
export const TRACED_CONNECTION =
  /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?postgres\/(?:cjs\/)?src\/connection\.js$/;

/** @param {string} dir @param {(path: string) => boolean} keep @returns {string[]} */
function walk(dir, keep) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // The webpack cache is not output and may legitimately hold old modules.
      if (entry.name === "cache") continue;
      out.push(...walk(path, keep));
    } else if (keep(path)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Problems with the postgres.js the build output would run. Empty = shippable.
 * @param {string} nextDir the build's distDir (`.next`)
 * @returns {{ problems: string[], bundled: number, traced: number }}
 */
export function builtPostgresProblems(nextDir) {
  /** @type {string[]} */
  const problems = [];
  let bundled = 0;
  for (const file of walk(join(nextDir, "server"), (p) => p.endsWith(".js"))) {
    const body = readFileSync(file, "utf8");
    if (!body.includes("options.onexecute")) continue;
    bundled++;
    if (UPSTREAM_EXECUTE_SHAPE.test(body)) {
      problems.push(`bundled UNPATCHED postgres.js in ${file}`);
    }
  }

  /** @type {Set<string>} */
  const tracedFiles = new Set();
  for (const nft of walk(nextDir, (p) => p.endsWith(".nft.json"))) {
    let files;
    try {
      files = JSON.parse(readFileSync(nft, "utf8")).files;
    } catch {
      problems.push(`unreadable trace ${nft}`);
      continue;
    }
    if (!Array.isArray(files)) continue;
    for (const rel of files) {
      if (typeof rel !== "string" || !TRACED_CONNECTION.test(rel.replaceAll("\\", "/"))) continue;
      tracedFiles.add(resolve(dirname(nft), rel));
    }
  }
  for (const file of tracedFiles) {
    let body = "";
    try {
      body = readFileSync(file, "utf8");
    } catch {
      problems.push(`traced postgres.js file is missing: ${file}`);
      continue;
    }
    if (!body.includes(POSTGRES_PATCH_MARKER)) {
      problems.push(`traced UNPATCHED postgres.js: ${file}`);
    }
  }

  if (bundled === 0 && tracedFiles.size === 0) {
    problems.push(
      `no postgres.js found in ${nextDir} — neither bundled in server/ nor in any *.nft.json trace, so this check proved nothing`,
    );
  }
  return { problems, bundled, traced: tracedFiles.size };
}

/**
 * The message the build prints before failing on its own output.
 * @param {string[]} problems
 * @returns {string}
 */
export function builtPostgresMessage(problems) {
  return [
    "[build] the BUILT server output would run an unpatched postgres.js:",
    ...problems.map((p) => `[build]   - ${p}`),
    "[build] node_modules may be patched while the output is not (a stale .next or build cache).",
    "[build] Delete .next and rebuild. On Vercel, redeploy WITHOUT the build cache.",
  ].join("\n");
}
