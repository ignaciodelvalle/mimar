#!/usr/bin/env tsx
/**
 * The name pass over UNRESOLVED event_places rows (PO decision 2026-10-06).
 *
 * `place:backfill-event-places` writes a row UNRESOLVED when the pet's home
 * per spine was recorded by name alone. On staging that left 141,427 of
 * 141,935 rows province-level. This pass asks THE resolver (resolveName: one
 * live row of the province, never the first homonym) once per distinct
 * (province, name) pair and, with --apply, writes the id only on the
 * backfill's own (spine-shaped) rows whose pair names exactly one row, with
 * the resolver's method (exact_name_unique / folded_name_unique). Rows the
 * 0250 trigger projected, ambiguous names and unknown names are never
 * touched. The logic is lib/place/event-places-name-pass.ts.
 *
 * RE-RUN IT AFTER EVERY PROJECTION REBUILD: place:backfill-event-places
 * writes name-only homes unresolved by design, and this pass is what gives
 * the unique ones their id.
 *
 *   pnpm place:resolve-event-places-by-name --target local
 *       dry run (the default) against the local database: zero writes.
 *   pnpm place:resolve-event-places-by-name --target staging [--env-file <path>]
 *       dry run against staging. Loads ONLY the env file (default
 *       .env.staging.local), and refuses unless BOTH the database and the
 *       Supabase URL are remote and name the STAGING project
 *       (STAGING_PROJECT_REF — production shares the pooler host).
 *   ... --apply --expect-unique <n>
 *       write, 50 rows per transaction; idempotent and resumable. <n> is the
 *       "rows to write" a dry run printed: the run refuses when the fresh
 *       inventory finds a different number. Against staging only after the PO
 *       has seen the dry run.
 *
 * Without --target it refuses: there is no default environment.
 * Prints hosts and a project ref prefix, never a credential.
 */

import { existsSync } from "node:fs";

import { config as loadEnv } from "dotenv";

import type { NamePassInventory } from "@/lib/place/event-places-name-pass";

import { STAGING_PROJECT_REF, isLocalUrl } from "./_env-target";

const LABEL = "place-resolve-event-places-by-name";

export type Target = "local" | "staging";

/** Host and the first 6 characters of the Supabase project ref; no credentials. */
export function describeHost(url: string | undefined): string {
  if (!url) return "(unset)";
  const host = url
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/.*@/, "")
    .replace(/[/?].*/, "");
  const ref = projectRef(url);
  if (!ref) return host;
  const short = `${ref.slice(0, 6)}…`;
  return `${host.split(ref).join(short)} (ref ${short})`;
}

/** The Supabase project ref an URL names (pooler user, direct host or API host). */
export function projectRef(url: string | undefined): string | null {
  if (!url) return null;
  const noScheme = url.replace(/^[a-z+]+:\/\//i, "");
  const userInfo = noScheme.includes("@") ? noScheme.slice(0, noScheme.lastIndexOf("@")) : "";
  const host = noScheme.replace(/.*@/, "").replace(/[/?].*/, "");
  return (
    userInfo.match(/^[^:]*\.([a-z0-9]{20})/i)?.[1] ??
    host.match(/(?:^|\.)([a-z0-9]{20})\.supabase\.(?:co|com)/i)?.[1] ??
    null
  );
}

/**
 * Why the loaded env does not match the requested target, or null. Both URLs
 * are checked: a half-loaded env splits Drizzle and Auth across environments.
 */
export function targetProblem(
  target: Target,
  databaseUrl: string | undefined,
  supabaseUrl: string | undefined,
  stagingRef: string = STAGING_PROJECT_REF,
): string | null {
  if (!databaseUrl) return "DATABASE_URL is not set";
  if (!supabaseUrl) return "NEXT_PUBLIC_SUPABASE_URL is not set";
  const dbLocal = isLocalUrl(databaseUrl);
  const apiLocal = isLocalUrl(supabaseUrl);
  if (target === "local") {
    return dbLocal && apiLocal ? null : "--target local needs BOTH hosts local";
  }
  if (dbLocal || apiLocal) return "--target staging needs BOTH hosts remote";
  const dbRef = projectRef(databaseUrl);
  const apiRef = projectRef(supabaseUrl);
  if (!dbRef || !apiRef) return "cannot read the project ref from both URLs";
  if (dbRef !== apiRef) return "the database and the Supabase URL name DIFFERENT projects";
  if (dbRef !== stagingRef) return "the project is NOT staging (production shares the pooler host)";
  return null;
}

/**
 * Why an apply must not start, or null: it needs --expect-unique with the
 * number of rows the dry run said it would write, and the fresh inventory must
 * find exactly that many.
 */
export function expectUniqueProblem(expected: string | null, actual: number): string | null {
  if (expected === null) return "--apply needs --expect-unique <rows to write, from the dry run>";
  if (!/^\d+$/.test(expected)) return `--expect-unique must be a whole number, got "${expected}"`;
  if (Number(expected) !== actual) {
    return `--expect-unique ${expected} but the inventory finds ${actual} rows to write`;
  }
  return null;
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function fail(message: string): never {
  console.error(`[${LABEL}] ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const target = argValue("--target");
  if (target !== "local" && target !== "staging") {
    fail("refusing: pass --target local or --target staging");
  }
  const apply = process.argv.includes("--apply");
  if (apply && process.argv.includes("--dry-run")) fail("--apply and --dry-run are exclusive");

  // ONLY the target's env file, overriding the shell: no second file may
  // complete the variables it lacks (the split-env failure).
  const envFile =
    argValue("--env-file") ?? (target === "staging" ? ".env.staging.local" : ".env.local");
  if (!existsSync(envFile)) fail(`no env file at ${envFile}`);
  const loaded = loadEnv({ path: envFile, override: true, quiet: true });
  if (loaded.error) fail(`cannot read ${envFile}: ${loaded.error.message}`);
  console.log(
    `[${LABEL}] env ${envFile}: ${Object.keys(loaded.parsed ?? {}).length} variable(s) loaded`,
  );
  console.log(`  database host ${describeHost(process.env.DATABASE_URL)}`);
  console.log(`  supabase host ${describeHost(process.env.NEXT_PUBLIC_SUPABASE_URL)}`);
  const problem = targetProblem(
    target,
    process.env.DATABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  if (problem) fail(`refusing: ${problem}`);
  console.log(`  target ${target} confirmed; mode ${apply ? "APPLY" : "dry run (zero writes)"}`);

  // The database modules load only now, after the env is settled.
  const { db } = await import("@/db");
  const { inventoryNamePass, applyNamePass, APPLY_BATCH } = await import(
    "@/lib/place/event-places-name-pass"
  );

  // Every inventory read (both modes) runs in its own short READ ONLY
  // transaction: the database itself refuses a write there, and none stays
  // open long enough for the pooler to close it. The resolver's catalogue
  // reads are plain SELECTs. Only applyNamePass writes.
  const log = (line: string) => console.log(line);
  const inv: NamePassInventory = await inventoryNamePass(
    db,
    {},
    {
      log,
      run: (read) => db.transaction((tx) => read(tx), { accessMode: "read only" }),
    },
  );

  printInventory(inv);

  if (apply) {
    const mismatch = expectUniqueProblem(argValue("--expect-unique"), inv.projection.write.rows);
    if (mismatch) fail(`refusing: ${mismatch}`);
  }
  if (!apply) {
    console.log(`\n[${LABEL}] dry run: nothing written.`);
    return;
  }
  console.log(`\n[${LABEL}] applying in transactions of ${APPLY_BATCH} rows...`);
  const res = await applyNamePass(db, inv, (r) => {
    if (r.batches % 200 === 0) console.log(`  ${r.batches} batches, ${r.updated} rows updated`);
  });
  console.log(
    `  done: ${res.batches} batches; updated ${res.updated}; skipped (no longer unresolved, catalogue row gone, or a homonym appeared) ${res.skipped}`,
  );
}

function pct(n: number, of: number): string {
  return of === 0 ? "0%" : `${((100 * n) / of).toFixed(1)}%`;
}

function printInventory(inv: NamePassInventory): void {
  const p = inv.projection;
  const total = p.before.resolved + p.before.unresolved;
  console.log(
    `\nevent_places now: ${total} rows; resolved ${p.before.resolved}; UNRESOLVED ${p.before.unresolved}`,
  );

  console.log("\nunresolved rows by `entered` keys (source):");
  for (const s of inv.enteredKeyShapes) {
    console.log(`  ${String(s.rows).padStart(8)}  {${s.keys}}  source=${s.source ?? "-"}`);
  }
  console.log(
    `  by shape: spine ${inv.rowsByShape.spine}; event_place ${inv.rowsByShape.event_place}; unknown ${inv.rowsByShape.unknown}`,
  );

  console.log("\nspine events behind the spine-shaped rows (payload keys present):");
  for (const s of inv.spineSources) {
    console.log(
      `  ${String(s.rows).padStart(8)} rows / ${String(s.spineEvents).padStart(6)} events  ${s.eventType}  {${s.keys}}`,
    );
  }

  console.log(`\ndistinct (province, locality) pairs: ${inv.pairs.length}`);
  console.log(
    `  unique    ${String(p.pairs.unique).padStart(6)} pairs  ${String(p.rows.unique).padStart(8)} rows  (exact spelling ${inv.uniqueBy.exact_name_unique} pairs, folded ${inv.uniqueBy.folded_name_unique})`,
  );
  console.log(
    `            rows to write (spine-shaped): ${p.write.rows} (exact_name_unique ${p.write.exactRows}, folded_name_unique ${p.write.foldedRows}); held back (trigger-shaped) ${p.heldUniqueRows}`,
  );
  console.log(
    `  ambiguous ${String(p.pairs.ambiguous).padStart(6)} pairs  ${String(p.rows.ambiguous).padStart(8)} rows`,
  );
  console.log(
    `  none      ${String(p.pairs.none).padStart(6)} pairs  ${String(p.rows.none).padStart(8)} rows  (not in catalogue ${p.noneRowsBy.not_in_catalogue}, no locality ${p.noneRowsBy.no_locality}, unknown province ${p.noneRowsBy.unknown_province})`,
  );

  const top = (verdict: "unique" | "ambiguous" | "none", n: number) =>
    [...inv.pairs]
      .filter((x) => x.verdict === verdict)
      .sort((a, b) => b.rows - a.rows)
      .slice(0, n);
  for (const v of ["unique", "ambiguous", "none"] as const) {
    const rows = top(v, v === "unique" ? 10 : 15);
    if (rows.length === 0) continue;
    console.log(`\n  top ${v} pairs:`);
    for (const x of rows) {
      console.log(
        `    ${String(x.rows).padStart(7)}  ${x.provinceCode ?? `? (entered "${x.enteredProvince ?? ""}")`} / ${x.locality ?? "(none)"}${x.noneReason ? `  [${x.noneReason}]` : ""}`,
      );
    }
  }

  console.log(
    `\nprojection: resolved ${p.before.resolved} -> ${p.after.resolved} (${pct(p.after.resolved, total)}); unresolved ${p.before.unresolved} -> ${p.after.unresolved} (${pct(p.after.unresolved, total)})`,
  );
}

if (process.argv[1]?.endsWith("place-resolve-event-places-by-name.ts")) {
  main()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      const cause =
        e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
      console.error(`[${LABEL}] ${e instanceof Error ? e.message : String(e)}${cause}`);
      process.exit(1);
    });
}
