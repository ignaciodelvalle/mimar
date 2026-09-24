// Vitest setup for the "db" project ONLY (serial, DB-integration tests).
//
// Loads env (via ./setup-env) and then FORCES the Postgres + Supabase URLs back
// to the local stack regardless of what's in .env.local. The integration tests
// must always run against the local Supabase + local Drizzle DB; pointing them
// at a remote project is a production incident waiting to happen (the
// seed/teardown helpers issue real auth.admin.createUser / deleteUser calls).
//
// Symptom this prevents: server actions create auth users on a remote
// project while drizzle queries hit local Postgres, so profile lookups
// fail with `PROFILE_UPDATE_FAILED: profile row not found`.
//
// The "unit" project loads only ./setup-env (no URL forcing) — safe because its
// files provably never reach the database client. See __tests__/db-reachability.ts.

// Safe to hoist: this pulls in vitest's own hook registry, not the DB client.
import { afterAll } from "vitest";

// Env loading (.env.local, .env) — shared with the "unit" project.
import "./setup-env";

// Local Supabase defaults (supabase start). Override only if .env values
// are remote or missing — keep custom local ports if a dev set them.
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
// New-style local key from `supabase status`. Universal across local stacks
// of the same supabase-cli version family.
const LOCAL_SERVICE_KEY = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

function isLocalUrl(u: string | undefined): boolean {
  return !!u && (u.includes("127.0.0.1") || u.includes("localhost"));
}

if (!process.env.DATABASE_URL || !isLocalUrl(process.env.DATABASE_URL)) {
  process.env.DATABASE_URL = LOCAL_DB_URL;
}

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !isLocalUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_SUPABASE_URL;
}

if (
  !process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY.startsWith("eyJ") // legacy JWT
) {
  // Either no key, or a JWT key (likely a remote project's). Replace with
  // the local-stack secret. A legitimate local JWT works too, but we can't
  // tell them apart, and forcing the local sb_secret matches `supabase status`.
  process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_KEY;
}

// Drain this file's connection pool before its worker can be torn down.
//
// Each test file gets its own module registry, so each one builds its own
// postgres.js pool. Those pools used to be abandoned, with `idle_timeout: 20`
// expected to drain them 20 seconds later — a race the run only wins if it
// keeps going that long. After the last file the worker exits at once, open
// sockets get cut under it, and vitest reports "Worker exited unexpectedly".
// Zero tests failed and `pnpm test` still exited 1, which is worse than a
// cosmetic problem: a suite that always exits non-zero cannot distinguish a
// real regression from its own teardown noise.
//
// The import is DYNAMIC on purpose. A static one is hoisted above the
// URL-forcing statements above, so db/index.ts would capture DATABASE_URL
// before this file corrects it. By the time this hook runs the test file has
// already imported the module, so this resolves the cached instance.
//
// And it is GUARDED on purpose. 45 files here call vi.mock("@/db"), so this
// import resolves to their MOCK. Optional chaining is not enough: vitest's mock
// proxy throws on property ACCESS, not on call, so even `mod.closeDbPools?.()`
// fails with "No closeDbPools export is defined on the @/db mock" — measured,
// it broke all 45 files on the first attempt at this fix.
//
// Skipping them is the CORRECT semantics rather than a dodge: a file that
// mocked the module never evaluated the real one, so that registry holds no
// pool to drain. And nothing meaningful is hidden by the catch — closeDbPools
// already swallows its own failures internally, because a teardown error must
// never turn a green run red. That is the whole point of this hook.
afterAll(async () => {
  try {
    const dbModule = (await import("@/db")) as { closeDbPools?: () => Promise<void> };
    await dbModule.closeDbPools?.();
  } catch {
    // Mocked @/db — no real pool in this file's registry.
  }
});
