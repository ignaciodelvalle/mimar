// Vitest globalSetup — runs once in the main process before/after all test files.
//
// WHY THIS EXISTS
// ---------------
// postgres.js maintains a connection pool in the vitest worker thread. With
// fileParallelism:false, all test files share ONE worker and ONE postgres.js
// pool instance. When the worker exits after the last test file, any open
// sockets are torn down by the OS — this produces:
//
//   "Error: write EPIPE" / "Worker exited unexpectedly"
//
// We cannot drain the worker's pool from globalSetup (different process), but
// we CAN inject the VITEST env flag early enough (before any test file imports
// db/index.ts) so that db/index.ts uses the bounded pool config:
//   max: 3 + idle_timeout: 20 s + max_lifetime: 60 s + connect_timeout: 10 s
//
// With idle_timeout: 20 s the pool self-drains within 20 s of the last query
// in each file. By the time the worker is instructed to exit (after the last
// test file completes), most connections are already returned to the server,
// leaving at most one straggler which exits cleanly within the OS TCP timeout.
//
// The setup export also sets DATABASE_URL to the local Supabase stack as a
// belt-and-suspenders guard (setup.ts also sets it per-file, but globalSetup
// runs before the first file so the flag is available immediately).

import postgres from "postgres";

import { EXEMPT_SEED_TAGS } from "@/scripts/check-spine-integrity";

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Sweep pet rows that carry NO event at all, once, before the suite starts.
 *
 * WHY (2026-08-01). The db project runs serially against ONE shared local
 * Postgres, which makes that database shared mutable state between files. Most
 * fixtures insert into `pets` directly — over thirty files do — and none of
 * those inserts writes a `pet_registered` event, because they are testing
 * something other than registration. Teardown deletes them. A run that DIES
 * before teardown does not.
 *
 * What it leaves behind is a cache row with no spine event: exactly what
 * invariant #3 forbids, and `pnpm lint:spine` fails on it for everyone using
 * that database until somebody deletes the rows by hand. That cost real time
 * today, and booking-race — the file that actually crashed — was only one of
 * the thirty-odd that can produce it. Fixing them one by one fixes the instance,
 * not the shape.
 *
 * WHY DELETING IS SAFE, and narrow despite looking broad:
 *  - Zero events is the exact debris signature. Every pet created through the
 *    application has `pet_registered`, which is the premise the spine fence is
 *    built on — so a pet with no events at all was inserted by a fixture.
 *  - A pet WITH events cannot be deleted anyway: the delete cascades into
 *    pet_events and the append-only trigger refuses. The database enforces the
 *    boundary independently of this query.
 *  - Everything else cascades cleanly (ownerships, cases, identifications,
 *    reminders — verified against the FK catalogue), so no orphan is created.
 *  - EXEMPT_SEED_TAGS is imported from the fence rather than re-listed here.
 *    The set of tags allowed to lack a registration event has ONE home; a
 *    second copy would drift and this sweep would start deleting rows the
 *    fence deliberately tolerates.
 *
 * WHY IT LOGS. The fence's job is to catch a pet that reached the database
 * without its event. Silently cleaning before every run would delete that
 * signal along with the debris. It prints what it removed instead, so a fixture
 * that has started leaking is visible in the output rather than absorbed.
 *
 * LOCAL ONLY, structurally: this runs in the `db` vitest project, whose
 * setup.ts and the guard below both force DATABASE_URL to 127.0.0.1. It cannot
 * reach staging even if a shell has the pooler exported — the same
 * leftover-shell trap check-spine-integrity.ts warns about.
 */
async function sweepEventlessPets(url: string): Promise<void> {
  if (!url.includes("127.0.0.1") && !url.includes("localhost")) return;
  const sql = postgres(url, { max: 1, connect_timeout: 5 });
  try {
    const removed = await sql`
      DELETE FROM pets p
      WHERE NOT EXISTS (SELECT 1 FROM pet_events e WHERE e.pet_id = p.id)
        AND (p.seed_tag IS NULL OR p.seed_tag NOT IN ${sql([...EXEMPT_SEED_TAGS])})
      RETURNING p.public_token, p.name
    `;
    if (removed.length > 0) {
      console.warn(
        `[global-setup] Swept ${removed.length} eventless pet row(s) left by an aborted run: ` +
          `${removed
            .slice(0, 5)
            .map((r) => `${r.public_token} (${r.name})`)
            .join(", ")}${removed.length > 5 ? ", …" : ""}`,
      );
    }
  } catch (err) {
    // NEVER silent. The first version of this swallowed everything, on the
    // theory that "no local stack" is a state the suite already reports on its
    // own terms — true, but the same catch then swallowed a genuine query bug
    // (postgres.js rejects sql.array() on the right of `<> ALL`), and a broken
    // sweep that returns quietly is indistinguishable from a clean database.
    // It looked like it worked for exactly as long as nobody checked.
    //
    // So: connection failures stay quiet, because an unreachable database is
    // about to be reported by every test in the suite. Anything else is a bug
    // in this function and says so.
    const message = err instanceof Error ? err.message : String(err);
    const unreachable = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|does not exist|Connection/i.test(message);
    if (!unreachable) {
      console.error(
        `[global-setup] Eventless-pet sweep FAILED (not a connection issue): ${message}`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function setup(): Promise<void> {
  // Activate the test-mode pool caps in db/index.ts.
  process.env.VITEST = "true";

  // Belt-and-suspenders: ensure DATABASE_URL is set to local before any
  // module in the main process reads it. Per-file setup.ts handles workers.
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.includes("127.0.0.1")) {
    process.env.DATABASE_URL = LOCAL_DB_URL;
  }

  await sweepEventlessPets(process.env.DATABASE_URL);
}

export async function teardown(): Promise<void> {
  // No-op: pool drain happens automatically via idle_timeout in the worker.
  // If future vitest versions expose a handle to the worker module cache, we
  // can call db.$client.end() here for a hard drain. For now, idle_timeout: 20
  // ensures connections close within 20 s of the last query.
}
