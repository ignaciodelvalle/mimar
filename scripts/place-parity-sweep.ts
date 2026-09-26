#!/usr/bin/env tsx
/**
 * The place parity sweep — the flip gate for the `scope` consumer
 * (localidades-por-id D7).
 *
 * For every govt user with an active grant, compares what the name path and
 * the id path let them see (pets, cases, welfare reports) and classifies each
 * disagreement (lib/place/parity-sweep.ts, lib/place/shadow.ts). Read-only:
 * it runs inside a transaction that is always rolled back.
 *
 * The flip gate: zero `other` and zero `legacy_grant`. homonym_split,
 * spelling_join and unresolved_to_province are the change working;
 * unit_widening is a person's confirmed decision and is listed. Flipping
 * place_read_flags.scope to 'id' is an operator act AFTER this passes and the
 * runtime sink shows seven days with no blocking kind. The report goes to the
 * private operations repo, never to this one.
 *
 *   pnpm place:parity-sweep                  local database
 *   pnpm place:parity-sweep --json           machine-readable
 *   pnpm place:parity-sweep --allow-remote   non-local host
 *
 * Exits 1 when the gate fails.
 */

import "./_load-env";

import { TransactionRollbackError } from "drizzle-orm";

import { db } from "@/db";
import { type SweepReport, sweepScopeParity } from "@/lib/place/parity-sweep";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function targetHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

class ReadOnly extends Error {}

async function main(): Promise<number> {
  const host = targetHost();
  if (!LOCAL_HOSTS.has(host) && !process.argv.includes("--allow-remote")) {
    throw new Error(`refusing ${host}: a non-local database needs --allow-remote`);
  }
  let report: SweepReport | null = null;
  try {
    await db.transaction(async (tx) => {
      report = await sweepScopeParity(tx);
      throw new ReadOnly();
    });
  } catch (e) {
    if (!(e instanceof ReadOnly || e instanceof TransactionRollbackError)) throw e;
  }
  const r = report as SweepReport | null;
  if (!r) throw new Error("the sweep did not run");

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`[place-parity-sweep] host ${host}: ${r.usersSwept} govt user(s) swept`);
    console.log(`  disagreements by kind: ${JSON.stringify(r.counts)}`);
    for (const row of r.rows.filter((x) => x.kind === "other" || x.kind === "legacy_grant")) {
      console.log(
        `  BLOCKING ${row.kind}: user ${row.userId} ${row.subjectTable} ${row.subjectId}`,
      );
    }
    console.log(
      r.verdict.pass
        ? "  ✓ flip gate passes (no other, no legacy_grant)"
        : `  ✗ flip gate FAILS: ${JSON.stringify(r.verdict.blocking)}`,
    );
  }
  return r.verdict.pass ? 0 : 1;
}

if (process.argv[1]?.endsWith("place-parity-sweep.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(`[place-parity-sweep] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
