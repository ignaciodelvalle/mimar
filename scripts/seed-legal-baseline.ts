// seed-legal-baseline — idempotent applier for the versioned legal-baseline
// dataset (jurisdiction-compliance WU2, spec BD2-BD6).
//
// ⚠️ LEGAL-LIABILITY GATE (fail-closed BEFORE any DB connection):
//   1. The dataset checksum must match its committed manifest
//      (data/legal-baseline/<version>.manifest.json) — spec BD5.
//   2. The run must carry `--approved-checksum <sha256>` equal to that hash.
//   3. The run must carry `--signoff-file <path>` pointing to an approval
//      record whose sha256 equals that hash and which names the engram
//      decision `sdd/jurisdiction-compliance/baseline-signoff` — spec BD4.
//      The sign-off record is written ONLY AFTER the PO records that engram
//      decision; producing it is a PO action, never an implementer's.
//   Any refusal exits 1 before a single row is read or written.
//
// Write semantics (spec BD2/BD3/BD6):
//   - Upsert keyed on the govt_business_rules_type_jurisdiction_unique
//     constraint (rule_type, country, province, locality — NULLS NOT
//     DISTINCT), so re-runs never duplicate rows.
//   - Admin-authored rows (`baseline_version IS NULL`) are NEVER clobbered:
//     the ON CONFLICT update carries an explicit
//     `WHERE baseline_version IS NOT NULL` guard.
//   - Seeded rows are stamped with `baseline_version` (origin badge).
//   - Every insert/update writes the SAME audit_log row the console's server
//     action writes (create-business-rule.ts / update-business-rule.ts), so
//     /admin/inteligencia B4 diffs and panorama rule-change markers see
//     baseline seeding like any other rule change. Unchanged rows write
//     nothing (idempotent re-runs are audit-silent).
//   - None of the baseline rule types registers a reevalHook
//     (lib/infra/rule-types-effects.ts covers only the PPP types), so the
//     seed skips the console's post-commit reeval step. Revisit if
//     BASELINE_RULE_KEYS ever widens to a hook-carrying type.
//
// Usage (applying to staging/production is Ignacio-gated regardless):
//   pnpm seed:legal-baseline --write-manifest
//   pnpm seed:legal-baseline --approved-checksum <sha256> \
//     --signoff-file data/legal-baseline/ar-v1.signoff.json [--actor <uuid>]
//
// `--dataset <version>` selects which dataset to act on; it DEFAULTS to ar-v1,
// so the PO's signed runbook command (which passes no --dataset) is unchanged.
//   pnpm seed:legal-baseline --dataset ar-v2 --write-manifest

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { auditLog, govtBusinessRules } from "@/db/schema";

import { AR_V1 } from "../data/legal-baseline/ar-v1";
import { AR_V2 } from "../data/legal-baseline/ar-v2";
import {
  type LegalBaselineDataset,
  type LegalBaselineRow,
  legalBaselineDatasetSchema,
} from "../data/legal-baseline/schema";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every dataset version the CLI can address, keyed by its version tag.
 *
 * `--dataset` DEFAULTS to ar-v1 on purpose: the PO's signed runbook invokes
 * this script with no such flag, so its behaviour must stay byte-identical to
 * before this registry existed. A newer draft is opt-in, never the default —
 * a dataset only reaches a DB when someone names it AND clears the sign-off
 * gate for that exact version.
 */
const DATASETS: Record<string, LegalBaselineDataset> = {
  [AR_V1.version]: AR_V1,
  [AR_V2.version]: AR_V2,
};
const DEFAULT_DATASET_VERSION = AR_V1.version;

type DbHandle = PostgresJsDatabase<typeof import("@/db/schema")>;

// ---------------------------------------------------------------------------
// Checksum + manifest (spec BD3/BD4)
// ---------------------------------------------------------------------------

/**
 * The checksum covers the CANONICAL DATASET CONTENT (JSON serialization of the
 * validated object), not the .ts file bytes: it captures exactly what reaches
 * the DB, and is immune to CRLF/formatting churn that never changes a row.
 */
export const CHECKSUM_BASIS = "sha256(JSON.stringify(dataset))";

export function computeDatasetChecksum(dataset: LegalBaselineDataset): string {
  return createHash("sha256").update(JSON.stringify(dataset), "utf8").digest("hex");
}

export const baselineManifestSchema = z
  .object({
    version: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    rowCount: z.number().int().min(1),
    checksumBasis: z.string(),
  })
  .strict();
export type BaselineManifest = z.infer<typeof baselineManifestSchema>;

export function buildManifest(dataset: LegalBaselineDataset): BaselineManifest {
  return {
    version: dataset.version,
    sha256: computeDatasetChecksum(dataset),
    rowCount: dataset.rows.length,
    checksumBasis: CHECKSUM_BASIS,
  };
}

// ---------------------------------------------------------------------------
// Sign-off gate (spec BD4/BD5)
// ---------------------------------------------------------------------------

/** Engram decision the PO must record BEFORE the sign-off record is written. */
export const BASELINE_SIGNOFF_DECISION = "sdd/jurisdiction-compliance/baseline-signoff";

export const baselineSignoffSchema = z
  .object({
    version: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Must equal BASELINE_SIGNOFF_DECISION — the record is only a pointer to
     * the real approval, which lives in engram. */
    engramDecision: z.string(),
    approvedBy: z.string().min(1),
    approvedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  })
  .strict();
export type BaselineSignoff = z.infer<typeof baselineSignoffSchema>;

export type GateInput = {
  dataset: LegalBaselineDataset;
  manifest: BaselineManifest | null;
  approvedChecksum: string | null;
  signoff: BaselineSignoff | null;
};

/**
 * Every reason the seed must refuse, or [] when cleared to write. Pure — no
 * DB, no filesystem — so the refusal paths are unit-testable and provably run
 * before any connection exists.
 */
export function collectRefusals(input: GateInput): string[] {
  const refusals: string[] = [];

  const parsed = legalBaselineDatasetSchema.safeParse(input.dataset);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      refusals.push(`dataset invalid at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return refusals; // checksum of an invalid dataset proves nothing
  }

  const checksum = computeDatasetChecksum(input.dataset);

  if (input.manifest === null) {
    refusals.push("manifest missing — run with --write-manifest and commit it first (spec BD3)");
  } else {
    if (input.manifest.sha256 !== checksum) {
      refusals.push(
        `manifest checksum mismatch: dataset is ${checksum} but manifest records ${input.manifest.sha256} — the dataset changed after the manifest was generated (spec BD5)`,
      );
    }
    if (input.manifest.version !== input.dataset.version) {
      refusals.push(
        `manifest version mismatch: dataset is ${input.dataset.version} but manifest records ${input.manifest.version}`,
      );
    }
    if (input.manifest.rowCount !== input.dataset.rows.length) {
      refusals.push(
        `manifest rowCount mismatch: dataset has ${input.dataset.rows.length} rows but manifest records ${input.manifest.rowCount}`,
      );
    }
  }

  if (input.approvedChecksum === null) {
    refusals.push("--approved-checksum is required (spec BD4)");
  } else if (input.approvedChecksum !== checksum) {
    refusals.push(
      `--approved-checksum ${input.approvedChecksum} does not match the dataset checksum ${checksum} (spec BD5)`,
    );
  }

  if (input.signoff === null) {
    refusals.push(
      `sign-off record missing — the PO must record the engram decision ${BASELINE_SIGNOFF_DECISION} and only then write the sign-off file (spec BD4)`,
    );
  } else {
    if (input.signoff.engramDecision !== BASELINE_SIGNOFF_DECISION) {
      refusals.push(
        `sign-off names decision "${input.signoff.engramDecision}" — expected ${BASELINE_SIGNOFF_DECISION}`,
      );
    }
    if (input.signoff.sha256 !== checksum) {
      refusals.push(
        `sign-off approves checksum ${input.signoff.sha256} but the dataset is ${checksum} — the dataset changed after approval; obtain a new sign-off (spec BD4/BD5)`,
      );
    }
    if (input.signoff.version !== input.dataset.version) {
      refusals.push(
        `sign-off approves version ${input.signoff.version} but the dataset is ${input.dataset.version}`,
      );
    }
  }

  return refusals;
}

// ---------------------------------------------------------------------------
// Seeding (spec BD2/BD3/BD6)
// ---------------------------------------------------------------------------

export type SeedSummary = {
  inserted: string[];
  updated: string[];
  unchanged: string[];
  /** Admin-authored rows (`baseline_version IS NULL`) the seed refused to touch. */
  protectedRows: string[];
};

function rowLabel(row: LegalBaselineRow): string {
  const j = row.jurisdiction;
  return `${row.ruleKey} @ ${j.country}/${j.province ?? "—"}/${j.locality ?? "—"}`;
}

function legalMetadataOf(row: LegalBaselineRow) {
  // EXACTLY the console writers' audit shape (create/update-business-rule.ts)
  // — 6 keys, no baselineVersion — so B4 diffs render seeded changes
  // identically to admin ones (spec BD6).
  return {
    requirementLevel: row.requirementLevel,
    legalBasis: row.legalBasis,
    authority: row.authority,
    sourceUrl: row.sourceUrl,
    effectiveFrom: row.effectiveFrom,
    effectiveUntil: null,
  };
}

export async function seedLegalBaseline(
  db: DbHandle,
  dataset: LegalBaselineDataset,
  opts: { actorUserId?: string | null } = {},
): Promise<SeedSummary> {
  const actorUserId = opts.actorUserId ?? null;
  const summary: SeedSummary = { inserted: [], updated: [], unchanged: [], protectedRows: [] };

  // One transaction for the whole dataset: a legal baseline applies
  // all-or-nothing — a half-applied version tag would be worse than none.
  await db.transaction(async (tx) => {
    for (const row of dataset.rows) {
      const j = row.jurisdiction;
      const tupleWhere = and(
        eq(govtBusinessRules.ruleType, row.ruleKey),
        eq(govtBusinessRules.jurisdictionCountry, j.country),
        j.province === null
          ? isNull(govtBusinessRules.jurisdictionProvince)
          : eq(govtBusinessRules.jurisdictionProvince, j.province),
        j.locality === null
          ? isNull(govtBusinessRules.jurisdictionLocality)
          : eq(govtBusinessRules.jurisdictionLocality, j.locality),
      );

      const [existing] = await tx.select().from(govtBusinessRules).where(tupleWhere).limit(1);

      // Admin-authored override — never clobbered by a re-seed (spec BD2).
      if (existing && existing.baselineVersion === null) {
        summary.protectedRows.push(rowLabel(row));
        continue;
      }

      const unchanged =
        existing !== undefined &&
        existing.baselineVersion === dataset.version &&
        JSON.stringify(existing.rulePayload) === JSON.stringify(row.rulePayload) &&
        existing.requirementLevel === row.requirementLevel &&
        existing.legalBasis === row.legalBasis &&
        existing.authority === row.authority &&
        existing.sourceUrl === row.sourceUrl &&
        existing.effectiveFrom === row.effectiveFrom &&
        // T6 review MINOR 11: effectiveUntil was omitted here while BOTH write
        // paths force it to null. A row carrying a set effectiveUntil compared
        // "unchanged", so the re-seed skipped it and the value survived until
        // some unrelated field changed and silently wiped it. Compare it.
        existing.effectiveUntil === null;
      if (unchanged) {
        summary.unchanged.push(rowLabel(row));
        continue;
      }

      const [written] = await tx
        .insert(govtBusinessRules)
        .values({
          jurisdictionCountry: j.country,
          jurisdictionProvince: j.province,
          jurisdictionLocality: j.locality,
          ruleType: row.ruleKey,
          rulePayload: row.rulePayload,
          requirementLevel: row.requirementLevel,
          legalBasis: row.legalBasis,
          authority: row.authority,
          sourceUrl: row.sourceUrl,
          effectiveFrom: row.effectiveFrom,
          effectiveUntil: null,
          baselineVersion: dataset.version,
          createdByUserId: actorUserId,
          updatedByUserId: actorUserId,
        })
        .onConflictDoUpdate({
          target: [
            govtBusinessRules.ruleType,
            govtBusinessRules.jurisdictionCountry,
            govtBusinessRules.jurisdictionProvince,
            govtBusinessRules.jurisdictionLocality,
          ],
          set: {
            rulePayload: row.rulePayload,
            requirementLevel: row.requirementLevel,
            legalBasis: row.legalBasis,
            authority: row.authority,
            sourceUrl: row.sourceUrl,
            effectiveFrom: row.effectiveFrom,
            effectiveUntil: null,
            baselineVersion: dataset.version,
            updatedByUserId: actorUserId,
            updatedAt: new Date(),
          },
          // Belt-and-braces vs a concurrent admin write between our SELECT and
          // this statement: an admin-authored row never gets updated.
          setWhere: sql`${govtBusinessRules.baselineVersion} is not null`,
        })
        .returning({ id: govtBusinessRules.id });

      if (!written) {
        // Conflict landed on an admin row the setWhere guard protected.
        summary.protectedRows.push(rowLabel(row));
        continue;
      }

      if (existing === undefined) {
        summary.inserted.push(rowLabel(row));
        await tx.insert(auditLog).values({
          actorUserId,
          action: "govt_business_rule_created",
          payload: {
            ruleId: written.id,
            ruleType: row.ruleKey,
            jurisdiction: { country: j.country, province: j.province, locality: j.locality },
            newPayload: row.rulePayload,
            newLegalMetadata: legalMetadataOf(row),
          },
        });
      } else {
        summary.updated.push(rowLabel(row));
        await tx.insert(auditLog).values({
          actorUserId,
          action: "govt_business_rule_updated",
          payload: {
            ruleId: written.id,
            ruleType: row.ruleKey,
            jurisdiction: { country: j.country, province: j.province, locality: j.locality },
            previousPayload: existing.rulePayload,
            newPayload: row.rulePayload,
            previousLegalMetadata: {
              requirementLevel: existing.requirementLevel,
              legalBasis: existing.legalBasis,
              authority: existing.authority,
              sourceUrl: existing.sourceUrl,
              effectiveFrom: existing.effectiveFrom,
              effectiveUntil: existing.effectiveUntil,
            },
            newLegalMetadata: legalMetadataOf(row),
          },
        });
      }
    }
  });

  return summary;
}

/** Gate + seed, in that order — the composition the CLI (and tests) run. */
export async function runSeedLegalBaseline(params: {
  db: DbHandle;
  dataset: LegalBaselineDataset;
  manifest: BaselineManifest | null;
  approvedChecksum: string | null;
  signoff: BaselineSignoff | null;
  actorUserId?: string | null;
}): Promise<{ ok: true; summary: SeedSummary } | { ok: false; refusals: string[] }> {
  const refusals = collectRefusals(params);
  if (refusals.length > 0) return { ok: false, refusals };
  const summary = await seedLegalBaseline(params.db, params.dataset, {
    actorUserId: params.actorUserId ?? null,
  });
  return { ok: true, summary };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function getFlag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  return value !== undefined && !value.startsWith("--") ? value : null;
}

function manifestPath(dataset: LegalBaselineDataset): string {
  return resolve(ROOT, "data", "legal-baseline", `${dataset.version}.manifest.json`);
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal", "::1"]);

/**
 * Host of a Postgres DSN, or null when it cannot be determined.
 *
 * Uses `new URL()`, NOT a regex (T6 review M6): the previous
 * `postgres(?:ql)?:\/\/[^@]+@([^:/]+)` REQUIRED credentials, so a perfectly
 * valid credential-less DSN (`postgresql://prod-db.example.com:5432/dim`, auth
 * via PGPASSWORD / .pgpass / client cert) parsed to null. `new URL` also strips
 * the IPv6 brackets that the regex would have captured.
 */
export function parsePgHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
    const host = parsed.hostname;
    if (!host) return null;
    // new URL renders an IPv6 hostname bracketed ("[::1]"); LOCAL_HOSTS holds
    // the bare form.
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  } catch {
    return null;
  }
}

/**
 * FAIL CLOSED (T6 review M6): an unparseable DSN is NOT local. The old
 * `dbHost ? LOCAL_HOSTS.has(dbHost) : true` treated "I could not tell" as
 * "local", which let an unrecognised DSN shape write the legal baseline to a
 * remote DB without ever asking for --allow-remote. When we cannot prove the
 * target is local, the Ignacio gate applies.
 */
export function isLocalSeedTarget(databaseUrl: string): boolean {
  const host = parsePgHost(databaseUrl);
  return host !== null && LOCAL_HOSTS.has(host);
}

function writeManifestFile(dataset: LegalBaselineDataset): void {
  const manifest = buildManifest(dataset);
  const path = manifestPath(dataset);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Manifest written: ${path}`);
  console.log(`  version : ${manifest.version}`);
  console.log(`  sha256  : ${manifest.sha256}`);
  console.log(`  rows    : ${manifest.rowCount}`);
  console.log(
    `NOTE: the manifest is NOT approval. The PO must record the engram decision\n${BASELINE_SIGNOFF_DECISION} and only then write the sign-off record.`,
  );
}

/** Read manifest + sign-off from disk; unreadable/malformed parses to null so
 * collectRefusals reports the precise blocker. Filesystem only — no DB. */
function loadGateInputs(argv: string[], dataset: LegalBaselineDataset): GateInput {
  let manifest: BaselineManifest | null = null;
  try {
    manifest = baselineManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath(dataset), "utf8")),
    );
  } catch {
    manifest = null;
  }

  let signoff: BaselineSignoff | null = null;
  const signoffFile = getFlag(argv, "--signoff-file");
  if (signoffFile !== null) {
    try {
      signoff = baselineSignoffSchema.parse(
        JSON.parse(readFileSync(resolve(ROOT, signoffFile), "utf8")),
      );
    } catch {
      signoff = null;
    }
  }

  return { dataset, manifest, approvedChecksum: getFlag(argv, "--approved-checksum"), signoff };
}

/** Env bootstrap + target guards. Exits the process on any refusal. */
async function guardSeedTarget(argv: string[]): Promise<void> {
  const { config: loadEnv } = await import("dotenv");
  loadEnv({ path: ".env.local" });
  loadEnv({ path: ".env" });

  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed: NODE_ENV=production. Aborting.");
    process.exit(2);
  }
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) {
    console.error("Missing DATABASE_URL in .env.local — aborting.");
    process.exit(2);
  }
  const dbHost = parsePgHost(databaseUrl);
  if (!argv.includes("--allow-remote") && !isLocalSeedTarget(databaseUrl)) {
    console.error(
      `ABORT: DATABASE_URL host "${dbHost ?? "(unparseable DSN)"}" is not a known local host. Applying the legal baseline to a remote DB is Ignacio-gated — re-run with --allow-remote only under that gate.`,
    );
    process.exit(2);
  }
}

function reportSummary(dataset: LegalBaselineDataset, summary: SeedSummary): void {
  console.log(`Legal baseline ${dataset.version} applied.`);
  console.log(`  inserted : ${summary.inserted.length}`);
  for (const label of summary.inserted) console.log(`    + ${label}`);
  console.log(`  updated  : ${summary.updated.length}`);
  for (const label of summary.updated) console.log(`    ~ ${label}`);
  console.log(`  unchanged: ${summary.unchanged.length}`);
  console.log(`  protected (admin-authored, untouched): ${summary.protectedRows.length}`);
  for (const label of summary.protectedRows) console.log(`    ! ${label}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const requestedVersion = getFlag(argv, "--dataset") ?? DEFAULT_DATASET_VERSION;
  const dataset = DATASETS[requestedVersion];
  if (dataset === undefined) {
    console.error(
      `ABORT: unknown dataset "${requestedVersion}". Known versions: ${Object.keys(DATASETS).join(", ")}`,
    );
    process.exit(1);
  }

  const parsed = legalBaselineDatasetSchema.safeParse(dataset);
  if (!parsed.success) {
    console.error("ABORT: dataset fails its own schema:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
  }

  if (argv.includes("--write-manifest")) {
    writeManifestFile(dataset);
    return;
  }

  // --- Gate (runs BEFORE any DB import/connection) ---
  const gateInputs = loadGateInputs(argv, dataset);
  const refusals = collectRefusals(gateInputs);
  if (refusals.length > 0) {
    console.error("ABORT: legal-baseline seed refused (no writes performed):");
    for (const refusal of refusals) console.error(`  - ${refusal}`);
    process.exit(1);
  }

  const actorUserId = getFlag(argv, "--actor");
  if (
    actorUserId !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorUserId)
  ) {
    console.error(`ABORT: --actor is not a UUID: ${actorUserId}`);
    process.exit(1);
  }

  await guardSeedTarget(argv);

  const { db, closeDbPools } = await import("../db");
  try {
    const result = await runSeedLegalBaseline({ db, ...gateInputs, actorUserId });
    if (!result.ok) {
      // Unreachable (gate already ran), but fail loudly if it ever isn't.
      for (const refusal of result.refusals) console.error(`  - ${refusal}`);
      process.exit(1);
    }
    reportSummary(dataset, result.summary);
  } finally {
    await closeDbPools();
  }
}

// Guard: only run when invoked directly (tests import the exports above).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("seed-legal-baseline.ts") ||
    process.argv[1].endsWith("seed-legal-baseline.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
