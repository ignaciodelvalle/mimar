#!/usr/bin/env tsx
/**
 * The coordinate pass over HOMONYM event_places rows — plan maestro A2,
 * 2026-10-07. DRY RUN ONLY: it counts, it never writes.
 *
 * The name pass (place:resolve-event-places-by-name) leaves a row unresolved
 * when its name matches more than one live locality of the province (7
 * Córdoba pairs on staging, plus others). This pass asks whether the row's
 * own event carries coordinates that sit clearly next to ONE of the
 * candidates' centroids, and reports, per pair, how many rows that would
 * settle and why the rest stay unresolved (no coordinates, a candidate with
 * no centroid, a point outside every candidate, or two candidates too close
 * to call). It never picks a winner otherwise. The logic and the thresholds
 * are lib/place/event-places-coordinate-pass.ts.
 *
 * There is no --apply: event_places' method CHECK (0250) has no value for "a
 * homonym settled by the event's coordinates", and that value is a decision
 * to take before any row is written.
 *
 *   pnpm place:resolve-event-places-by-coordinates
 *       against the LOCAL database (DATABASE_URL from .env.local, or the
 *       Supabase CLI default). The pass's own reads (event_places with the
 *       events' points, the candidates' centroids) each run in a short READ
 *       ONLY transaction. The homonym lookup does NOT: resolveName ->
 *       localitiesByName queries through the global pool, as plain SELECTs
 *       outside any transaction. Nothing in this script issues a write.
 *   ... --env-file <path> --allow-remote
 *       against another database, on purpose. A non-local host is refused
 *       without --allow-remote. NOT against staging until the PO asks for it.
 *
 * Prints the host and project ref, never a credential.
 */

import { existsSync } from "node:fs";

import { config as loadEnv } from "dotenv";

import type { CoordinatePassInventory } from "@/lib/place/event-places-coordinate-pass";

import { DEFAULT_LOCAL_URL, describeTarget, remoteSkipReason } from "./_db-target";

const LABEL = "place-resolve-event-places-by-coordinates";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function fail(message: string): never {
  console.error(`[${LABEL}] ${message}`);
  process.exit(2);
}

/** Why this run must not connect, or null. Exported for the test. */
export function refusal(
  rawUrl: string,
  allowRemote: boolean,
  argv: readonly string[],
): string | null {
  if (argv.includes("--apply")) {
    return "there is no --apply: this pass is a dry run until the method value is decided";
  }
  const reason = remoteSkipReason(describeTarget(rawUrl), allowRemote);
  return reason === null ? null : `${reason} Pass --allow-remote to read it on purpose.`;
}

async function main(): Promise<void> {
  const envFile = argValue("--env-file") ?? ".env.local";
  if (existsSync(envFile)) {
    const loaded = loadEnv({ path: envFile, override: true, quiet: true });
    if (loaded.error) fail(`cannot read ${envFile}: ${loaded.error.message}`);
  } else if (argValue("--env-file")) {
    fail(`no env file at ${envFile}`);
  }
  process.env.DATABASE_URL ??= DEFAULT_LOCAL_URL;
  const rawUrl = process.env.DATABASE_URL;
  const target = describeTarget(rawUrl);
  console.log(`[${LABEL}] database ${target.label}; mode: dry run (zero writes)`);
  const refused = refusal(rawUrl, process.argv.includes("--allow-remote"), process.argv);
  if (refused) fail(`refusing: ${refused}`);

  // The database modules load only now, after the env is settled.
  const { db } = await import("@/db");
  const { inventoryCoordinatePass } = await import("@/lib/place/event-places-coordinate-pass");
  const inv = await inventoryCoordinatePass(
    db,
    {},
    { run: (read) => db.transaction((tx) => read(tx), { accessMode: "read only" }) },
  );
  printInventory(inv);
  console.log(`\n[${LABEL}] dry run: nothing written.`);
}

function km(n: number | null): string {
  return n === null ? "-" : `${n.toFixed(1)} km`;
}

export function printInventory(inv: CoordinatePassInventory, log = console.log): void {
  const t = inv.totals;
  log(`\nunresolved event_places rows: ${inv.unresolvedRows}`);
  log(`  whose name is a homonym: ${inv.homonymRows} rows in ${inv.pairs.length} pair(s)`);
  log(
    `  settled by the event's coordinates: ${t.resolved} rows (spine-shaped, i.e. writable: ${t.resolvedWritable})`,
  );
  log(
    `  left unresolved: no coordinates ${t.byReason.no_coords}; candidate without centroid ${t.byReason.candidate_without_centroid}; outside every candidate ${t.byReason.outside_all}; too close to call ${t.byReason.too_close_to_call}`,
  );
  for (const p of inv.pairs) {
    log(`\n  ${p.provinceCode} / ${p.locality}: ${p.rows} rows (${p.writableRows} spine-shaped)`);
    for (const c of p.candidates) {
      const centroid = c.lat === null || c.lng === null ? "no centroid" : `${c.lat}, ${c.lng}`;
      log(
        `    candidate ${c.localityId.slice(0, 8)}… ${c.localityName} (${c.departmentName ?? "?"}) [${centroid}] chosen for ${p.chosen[c.localityId] ?? 0} row(s)`,
      );
    }
    log(
      `    unresolved: no_coords ${p.byReason.no_coords}, candidate_without_centroid ${p.byReason.candidate_without_centroid}, outside_all ${p.byReason.outside_all}, too_close_to_call ${p.byReason.too_close_to_call}`,
    );
  }
  const close = inv.decisions.filter(
    (d) => d.decision.verdict === "unresolved" && d.decision.reason === "too_close_to_call",
  );
  if (close.length > 0) {
    log("\n  too close to call (nearest / runner-up):");
    for (const d of close.slice(0, 10)) {
      if (d.decision.verdict !== "unresolved") continue;
      log(`    ${d.eventId}  ${km(d.decision.nearestKm)} / ${km(d.decision.runnerUpKm)}`);
    }
  }
}

if (process.argv[1]?.endsWith("place-resolve-event-places-by-coordinates.ts")) {
  main()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      const cause =
        e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
      console.error(`[${LABEL}] ${e instanceof Error ? e.message : String(e)}${cause}`);
      process.exit(1);
    });
}
