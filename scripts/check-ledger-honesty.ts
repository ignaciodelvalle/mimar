#!/usr/bin/env tsx
/**
 * db:doctor — does the DATABASE agree with what the migration ledger claims?
 *
 * Run:  pnpm db:doctor                    (judges DATABASE_URL, local only)
 *       pnpm db:doctor -- --allow-remote  (judges a remote database on purpose)
 *
 * NOT part of `pnpm verify`. It needs a live database and it is meant to be
 * pointed at a specific environment — staging before a cutover, production
 * after one. `pnpm verify` must stay runnable on a DB-less box.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-07-31, staging reported 156 migrations applied, zero pending, zero
 * checksum drift — a perfect bill of health — while 27 of its 53 public tables
 * had RLS switched OFF and the anon key served rows from profiles, pets and
 * audit_log (migration 0165's header records the measurement). The ledger was
 * not lying about itself; it was answering a different question than anyone
 * thought they were asking.
 *
 * The cause: `drizzle-kit push` builds tables from db/schema.ts, which carries
 * no RLS, and `migrate.ts --baseline` marks every file applied WITHOUT running
 * its SQL. Together they produce exactly that: right tables, right columns, no
 * RLS, and a ledger that says everything ran.
 *
 * `db:migrate --status` cannot catch this. It compares files to ledger ROWS —
 * both sides of that comparison are bookkeeping. Nothing in the toolchain ever
 * asked the database whether the SQL actually took effect. This script is that
 * question.
 *
 * WHAT IT CHECKS
 * --------------
 *   A. LEDGER INTEGRITY — bookkeeping vs. files. Every migration file has a
 *      ledger row, every checksum matches the bytes on disk, and no ledger row
 *      names a file that does not exist.
 *   B. REAL RLS STATE — bookkeeping vs. reality. Every public table actually
 *      has relrowsecurity = true and at least one policy (or is an intentional
 *      deny-all). Shares its query and its verdict logic with
 *      scripts/check-rls-coverage.ts so there is one definition of "has RLS".
 *   C. PROBES — bookkeeping vs. reality, spot-checked. A small manifest of
 *      high-value objects from recent migrations, each asserting the EFFECT of
 *      the SQL rather than the existence of its ledger row. A `--baseline`d
 *      database passes A and fails these.
 *
 * WHY IT REFUSES INSTEAD OF SKIPPING
 * ----------------------------------
 * The DB-backed fences in `pnpm verify` (lint:rls, lint:spine, lint:scope-authz)
 * SKIP with exit 0 when the database is remote or unreachable — correct there,
 * because a DB-less CI box must not fail the build. This script does the
 * opposite: an unreachable database, or a remote one without --allow-remote, is
 * a non-zero exit. A doctor whose silence reads as a clean bill of health is the
 * exact failure it was written to prevent.
 *
 * EXIT CODES
 *   0  every check passed against the named database
 *   1  at least one check failed (report names each one)
 *   2  could not run: no reachable database, or a remote target without opt-in
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { config as loadEnv } from "dotenv";
import postgres from "postgres";

import {
  DEFAULT_LOCAL_URL,
  type DbTarget,
  describeTarget,
  lines,
  remoteSkipReason,
} from "./_db-target";
import { checkFunctionParity } from "./check-function-parity";
import { DENY_ALL_ALLOWLIST, evaluateCoverage, fetchRlsCoverage } from "./check-rls-coverage";
import { checksum, listMigrationFiles } from "./migrate";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const MIGRATIONS_DIR = "db/migrations";
const TRACKING_TABLE = "_dim_migrations";

// ---------------------------------------------------------------------------
// C. Probe manifest
// ---------------------------------------------------------------------------
// Each probe asserts the EFFECT of a recent migration's SQL, expressed as a
// query returning exactly one boolean column `ok`. The point is not coverage —
// it is a tripwire: a database built by `drizzle-kit push` + `--baseline` has
// the tables and the ledger rows, so section A passes, and these fail.
//
// Choosing probes: prefer effects that a schema-only rebuild cannot reproduce —
// policies, defaults, dropped objects, nullability changes. A probe that merely
// asserts "column exists" is the weakest kind, because `push` creates columns;
// keep at most one and pick a column added by an ALTER, not by the table's
// original CREATE.

type Probe = {
  id: string;
  migration: string;
  /** What is true when the migration's SQL actually ran. */
  expectation: string;
  /** SQL returning one row, one boolean column named `ok`. */
  query: string;
};

const PROBES: Probe[] = [
  {
    id: "disclosure-defaults-fail-closed",
    migration: "0158",
    expectation: "pets.disclose_first_name_when_lost DEFAULTs to false",
    query: `
      SELECT coalesce(
        (SELECT column_default = 'false'
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name   = 'pets'
            AND column_name  = 'disclose_first_name_when_lost'),
        false) AS ok
    `,
  },
  {
    id: "identification-date-may-be-unknown",
    migration: "0161",
    expectation: "pet_identifications.recorded_at is NULLABLE",
    query: `
      SELECT coalesce(
        (SELECT is_nullable = 'YES'
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name   = 'pet_identifications'
            AND column_name  = 'recorded_at'),
        false) AS ok
    `,
  },
  {
    id: "unverified-jurisdiction-flag",
    migration: "0162",
    expectation: "welfare_reports.jurisdiction_unverified exists",
    query: `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'welfare_reports'
           AND column_name  = 'jurisdiction_unverified'
      ) AS ok
    `,
  },
  {
    id: "ownerships-no-postgrest-writes",
    migration: "0163",
    expectation: "ownerships has ZERO write policies and keeps its SELECT policy",
    query: `
      SELECT (
        (SELECT count(*) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'ownerships'
            AND cmd <> 'SELECT') = 0
        AND
        (SELECT count(*) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'ownerships'
            AND cmd = 'SELECT') >= 1
      ) AS ok
    `,
  },
  {
    id: "welfare-evidence-bucket-locked",
    migration: "0164",
    expectation: 'storage.objects has no "Anyone can upload welfare evidence" policy',
    query: `
      SELECT NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'storage'
           AND policyname = 'Anyone can upload welfare evidence'
      ) AS ok
    `,
  },
  {
    id: "share-telemetry-dropped",
    migration: "0167",
    expectation: "public.share_telemetry no longer exists",
    query: "SELECT to_regclass('public.share_telemetry') IS NULL AS ok",
  },
  {
    id: "pet-tags-select-own-only",
    migration: "0169",
    expectation: "pet_tags has exactly one SELECT policy and ZERO write policies",
    query: `
      SELECT (
        (SELECT count(*) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'pet_tags'
            AND cmd = 'SELECT') = 1
        AND
        (SELECT count(*) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'pet_tags'
            AND cmd <> 'SELECT') = 0
      ) AS ok
    `,
  },
  {
    id: "erase-scrubs-pet-tags",
    migration: "0170",
    expectation:
      "erase_subject_data's live body scrubs pet_tags (a push+baseline DB keeps the 0166 body)",
    query: `
      SELECT position('pet_tags_scrubbed' IN pg_get_functiondef(
        'public.erase_subject_data(uuid, text)'::regprocedure
      )) > 0 AS ok
    `,
  },
  {
    id: "audit-log-override-requires-actor",
    migration: "0182",
    expectation:
      "enforce_audit_log_append_only's live body requires app.allow_audit_mutation_actor (the E-3 drift class, for this exact function)",
    query: `
      SELECT position('allow_audit_mutation_actor' IN pg_get_functiondef(
        'public.enforce_audit_log_append_only()'::regprocedure
      )) > 0 AS ok
    `,
  },
];

// ---------------------------------------------------------------------------
// Report accumulation
// ---------------------------------------------------------------------------

type Section = { name: string; failures: string[]; note: string };

function reportSection(section: Section): void {
  if (section.failures.length === 0) {
    console.log(`✓ ${section.name} — ${section.note}`);
    return;
  }
  console.error(`✗ ${section.name} — ${section.failures.length} problem(s):`);
  for (const f of section.failures) console.error(`    ${f}`);
}

// ---------------------------------------------------------------------------
// A. Ledger integrity — files vs. ledger rows
// ---------------------------------------------------------------------------

type LedgerRow = { filename: string; checksum: string };

async function checkLedger(client: postgres.Sql): Promise<Section> {
  const failures: string[] = [];

  const files = listMigrationFiles(MIGRATIONS_DIR);
  const diskChecksums = new Map<string, string>();
  for (const f of files) {
    diskChecksums.set(f, checksum(readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")));
  }

  const tableExists = await client<{ r: string | null }[]>`
    SELECT to_regclass(${`public.${TRACKING_TABLE}`}) AS r
  `;
  if (tableExists[0].r === null) {
    failures.push(
      `public.${TRACKING_TABLE} does not exist — this database has never been migrated by scripts/migrate.ts. If it has application schema anyway, it was built by drizzle-kit push: the exact provenance that produced the 2026-07-31 staging incident.`,
    );
    return { name: "A. Ledger integrity", failures, note: "" };
  }

  const rows = await client<LedgerRow[]>`
    SELECT filename, checksum FROM public._dim_migrations
  `;
  const recorded = new Map(rows.map((r) => [r.filename, r.checksum]));

  for (const f of files) {
    const stored = recorded.get(f);
    if (stored === undefined) {
      failures.push(`${f} — on disk, NOT in the ledger (pending). Run pnpm db:migrate.`);
      continue;
    }
    const disk = diskChecksums.get(f) as string;
    if (disk !== stored) {
      failures.push(
        `${f} — checksum DRIFT. Ledger has ${stored.slice(0, 12)}…, the file hashes to ${disk.slice(0, 12)}…. The file was edited after being applied; this database no longer matches the committed SQL. Applied files are immutable — record prose corrections in docs/db/migration-errata.md instead.`,
      );
    }
  }

  for (const filename of recorded.keys()) {
    if (!diskChecksums.has(filename)) {
      failures.push(
        `${filename} — in the ledger, NOT on disk. A migration file was deleted or renamed after being applied; the database carries changes no committed file describes.`,
      );
    }
  }

  return {
    name: "A. Ledger integrity",
    failures,
    note: `${files.length} file(s), ${recorded.size} ledger row(s), checksums match.`,
  };
}

// ---------------------------------------------------------------------------
// B. Real RLS state — the check the ledger cannot do
// ---------------------------------------------------------------------------

async function checkRealRlsState(client: postgres.Sql): Promise<Section> {
  const failures: string[] = [];
  const rows = await fetchRlsCoverage(client);
  const { violations, allowlisted } = evaluateCoverage(rows);

  for (const v of violations) {
    failures.push(
      v.kind === "rls_disabled"
        ? `${v.table_name} — RLS is DISABLED in this database. A migration says it enabled it; the database disagrees. This is the 2026-07-31 staging shape.`
        : `${v.table_name} — RLS on, ZERO policies, and not in DENY_ALL_ALLOWLIST (scripts/check-rls-coverage.ts). Either add a policy or document the deny-all.`,
    );
  }

  // A table that is allowlisted as deny-all but no longer exists is not a
  // failure — it is stale bookkeeping worth naming, since the allowlist is how
  // a reviewer reasons about the PostgREST surface.
  const present = new Set(rows.map((r) => r.table_name));
  const staleAllowlist = Object.keys(DENY_ALL_ALLOWLIST).filter((t) => !present.has(t));

  const staleNote =
    staleAllowlist.length > 0
      ? ` NOTE: DENY_ALL_ALLOWLIST names ${staleAllowlist.length} table(s) absent from this database (${staleAllowlist.join(", ")}).`
      : "";

  return {
    name: "B. Real RLS state",
    failures,
    note: `${rows.length} table(s) checked; ${rows.length - allowlisted.length} have policies; ${allowlisted.length} intentional deny-all.${staleNote}`,
  };
}

// ---------------------------------------------------------------------------
// C. Probes — did recent SQL actually take effect?
// ---------------------------------------------------------------------------

async function checkProbes(client: postgres.Sql): Promise<Section> {
  const failures: string[] = [];

  for (const probe of PROBES) {
    let ok: boolean;
    try {
      const result = await client.unsafe<{ ok: boolean }[]>(probe.query);
      ok = result[0]?.ok === true;
    } catch (err) {
      failures.push(
        `${probe.id} (migration ${probe.migration}) — probe query FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!ok) {
      failures.push(
        `${probe.id} (migration ${probe.migration}) — expected: ${probe.expectation}. The ledger may say ${probe.migration} is applied; its SQL did not take effect here.`,
      );
    }
  }

  return {
    name: "C. Probes",
    failures,
    note: `${PROBES.length} probe(s) from migrations ${PROBES[0].migration}–${PROBES[PROBES.length - 1].migration} all hold.`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function refuse(reason: string, remedy: string, target: DbTarget): never {
  console.error(
    lines(
      "✗ db:doctor could not run.",
      `  ${reason}`,
      `  Database looked at: ${target.label}`,
      "  NOTHING was verified. This is a refusal, not a pass — a doctor that stays",
      "  quiet about an unexamined database is the failure it exists to prevent.",
      remedy,
    ),
  );
  process.exit(2);
}

export async function runDoctor(argv: string[] = []): Promise<void> {
  const allowRemote = argv.includes("--allow-remote");
  const rawUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
  const usingDefault = process.env.DATABASE_URL === undefined;
  const target = describeTarget(rawUrl);

  const remote = remoteSkipReason(target, allowRemote);
  if (remote !== null) {
    refuse(
      remote,
      lines(
        "  Auditing a remote database has to be deliberate, not a side effect of a stale shell.",
        "  This script is strictly read-only (SELECTs against pg_class, pg_policies,",
        "  information_schema and _dim_migrations). To audit staging on purpose:",
        "    pnpm db:doctor -- --allow-remote",
      ),
      target,
    );
  }

  const client = postgres(rawUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });

  try {
    const sections: Section[] = [];
    try {
      sections.push(await checkLedger(client));
      sections.push(await checkRealRlsState(client));
      sections.push(await checkProbes(client));
      // Section D (Lote B5): every repo-owned function's LIVE body vs the last
      // source that defines it — the general sweep for the E-3 drift class the
      // per-function probes above only spot-check.
      sections.push(await checkFunctionParity(client));
    } catch (err) {
      refuse(
        `Could not reach the database (${err instanceof Error ? err.message : String(err)}).`,
        lines(
          "  Start the local stack with pnpm db:start, or point DATABASE_URL at a reachable database.",
          "  Unlike the fences inside pnpm verify, an unreachable database is a FAILURE here:",
          "  db:doctor is invoked to examine one specific environment.",
        ),
        target,
      );
    }

    const origin = usingDefault ? "default local URL" : "DATABASE_URL";
    const remoteNote = target.isLocal ? "" : " [REMOTE — --allow-remote]";
    console.log(`\ndb:doctor — ${target.label} (from ${origin})${remoteNote}\n`);

    for (const section of sections) reportSection(section);

    const failed = sections.filter((s) => s.failures.length > 0);
    if (failed.length > 0) {
      console.error(
        lines(
          "",
          `✗ db:doctor FAILED — ${failed.length} of ${sections.length} section(s) disagree with the ledger.`,
          `  Database: ${target.label}`,
          "  A ledger row proves a file was RECORDED, never that its SQL RAN. Sections B and C",
          "  ask the database directly; when they fail while A passes, suspect a drizzle-kit push",
          "  plus migrate.ts --baseline (see migration 0165's header for the case that happened).",
        ),
      );
      process.exit(1);
    }

    console.log(
      lines(
        "",
        `✓ db:doctor clean — the database agrees with the ledger on all ${sections.length} sections.`,
        `  Database: ${target.label}`,
      ),
    );
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).endsWith("check-ledger-honesty.ts");

if (isMain) {
  runDoctor(process.argv.slice(2)).catch((err) => {
    console.error("✗ check-ledger-honesty: unexpected error:", err);
    process.exit(1);
  });
}
