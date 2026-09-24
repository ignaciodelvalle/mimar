// Import the 48 barrios of the Ciudad Autónoma de Buenos Aires into
// `ar_localities`. INDEC's CPPDyL dataset (which `import-indec-localities.ts`
// consumes) treats CABA as a single locality ("Ciudad Autónoma de Buenos
// Aires"). The 48 barrios are formalized by Ley CABA 1.777 (Comunas, 2005)
// and live in `data.buenosaires.gob.ar` — but for a stable, dependency-free
// import we hard-code the canonical list here.
//
// Each row is UPSERTed: idempotent on locality_slug per province. Re-runs
// only update `last_imported_at` (no-op).
//
// Provincia: 'AR-C' (ISO 3166-2:AR for CABA).
// Source:    'caba_open_data' (migration 0028 added this to the enum).
// Category:  'barrio'.
//
// Usage:
//   pnpm tsx scripts/import-caba-barrios.ts
//   pnpm tsx scripts/import-caba-barrios.ts --dry-run
//
// Notes:
// - Each barrio ships its area-weighted polygon centroid (latitude/longitude),
//   frozen in scripts/caba-barrios-data.ts (derived once from
//   public/geo/caba-barrios.geojson). Panorama layers that snap dots to
//   ar_localities centroids depend on these being non-NULL; the upsert below
//   also BACKFILLS coordinates onto rows that predate this (imported NULL).
// - indec_id stays null — these rows don't come from INDEC.
// - This importer only ever inserts the 48 named barrios from CABA_BARRIOS, so
//   it structurally CANNOT reintroduce the whole-province aggregate (the
//   city-wide "Ciudad Autónoma de Buenos Aires" row). Do NOT add the whole city
//   to CABA_BARRIOS: it would recreate the province-as-locality overlap that
//   isWholeProvinceAggregate (lib/infra/ar-localidades.ts) exists to drop. The
//   INDEC importer is where that aggregate is filtered out on ingest.

import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  type ArgentineLocalitySource,
  type NewArgentineLocality,
  arLocalities,
  arLocalitiesImportRuns,
  db,
} from "@/db";

// Canonical barrio reference data (names + area-weighted polygon centroids).
// Single source of truth shared with seed-panorama.ts and
// redistribute-caba-barrios.ts. We consume only name + centroid here; the
// ar_localities locality_slug is derived by this script's own slugify()
// (hyphenated), which differs from the geo-join slug carried on each entry.
import { CABA_BARRIOS } from "./caba-barrios-data";

const SOURCE: ArgentineLocalitySource = "caba_open_data";
const PROVINCE_CODE = "AR-C";
const CATEGORY = "barrio";
const SOURCE_URL = "data.buenosaires.gob.ar (Ley CABA 1.777 — 48 barrios oficiales)";

// The canonical Ley CABA 1.777 barrio list (names + centroids) lives in
// scripts/caba-barrios-data.ts (imported above as CABA_BARRIOS).

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type Stats = {
  inserted: number;
  updated: number;
  noop: number;
  errors: { name: string; reason: string }[];
};

export async function runImport(options?: { dryRun?: boolean }): Promise<Stats> {
  const dryRun = options?.dryRun ?? false;
  const stats: Stats = { inserted: 0, updated: 0, noop: 0, errors: [] };

  const [run] = await db
    .insert(arLocalitiesImportRuns)
    .values({ source: SOURCE, sourceUrl: SOURCE_URL, status: "running" })
    .returning();

  console.log(`Started CABA barrios import run ${run.id} (dryRun=${dryRun})`);

  try {
    // Pre-fetch the active AR-C catalog ONCE and index it by slug, so the
    // per-barrio existence check is an in-memory lookup instead of 48 SELECTs
    // over remote latency. Inserts are flushed in a single multi-row INSERT and
    // no-op touches (last_imported_at bump) collapse into one batched UPDATE.
    const existingRows = await db
      .select()
      .from(arLocalities)
      .where(and(eq(arLocalities.provinceCode, PROVINCE_CODE), isNull(arLocalities.removedAt)));
    const existingBySlug = new Map<string, (typeof existingRows)[number]>();
    for (const r of existingRows) existingBySlug.set(r.localitySlug, r);

    const toInsert: NewArgentineLocality[] = [];
    const toTouchIds: string[] = [];
    const now = new Date();

    for (const barrio of CABA_BARRIOS) {
      const localityName = barrio.name;
      const slug = slugify(localityName);
      // Area-weighted polygon centroid, clamped to the column's numeric(10,7).
      const latitude = barrio.lat.toFixed(7);
      const longitude = barrio.lng.toFixed(7);
      const existing = existingBySlug.get(slug);

      if (existing) {
        // Already there. Bump last_imported_at + migrate source/version if it
        // came in via a different ingest path. Also BACKFILL the centroid onto
        // rows imported before we shipped coordinates (latitude/longitude NULL)
        // — panorama centroid-snapping drops any barrio row without coords.
        const needsUpdate =
          existing.source !== SOURCE ||
          existing.category !== CATEGORY ||
          existing.localityName !== localityName ||
          existing.latitude !== latitude ||
          existing.longitude !== longitude;
        if (needsUpdate) {
          if (!dryRun) {
            await db
              .update(arLocalities)
              .set({
                source: SOURCE,
                sourceVersion: "1.777",
                category: CATEGORY,
                localityName,
                latitude,
                longitude,
                lastImportedAt: now,
              })
              .where(eq(arLocalities.id, existing.id));
          }
          stats.updated += 1;
        } else {
          toTouchIds.push(existing.id);
          stats.noop += 1;
        }
        continue;
      }

      toInsert.push({
        provinceCode: PROVINCE_CODE,
        departmentName: null,
        departmentCode: null,
        localityName,
        localitySlug: slug,
        indecId: null,
        category: CATEGORY,
        latitude,
        longitude,
        source: SOURCE,
        sourceVersion: "1.777",
      });
      stats.inserted += 1;
    }

    if (!dryRun) {
      // No unique constraint spans (province, slug) for these rows (indec_id is
      // NULL, so onConflict has no target) — idempotency is guaranteed by the
      // pre-filter above, which only queues barrios not already present.
      if (toInsert.length > 0) {
        await db.insert(arLocalities).values(toInsert);
      }
      if (toTouchIds.length > 0) {
        await db
          .update(arLocalities)
          .set({ lastImportedAt: now })
          .where(inArray(arLocalities.id, toTouchIds));
      }
    }

    await db
      .update(arLocalitiesImportRuns)
      .set({
        status: stats.errors.length > 0 ? "failed" : "ok",
        finishedAt: new Date(),
        insertedCount: stats.inserted,
        updatedCount: stats.updated,
        noopCount: stats.noop,
        details: stats.errors.length > 0 ? { errors: stats.errors } : {},
      })
      .where(eq(arLocalitiesImportRuns.id, run.id));
  } catch (err) {
    await db
      .update(arLocalitiesImportRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        details: { error: err instanceof Error ? err.message : "unknown" },
      })
      .where(eq(arLocalitiesImportRuns.id, run.id));
    throw err;
  }

  console.log(
    `CABA barrios import done: ${stats.inserted} inserted, ${stats.updated} updated, ${stats.noop} no-op, ${stats.errors.length} errors`,
  );
  return stats;
}

// Allow direct execution via `pnpm tsx scripts/import-caba-barrios.ts`.
// `process.argv[1]` ends with the script path when run directly; the
// `?.endsWith(...)` guard prevents auto-run when imported from a test.
const calledDirectly = process.argv[1]?.endsWith("import-caba-barrios.ts");
if (calledDirectly) {
  const dryRun = process.argv.includes("--dry-run");
  runImport({ dryRun })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
