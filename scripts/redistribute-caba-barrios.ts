/**
 * DIM One-Shot Migration — redistribute-caba-barrios.ts
 *
 * Reassigns the CABA "whole-city placeholder" jurisdiction blob to the 48 real
 * barrios so the government panorama reads as a real by-barrio distribution
 * instead of one undifferentiated lump.
 *
 * ─── THE PROBLEM ───────────────────────────────────────────────────────────
 *   INDEC models CABA as a SINGLE locality ("Ciudad Autónoma de Buenos Aires",
 *   category='componente' — the whole-city operator placeholder, NOT a barrio).
 *   The 48 barrios (Ley CABA 1.777) live in ar_localities but WITHOUT
 *   coordinates, so scripts/seed-panorama.ts (which filters `latitude IS NOT
 *   NULL`) skipped them and every CABA pet fell back to the placeholder. When a
 *   funcionario logs in as the CABA whole-city operator (govt@dim.test) the
 *   panorama/queues therefore show CABA as ONE blob. Other provinces are fine.
 *
 * ─── WHAT THIS DOES ────────────────────────────────────────────────────────
 *   1. pets              — every CABA pet at the placeholder is reassigned to a
 *                          real barrio, weighted by ~census population and keyed
 *                          off a stable hash of the pet id (Postgres hashtext),
 *                          so bigger barrios (Palermo, Caballito, Recoleta,
 *                          Flores, Belgrano…) get more and every barrio gets
 *                          some — deterministic and re-runnable.
 *   2. pet_events        — outbreak_signal payloads snapshot pet_jurisdiction_*
 *                          (the ONLY event type that does — see lib/metrics/
 *                          scope.ts). Placeholder CABA snapshots are set to the
 *                          pet's NEW barrio via a join, keeping the zoonosis /
 *                          surveillance panorama layers aligned with the pets.
 *   3. cases             — CABA cases at the placeholder (lost_pet_episode,
 *                          custody_episode/decomiso, custody_dispute) inherit
 *                          their primary pet's new barrio via a join.
 *   4. custody_disputes  — same, via pet_id.
 *   5. welfare_reports   — denuncias with a subject pet inherit the pet's barrio;
 *                          standalone denuncias (no pet) spread across barrios by
 *                          a stable hash of their own id.
 *   Coordinates (lat/lng) are NEVER touched — only the locality label snapshots.
 *   Non-CABA rows are NEVER touched.
 *
 * ─── IDEMPOTENCY ───────────────────────────────────────────────────────────
 *   Every statement keys off `jurisdiction_locality = <placeholder>`, so once a
 *   row is on a real barrio it is skipped. The hash keeps assignments stable, so
 *   re-running converges to the exact same distribution.
 *
 * ─── LOCAL-ONLY GUARD ──────────────────────────────────────────────────────
 *   Refuses a non-local DATABASE_URL host unless --allow-remote is passed.
 *   ALWAYS refuses when NODE_ENV=production. Mirrors seed-panorama.ts /
 *   seed-flagship-pampa.ts (exit code 4 on guard failure).
 *
 * ─── CLI FLAGS ─────────────────────────────────────────────────────────────
 *   --allow-remote   Target a non-local DB (staging).
 *   --dry-run        Print the plan (counts only) and exit without writing.
 *
 * Usage (local):
 *   pnpm redistribute:caba-barrios
 *   pnpm redistribute:caba-barrios -- --dry-run
 * Usage (staging — Ignacio only, .env points at staging):
 *   pnpm redistribute:caba-barrios -- --allow-remote
 */

// ---------------------------------------------------------------------------
// 0. Static (side-effect-free) imports — pure data, safe before env bootstrap
// ---------------------------------------------------------------------------

import {
  CABA_BARRIOS,
  CABA_PLACEHOLDER_LOCALITY,
  CABA_PROVINCE,
  CABA_TOTAL_WEIGHT,
} from "./caba-barrios-data";

// ---------------------------------------------------------------------------
// 1. Env bootstrap (must run before db/index.ts is imported)
// ---------------------------------------------------------------------------

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ---------------------------------------------------------------------------
// 2. Parse CLI flags + safety guards
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const ALLOW_REMOTE = argv.includes("--allow-remote");
const DRY_RUN = argv.includes("--dry-run");

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal", "::1"]);

function parsePgHost(url: string): string | null {
  const match = url.match(/^postgres(?:ql)?:\/\/[^@]+@([^:/]+)/);
  return match ? match[1] : null;
}

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env.local — aborting.");
  process.exit(2);
}

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run: NODE_ENV=production. Aborting.");
  process.exit(2);
}

const dbHost = parsePgHost(DATABASE_URL);
const isLocalDb = dbHost ? LOCAL_HOSTS.has(dbHost) : true;

if (!ALLOW_REMOTE && !isLocalDb) {
  console.error(
    [
      "",
      "==============================================================",
      "  ABORT: redistribute-caba-barrios target is NOT a local Postgres.",
      "==============================================================",
      `  DATABASE_URL host : ${dbHost ?? "(not set)"}`,
      `  Allowed local hosts: ${[...LOCAL_HOSTS].join(", ")}`,
      "",
      "  This script relabels production jurisdiction data. Running it",
      "  against a remote DB by mistake is a real incident.",
      "",
      "  If you meant to target this host, re-run with --allow-remote.",
      "==============================================================",
      "",
    ].join("\n"),
  );
  process.exit(4);
}

if (ALLOW_REMOTE && !isLocalDb) {
  console.warn(
    [
      "",
      "==============================================================",
      "  WARNING: --allow-remote in effect.",
      `  DATABASE_URL host: ${dbHost}`,
      "  About to relabel CABA jurisdiction data on a REMOTE database.",
      "==============================================================",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 3. Deferred imports (after env is populated)
// ---------------------------------------------------------------------------

const { sql } = await import("drizzle-orm");
const { db } = await import("../db");

// ---------------------------------------------------------------------------
// 4. Helpers + logging
// ---------------------------------------------------------------------------

type LogTag = "STEP" | "OK" | "SKIP" | "WARN" | "INFO" | "DONE" | "FAIL";
function log(tag: LogTag, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${tag.padEnd(4)}] ${msg}`);
}

function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

const PLACEHOLDER = escapeSqlLiteral(CABA_PLACEHOLDER_LOCALITY);
const PROVINCE = escapeSqlLiteral(CABA_PROVINCE);

/**
 * A CTE holding (name, cum) where `cum` is the running cumulative UPPER bound of
 * each barrio's weight. Referenced by the weighted-pick scalar subquery below.
 * The first row is type-cast so Postgres infers text/int for the VALUES list.
 */
function barriosCte(): string {
  let cum = 0;
  const rows = CABA_BARRIOS.map((b, i) => {
    cum += b.weight;
    const name = `'${escapeSqlLiteral(b.name)}'${i === 0 ? "::text" : ""}`;
    const c = `${cum}${i === 0 ? "::int" : ""}`;
    return `(${name}, ${c})`;
  });
  return `caba_b(name, cum) AS (VALUES ${rows.join(", ")})`;
}

/**
 * Scalar subquery: deterministic weighted barrio pick from a text key expression
 * (e.g. `p.id::text`). Same key → same barrio. Requires the `caba_b` CTE to be
 * in scope. `hashtext` is a stable built-in; `& 2147483647` masks it to a
 * non-negative 31-bit int before the modulo.
 */
function pickExpr(keyExpr: string): string {
  return `(SELECT cb.name FROM caba_b cb
           WHERE (hashtext(${keyExpr}) & 2147483647) % ${CABA_TOTAL_WEIGHT} < cb.cum
           ORDER BY cb.cum ASC LIMIT 1)`;
}

async function scalarCount(query: string): Promise<number> {
  const rows = (await db.execute(sql.raw(query))) as unknown as Array<{ n: number | string }>;
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// 5. Pre-flight counts (the "before" picture)
// ---------------------------------------------------------------------------

const CABA_PET_FILTER = `jurisdiction_province = '${PROVINCE}' AND jurisdiction_locality = '${PLACEHOLDER}'`;

async function reportBefore(): Promise<void> {
  const pets = await scalarCount(`SELECT count(*)::int AS n FROM pets WHERE ${CABA_PET_FILTER}`);
  const events = await scalarCount(
    `SELECT count(*)::int AS n FROM pet_events
     WHERE (payload->>'pet_jurisdiction_province') = '${PROVINCE}'
       AND (payload->>'pet_jurisdiction_locality') = '${PLACEHOLDER}'`,
  );
  const cases = await scalarCount(`SELECT count(*)::int AS n FROM cases WHERE ${CABA_PET_FILTER}`);
  const disputes = await scalarCount(
    `SELECT count(*)::int AS n FROM custody_disputes WHERE ${CABA_PET_FILTER}`,
  );
  const welfare = await scalarCount(
    `SELECT count(*)::int AS n FROM welfare_reports WHERE ${CABA_PET_FILTER}`,
  );

  log("INFO", "── BEFORE (rows still on the CABA whole-city placeholder) ──");
  log("INFO", `  pets              : ${pets}`);
  log("INFO", `  pet_events (snap) : ${events}`);
  log("INFO", `  cases             : ${cases}`);
  log("INFO", `  custody_disputes  : ${disputes}`);
  log("INFO", `  welfare_reports   : ${welfare}`);
}

async function reportPerBarrio(): Promise<void> {
  const rows = (await db.execute(
    sql.raw(
      `SELECT jurisdiction_locality AS barrio, count(*)::int AS n
       FROM pets
       WHERE jurisdiction_province = '${PROVINCE}' AND jurisdiction_locality IS NOT NULL
       GROUP BY jurisdiction_locality
       ORDER BY n DESC`,
    ),
  )) as unknown as Array<{ barrio: string; n: number | string }>;

  log("INFO", "── AFTER (CABA pets per barrio) ──");
  let total = 0;
  for (const r of rows) {
    total += Number(r.n);
    log("INFO", `  ${String(r.barrio).padEnd(24)} ${r.n}`);
  }
  log("INFO", `  ${"TOTAL".padEnd(24)} ${total} across ${rows.length} localities`);
}

// ---------------------------------------------------------------------------
// 6. The migration statements
// ---------------------------------------------------------------------------

async function runUpdate(label: string, query: string): Promise<void> {
  // postgres-js returns a RowList whose `.count` is the affected-row count for
  // UPDATE/DELETE (drizzle's `execute` passes the raw result through).
  const res = (await db.execute(sql.raw(query))) as unknown as { count?: number };
  const n = typeof res?.count === "number" ? res.count : undefined;
  log("OK", `${label}${n !== undefined ? ` — ${n} rows` : ""}`);
}

/** A valid profile id, required as the accountable actor for the append-only override. */
async function findActorProfileId(): Promise<string> {
  const rows = (await db.execute(sql.raw("SELECT id FROM profiles LIMIT 1"))) as unknown as Array<{
    id: string;
  }>;
  if (!rows[0]?.id) {
    throw new Error(
      "No profile row found — cannot set app.allow_event_mutation_actor for the override.",
    );
  }
  return rows[0].id;
}

/**
 * pet_events is append-only (invariant #2 — enforce_pet_events_append_only,
 * migration 0127). Mutating a payload requires the SANCTIONED override:
 * `app.allow_event_mutation=true` + `app.allow_event_mutation_actor=<uuid>`,
 * set transaction-locally (same path seed-panorama's runClean uses). We only
 * relabel the jurisdiction SNAPSHOT — the append-only spine (event rows, types,
 * timestamps) is untouched.
 */
async function runEventUpdate(label: string, actorId: string, query: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw("SELECT set_config('app.allow_event_mutation', 'true', true)"));
    await tx.execute(
      sql.raw(
        `SELECT set_config('app.allow_event_mutation_actor', '${escapeSqlLiteral(actorId)}', true)`,
      ),
    );
    const res = (await tx.execute(sql.raw(query))) as unknown as { count?: number };
    const n = typeof res?.count === "number" ? res.count : undefined;
    log("OK", `${label}${n !== undefined ? ` — ${n} rows` : ""}`);
  });
}

async function migrate(): Promise<void> {
  const cte = barriosCte();
  const actorId = await findActorProfileId();

  // 1. Pets — weighted, hash-stable barrio per pet.
  await runUpdate(
    "pets → barrios",
    `WITH ${cte}
     UPDATE pets p
     SET jurisdiction_locality = ${pickExpr("p.id::text")}, updated_at = now()
     WHERE p.jurisdiction_province = '${PROVINCE}'
       AND p.jurisdiction_locality = '${PLACEHOLDER}'`,
  );

  // 2. pet_events — outbreak_signal (and any other snapshot-carrier) inherits the
  //    pet's NEW barrio. Keyed off the payload placeholder so it is idempotent.
  //    Append-only override required (see runEventUpdate).
  await runEventUpdate(
    "pet_events snapshot → pet barrio",
    actorId,
    `UPDATE pet_events e
     SET payload = jsonb_set(e.payload, '{pet_jurisdiction_locality}', to_jsonb(p.jurisdiction_locality))
     FROM pets p
     WHERE e.pet_id = p.id
       AND (e.payload->>'pet_jurisdiction_province') = '${PROVINCE}'
       AND (e.payload->>'pet_jurisdiction_locality') = '${PLACEHOLDER}'`,
  );

  // 3. cases with a primary pet — inherit the pet's barrio.
  await runUpdate(
    "cases → primary pet barrio",
    `UPDATE cases c
     SET jurisdiction_locality = p.jurisdiction_locality, updated_at = now()
     FROM pets p
     WHERE c.primary_pet_id = p.id
       AND c.jurisdiction_province = '${PROVINCE}'
       AND c.jurisdiction_locality = '${PLACEHOLDER}'`,
  );

  // 3b. cases with no primary pet (fallback) — spread by hash of the case id.
  await runUpdate(
    "cases (no pet) → hashed barrio",
    `WITH ${cte}
     UPDATE cases c
     SET jurisdiction_locality = ${pickExpr("c.id::text")}, updated_at = now()
     WHERE c.primary_pet_id IS NULL
       AND c.jurisdiction_province = '${PROVINCE}'
       AND c.jurisdiction_locality = '${PLACEHOLDER}'`,
  );

  // 4. custody_disputes — inherit the pet's barrio (jurisdiction_locality NOT NULL).
  await runUpdate(
    "custody_disputes → pet barrio",
    `UPDATE custody_disputes d
     SET jurisdiction_locality = p.jurisdiction_locality
     FROM pets p
     WHERE d.pet_id = p.id
       AND d.jurisdiction_province = '${PROVINCE}'
       AND d.jurisdiction_locality = '${PLACEHOLDER}'`,
  );

  // 5. welfare_reports with a subject pet — inherit the pet's barrio.
  await runUpdate(
    "welfare_reports (with pet) → pet barrio",
    `UPDATE welfare_reports w
     SET jurisdiction_locality = p.jurisdiction_locality
     FROM pets p
     WHERE w.subject_pet_id = p.id
       AND w.jurisdiction_province = '${PROVINCE}'
       AND w.jurisdiction_locality = '${PLACEHOLDER}'`,
  );

  // 5b. welfare_reports standalone (no subject pet) — spread by hash of the id.
  await runUpdate(
    "welfare_reports (standalone) → hashed barrio",
    `WITH ${cte}
     UPDATE welfare_reports w
     SET jurisdiction_locality = ${pickExpr("w.id::text")}
     WHERE w.subject_pet_id IS NULL
       AND w.jurisdiction_province = '${PROVINCE}'
       AND w.jurisdiction_locality = '${PLACEHOLDER}'`,
  );
}

// ---------------------------------------------------------------------------
// 7. Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(
    "INFO",
    `Redistribute CABA barrios — host ${dbHost ?? "(local)"}${DRY_RUN ? " [DRY-RUN]" : ""}`,
  );
  log("INFO", `Placeholder locality: "${CABA_PLACEHOLDER_LOCALITY}" → 48 barrios`);

  await reportBefore();

  if (DRY_RUN) {
    log("DONE", "Dry-run complete — no rows written.");
    return;
  }

  await migrate();
  await reportPerBarrio();

  log("DONE", "CABA barrio redistribution complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("\n[FATAL]", err);
    process.exit(1);
  });
