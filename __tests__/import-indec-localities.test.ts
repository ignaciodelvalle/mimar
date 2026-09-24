// Test del importer con un CSV fixture chiquito. Mockea global.fetch para
// evitar pegarle a datos.gob.ar desde CI.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { and, eq, inArray, isNotNull, isNull, like, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { arLocalities, arLocalitiesImportRuns, db } from "@/db";
import {
  FALLBACK_FIXTURE_SOURCE_VERSION,
  REMOVAL_MIN_RECOGNISED_ROWS,
  runImport,
} from "@/scripts/import-indec-localities";

import { restoreIndecCatalog } from "./_helpers/restore-indec-catalog";

const FIXTURE_PATH = join(
  __dirname,
  "..",
  "scripts",
  "__fixtures__",
  "indec-localidades-sample.csv",
);
const csvFixture = readFileSync(FIXTURE_PATH, "utf-8");

// ---------------------------------------------------------------------------
// FIXTURE IDS THAT CANNOT EXIST UPSTREAM (rewritten 2026-08-21)
// ---------------------------------------------------------------------------
//
// This cleanup HARD-DELETES by indec_id, and three of the ids it deleted were
// real: `06028010` is "Almirante Brown" and `50028010` is "Colonia Segovia" in
// the live feed, and both had already been erased from the dev catalog by
// earlier runs of this very file. (`06441010`, the "La Plata" fixture, turned
// out never to have existed upstream — which is luck, not design, and is
// exactly the kind of luck this rewrite stops depending on.)
//
// The failure shape is the one caba-barrios.test.ts already survived once: a
// test that deletes "its own" rows by a real identifier is a test that quietly
// edits production-shaped data every time it runs, and the damage is invisible
// because the row simply is not there any more.
//
// So every synthetic id now carries department code `999` — INDEC assigns no
// such department in any province, so no id below can ever collide with a live
// row, whatever upstream ships next. The check at the bottom of this block is
// what keeps that true when someone adds a fixture row in a hurry.
const FIXTURE_INDEC_IDS = [
  "02014010", // CABA - Comuna 2   (REAL upstream; superseded, never imported)
  "02098010", // CABA - Comuna 14  (REAL upstream; superseded, never imported)
  "06999010", // Avellaneda        (dept 06999 — impossible)
  "06999020", // La Plata          (dept 06999 — impossible)
  "50999010", // Mendoza capital   (dept 50999 — impossible)
  "50999020", // Paraje (intentionally skipped by category filter)
  "99999010", // Inventada (intentionally rejected by province filter)
  "06999030", // Empty name (intentionally rejected by required-field filter)
] as const;

/**
 * The two AR-C rows, which are transcribed VERBATIM from the live feed (fetched
 * 2026-08-19) and MUST stay real.
 *
 * They used to be inventions — "02014010" was labelled "Palermo", and upstream
 * that id is now "CABA - Comuna 2" — which is how the 2026-08-19 CI break got
 * its second half: caba-barrios.test.ts hard-deleted those ids as stale fixture
 * residue and took a live row with it, turning 15 rows into 14.
 *
 * They cannot be made synthetic like the rest: the test below proves the
 * importer refuses to persist a REAL upstream AR-C id at any granularity, and
 * an invented id would prove only that it refuses to persist an invented one.
 * So they are cleaned up by MARKER instead of by id — see below.
 */
const FIXTURE_CABA_IDS = ["02014010", "02098010"] as const;

/**
 * Rows this file PLANTS in the catalog by hand and that appear in NO CSV — the
 * removal-pass tests need a stale-looking active row to watch. Same `999`
 * department rule as the synthetic fixture ids, and for the same reason: a
 * planted row is deleted outright in cleanup, so it must be an id upstream
 * cannot mint. They are deliberately NOT in `FIXTURE_INDEC_IDS`, which is
 * asserted equal to the CSV's own id list.
 */
const PLANTED_STALE_IDS = ["06999110", "06999120"] as const;

/** Ids this file may delete outright, because upstream cannot mint them. */
const SYNTHETIC_FIXTURE_IDS = FIXTURE_INDEC_IDS.filter(
  (id) => !FIXTURE_CABA_IDS.includes(id as (typeof FIXTURE_CABA_IDS)[number]),
);

/**
 * The `source_version` a fixture import stamps.
 *
 * `runImport` takes it from the response's `Last-Modified` header, so the
 * harness sets a marker there rather than a plausible date. It is the second
 * lock on the cleanup: a row is fixture residue only if it carries one of these
 * versions, so the two REAL CABA ids can be cleaned without any possibility of
 * deleting a row a live import wrote.
 */
const FIXTURE_SOURCE_VERSION = "fixture-test";

/** Every source_version a row written by this file can carry. */
const FIXTURE_SOURCE_VERSIONS = [
  FIXTURE_SOURCE_VERSION,
  // The fallback path stamps its own, and one test exercises it. IMPORTED from
  // the importer, not repeated as a literal: two copies of a marker are two
  // things a rename can put out of step, and the half that rots here is the
  // cleanup's SCOPE — the fallback rows would quietly stop being deleted.
  FALLBACK_FIXTURE_SOURCE_VERSION,
  // The pre-fix AR-C row the self-healing test plants by hand.
  "pre-fix",
];

function buildResponse(headers?: Record<string, string>): Response {
  return new Response(csvFixture, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Last-Modified": FIXTURE_SOURCE_VERSION,
      ...headers,
    },
  });
}

/**
 * An ACTIVE indec_cppdyl row that appears in no CSV this file ships — i.e. a
 * removal candidate. The removal-guard tests watch exactly this row: if the
 * stale-row pass runs, it is stamped `removed_at`; if the guard holds, it is
 * untouched.
 */
async function plantStaleRow(indecId: string): Promise<void> {
  await db.insert(arLocalities).values({
    provinceCode: "AR-B",
    departmentCode: indecId.slice(0, 5),
    departmentName: "Departamento 999",
    localityName: `Stale ${indecId}`,
    localitySlug: `stale-${indecId}`,
    indecId,
    category: "localidad",
    source: "indec_cppdyl",
    sourceVersion: FIXTURE_SOURCE_VERSION,
  });
}

/** How many indec_cppdyl rows are still active — the number a bad removal pass destroys. */
async function countActiveIndecRows(): Promise<number> {
  const rows = await db
    .select({ id: arLocalities.id })
    .from(arLocalities)
    .where(and(eq(arLocalities.source, "indec_cppdyl"), isNull(arLocalities.removedAt)));
  return rows.length;
}

/**
 * A syntactically perfect feed of `rowCount` rows that imports NOTHING.
 *
 * Every row is a "Paraje" — a category the importer drops as too granular — so
 * the feed exercises the completeness floor without inserting thousands of rows
 * into the shared local catalog. Ids carry the impossible `999` department, so
 * even a future category change could not collide with a live locality.
 *
 * Each row still carries a READABLE `id`, which is what the floor counts since
 * 2026-08-21 — so this builds a feed that is short, not one that is
 * unintelligible. The renamed-column test strips the id column from the header
 * afterwards to build the other kind.
 */
function syntheticFeed(rowCount: number): string {
  const header = csvFixture.split("\n")[0];
  const provinces: [string, string][] = [
    ["06", "Buenos Aires"],
    ["10", "Catamarca"],
    ["14", "Cordoba"],
  ];
  const lines = [header];
  for (let i = 0; i < rowCount; i++) {
    const [provinceId, provinceName] = provinces[i % provinces.length];
    const localityCode = String(Math.floor(i / provinces.length)).padStart(3, "0");
    const id = `${provinceId}999${localityCode}`;
    lines.push(
      `"Paraje",-34.0000000,-58.0000000,"${provinceId}999","Departamento 999","INDEC","","","","${id}","Paraje ${i}","${provinceId}","${provinceName}"`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function cleanupFixtureRows() {
  // Synthetic ids: safe to delete outright — upstream cannot mint a `999`
  // department, so there is no live row wearing one of these ids to destroy.
  await db
    .delete(arLocalities)
    .where(inArray(arLocalities.indecId, [...SYNTHETIC_FIXTURE_IDS, ...PLANTED_STALE_IDS]));
  // REAL ids: only rows this file wrote, identified by the marker version. A
  // live AR-C row (if a future import ever wrote one) carries a real date here
  // and survives — which is the whole point, since deleting one is precisely
  // the accident that broke CI for three pushes.
  //
  // …plus the SUPERSEDED ones, whatever version wrote them. A bootstrapped
  // database is not empty here: `pnpm db:bootstrap` runs the real INDEC import,
  // which ingests 02014010 / 02098010 and then soft-deletes them under the AR-C
  // rule. Those rows carry a genuine upstream Last-Modified as their
  // source_version, so the marker-scoped delete above can never free the id —
  // and three tests in this file assume it is free: two count rows for these
  // ids, and one INSERTs 02014010 outright and hit
  // `ar_localities_indec_id_unique`. The test that stands in for "a pre-fix
  // catalog" even says in its own comment that staging and prod carry these
  // rows; it just never claimed the key.
  //
  // `removedAt IS NOT NULL` is the safe half of that set: a superseded row is
  // exactly what the next import recreates, so dropping it costs nothing, while
  // a LIVE row (removedAt IS NULL) is still untouchable — the protection above
  // is narrowed, not removed.
  await db
    .delete(arLocalities)
    .where(
      and(
        inArray(arLocalities.indecId, [...FIXTURE_CABA_IDS]),
        or(
          inArray(arLocalities.sourceVersion, FIXTURE_SOURCE_VERSIONS),
          isNotNull(arLocalities.removedAt),
        ),
      ),
    );
  // Un-soft-delete real catalog rows the soft-delete subtest may have stamped.
  // The script's soft-delete pass marks any indec_cppdyl row that isn't in the
  // current CSV as removed; running with a fixture CSV obliterates the live
  // catalog unless we restore it here. The shared helper also re-drops the
  // whole-province aggregate rows a blanket restore would resurrect (they fail
  // the lint:locality gate) — see _helpers/restore-indec-catalog.ts.
  await restoreIndecCatalog();
  // Remove the test-only import runs (those point at the fixture URL, not the
  // real datos.gob.ar URL).
  await db
    .delete(arLocalitiesImportRuns)
    .where(
      or(
        like(arLocalitiesImportRuns.sourceUrl, "%fixture%"),
        eq(arLocalitiesImportRuns.sourceUrl, "https://test.example/fixture.csv"),
      ),
    );
}

beforeEach(cleanupFixtureRows);
afterAll(cleanupFixtureRows);

// Per-test timeouts: the script does N+M synchronous queries (N for upsert
// checks, M for the soft-delete scan over all indec_cppdyl rows). With ~4000
// real catalog rows present each test that triggers a full import can take
// 30-45 s under load; tests that run two full imports need up to 90 s. Each
// `it` carries an explicit budget — the dry-run test has no soft-delete scan
// and stays fast.
describe("import-indec-localities", () => {
  // THE FENCE THAT KEEPS THE CLEANUP SAFE. Everything else in this file assumes
  // `cleanupFixtureRows` cannot destroy a live row; that assumption is only as
  // good as the ids, and the ids are a hand-maintained list in a CSV. It held
  // for months and then did not: `06028010` (Almirante Brown) and `50028010`
  // (Colonia Segovia) were real, and this suite had already deleted both from
  // the dev catalog before anyone noticed.
  it("uses only INDEC ids upstream cannot mint, and stamps every fixture row", () => {
    // Positions 3-5 of an INDEC id are the department; `999` is assigned in no
    // province, so a synthetic id can never name a real locality. The PLANTED
    // ids obey the same rule: cleanup deletes them by id, so an id upstream
    // could mint would be the same landmine in a different room.
    for (const id of [...SYNTHETIC_FIXTURE_IDS, ...PLANTED_STALE_IDS]) {
      expect(id.slice(2, 5), `${id} must use the impossible department 999`).toBe("999");
    }
    // NON-VACUITY: an empty list would pass the loop above in silence.
    expect(SYNTHETIC_FIXTURE_IDS.length).toBeGreaterThanOrEqual(5);
    expect(PLANTED_STALE_IDS.length).toBeGreaterThanOrEqual(2);

    // Every id in the CSV is accounted for here. A row added to the fixture and
    // not listed would never be cleaned up, and would leak into the catalog.
    const csvIds = csvFixture
      .split("\n")
      .slice(1)
      .filter((line) => line.trim().length > 0)
      .map((line) => line.split(",")[9].replaceAll('"', ""));
    expect([...csvIds].sort()).toEqual([...FIXTURE_INDEC_IDS].sort());

    // The two REAL ids are the ONLY ones exempt from the rule above, and they
    // are exempt because the AR-C test needs them real. Anything else claiming
    // that exemption is a mistake.
    expect(FIXTURE_CABA_IDS.every((id) => id.startsWith("02"))).toBe(true);
  });

  // 60 s: one full import — upsert + soft-delete scan over ~4 k catalog rows.
  it("imports the fixture CSV: 3 valid rows, 3 skipped (paraje + 2 CABA), 2 errored", async () => {
    global.fetch = vi.fn(async () => buildResponse());
    const stats = await runImport({ sourceUrl: "https://test.example/fixture.csv" });

    expect(stats.inserted).toBe(3);
    expect(stats.updated).toBe(0);
    expect(stats.noop).toBe(0);
    // "Paraje" (category filter) + the two AR-C comunas (superseded by
    // caba_open_data — CABA is its 48 barrios, never INDEC's tiling of it).
    expect(stats.skipped).toBe(3);
    expect(stats.supersededSkipped).toBe(2);
    expect(stats.errors).toHaveLength(2); // unknown province + missing name

    const rows = await db
      .select()
      .from(arLocalities)
      .where(eq(arLocalities.source, "indec_cppdyl"));

    const fixtureRows = rows.filter((r) =>
      FIXTURE_INDEC_IDS.includes(r.indecId as (typeof FIXTURE_INDEC_IDS)[number]),
    );
    expect(fixtureRows).toHaveLength(3);

    const mendoza = fixtureRows.find((r) => r.indecId === "50999010");
    expect(mendoza?.category).toBe("ciudad");
    expect(mendoza?.provinceCode).toBe("AR-M");

    const laPlata = fixtureRows.find((r) => r.indecId === "06999020");
    expect(laPlata?.provinceCode).toBe("AR-B");
    expect(laPlata?.category).toBe("localidad");
    expect(laPlata?.localitySlug).toBe("la-plata");
    expect(laPlata?.latitude).toBe("-34.9214000");
    expect(laPlata?.longitude).toBe("-57.9544000");

    const runs = await db
      .select()
      .from(arLocalitiesImportRuns)
      .where(eq(arLocalitiesImportRuns.sourceUrl, "https://test.example/fixture.csv"));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("ok");
    expect(runs[0].insertedCount).toBe(3);
  }, 60_000);

  // THE CI BREAK, AS A TEST (2026-08-19 upstream change).
  //
  // INDEC replaced CABA's single department-less city-wide row with 15
  // per-Comuna rows. Every one carries a departamento_id, so
  // isWholeProvinceAggregate — which required department_code to be null — saw
  // none of them, and all 15 imported as active indec_cppdyl AR-C rows on every
  // CI bootstrap (`inserted=4023 … skipped=0`). Nothing noticed until
  // caba-barrios.test.ts counted 15 rows that should not exist.
  //
  // The rule was never about the shape. CABA IS its 48 caba_open_data barrios,
  // so NO indec_cppdyl row for AR-C belongs in the catalog at any granularity.
  it("drops EVERY indec_cppdyl row for AR-C, whatever granularity INDEC ships", async () => {
    global.fetch = vi.fn(async () => buildResponse());
    await runImport({ sourceUrl: "https://test.example/fixture.csv" });

    const cabaIndec = await db
      .select({ id: arLocalities.id, indecId: arLocalities.indecId })
      .from(arLocalities)
      .where(
        and(
          eq(arLocalities.provinceCode, "AR-C"),
          eq(arLocalities.source, "indec_cppdyl"),
          isNull(arLocalities.removedAt),
        ),
      );
    expect(cabaIndec).toEqual([]);

    // Not merely inactive — never written at all, so a later blanket
    // "un-soft-delete" cannot resurrect them.
    const anyRow = await db
      .select({ id: arLocalities.id })
      .from(arLocalities)
      .where(inArray(arLocalities.indecId, [...FIXTURE_CABA_IDS]));
    expect(anyRow).toEqual([]);
  }, 60_000);

  // SELF-HEALING for the DBs that already ingested them. Staging and prod
  // bootstrapped after 2026-08-19 carry the 15 live comuna rows; the fix has to
  // clear them on the next import rather than needing a data migration.
  it("soft-deletes an AR-C indec row an EARLIER import already ingested", async () => {
    // Stand in for a pre-fix catalog: an active AR-C indec_cppdyl row.
    await db.insert(arLocalities).values({
      provinceCode: "AR-C",
      departmentCode: "02014",
      departmentName: "Comuna 2",
      localityName: "CABA - Comuna 2",
      localitySlug: "caba-comuna-2",
      indecId: "02014010",
      category: "componente",
      source: "indec_cppdyl",
      sourceVersion: "pre-fix",
    });

    global.fetch = vi.fn(async () => buildResponse());
    // The 8-row fixture is far below REMOVAL_MIN_RECOGNISED_ROWS, so the removal
    // pass refuses to run unless the harness says the partial feed is
    // deliberate. This test is ABOUT the removal pass, so it says so.
    await runImport({
      sourceUrl: "https://test.example/fixture.csv",
      allowPartialFeedRemovals: true,
    });

    const [row] = await db
      .select({ removedAt: arLocalities.removedAt })
      .from(arLocalities)
      .where(eq(arLocalities.indecId, "02014010"));
    expect(row).toBeDefined();
    expect(row.removedAt).not.toBeNull();
  }, 60_000);

  // 60 s: first run triggers a full soft-delete scan; second run is fast
  // (all real rows already soft-deleted, nothing new to remove).
  it("is idempotent on re-run with the same CSV (3 noop, 0 changes)", async () => {
    global.fetch = vi.fn(async () => buildResponse());
    await runImport({ sourceUrl: "https://test.example/fixture.csv" });

    // Re-run — re-mock fetch since vi.fn() was consumed
    global.fetch = vi.fn(async () => buildResponse());
    const second = await runImport({ sourceUrl: "https://test.example/fixture.csv" });

    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.noop).toBe(3);
    // A skipped row stays skipped on every run — it must never oscillate
    // between "dropped" and "restored" across imports.
    expect(second.supersededSkipped).toBe(2);
  }, 60_000);

  // 90 s: beforeEach restores the full catalog before this test, so BOTH
  // import runs face the complete soft-delete scan (~4 k rows each).
  it("soft-deletes rows that disappear from the new CSV", async () => {
    global.fetch = vi.fn(async () => buildResponse());
    // BOTH runs opt in, not just the second. The removal pass is what puts the
    // real catalog into its "already removed" state; if only the second run had
    // it, that run would remove ~4 k real rows on top of La Plata and the count
    // below would stop meaning anything.
    await runImport({
      sourceUrl: "https://test.example/fixture.csv",
      allowPartialFeedRemovals: true,
    });

    // Now ship a CSV without La Plata (06999020). A CABA row would prove
    // nothing here: the importer never persisted it in the first place.
    const trimmedCsv = csvFixture
      .split("\n")
      .filter((line) => !line.includes('"06999020"'))
      .join("\n");
    global.fetch = vi.fn(
      async () =>
        new Response(trimmedCsv, {
          status: 200,
          // The marker again, not a plausible date — every row this file writes
          // must be identifiable as fixture residue by its source_version.
          headers: { "Last-Modified": FIXTURE_SOURCE_VERSION },
        }),
    );

    const stats = await runImport({
      sourceUrl: "https://test.example/fixture.csv",
      allowPartialFeedRemovals: true,
    });
    expect(stats.removed).toBe(1);
    expect(stats.removalsSkipped).toBeNull();

    const [laPlata] = await db
      .select()
      .from(arLocalities)
      .where(eq(arLocalities.indecId, "06999020"));
    expect(laPlata.removedAt).not.toBeNull();
  }, 90_000);

  // -------------------------------------------------------------------------
  // THE REMOVAL PASS IS ONLY SAFE OVER A FEED THAT IS ACTUALLY THE CATALOG
  // -------------------------------------------------------------------------
  // Everything above proves the stale-row pass WORKS. These three prove it
  // REFUSES, and that is the half with the teeth: "soft-delete every active row
  // absent from the parsed feed" is a correct rule about a complete feed and a
  // catalog-wipe about anything less. One unreachable datos.gob.ar and the
  // fallback fixture — 8 rows — would have stamped ~4 000 real localities
  // `removed_at` on staging or prod, with the run row reporting `status: ok`.
  //
  // The guard is deliberately NOT "trust usedFallback": a truncated live
  // download is the same hazard wearing a 200, so the feed carries its own
  // completeness floor. And the floor is NOT stated over parsed rows — the third
  // test is a full-size feed whose id column was renamed, which is complete by
  // every measure except the only one that matters. `allowPartialFeedRemovals`
  // is the harness's explicit opt-out and has no production caller — the three
  // tests below are the coverage of the DEFAULT.

  it("refuses to remove anything when the live fetch fell back to the fixture", async () => {
    await plantStaleRow(PLANTED_STALE_IDS[0]);
    const activeBefore = await countActiveIndecRows();

    global.fetch = vi.fn(async () => {
      throw new Error("datos.gob.ar unreachable (simulated)");
    });
    const stats = await runImport({ sourceUrl: "https://test.example/fixture.csv" });

    expect(stats.usedFallback).toBe(true);
    // Asserted BEFORE the reason: this number is the landmine. Without the
    // guard it is the whole catalog.
    expect(stats.removed).toBe(0);
    expect(stats.removalsSkipped).toBe("fallback");

    // The planted row is absent from the 8-row fallback fixture, so the old
    // code would have stamped it — along with every other real locality.
    const [planted] = await db
      .select({ removedAt: arLocalities.removedAt })
      .from(arLocalities)
      .where(eq(arLocalities.indecId, PLANTED_STALE_IDS[0]));
    expect(planted.removedAt).toBeNull();

    // NOT MERELY ONE ROW: the whole catalog is still standing. A guard that
    // spared only the row we happened to watch would pass the assertion above.
    // The 3 fixture rows the fallback import inserts are the expected delta.
    expect(await countActiveIndecRows()).toBe(activeBefore + 3);
    // NON-VACUITY: on a catalog of 5 rows this proves nothing. The local DB
    // carries the real ~4 k, and that is the number the landmine was aimed at.
    expect(activeBefore).toBeGreaterThan(1000);

    // And the run row says WHY, because a degraded run that looks identical to a
    // healthy one in the audit trail is how this stays invisible.
    const [run] = await db
      .select()
      .from(arLocalitiesImportRuns)
      .where(eq(arLocalitiesImportRuns.sourceUrl, "https://test.example/fixture.csv"));
    expect(run.removedCount).toBe(0);
    expect((run.details as { removalsSkipped?: string }).removalsSkipped).toBe("fallback");
  }, 60_000);

  it("refuses to remove anything when the parsed feed is below the completeness floor", async () => {
    await plantStaleRow(PLANTED_STALE_IDS[1]);

    // A 200 OK with a truncated body: no fallback flag, nothing to warn about,
    // and 1 000 fewer rows than the floor.
    const truncated = syntheticFeed(3000);
    global.fetch = vi.fn(
      async () =>
        new Response(truncated, {
          status: 200,
          headers: { "Last-Modified": FIXTURE_SOURCE_VERSION },
        }),
    );
    const stats = await runImport({ sourceUrl: "https://test.example/fixture.csv" });

    expect(stats.usedFallback).toBe(false);
    expect(stats.removed).toBe(0);
    expect(stats.removalsSkipped).toBe("partial-feed");
    // The floor has to sit between the two: comfortably above any fixture, far
    // enough below the live feed (4 023 rows on 2026-08-21) that ordinary
    // upstream churn never trips it.
    expect(REMOVAL_MIN_RECOGNISED_ROWS).toBeGreaterThanOrEqual(1000);
    expect(REMOVAL_MIN_RECOGNISED_ROWS).toBeLessThan(4000);
    // The synthetic rows are all parajes — parsed, counted, imported by nobody.
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(3000);

    const [planted] = await db
      .select({ removedAt: arLocalities.removedAt })
      .from(arLocalities)
      .where(eq(arLocalities.indecId, PLANTED_STALE_IDS[1]));
    expect(planted.removedAt).toBeNull();

    const [run] = await db
      .select()
      .from(arLocalitiesImportRuns)
      .where(eq(arLocalitiesImportRuns.sourceUrl, "https://test.example/fixture.csv"));
    expect((run.details as { removalsSkipped?: string }).removalsSkipped).toBe("partial-feed");
  }, 60_000);

  it("refuses to remove anything when the feed's `id` column was renamed away", async () => {
    // THE HOLE A ROW-COUNT FLOOR CANNOT SEE, and the one upstream has ALREADY
    // demonstrated it can produce: on 2026-08-19 INDEC renamed `municipio_id` to
    // `gobierno_local_id` and MOVED the `id` column. The move was harmless
    // because csv-parse keys rows by header name — and that is exactly what
    // makes the rename dangerous. A feed whose id column is called something
    // else parses perfectly, arrives at full size, sails over any floor stated
    // in ROWS, and yields an EMPTY seen-set. "Every active row is absent from
    // the feed" is then true of the entire catalog, and the run reports
    // `status: ok` while stamping ~4 000 real localities `removed_at`.
    //
    // So the floor is stated over rows the importer UNDERSTOOD — ids it could
    // actually read — not over rows it received. Same reason the fallback check
    // was not enough on its own: the hazard is "this feed is not the catalog",
    // and a feed can fail that in more ways than being short.
    //
    // DRY RUN ON PURPOSE. Under the defect this run computes a removal set of
    // the whole catalog; `dryRun` lets the assertion see that number without the
    // test being the thing that destroys the local DB when it goes red.
    const activeBefore = await countActiveIndecRows();
    const renamed = syntheticFeed(4000).replace(',"id",', ',"codigo",');
    // The feed really is full-size and really has lost the column — otherwise
    // this would just be the row-count floor firing again under a new name.
    expect(renamed.split("\n")[0]).not.toContain('"id"');
    expect(renamed.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(4001);

    global.fetch = vi.fn(
      async () =>
        new Response(renamed, {
          status: 200,
          headers: { "Last-Modified": FIXTURE_SOURCE_VERSION },
        }),
    );
    const stats = await runImport({
      dryRun: true,
      sourceUrl: "https://test.example/fixture.csv",
    });

    expect(stats.usedFallback).toBe(false);
    // Not one row is understood: every record fails the required-field check.
    expect(stats.errors).toHaveLength(4000);
    expect(stats.removalsSkipped).toBe("partial-feed");
    expect(stats.removed).toBe(0);
    // NON-VACUITY: `removed=0` proves nothing on an empty catalog. The local DB
    // carries the real ~4 k, and that is the number the defect was aimed at.
    expect(activeBefore).toBeGreaterThan(1000);
    expect(await countActiveIndecRows()).toBe(activeBefore);
  }, 60_000);

  // The upstream header rename (2026-08-19): municipio_id / municipio_nombre
  // became gobierno_local_id / gobierno_local_nombre, and the column ORDER
  // moved `id` to the far side of them. The importer reads columns BY NAME
  // (csv-parse `columns: true`) and reads neither of the renamed ones, so this
  // is a no-op for us — but "we think it's a no-op" is not the same claim as
  // "the parse still produces the right rows", and only one of them is testable.
  it("parses the post-rename header shape (gobierno_local_*, reordered id)", async () => {
    const header = csvFixture.split("\n")[0];
    expect(header).toContain('"gobierno_local_id"');
    expect(header).toContain('"gobierno_local_nombre"');
    expect(header).not.toContain('"municipio_id"');

    global.fetch = vi.fn(async () => buildResponse());
    const stats = await runImport({ sourceUrl: "https://test.example/fixture.csv" });
    expect(stats.inserted).toBe(3);

    // The id column still lands on the right row despite moving position.
    const [laPlata] = await db
      .select({ name: arLocalities.localityName })
      .from(arLocalities)
      .where(eq(arLocalities.indecId, "06999020"));
    expect(laPlata.name).toBe("La Plata");
  }, 60_000);

  // dry-run skips all DB writes and the soft-delete scan — stays fast.
  it("respects --dry-run: no writes, no run row persisted with finishedAt", async () => {
    global.fetch = vi.fn(async () => buildResponse());
    const stats = await runImport({
      dryRun: true,
      sourceUrl: "https://test.example/fixture.csv",
    });
    expect(stats.inserted).toBe(3);

    // No rows inserted — the catalog stays untouched.
    const fixtureRowsCount = await db
      .select({ id: arLocalities.id })
      .from(arLocalities)
      .where(eq(arLocalities.indecId, "06999020"));
    expect(fixtureRowsCount).toHaveLength(0);
  });

  // Graceful fallback: when the live fetch fails, the script loads the bundled
  // sample fixture instead of throwing. Bootstrap / CI stay green.
  it("falls back to the bundled fixture when the live fetch fails", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("Network unreachable (simulated)");
    });
    const stats = await runImport({ sourceUrl: "https://test.example/fixture.csv" });

    expect(stats.usedFallback).toBe(true);
    // Fixture has 3 importable rows (2 more are CABA, superseded).
    expect(stats.inserted).toBe(3);
    expect(stats.errors.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  // Local file path override: when localCsvPath is provided, no fetch is made.
  it("loads from a local CSV file when localCsvPath is provided (no fetch)", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const stats = await runImport({
      localCsvPath: FIXTURE_PATH,
      sourceUrl: "https://test.example/fixture.csv",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stats.usedFallback).toBe(false);
    expect(stats.inserted).toBe(3);
  }, 60_000);
});
