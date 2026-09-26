// Shadow mode never breaks the request it watches (localidades-por-id,
// stage D verify W3).
//
// In `shadow` a consumer (routing, rules, coverage) serves the name path and
// computes the id path only to compare them. If the id path fails — a missing
// function on a half-migrated environment, a timeout — that is a finding for
// the operators, not an error for the person being served: it is reported
// (reportError, structured log) and the caller serves the name result as if
// no comparison had been attempted.
//
// The id path runs in its own savepoint (`exec.transaction` on a transaction
// is a nested SAVEPOINT in Drizzle), so a failed statement is rolled back to
// it and never leaves the caller's transaction aborted.

import type { db } from "@/db";
import { reportError } from "@/lib/infra/report-error";
import type { PlaceReadConsumer } from "@/lib/place/flags";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export async function shadowIdPath<T>(
  consumer: PlaceReadConsumer,
  exec: Executor,
  run: (exec: Tx) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await exec.transaction((sp) => run(sp)) };
  } catch (error) {
    reportError(`place-shadow/${consumer}`, error, { consumer });
    return { ok: false };
  }
}
