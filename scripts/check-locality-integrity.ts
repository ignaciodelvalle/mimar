// Locality-integrity CI gate — data-integrity guardrail.
//
// Asserts that no phantom locality double-counts a real one in ar_localities.
// The damage is the same in every form: a Localidad dropdown entry that covers
// the same ground as other entries silently corrupts every per-locality rollup
// (see /gob/analytics). Three checks, because the phantom has worn three shapes.
//
// 1. WHOLE-PROVINCE AGGREGATE — a "locality" spanning its entire province. A
//    violation iff BOTH (a) its canonical name resolves to its OWN province
//    (provinceByName tolerates the "Ciudad Autónoma…" alias), AND (b) it has no
//    departamento. Name-equality ALONE is not the tell: real capitals (Córdoba,
//    Mendoza, Salta…) share their province's name but always sit inside a
//    departamento, so (b) spares them.
//
// 2. SUPERSEDED SOURCE — an active row from a source another source has
//    displaced for that province. Today: any indec_cppdyl row for AR-C, because
//    CABA IS its 48 caba_open_data barrios (Ley 1.777).
//
//    THIS CHECK EXISTS BECAUSE CHECK 1 WAS THE WHOLE GATE AND WENT BLIND. Until
//    2026-08-19 CABA's overlap arrived as exactly one department-less city-wide
//    row (indec_id 02000010) and check 1 described it perfectly. INDEC then
//    replaced it with 15 per-Comuna rows, ids 02007010 … 02105010, each with a
//    departamento_id. Check 1 kept answering correctly — none of them IS a
//    whole-province aggregate — and the gate printed "✓ clean" while every CI
//    bootstrap ingested 15 phantom AR-C localities, because the query only ever
//    loaded the department-less slice. Enumerating a FORM instead of the SUBJECT
//    is the recurring failure this repo keeps paying for.
//
// 3. COVERAGE FLOOR (non-vacuity) — checks 1 and 2 both pass over an EMPTY
//    catalog, which is worse than the state they guard against. So the gate also
//    asserts each alt-source province still carries what its owning source owes
//    (48 barrios for CABA), counting ONLY that source so stray INDEC rows can
//    never masquerade as coverage.
//
// Checks 1 and 2 reuse the predicates in lib/reference/locality-integrity — the
// same ones the runtime dropdown belt and the INDEC importer use — so they stay
// in lockstep from one source of truth.
//
// Source of truth: the live Postgres catalog (local Supabase Docker DB, same DB
// migrations run against). We fetch the department-less active rows PLUS every
// active row for an alt-source province (two tiny slices) and evaluate in JS.
//
// Run:  pnpm tsx scripts/check-locality-integrity.ts   (or: pnpm lint:locality)
// Exits 0 when the catalog is clean OR the DB is unreachable (graceful skip so
//   DB-less CI does not hard-fail; the invariant LOGIC is also enforced offline
//   by __tests__/check-locality-integrity.test.ts,
//   lib/reference/locality-integrity.test.ts + lib/infra/ar-localidades.test.ts).
// Exits 1 listing every offending row, with the command or SQL to remediate.

import postgres from "postgres";

import {
  ALT_SOURCE_PROVINCES,
  isSupersededByAltSource,
  isWholeProvinceAggregate,
} from "@/lib/reference/locality-integrity";

export type LocalityRow = {
  province_code: string;
  locality_name: string;
  locality_slug: string;
  department_code: string | null;
  source: string;
};

/**
 * Pure core: given catalog rows, return the whole-province aggregate offenders.
 * Extracted so the invariant is unit-testable without a database.
 */
export function findAggregateViolations(rows: LocalityRow[]): LocalityRow[] {
  return rows.filter((r) =>
    isWholeProvinceAggregate({
      provinceCode: r.province_code,
      localityName: r.locality_name,
      departmentCode: r.department_code,
    }),
  );
}

/**
 * The second detector: rows whose source another source supersedes for that
 * province (today: any indec_cppdyl row for AR-C, owned by caba_open_data).
 *
 * WHY IT IS SEPARATE FROM THE ONE ABOVE. findAggregateViolations asks about a
 * row's SHAPE — department-less, name equal to its province — which faithfully
 * described the single CABA row INDEC shipped when it was written. On
 * 2026-08-19 INDEC swapped that for 15 per-Comuna rows, each with a
 * departamento_id. The shape check went on answering correctly and the gate
 * went blind: it queried only the department-less slice, so it never LOADED the
 * 15 offenders, and printed "✓ Locality integrity clean" over a catalog that
 * double-counted the entire city. This one is about the subject, so the answer
 * survives the next reshape.
 */
export function findSupersededViolations(rows: LocalityRow[]): LocalityRow[] {
  return rows.filter((r) =>
    isSupersededByAltSource({ provinceCode: r.province_code, source: r.source }),
  );
}

export type CoverageShortfall = {
  provinceCode: string;
  source: string;
  seen: number;
  minimumRows: number;
  reason: string;
};

/**
 * NON-VACUITY FLOOR. "No superseded rows for AR-C" is trivially true of an
 * EMPTY AR-C catalog — a strictly worse state than the one being guarded
 * against, and one this gate would otherwise applaud. So the gate also counts
 * what the OWNING source actually contributes and fails when it falls under the
 * floor that source owes (48 barrios for CABA, Ley 1.777).
 *
 * `rows` must be the full slice for the alt-source provinces, all sources
 * included — only the owning source is counted, never the rows it supersedes,
 * so 48 stray INDEC rows can never masquerade as coverage.
 */
export function findCoverageShortfalls(rows: LocalityRow[]): CoverageShortfall[] {
  const out: CoverageShortfall[] = [];
  for (const [provinceCode, alt] of Object.entries(ALT_SOURCE_PROVINCES)) {
    const seen = rows.filter(
      (r) => r.province_code === provinceCode && r.source === alt.source,
    ).length;
    if (seen < alt.minimumRows) {
      out.push({
        provinceCode,
        source: alt.source,
        seen,
        minimumRows: alt.minimumRows,
        reason: alt.reason,
      });
    }
  }
  return out;
}

/** The provinces whose whole catalog the gate must load, not just a slice. */
const ALT_SOURCE_PROVINCE_CODES = Object.keys(ALT_SOURCE_PROVINCES);

async function runCheck(): Promise<void> {
  const dbUrl =
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54322/postgres";

  const sql = postgres(dbUrl, { max: 1, connect_timeout: 5 });

  let rows: LocalityRow[];
  try {
    // Two slices, both tiny:
    //   - department-less active rows: the only ones that can be a whole-province
    //     aggregate (condition 2);
    //   - EVERY active row for an alt-source province: the superseded check is
    //     about source, not shape, so restricting it to department-less rows is
    //     exactly the mistake that let INDEC's 15 CABA comunas through — they
    //     all carry a departamento_id and the old query never loaded them.
    rows = await sql<LocalityRow[]>`
      SELECT province_code, locality_name, locality_slug, department_code, source
      FROM ar_localities
      WHERE removed_at IS NULL
        AND (department_code IS NULL OR province_code = ANY(${ALT_SOURCE_PROVINCE_CODES}))
    `;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] check-locality-integrity: could not reach the DB (${reason}). Skipping this run.\n  This guard needs the local Supabase stack (pnpm db:start) or a DATABASE_URL.\n  The invariant LOGIC is still enforced offline by __tests__/check-locality-integrity.test.ts and lib/infra/ar-localidades.test.ts.`,
    );
    await sql.end({ timeout: 1 }).catch(() => {});
    process.exit(0);
    return;
  }
  await sql.end({ timeout: 1 }).catch(() => {});

  const aggregates = findAggregateViolations(rows);
  const superseded = findSupersededViolations(rows);
  const shortfalls = findCoverageShortfalls(rows);
  let failed = false;

  for (const v of aggregates) {
    console.error(
      `✗ ar_localities: "${v.locality_name}" (${v.locality_slug}, ${v.province_code}) is a whole-province aggregate — it duplicates its province and double-counts its subdivisions.`,
    );
    console.error(
      `  Remediate: update ar_localities set removed_at = now() where province_code = '${v.province_code}' and locality_slug = '${v.locality_slug}';`,
    );
  }
  if (aggregates.length > 0) {
    console.error(
      `\n✗ ${aggregates.length} whole-province aggregate row(s) in ar_localities. The INDEC importer now drops these on ingest — soft-delete the leftover row(s) above.`,
    );
    failed = true;
  }

  // Superseded rows are reported as ONE group per province: the 2026-08 break
  // put 15 of them in the catalog at once, and 15 identical paragraphs would
  // bury the single sentence that matters.
  if (superseded.length > 0) {
    const byProvince = new Map<string, LocalityRow[]>();
    for (const v of superseded) {
      const bucket = byProvince.get(v.province_code) ?? [];
      bucket.push(v);
      byProvince.set(v.province_code, bucket);
    }
    for (const [provinceCode, rowsForProvince] of byProvince) {
      const alt = ALT_SOURCE_PROVINCES[provinceCode as keyof typeof ALT_SOURCE_PROVINCES];
      const sources = [...new Set(rowsForProvince.map((r) => r.source))].join(", ");
      console.error(
        `✗ ar_localities: ${rowsForProvince.length} active ${sources} row(s) for ${provinceCode}, whose catalog '${alt.source}' owns outright.`,
      );
      console.error(`  Why: ${alt.reason}`);
      console.error(
        `  Examples: ${rowsForProvince
          .slice(0, 5)
          .map((r) => `"${r.locality_name}"`)
          .join(", ")}${rowsForProvince.length > 5 ? ", …" : ""}`,
      );
      console.error(
        `  Remediate: re-run \`pnpm tsx scripts/import-indec-localities.ts\` — it drops these on ingest and soft-deletes leftovers. Or: update ar_localities set removed_at = now() where province_code = '${provinceCode}' and source in ('${[
          ...new Set(rowsForProvince.map((r) => r.source)),
        ].join("','")}') and removed_at is null;`,
      );
    }
    failed = true;
  }

  // NON-VACUITY. Every check above passes trivially over an empty catalog, and
  // "the AR-C catalog is empty" is a worse state than "the AR-C catalog has
  // 15 rows too many". A gate that cannot tell those apart is not a gate.
  for (const s of shortfalls) {
    console.error(
      `✗ ar_localities: ${s.provinceCode} has ${s.seen} active '${s.source}' row(s), below the ${s.minimumRows} that source owes. The superseded-row check above is vacuous while this holds.`,
    );
    console.error(`  Why: ${s.reason}`);
    console.error("  Remediate: pnpm tsx scripts/import-caba-barrios.ts");
    failed = true;
  }

  if (failed) process.exit(1);

  const covered = ALT_SOURCE_PROVINCE_CODES.map((p) => {
    const alt = ALT_SOURCE_PROVINCES[p as keyof typeof ALT_SOURCE_PROVINCES];
    const seen = rows.filter((r) => r.province_code === p && r.source === alt.source).length;
    return `${p}=${seen} ${alt.source}`;
  }).join(", ");
  console.log(
    `✓ Locality integrity clean — 0 whole-province aggregates and 0 superseded rows across ${rows.length} inspected active row(s); alt-source coverage ${covered}.`,
  );
}

// Only query the DB when invoked as a CLI (pnpm lint:locality / tsx). Importing
// this module from unit tests must not trigger the query or process.exit.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-locality-integrity.ts") ||
    process.argv[1].endsWith("check-locality-integrity.js"));

if (isMain) {
  runCheck();
}
