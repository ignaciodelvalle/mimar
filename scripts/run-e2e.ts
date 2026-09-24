// run-e2e — `pnpm e2e`, with the repo's own .env already loaded.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// `pnpm e2e` used to be a bare `playwright test`, and Playwright loads no .env
// file: neither playwright.config.ts nor the specs ever read one. The app under
// test does not care — `next start` loads .env.local itself — but the SPECS run
// in plain Node, and e2e/demo/_db-cleanup.ts decides what it may delete from
// `DATABASE_URL` alone. Absent, that answer is "no database was declared", and
// every local run silently skips its cleanup: the create-pet / degraded-states
// pets are never removed, and they pile up on /perdidas exactly as that file's
// header describes. The only way to opt back in was to export DATABASE_URL by
// hand before the command, which is a step nobody remembers and no error names
// until weeks later.
//
// WHAT IT MUST NOT DO, AND HOW THAT IS GUARANTEED
// ---------------------------------------------------------------------------
// CI sets DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL and friends explicitly in the
// job's `env:` block and then runs `pnpm e2e --reporter=list,github,html`
// (.github/workflows/ci.yml, "Run Playwright e2e suite"). This file must be
// incapable of moving that target. dotenv's `config()` NEVER overwrites a key
// already present in process.env — that is the default and the load-bearing
// property here, so an explicitly-set variable always wins and CI is untouched.
// (`override: true`, which scripts/ops/with-env.ts uses on purpose to point a
// tool at a different database, is exactly what must NOT appear below.)
//
// The load order mirrors scripts/db-bootstrap.ts: .env.local first, .env as the
// fallback. A missing file is not an error — CI has neither, and the nightly
// drives a deployed origin with no DATABASE_URL by design.
//
// Playwright is spawned as a NODE process rather than through a shell so the
// caller's argv survives verbatim on Windows: `--grep "two words"` through
// `shell: true` is a quoting bug waiting to happen, and this script's whole
// job is to be transparent. The child's exit code is the script's exit code.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

import { config as loadEnv } from "dotenv";

/** Loaded for their side effect on process.env; the names are for the log. */
const ENV_FILES = [".env.local", ".env"] as const;

const loaded: string[] = [];
for (const file of ENV_FILES) {
  const result = loadEnv({ path: file });
  // `error`, NOT `parsed`. dotenv 16.6.1 answers a missing file with
  // `{ parsed: {}, error: ENOENT }` — an empty object, not `undefined` — so a
  // `parsed !== undefined` test reports every absent file as loaded. Measured:
  // this line first claimed "loaded .env.local + .env" in a worktree that had
  // neither, which is the one lie a log line like this must not tell.
  if (result.error === undefined) loaded.push(file);
}

console.log(
  loaded.length > 0
    ? `[e2e] loaded ${loaded.join(" + ")} (existing environment variables win)`
    : "[e2e] no .env file found — using the process environment as-is",
);

// A visible HOST and never a value: the operator needs to confirm which
// database the specs' cleanups will be allowed to touch before reading the
// run's output, and _db-cleanup.ts refuses anything but this machine.
const databaseUrl = process.env.DATABASE_URL?.trim();
if (databaseUrl) {
  try {
    console.log(`[e2e] DATABASE_URL → ${new URL(databaseUrl).host}`);
  } catch {
    console.warn("[e2e] DATABASE_URL is set but is not a valid URL — the cleanups will refuse it.");
  }
} else {
  console.warn(
    "[e2e] DATABASE_URL is not set: the local-DB cleanups in e2e/demo/_db-cleanup.ts will skip, and specs that register a pet will leave it behind. Expected when driving a deployed origin; locally, `npx supabase status -o env` fills .env.local.",
  );
}

// Resolved from the repo root (this script runs with cwd = package root, which
// is where pnpm puts it), so it is the same @playwright/test the config and the
// specs import — not whatever a parent directory might hoist.
const playwrightCli = createRequire(join(process.cwd(), "package.json")).resolve(
  "@playwright/test/cli",
);

const child = spawnSync(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

if (child.error) {
  console.error(`[e2e] could not start Playwright: ${child.error.message}`);
  process.exit(1);
}

// `status` is null when the child died on a signal; 1 is the honest answer
// there. Never normalise a non-zero code — the e2e verdict is the point.
process.exit(child.status ?? 1);
